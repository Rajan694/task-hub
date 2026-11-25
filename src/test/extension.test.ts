import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../extension';
import type { HubCommand, RunState } from '../model';
import { rowState } from '../ui/treeProvider';
import { powershellPath } from '../platform';
import { isAlive } from '../runner/killTree';
import { stripAnsi } from '../runner/outputWatcher';

// These tests run in the workspace src/test/fixtures/workspace (see .vscode-test.mjs).

const EXTENSION_ID = 'rajan694.task-hub';

async function getApi(): Promise<TestApi> {
	const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
	assert.ok(extension, 'extension is installed');
	const api = await extension.activate();
	await api.registry.ready;
	return api;
}

function find(api: TestApi, id: string): HubCommand {
	const command = api.registry.all().find((c) => c.id === id);
	assert.ok(command, `${id} not found; found ${api.registry.all().map((c) => c.id).join(', ')}`);
	return command;
}

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 15000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Whether output mentions a path; Windows paths compare without case (VS Code writes d:\, processes print D:\). */
function includesPath(output: string, file: string): boolean {
	return process.platform === 'win32' ? output.toLowerCase().includes(file.toLowerCase()) : output.includes(file);
}

function workspaceRoot(): string {
	return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

suite('Task Hub', () => {
	let api: TestApi;
	suiteSetup(async () => {
		api = await getApi();
	});
	teardown(async () => {
		await Promise.all(api.runner.runningCommands().map((c) => api.runner.stop(c.key)));
	});

	test('activates and registers its commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of ['taskHub.refresh', 'taskHub.run', 'taskHub.stop', 'taskHub.restart', 'taskHub.openUrl', 'taskHub.showOutput']) {
			assert.ok(commands.includes(id), id);
		}
	});

	suite('finding scripts', () => {
		test('lists the scripts of every package.json, skipping node_modules', () => {
			const ids = api.registry.all().filter((c) => c.source === 'npm').map((c) => c.id);
			assert.deepStrictEqual(ids, [
				'npm:root:pass',
				'npm:root:fail',
				'npm:root:serve',
				'npm:root:ask',
				'npm:apps/pnpm-app:build',
				'npm:apps/web:dev',
				'npm:apps/web:build',
			]);
		});

		test('each package runs in its own folder with the nearest package manager', () => {
			const root = workspaceRoot();
			const web = find(api, 'npm:apps/web:build');
			assert.strictEqual(web.commandLine, 'npm run build', 'npm, from the root package-lock.json');
			assert.strictEqual(web.cwd.fsPath, path.join(root, 'apps', 'web'));
			assert.strictEqual(web.group.label, 'apps/web');
			assert.strictEqual(web.group.description, 'package.json · npm');

			const pnpmApp = find(api, 'npm:apps/pnpm-app:build');
			assert.strictEqual(pnpmApp.commandLine, 'pnpm run build', 'pnpm, from the packageManager field');
			assert.strictEqual(pnpmApp.group.description, 'package.json · pnpm');

			const pass = find(api, 'npm:root:pass');
			assert.strictEqual(pass.cwd.fsPath, root);
			assert.strictEqual(pass.group.label, path.basename(root));
		});

		test('points each script at its line in package.json', () => {
			const fail = find(api, 'npm:root:fail');
			const lines = fs.readFileSync(path.join(workspaceRoot(), 'package.json'), 'utf8').split('\n');
			assert.strictEqual(fail.definedAt?.range.start.line, lines.findIndex((l) => l.includes('"fail"')));
			assert.strictEqual(fail.body, `node -e "console.error('broken'); process.exit(3)"`);
		});

		test('marks dev servers as long-running', () => {
			assert.strictEqual(find(api, 'npm:root:serve').longRunning, true);
			assert.strictEqual(find(api, 'npm:apps/web:dev').longRunning, true);
			assert.strictEqual(find(api, 'npm:root:pass').longRunning, false);
		});

		test('the tree has one heading per package and file, root first', () => {
			const groups = api.tree.getChildren();
			assert.deepStrictEqual(
				groups.map((g) => (g.kind === 'group' ? g.group.label : '?')),
				[
					'Groups',
					path.basename(workspaceRoot()),
					'apps/pnpm-app',
					'apps/web',
					'Makefile',
					'justfile',
					'Taskfile.yml',
					'compose.yaml',
					'python/manage.py',
					'python/pyproject.toml',
					'python/pyproject.toml',
					'java/maven',
					'java/maven/api',
					'java/maven/web',
					'java/gradle',
					'java/gradle/app',
					'java/gradle/lib/core',
					'scripts/',
					'VS Code tasks',
					'My commands',
				],
			);
			const rows = api.tree.getChildren(groups[1]).map((node) => api.tree.getTreeItem(node));
			assert.deepStrictEqual(
				rows.map((r) => r.label),
				['pass', 'fail', 'serve', 'ask'],
			);
		});

		test('a new package.json shows up after a refresh', async () => {
			const dir = path.join(workspaceRoot(), 'apps', 'added');
			fs.mkdirSync(dir, { recursive: true });
			try {
				fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"hello": "echo hi"}}');
				await api.registry.scan();
				assert.ok(find(api, 'npm:apps/added:hello'));
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
				await api.registry.scan();
			}
			assert.ok(!api.registry.all().some((c) => c.id === 'npm:apps/added:hello'));
		});
	});

	suite('running scripts', () => {
		test('a passing script ends as passed', async () => {
			const command = find(api, 'npm:root:pass');
			const state = await api.runner.run(command);
			assert.strictEqual(state.status, 'passed', api.runner.outputText(command.key));
			assert.strictEqual(state.exitCode, 0);
			assert.deepStrictEqual(api.states.get(command.key), state);
			assert.match(api.runner.outputText(command.key), /all good/);
			assert.strictEqual(api.tree.getTreeItem(api.tree.nodeFor(command.key)!).contextValue, 'cmd.passed+args+savable');
		});

		test('a failing script ends as failed with its exit code', async () => {
			const command = find(api, 'npm:root:fail');
			const state = await api.runner.run(command);
			assert.strictEqual(state.status, 'failed');
			assert.strictEqual(state.exitCode, 3);
			assert.match(api.runner.outputText(command.key), /broken/);
			assert.strictEqual(api.tree.getTreeItem(api.tree.nodeFor(command.key)!).description, 'failed (exit 3)');
		});

		test('a nested script runs in its package folder', async () => {
			const command = find(api, 'npm:apps/web:build');
			const state = await api.runner.run(command);
			assert.strictEqual(state.status, 'passed', api.runner.outputText(command.key));
			const printed = stripAnsi(api.runner.outputText(command.key));
			assert.ok(includesPath(printed, path.join(workspaceRoot(), 'apps', 'web')), printed);
		});

		test('a dev server becomes ready with its URL, and Stop ends the whole process tree', async () => {
			const command = find(api, 'npm:root:serve');
			const done = api.runner.run(command);
			const ready = await waitFor('ready', () => {
				const s = api.states.get(command.key);
				return s.status === 'ready' && s;
			});
			assert.strictEqual(ready.url, 'http://localhost:5199/');
			assert.strictEqual(api.tree.getTreeItem(api.tree.nodeFor(command.key)!).contextValue, 'cmd.running.url+args+savable');

			const pid = await waitFor('server pid', () => Number(/pid=(\d+)/.exec(api.runner.outputText(command.key))?.[1]));
			assert.ok(isAlive(pid), 'server is running');

			const stopped = await api.runner.stop(command.key);
			assert.strictEqual(stopped?.status, 'stopped');
			assert.strictEqual((await done).status, 'stopped');
			// The server is a grandchild (shell → npm → shell → node), not the process Task Hub started.
			await waitFor('server to exit', () => !isAlive(pid), 7000);
		});

		test('restart stops the old process and starts a new one', async () => {
			const command = find(api, 'npm:apps/web:dev');
			void api.runner.run(command);
			const firstPid = await waitFor('first pid', () => Number(/pid=(\d+)/.exec(api.runner.outputText(command.key))?.[1]));

			await api.runner.restart(command);
			const secondPid = await waitFor('second pid', () => {
				const pid = Number(/pid=(\d+)/.exec(api.runner.outputText(command.key))?.[1]);
				return pid !== firstPid && pid;
			});
			await waitFor('ready again', () => api.states.get(command.key).status === 'ready');
			await waitFor('old server to exit', () => !isAlive(firstPid), 7000);
			assert.ok(isAlive(secondPid));
		});

		test('running a command that already runs waits for the same run', async () => {
			const command = find(api, 'npm:root:serve');
			const first = api.runner.run(command);
			const second = api.runner.run(command);
			assert.strictEqual(first, second);
			assert.strictEqual(api.runner.runningCommands().length, 1);
		});

		test('typed input reaches the process', async () => {
			const command = find(api, 'npm:root:ask');
			const done = api.runner.run(command);
			// What the terminal passes on when the user types "hello" and Enter.
			api.runner.sendInput(command.key, 'hello\r');
			const state: RunState = await done;
			assert.strictEqual(state.status, 'passed', api.runner.outputText(command.key));
			assert.match(stripAnsi(api.runner.outputText(command.key)), /got: hello/);
		});

		test('the run buttons work from the tree', async () => {
			const command = find(api, 'npm:root:pass');
			const node = api.tree.nodeFor(command.key)!;
			await vscode.commands.executeCommand('taskHub.run', node);
			await waitFor('passed', () => api.states.get(command.key).status === 'passed' && !api.runner.isRunning(command.key));
		});
	});
	suite('more sources (v0.2)', () => {
		const ids = (source: string) => api.registry.all().filter((c) => c.source === source).map((c) => c.id);

		test('Makefile targets, with ## descriptions', () => {
			assert.deepStrictEqual(ids('make'), ['make:root:build', 'make:root:test', 'make:root:clean']);
			const build = find(api, 'make:root:build');
			assert.strictEqual(build.commandLine, 'make build');
			assert.strictEqual(build.description, 'Build the app');
			assert.strictEqual(build.definedAt?.range.start.line, 5);
		});

		test('justfile recipes, with parameters to ask for', () => {
			assert.deepStrictEqual(ids('just'), ['just:root:dev', 'just:root:deploy']);
			const deploy = find(api, 'just:root:deploy');
			assert.strictEqual(deploy.commandLine, 'just deploy');
			assert.deepStrictEqual(
				deploy.args?.map((a) => [a.name, a.required, a.defaultValue]),
				[
					['env', true, undefined],
					['target', false, 'web'],
					['flags', false, ''],
				],
			);
			assert.strictEqual(find(api, 'just:root:dev').longRunning, true);
		});

		test('Taskfile tasks, without internal ones', () => {
			assert.deepStrictEqual(ids('taskfile'), ['taskfile:root:build', 'taskfile:root:db:migrate']);
			assert.strictEqual(find(api, 'taskfile:root:db:migrate').commandLine, 'task db:migrate');
		});

		test('compose services, with Logs and Stop, and their running state from docker', () => {
			assert.deepStrictEqual(ids('compose'), ['compose:root:postgres', 'compose:root:api']);
			const postgres = find(api, 'compose:root:postgres');
			assert.strictEqual(postgres.commandLine, 'docker compose up -d postgres');
			assert.strictEqual(postgres.description, 'postgres:16');
			assert.deepStrictEqual(
				postgres.actions?.map((a) => a.commandLine),
				['docker compose logs -f --tail 200 postgres', 'docker compose stop postgres'],
			);
			assert.strictEqual(rowState(postgres, { status: 'idle' }, true).contextValue, 'cmd.up+service');
			assert.strictEqual(rowState(postgres, { status: 'idle' }, false).contextValue, 'cmd.idle+service');
			assert.strictEqual(rowState(postgres, { status: 'running' }, false).contextValue, 'cmd.running+service');
		});

		test('scripts, one heading per folder, with what each takes', () => {
			const expected = ['script:scripts:backup.ps1', 'script:scripts:deploy.sh', 'script:scripts:greet.sh'];
			if (process.platform === 'win32') {
				expected.push('script:scripts:hello.cmd');
			}
			expected.push('script:scripts:plain.sh');
			assert.deepStrictEqual(ids('script'), expected);

			const deploy = find(api, 'script:scripts:deploy.sh');
			assert.strictEqual(deploy.cwd.fsPath, path.join(workspaceRoot(), 'scripts'));
			assert.strictEqual(deploy.exec?.args[0], 'deploy.sh');
			assert.strictEqual(deploy.description, 'env [--dry-run]');
			assert.strictEqual(deploy.commandLine, 'bash deploy.sh');

			const greet = find(api, 'script:scripts:greet.sh');
			assert.strictEqual(greet.description, '[$1 (hello, bye, later)] [name]');

			assert.strictEqual(find(api, 'script:scripts:plain.sh').freeArgs, true);

			const backup = find(api, 'script:scripts:backup.ps1');
			assert.strictEqual(backup.description, powershellPath() ? '-Target [-Schedule (daily, weekly)] [-Force]' : 'needs pwsh');
		});

		test('VS Code tasks, without hidden ones', () => {
			assert.deepStrictEqual(ids('vscode'), ['vscode:echo-task', 'vscode:failing-task']);
			const echo = find(api, 'vscode:echo-task');
			assert.strictEqual(echo.description, 'Says hello');
			assert.strictEqual(echo.commandLine, 'echo hello-from-task');
		});

		test('saved commands from .vscode/task-hub.json', () => {
			const hi = find(api, 'saved:say-hi');
			assert.strictEqual(hi.label, 'Say hi');
			assert.strictEqual(hi.cwd.fsPath, path.join(workspaceRoot(), 'apps', 'web'));
			assert.strictEqual(hi.group.description, '.vscode/task-hub.json');
			assert.strictEqual(rowState(hi, { status: 'idle' }).contextValue, 'cmd.idle+args+saved');
		});

		test('a script runs with its arguments as a list, and Restart reuses them', async () => {
			const deploy = find(api, 'script:scripts:deploy.sh');
			const state = await api.runner.run(deploy, { args: ['staging; echo injected', '--dry-run'] });
			assert.strictEqual(state.status, 'passed', api.runner.outputText(deploy.key));
			const output = stripAnsi(api.runner.outputText(deploy.key));
			assert.match(output, /deploying to staging; echo injected --dry-run/);
			assert.doesNotMatch(output, /^injected/m);

			await api.runner.restart(deploy);
			await waitFor('second run', () => !api.runner.isRunning(deploy.key) && api.states.get(deploy.key).status === 'passed');
			assert.match(stripAnsi(api.runner.outputText(deploy.key)), /deploying to staging; echo injected --dry-run/);
		});

		test('a case "$1" script fails on an unknown choice', async () => {
			const greet = find(api, 'script:scripts:greet.sh');
			assert.strictEqual((await api.runner.run(greet, { args: ['hello', 'Ada'] })).status, 'passed');
			assert.match(stripAnsi(api.runner.outputText(greet.key)), /hello Ada/);
			const failed = await api.runner.run(greet, { args: ['nope'] });
			assert.strictEqual(failed.exitCode, 2);
		});

		test('a PowerShell script gets named arguments', async function () {
			if (!powershellPath()) {
				this.skip();
			}
			const backup = find(api, 'script:scripts:backup.ps1');
			const state = await api.runner.run(backup, { args: ['-Target', 'C:/data', '-Schedule', 'weekly', '-Force'] });
			assert.strictEqual(state.status, 'passed', api.runner.outputText(backup.key));
			assert.match(stripAnsi(api.runner.outputText(backup.key)), /backup C:\/data weekly True/);
		});

		test('a .cmd script runs on Windows', async function () {
			if (process.platform !== 'win32') {
				this.skip();
			}
			const hello = find(api, 'script:scripts:hello.cmd');
			const state = await api.runner.run(hello, { args: ['there'] });
			assert.strictEqual(state.status, 'passed', api.runner.outputText(hello.key));
			assert.match(stripAnsi(api.runner.outputText(hello.key)), /hello from cmd there/);
		});

		test('a saved command runs in its folder', async () => {
			const hi = find(api, 'saved:say-hi');
			assert.strictEqual((await api.runner.run(hi)).status, 'passed');
			const output = stripAnsi(api.runner.outputText(hi.key));
			assert.ok(output.includes('hi from saved') && includesPath(output, path.join(workspaceRoot(), 'apps', 'web')), output);
		});

		test('free-text arguments reach a script as separate words', async () => {
			const plain = find(api, 'script:scripts:plain.sh');
			await api.runner.run(plain, { args: ['a b', 'c'] });
			assert.match(stripAnsi(api.runner.outputText(plain.key)), /got 2 args: a b c/);
		});

		test('VS Code tasks run through VS Code, with their exit code', async () => {
			const echo = find(api, 'vscode:echo-task');
			assert.strictEqual((await api.runner.run(echo)).status, 'passed');
			const failing = find(api, 'vscode:failing-task');
			const state = await api.runner.run(failing);
			assert.strictEqual(state.status, 'failed');
			assert.strictEqual(state.exitCode, 2);
		});

		test('saving a command adds it to task-hub.json, keeping the comments; deleting removes it', async () => {
			const folder = vscode.workspace.workspaceFolders![0];
			const file = path.join(workspaceRoot(), '.vscode', 'task-hub.json');
			const original = fs.readFileSync(file, 'utf8');
			try {
				const added = await api.saved.add(folder, { label: 'List files', command: 'ls', cwd: 'scripts' });
				await api.registry.scan();
				const listed = find(api, `saved:${added.id}`);
				assert.strictEqual(listed.cwd.fsPath, path.join(workspaceRoot(), 'scripts'));
				assert.match(fs.readFileSync(file, 'utf8'), /\/\/ Saved commands for the tests\./);

				await api.saved.remove(folder, added.id);
				await api.registry.scan();
				assert.ok(!api.registry.all().some((c) => c.id === `saved:${added.id}`));
				assert.ok(find(api, 'saved:say-hi'));
			} finally {
				fs.writeFileSync(file, original);
				await api.registry.scan();
			}
		});

		test('a command that needs a missing program fails with the reason', async () => {
			const plain = find(api, 'script:scripts:plain.sh');
			const state = await api.runner.run({ ...plain, key: `${plain.key}#unavailable`, unavailable: 'needs bash' });
			assert.strictEqual(state.status, 'failed');
			assert.strictEqual(state.error, 'needs bash');
		});
	});
});

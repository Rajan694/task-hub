import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../extension';
import type { HubCommand, RunState } from '../model';
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
			const ids = api.registry.all().map((c) => c.id);
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
			assert.strictEqual(fail.description, `node -e "console.error('broken'); process.exit(3)"`);
		});

		test('marks dev servers as long-running', () => {
			assert.strictEqual(find(api, 'npm:root:serve').longRunning, true);
			assert.strictEqual(find(api, 'npm:apps/web:dev').longRunning, true);
			assert.strictEqual(find(api, 'npm:root:pass').longRunning, false);
		});

		test('the tree has one heading per package, root first', () => {
			const groups = api.tree.getChildren();
			assert.deepStrictEqual(
				groups.map((g) => (g.kind === 'group' ? g.group.label : '?')),
				[path.basename(workspaceRoot()), 'apps/pnpm-app', 'apps/web'],
			);
			const rows = api.tree.getChildren(groups[0]).map((node) => api.tree.getTreeItem(node));
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
			assert.strictEqual(api.tree.getTreeItem(api.tree.nodeFor(command.key)!).contextValue, 'cmd.passed');
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
			assert.ok(printed.includes(path.join(workspaceRoot(), 'apps', 'web')), printed);
		});

		test('a dev server becomes ready with its URL, and Stop ends the whole process tree', async () => {
			const command = find(api, 'npm:root:serve');
			const done = api.runner.run(command);
			const ready = await waitFor('ready', () => {
				const s = api.states.get(command.key);
				return s.status === 'ready' && s;
			});
			assert.strictEqual(ready.url, 'http://localhost:5199/');
			assert.strictEqual(api.tree.getTreeItem(api.tree.nodeFor(command.key)!).contextValue, 'cmd.running.url');

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
});

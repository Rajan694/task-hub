import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../extension';
import type { HubCommand } from '../model';
import { stripAnsi } from '../runner/outputWatcher';
import { groupRowState, type GroupNode } from '../ui/treeProvider';

// Runs in src/test/fixtures/workspace (see .vscode-test.mjs).

const win = process.platform === 'win32';

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

suite('v0.4', () => {
	let api: TestApi;
	let root: string;
	suiteSetup(async () => {
		api = await vscode.extensions.getExtension<TestApi>('rajan694.task-hub')!.activate();
		// The test VS Code keeps its workspace state between runs: start without loaded Gradle task lists.
		await api.gradleTasks.clear();
		await api.registry.scan();
		await api.groups.ready;
		root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	});
	teardown(async () => {
		await Promise.all(api.runner.runningCommands().map((c) => api.runner.stop(c.key)));
	});

	const find = (id: string): HubCommand => {
		const command = api.registry.all().find((c) => c.id === id);
		assert.ok(command, `${id} not found`);
		return command;
	};
	const ids = (source: string) => api.registry.all().filter((c) => c.source === source).map((c) => c.id);
	const groupKey = (id: string) => `${vscode.workspace.workspaceFolders![0].uri.toString()}#group:${id}`;

	suite('Python', () => {
		test('Django commands, Poe tasks and PDM scripts', () => {
			assert.deepStrictEqual(ids('python'), [
				'python:python:runserver',
				'python:python:migrate',
				'python:python:makemigrations',
				'python:python:test',
				'python:python:poe:test',
				'python:python:poe:lint',
				'python:python:poe:serve',
				'python:python:poe:build',
				'python:python:pdm:start',
				'python:python:pdm:migrate:db',
			]);
			assert.strictEqual(find('python:python:runserver').longRunning, true);
			assert.match(find('python:python:migrate').commandLine, /^python3? manage\.py migrate$/);
			assert.strictEqual(find('python:python:poe:lint').commandLine, 'poe lint');
			assert.strictEqual(find('python:python:poe:lint').description, 'Lint the code');
			assert.strictEqual(find('python:python:pdm:migrate:db').commandLine, 'pdm run migrate:db');
			assert.strictEqual(find('python:python:migrate').cwd.fsPath, path.join(root, 'python'));
		});

		test('a Django command runs with the project Python', async () => {
			const migrate = find('python:python:migrate');
			const state = await api.runner.run(migrate);
			assert.strictEqual(state.status, 'passed', api.runner.outputText(migrate.key));
			assert.match(stripAnsi(api.runner.outputText(migrate.key)), /manage migrate/);
		});
	});

	suite('Maven', () => {
		test('one heading per module; modules run from the root with -pl', () => {
			const mvn = win ? 'mvnw.cmd' : './mvnw';
			assert.deepStrictEqual(
				ids('maven').filter((id) => id.endsWith(':test') || id.endsWith(':spring-boot:run')),
				['maven:java/maven:test', 'maven:java/maven/api:test', 'maven:java/maven/api:spring-boot:run', 'maven:java/maven/web:test'],
			);
			const run = find('maven:java/maven/api:spring-boot:run');
			assert.strictEqual(run.commandLine, `${mvn} -pl api spring-boot:run`);
			assert.strictEqual(run.cwd.fsPath, path.join(root, 'java', 'maven'));
			assert.strictEqual(run.longRunning, true);
			assert.strictEqual(find('maven:java/maven:install').commandLine, `${mvn} install`);
			assert.strictEqual(run.group.description, 'pom.xml · Maven wrapper');
		});

		test('the wrapper runs', async () => {
			const test = find('maven:java/maven/web:test');
			const state = await api.runner.run(test);
			assert.strictEqual(state.status, 'passed', api.runner.outputText(test.key));
			assert.match(stripAnsi(api.runner.outputText(test.key)), /mvnw -pl web test/);
		});
	});

	suite('Gradle', () => {
		const gradlew = win ? 'gradlew.bat' : 'sh gradlew'; // the fixture's gradlew isn't executable

		test('one heading per project; subprojects run from the root by path', () => {
			assert.deepStrictEqual(ids('gradle'), [
				'gradle:java/gradle:build',
				'gradle:java/gradle:test',
				'gradle:java/gradle:clean',
				'gradle:java/gradle:assemble',
				'gradle:java/gradle/app:build',
				'gradle:java/gradle/app:test',
				'gradle:java/gradle/app:clean',
				'gradle:java/gradle/app:assemble',
				'gradle:java/gradle/app:run',
				'gradle:java/gradle/app:bootRun',
				'gradle:java/gradle/lib/core:build',
				'gradle:java/gradle/lib/core:test',
				'gradle:java/gradle/lib/core:clean',
				'gradle:java/gradle/lib/core:assemble',
			]);
			assert.strictEqual(find('gradle:java/gradle/app:bootRun').commandLine, `${gradlew} :app:bootRun`);
			assert.strictEqual(find('gradle:java/gradle/lib/core:test').commandLine, `${gradlew} :lib:core:test`);
			assert.strictEqual(find('gradle:java/gradle:build').commandLine, `${gradlew} build`);
			assert.strictEqual(find('gradle:java/gradle/app:bootRun').cwd.fsPath, path.join(root, 'java', 'gradle'));
		});

		test('Load All Tasks asks Gradle once and keeps the list', async () => {
			const heading = api.tree.getChildren().find((n) => n.kind === 'group' && n.group.label === 'java/gradle/app') as GroupNode;
			assert.ok(heading.group.loadAllTasks);
			assert.match(String(api.tree.getTreeItem(heading).contextValue), /\+loadall/);
			await vscode.commands.executeCommand('taskHub.loadAllTasks', heading);
			const custom = find('gradle:java/gradle/app:customTask');
			assert.strictEqual(custom.commandLine, `${gradlew} :app:customTask`);
			assert.ok(!api.registry.all().some((c) => c.id.includes('compileJava') && c.id.includes('lib:core')), 'tasks of other projects left out');
			const loaded = api.tree.getChildren().find((n) => n.kind === 'group' && n.group.label === 'java/gradle/app') as GroupNode;
			assert.match(String(loaded.group.description), /all tasks/);
			assert.strictEqual(loaded.group.loadAllTasks, undefined);

			await api.gradleTasks.clear();
			await api.registry.scan();
			assert.ok(!api.registry.all().some((c) => c.id === 'gradle:java/gradle/app:customTask'));
		});
	});

	suite('groups', () => {
		test('groups from task-hub.json under a Groups heading', () => {
			assert.deepStrictEqual(
				api.groups.all().map((g) => g.def.label),
				['Start everything', 'Broken', 'Never ready', 'Missing'],
			);
			const heading = api.tree.getChildren()[0] as GroupNode;
			assert.strictEqual(heading.group.label, 'Groups');
			const start = api.tree.getTreeItem(heading.children[0]);
			assert.strictEqual(start.label, 'Start everything');
			assert.strictEqual(start.description, 'pass → serve → plain.sh');
			assert.strictEqual(start.contextValue, 'rungroup.idle');
			const steps = api.tree.getChildren(heading.children[0]).map((n) => api.tree.getTreeItem(n));
			assert.deepStrictEqual(
				steps.map((s) => s.label),
				['pass', 'serve', 'plain.sh'],
			);
		});

		test('steps run in order, each waiting; Stop stops what still runs', async () => {
			const key = groupKey('start');
			const serve = find('npm:root:serve');
			const plain = find('script:scripts:plain.sh');
			const state = await api.groups.run(key);
			assert.strictEqual(state.status, 'done', state.message);
			assert.strictEqual(api.states.get(find('npm:root:pass').key).status, 'passed');
			assert.strictEqual(api.states.get(serve.key).status, 'ready', 'serve was ready before plain.sh started');
			assert.match(stripAnsi(api.runner.outputText(plain.key)), /got 1 args: from-group/);
			assert.ok(api.groups.isRunning(key), 'serve still runs');
			assert.strictEqual(api.tree.getTreeItem(api.tree.groupNodeFor(key)!).contextValue, 'rungroup.running');

			await api.groups.stop(key);
			assert.strictEqual(api.states.get(serve.key).status, 'stopped');
			assert.ok(!api.groups.isRunning(key));
			assert.strictEqual(api.groups.state(key).status, 'stopped');
		});

		test('a failing step stops the group there', async () => {
			const build = find('npm:apps/web:build');
			const before = api.states.get(build.key).startedAt;
			const state = await api.groups.run(groupKey('broken'));
			assert.strictEqual(state.status, 'failed');
			assert.strictEqual(state.step, 0);
			assert.match(String(state.message), /fail: exit 3/);
			assert.strictEqual(api.states.get(build.key).startedAt, before, 'the next step did not start');
			assert.match(String(api.tree.getTreeItem(api.tree.groupNodeFor(groupKey('broken'))!).description), /failed at fail/);
		});

		test('a step that is never ready times out', async () => {
			const state = await api.groups.run(groupKey('slow'));
			assert.strictEqual(state.status, 'failed');
			assert.match(String(state.message), /not ready after 1s/);
		});

		test('a step naming a missing command fails', async () => {
			const state = await api.groups.run(groupKey('missing'));
			assert.strictEqual(state.status, 'failed');
			assert.match(String(state.message), /no command "npm:root:nope"/);
		});

		test('stopping a group while it starts', async () => {
			const key = groupKey('start');
			const running = api.groups.run(key);
			await waitFor('serve to start', () => api.runner.isRunning(find('npm:root:serve').key));
			await api.groups.stop(key);
			assert.strictEqual((await running).status, 'stopped');
			assert.strictEqual(api.runner.runningCommands().length, 0);
		});

		test('Add to Group writes the step; a new group appears in the tree', async () => {
			const folder = vscode.workspace.workspaceFolders![0];
			const file = path.join(root, '.vscode', 'task-hub.json');
			const original = fs.readFileSync(file, 'utf8');
			try {
				await api.saved.addStep(folder, { label: 'Checks' }, { run: 'make:root:test' });
				await api.saved.addStep(folder, { id: 'checks' }, { run: 'npm:root:pass', waitFor: 'running' });
				await api.groups.ready;
				const checks = api.groups.all().find((g) => g.def.id === 'checks');
				assert.deepStrictEqual(checks?.def.steps, [
					{ run: 'make:root:test', waitFor: undefined, timeoutSec: undefined, args: undefined },
					{ run: 'npm:root:pass', waitFor: 'running', timeoutSec: undefined, args: undefined },
				]);
				assert.match(fs.readFileSync(file, 'utf8'), /\/\/ Groups for the tests\./);
				assert.ok(api.tree.groupNodeFor(checks!.key));

				await api.saved.removeGroup(folder, 'checks');
				await api.groups.ready;
				assert.ok(!api.groups.all().some((g) => g.def.id === 'checks'));
			} finally {
				fs.writeFileSync(file, original);
				await api.groups.reload();
			}
		});

		test('group row texts', () => {
			const names = ['postgres', 'api', 'web'];
			assert.strictEqual(groupRowState({ status: 'idle' }, false, names).text, 'postgres → api → web');
			assert.strictEqual(groupRowState({ status: 'running', step: 1 }, true, names).text, 'step 2/3: api');
			assert.strictEqual(groupRowState({ status: 'done' }, true, names).text, 'running');
			assert.strictEqual(groupRowState({ status: 'done' }, false, names).text, 'done');
			assert.strictEqual(groupRowState({ status: 'failed', step: 2 }, false, names).text, 'failed at web');
		});
	});
});

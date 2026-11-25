import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../extension';
import type { HubCommand } from '../model';
import { RunStateStore } from '../state';
import { quickRunSections } from '../ui/quickPick';
import { statusBarText } from '../ui/statusBar';
import type { GroupNode } from '../ui/treeProvider';

// Runs in src/test/fixtures/workspace (see .vscode-test.mjs).

function memento(): vscode.Memento {
	const values = new Map<string, unknown>();
	return {
		keys: () => [...values.keys()],
		get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
		update: async (key: string, value: unknown) => void values.set(key, JSON.parse(JSON.stringify(value))),
	} as unknown as vscode.Memento;
}

suite('run history', () => {
	test('survives a reload; what was running comes back as stopped', () => {
		const storage = memento();
		const first = new RunStateStore(storage);
		first.set('a', { status: 'passed', startedAt: 1_000, endedAt: 2_000, exitCode: 0, args: ['staging'] });
		first.set('b', { status: 'ready', startedAt: 3_000, url: 'http://localhost:5173/' });
		first.set('c', { status: 'failed', startedAt: 500, endedAt: 900, exitCode: 2 });
		first.dispose(); // saves at once

		const second = new RunStateStore(storage);
		assert.deepStrictEqual(second.get('a'), { status: 'passed', startedAt: 1_000, endedAt: 2_000, exitCode: 0, args: ['staging'] });
		const b = second.get('b');
		assert.strictEqual(b.status, 'stopped');
		assert.strictEqual(b.url, undefined);
		assert.ok(b.endedAt && b.endedAt >= 3_000);
		assert.strictEqual(second.get('never').status, 'idle');
		assert.deepStrictEqual(
			second.recent().map((r) => r.key),
			['b', 'a', 'c'],
		);
		second.dispose();
	});
});

suite('status bar', () => {
	test('text', () => {
		assert.strictEqual(statusBarText(0), '$(play)');
		assert.strictEqual(statusBarText(2), '$(sync~spin) 2 running');
	});
});

suite('control panel', () => {
	let api: TestApi;
	let folder: vscode.WorkspaceFolder;
	let file: string;
	let original: string;

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension<TestApi>('rajan694.task-hub')!;
		api = await extension.activate();
		await api.registry.ready;
		folder = vscode.workspace.workspaceFolders![0];
		file = path.join(folder.uri.fsPath, '.vscode', 'task-hub.json');
		original = fs.readFileSync(file, 'utf8');
	});
	teardown(async () => {
		await Promise.all(api.runner.runningCommands().map((c) => api.runner.stop(c.key)));
		fs.writeFileSync(file, original);
		await api.registry.scan();
		await api.favorites.reload();
	});

	const find = (id: string): HubCommand => {
		const command = api.registry.all().find((c) => c.id === id);
		assert.ok(command, id);
		return command;
	};

	test('favorites are saved in task-hub.json and pinned at the top of the tree', async () => {
		const pass = find('npm:root:pass');
		const build = find('make:root:build');
		await api.favorites.set(build, true);
		await api.favorites.set(pass, true);
		await api.favorites.ready;

		assert.match(fs.readFileSync(file, 'utf8'), /"favorites": \[\s*"make:root:build",\s*"npm:root:pass"\s*\]/);
		assert.match(fs.readFileSync(file, 'utf8'), /\/\/ Saved commands for the tests\./);

		const favorites = api.tree.getChildren()[0] as GroupNode;
		assert.strictEqual(favorites.group.label, 'Favorites');
		const rows = api.tree.getChildren(favorites).map((n) => api.tree.getTreeItem(n));
		assert.deepStrictEqual(
			rows.map((r) => r.label),
			['build', 'pass'],
		);
		// Where each favorite comes from; then its status once it has run (pass ran in an earlier suite).
		assert.strictEqual(rows[0].description, 'Makefile');
		assert.ok(String(rows[1].description).startsWith(path.basename(folder.uri.fsPath)), String(rows[1].description));
		assert.match(String(rows[1].contextValue), /\+fav/);
		assert.notStrictEqual(rows[1].id, pass.key, 'the favorite row has its own id');

		// Both rows follow the command's state.
		await api.runner.run(pass);
		const favoriteRow = api.tree.getTreeItem(api.tree.getChildren(favorites)[1]);
		assert.match(String(favoriteRow.description), /^workspace — passed · /);
		assert.match(String(api.tree.getTreeItem(api.tree.nodeFor(pass.key)!).description), /^passed · /);

		await api.favorites.set(build, false);
		await api.favorites.ready;
		const remaining = api.tree.getChildren()[0] as GroupNode;
		assert.deepStrictEqual(
			api.tree.getChildren(remaining).map((n) => (n.kind === 'command' ? n.command.id : '')),
			['npm:root:pass'],
		);
	});

	test('no favorites, no Favorites heading', () => {
		assert.notStrictEqual((api.tree.getChildren()[0] as GroupNode).group.label, 'Favorites');
	});

	test('the quick pick lists running, favorite and recent commands first, each command once', async () => {
		const serve = find('npm:root:serve');
		const fail = find('npm:root:fail');
		const build = find('make:root:build');
		await api.favorites.set(build, true);
		await api.favorites.ready;
		await api.runner.run(fail);
		void api.runner.run(serve);

		const sections = quickRunSections(api);
		assert.deepStrictEqual(
			sections.slice(0, 3).map((s) => [s.label, s.commands[0].id]),
			[
				['Running', 'npm:root:serve'],
				['Favorites', 'make:root:build'],
				['Recent', 'npm:root:fail'],
			],
		);
		const all = sections.flatMap((s) => s.commands.map((c) => c.key));
		assert.strictEqual(new Set(all).size, all.length, 'no command twice');
		assert.strictEqual(all.length, api.registry.all().length, 'every command once');
	});

	test('the quick pick opens and closes', async () => {
		await vscode.commands.executeCommand('taskHub.quickRun');
		await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
	});

	test('Stop All stops every running command', async () => {
		const serve = find('npm:root:serve');
		const dev = find('npm:apps/web:dev');
		void api.runner.run(serve);
		void api.runner.run(dev);
		await vscode.commands.executeCommand('taskHub.stopAll');
		assert.strictEqual(api.runner.runningCommands().length, 0);
		assert.strictEqual(api.states.get(serve.key).status, 'stopped');
		assert.strictEqual(api.states.get(dev.key).status, 'stopped');
	});

	test('the last arguments are part of the saved state', async () => {
		const plain = find('script:scripts:plain.sh');
		await api.runner.run(plain, { args: ['one', 'two'] });
		assert.deepStrictEqual(api.states.get(plain.key).args, ['one', 'two']);
		assert.deepStrictEqual(api.runner.lastArgs(plain.key), ['one', 'two']);
	});
});

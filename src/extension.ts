import * as vscode from 'vscode';
import { DETECTORS } from './detectors';
import { CommandRegistry } from './registry';
import { Runner } from './runner/runner';
import { RunStateStore } from './state';
import { registerCommands } from './ui/commands';
import { CommandsTreeProvider } from './ui/treeProvider';

/** Returned from activate() for the extension's own tests; not a stable API for other extensions. */
export interface TestApi {
	registry: CommandRegistry;
	runner: Runner;
	states: RunStateStore;
	tree: CommandsTreeProvider;
}

export function activate(context: vscode.ExtensionContext): TestApi {
	const log = vscode.window.createOutputChannel('Task Hub', { log: true });
	log.info(`Task Hub ${context.extension.packageJSON.version} activated`);

	const states = new RunStateStore();
	const runner = new Runner(states, log);
	const registry = new CommandRegistry(DETECTORS, log);
	const tree = new CommandsTreeProvider(registry, states);

	context.subscriptions.push(
		log,
		states,
		runner,
		registry,
		tree,
		vscode.window.createTreeView('taskHub.commands', { treeDataProvider: tree, showCollapseAll: true }),
		...registerCommands({ registry, runner, states, extensionId: context.extension.id }),
	);

	// A progress bar on the view during the first scan; the "nothing found" text waits for it.
	void vscode.window
		.withProgress({ location: { viewId: 'taskHub.commands' } }, () => registry.ready)
		.then(() => vscode.commands.executeCommand('setContext', 'taskHub.scanned', true));

	return { registry, runner, states, tree };
}

export function deactivate(): void {}

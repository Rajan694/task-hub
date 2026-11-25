import * as vscode from 'vscode';
import { ArgMemory } from './args/prompt';
import { createDetectors } from './detectors';
import { CommandRegistry } from './registry';
import { Runner } from './runner/runner';
import { SavedStore } from './saved';
import { ServiceMonitor } from './services';
import { RunStateStore } from './state';
import { registerCommands } from './ui/commands';
import { CommandsTreeProvider } from './ui/treeProvider';

/** Returned from activate() for the extension's own tests; not a stable API for other extensions. */
export interface TestApi {
	registry: CommandRegistry;
	runner: Runner;
	states: RunStateStore;
	services: ServiceMonitor;
	saved: SavedStore;
	memory: ArgMemory;
	tree: CommandsTreeProvider;
}

export function activate(context: vscode.ExtensionContext): TestApi {
	const log = vscode.window.createOutputChannel('Task Hub', { log: true });
	log.info(`Task Hub ${context.extension.packageJSON.version} activated`);

	const states = new RunStateStore();
	const runner = new Runner(states, log);
	const saved = new SavedStore(context.workspaceState);
	const memory = new ArgMemory(context.workspaceState);
	const registry = new CommandRegistry(createDetectors(saved), log);
	const services = new ServiceMonitor(registry, log);
	const tree = new CommandsTreeProvider(registry, states, services);
	const view = vscode.window.createTreeView('taskHub.commands', { treeDataProvider: tree, showCollapseAll: true });
	services.setVisible(view.visible);

	context.subscriptions.push(
		log,
		states,
		runner,
		saved,
		registry,
		services,
		tree,
		view,
		view.onDidChangeVisibility((e) => services.setVisible(e.visible)),
		...registerCommands({ registry, runner, states, services, saved, memory, extensionId: context.extension.id }),
	);

	// A progress bar on the view during the first scan; the "nothing found" text waits for it.
	void vscode.window
		.withProgress({ location: { viewId: 'taskHub.commands' } }, () => registry.ready)
		.then(() => vscode.commands.executeCommand('setContext', 'taskHub.scanned', true));

	return { registry, runner, states, services, saved, memory, tree };
}

export function deactivate(): void {}

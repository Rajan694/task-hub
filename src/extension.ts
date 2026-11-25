import * as vscode from 'vscode';
import { ArgMemory } from './args/prompt';
import { createDetectors } from './detectors';
import { GradleTaskCache } from './detectors/gradle';
import { Favorites } from './favorites';
import { Groups } from './groups';
import { CommandRegistry } from './registry';
import { Runner } from './runner/runner';
import { SavedStore } from './saved';
import { ServiceMonitor } from './services';
import { RunStateStore } from './state';
import { registerCommands } from './ui/commands';
import { registerStatusBar } from './ui/statusBar';
import { CommandsTreeProvider } from './ui/treeProvider';

/** Returned from activate() for the extension's own tests; not a stable API for other extensions. */
export interface TestApi {
	registry: CommandRegistry;
	runner: Runner;
	states: RunStateStore;
	services: ServiceMonitor;
	saved: SavedStore;
	favorites: Favorites;
	groups: Groups;
	gradleTasks: GradleTaskCache;
	memory: ArgMemory;
	tree: CommandsTreeProvider;
}

export function activate(context: vscode.ExtensionContext): TestApi {
	const log = vscode.window.createOutputChannel('Task Hub', { log: true });
	log.info(`Task Hub ${context.extension.packageJSON.version} activated`);

	const states = new RunStateStore(context.workspaceState);
	const runner = new Runner(states, log);
	const saved = new SavedStore(context.workspaceState);
	const memory = new ArgMemory(context.workspaceState);
	const gradleTasks = new GradleTaskCache(context.workspaceState);
	const registry = new CommandRegistry(createDetectors(saved, gradleTasks), log);
	const services = new ServiceMonitor(registry, log);
	const favorites = new Favorites(saved, registry);
	const groups = new Groups(saved, registry, runner, states);
	const tree = new CommandsTreeProvider(registry, states, services, favorites, groups);
	const view = vscode.window.createTreeView('taskHub.commands', { treeDataProvider: tree, showCollapseAll: true });
	services.setVisible(view.visible);

	context.subscriptions.push(
		log,
		states,
		runner,
		saved,
		registry,
		services,
		favorites,
		groups,
		tree,
		view,
		registerStatusBar(runner, states, registry),
		view.onDidChangeVisibility((e) => services.setVisible(e.visible)),
		...registerCommands({ registry, runner, states, services, saved, favorites, groups, gradleTasks, memory, log, extensionId: context.extension.id }),
	);

	// A progress bar on the view during the first scan; the "nothing found" text waits for it.
	void vscode.window
		.withProgress({ location: { viewId: 'taskHub.commands' } }, () => registry.ready)
		.then(() => vscode.commands.executeCommand('setContext', 'taskHub.scanned', true));

	return { registry, runner, states, services, saved, favorites, groups, gradleTasks, memory, tree };
}

export function deactivate(): void {}

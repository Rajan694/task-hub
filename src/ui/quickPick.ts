import * as vscode from 'vscode';
import type { Favorites } from '../favorites';
import type { Groups, RunGroup } from '../groups';
import { statusText } from '../format';
import type { HubCommand, RunState, RunStatus } from '../model';
import type { CommandRegistry } from '../registry';
import type { Runner } from '../runner/runner';
import type { RunStateStore } from '../state';

/** How many recently run commands get their own section. */
const RECENT = 5;

export interface QuickRunDeps {
	registry: CommandRegistry;
	runner: Runner;
	states: RunStateStore;
	favorites: Favorites;
	groups: Groups;
}

/** What the quick pick can ask the rest of Task Hub to do. */
export interface QuickRunActions {
	run(command: HubCommand, how?: 'run' | 'withArgs' | 'restart'): unknown;
	stop(command: HubCommand): unknown;
	showOutput(command: HubCommand): unknown;
	openUrl(command: HubCommand): unknown;
	runGroup(group: RunGroup): unknown;
	stopGroup(group: RunGroup): unknown;
}

export interface Section {
	label: string;
	commands: HubCommand[];
}

/**
 * The quick pick's sections, each command in the first one it belongs to: Running, Favorites,
 * Recent (the last commands run), then every heading of the sidebar.
 */
export function quickRunSections({ registry, runner, states, favorites }: QuickRunDeps): Section[] {
	const shown = new Set<string>();
	const take = (commands: readonly (HubCommand | undefined)[]) =>
		commands.filter((c): c is HubCommand => {
			if (!c || shown.has(c.key)) {
				return false;
			}
			shown.add(c.key);
			return true;
		});
	const sections: Section[] = [
		{ label: 'Running', commands: take(runner.runningCommands()) },
		{ label: 'Favorites', commands: take(favorites.commands()) },
		{
			label: 'Recent',
			commands: take(
				states
					.recent()
					.map(({ key }) => registry.get(key))
					.filter((c) => c !== undefined)
					.slice(0, RECENT),
			),
		},
	];
	const groups = new Map<string, Section>();
	for (const command of registry.all()) {
		const id = `${command.folder.uri.toString()}#${command.group.id}`;
		let section = groups.get(id);
		if (!section) {
			section = { label: command.group.label, commands: [] };
			groups.set(id, section);
		}
		section.commands.push(...take([command]));
	}
	return [...sections, ...groups.values()].filter((s) => s.commands.length);
}

interface CommandItem extends vscode.QuickPickItem {
	command?: HubCommand;
	group?: RunGroup;
	stopAll?: boolean;
}

const BUTTONS = {
	stop: { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: 'Stop' },
	restart: { iconPath: new vscode.ThemeIcon('debug-restart'), tooltip: 'Restart' },
	output: { iconPath: new vscode.ThemeIcon('output'), tooltip: 'Show Output' },
	withArgs: { iconPath: new vscode.ThemeIcon('symbol-parameter'), tooltip: 'Run with Arguments…' },
};

const ICONS: Record<RunStatus, string> = {
	idle: 'play',
	running: 'sync~spin',
	ready: 'sync~spin',
	passed: 'pass',
	failed: 'error',
	stopped: 'debug-stop',
};

/**
 * Task Hub: Run Command… — every command in one searchable list. Enter runs a command; on a
 * running one it offers Stop, Restart, Show Output and Open in Browser. The row buttons do
 * the same without leaving the list.
 */
export function showQuickRun(deps: QuickRunDeps, actions: QuickRunActions): void {
	const pick = vscode.window.createQuickPick<CommandItem>();
	pick.title = 'Task Hub';
	pick.placeholder = 'Run a command (type to search; running commands can be stopped)';
	pick.matchOnDescription = true;

	const render = () => {
		const items: CommandItem[] = [];
		const running = deps.runner.runningCommands().length;
		if (running > 1) {
			items.push({ label: `$(debug-stop) Stop All (${running})`, stopAll: true, alwaysShow: true });
		}
		const sections = quickRunSections(deps);
		// Groups go after Running and Favorites.
		const groupsAt = sections.findIndex((s) => s.label !== 'Running' && s.label !== 'Favorites');
		sections.forEach((section, index) => {
			if (index === groupsAt) {
				pushGroups(items, deps);
			}
			items.push({ label: section.label, kind: vscode.QuickPickItemKind.Separator });
			for (const command of section.commands) {
				items.push(itemFor(command, deps.states.get(command.key), deps.runner.isRunning(command.key)));
			}
		});
		if (groupsAt < 0) {
			pushGroups(items, deps);
		}
		const active = pick.activeItems[0]?.command?.key;
		pick.items = items;
		const again = items.find((i) => i.command?.key === active);
		if (again) {
			pick.activeItems = [again];
		}
	};
	render();
	const updates = vscode.Disposable.from(
		deps.states.onDidChange(() => render()),
		deps.groups.onDidChange(() => render()),
	);

	pick.onDidTriggerItemButton(({ item, button }) => {
		const command = item.command;
		if (!command) {
			return;
		}
		if (button === BUTTONS.stop) {
			void actions.stop(command);
		} else if (button === BUTTONS.restart) {
			void actions.run(command, 'restart');
		} else if (button === BUTTONS.output) {
			pick.hide();
			void actions.showOutput(command);
		} else if (button === BUTTONS.withArgs) {
			pick.hide();
			void actions.run(command, 'withArgs');
		}
	});
	pick.onDidAccept(() => {
		const item = pick.selectedItems[0];
		pick.hide();
		if (item?.stopAll) {
			for (const command of deps.runner.runningCommands()) {
				void actions.stop(command);
			}
		} else if (item?.group) {
			void (deps.groups.isRunning(item.group.key) ? actions.stopGroup(item.group) : actions.runGroup(item.group));
		} else if (item?.command) {
			if (deps.runner.isRunning(item.command.key)) {
				void runningMenu(item.command, deps, actions);
			} else {
				void actions.run(item.command);
			}
		}
	});
	pick.onDidHide(() => {
		updates.dispose();
		pick.dispose();
	});
	pick.show();
}

/** One item per group: Enter runs it, or stops it while it runs. */
function pushGroups(items: CommandItem[], { groups }: QuickRunDeps): void {
	if (!groups.all().length) {
		return;
	}
	items.push({ label: 'Groups', kind: vscode.QuickPickItemKind.Separator });
	for (const group of groups.all()) {
		const running = groups.isRunning(group.key);
		const names = group.def.steps.map((step) => groups.stepCommand(group, step)?.label ?? step.run).join(' → ');
		items.push({
			label: `$(${running ? 'debug-stop' : 'run-all'}) ${group.def.label}`,
			description: running ? `running — Enter stops it · ${names}` : names,
			group,
		});
	}
}

function itemFor(command: HubCommand, state: RunState, isRunning: boolean): CommandItem {
	const status = statusText(state);
	const buttons = isRunning
		? [BUTTONS.stop, BUTTONS.restart, ...(command.vscodeTask ? [] : [BUTTONS.output])]
		: [...(command.acceptsArgs ? [BUTTONS.withArgs] : []), ...(state.status !== 'idle' && !command.vscodeTask ? [BUTTONS.output] : [])];
	return {
		label: `$(${ICONS[state.status]}) ${command.label}`,
		description: [command.group.label, status].filter(Boolean).join(' · '),
		detail: undefined,
		command,
		buttons,
	};
}

async function runningMenu(command: HubCommand, deps: QuickRunDeps, actions: QuickRunActions): Promise<void> {
	const url = deps.states.get(command.key).url;
	const choices = [
		{ label: '$(debug-stop) Stop', run: () => actions.stop(command) },
		{ label: '$(debug-restart) Restart', run: () => actions.run(command, 'restart') },
		{ label: '$(output) Show Output', run: () => actions.showOutput(command) },
		...(url ? [{ label: `$(globe) Open ${url}`, run: () => actions.openUrl(command) }] : []),
	];
	const choice = await vscode.window.showQuickPick(choices, { title: `${command.group.label} › ${command.label} is running` });
	await choice?.run();
}

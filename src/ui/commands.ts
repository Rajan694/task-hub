import * as path from 'path';
import * as vscode from 'vscode';
import { ArgMemory, askExtraArgs, askForArgs } from '../args/prompt';
import { readSettings } from '../config';
import { isLongRunning } from '../detectors/common';
import type { GradleTaskCache } from '../detectors/gradle';
import type { Favorites } from '../favorites';
import type { Groups } from '../groups';
import { failureReason, formatDuration } from '../format';
import type { HubCommand } from '../model';
import type { CommandRegistry } from '../registry';
import { stripAnsi } from '../runner/outputWatcher';
import type { Runner } from '../runner/runner';
import { SavedStore } from '../saved';
import type { ServiceMonitor } from '../services';
import { quoteArg } from '../shell';
import type { RunStateStore } from '../state';
import { registerGroupCommands } from './groupCommands';
import { showQuickRun } from './quickPick';
import type { TreeNode } from './treeProvider';

interface Deps {
	registry: CommandRegistry;
	runner: Runner;
	states: RunStateStore;
	services: ServiceMonitor;
	saved: SavedStore;
	favorites: Favorites;
	groups: Groups;
	gradleTasks: GradleTaskCache;
	memory: ArgMemory;
	log: vscode.LogOutputChannel;
	extensionId: string;
}

/** Commands run code from the workspace, so Restricted Mode blocks them. */
function trusted(): boolean {
	if (vscode.workspace.isTrusted) {
		return true;
	}
	void vscode.window
		.showWarningMessage(
			'Task Hub does not run commands in Restricted Mode, because running them executes code from this workspace.',
			'Manage Workspace Trust',
		)
		.then((choice) => choice && vscode.commands.executeCommand('workbench.trust.manage'));
	return false;
}

const UNAVAILABLE_HELP: Record<string, string> = {
	'needs bash': 'Install Git for Windows (it includes Git Bash) or WSL, then reload the window.',
	'needs pwsh': 'Install PowerShell 7 (https://aka.ms/powershell), then reload the window.',
};

type How = 'run' | 'withArgs' | 'again' | 'restart';

export function registerCommands(deps: Deps): vscode.Disposable[] {
	const { registry, runner, states, services, saved, favorites, groups, memory, extensionId } = deps;

	/** Asks for arguments when the command takes them, then starts it. Returns whether it started. */
	const start = async (command: HubCommand, how: How = 'run'): Promise<boolean> => {
		if (!trusted()) {
			return false;
		}
		if (command.unavailable) {
			void vscode.window.showErrorMessage(`${command.label} ${command.unavailable}. ${UNAVAILABLE_HELP[command.unavailable] ?? ''}`.trim());
			return false;
		}
		if (how === 'restart') {
			void runner.restart(command);
		} else {
			const args =
				how === 'again'
					? (runner.lastArgs(command.key) ?? [])
					: how === 'withArgs'
						? await askExtraArgs(command, memory)
						: await askForArgs(command, memory);
			if (args === undefined) {
				return false; // Escape: nothing runs.
			}
			void runner.run(command, { args });
		}
		if (readSettings(command.folder.uri).revealTerminal === 'always') {
			runner.showOutput(command, true);
		}
		return true;
	};

	const onCommand = (id: string, handler: (command: HubCommand, node: TreeNode) => unknown) =>
		vscode.commands.registerCommand(id, (node?: TreeNode) => (node?.kind === 'command' ? handler(node.command, node) : undefined));

	const openUrl = async (command: HubCommand) => {
		const url = states.get(command.key).url;
		if (!url) {
			return;
		}
		if (readSettings(command.folder.uri).openUrlIn === 'simpleBrowser') {
			await vscode.commands.executeCommand('simpleBrowser.show', url);
		} else {
			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	};

	return [
		onCommand('taskHub.run', (command) => start(command)),
		onCommand('taskHub.runWithArgs', (command) => start(command, 'withArgs')),
		onCommand('taskHub.stop', (command) => runner.stop(command.key)),
		onCommand('taskHub.restart', (command) => start(command, 'restart')),
		onCommand('taskHub.showOutput', (command) => runner.showOutput(command)),
		onCommand('taskHub.openUrl', openUrl),
		onCommand('taskHub.addFavorite', (command) => favorites.set(command, true)),
		onCommand('taskHub.removeFavorite', (command) => favorites.set(command, false)),
		vscode.commands.registerCommand('taskHub.quickRun', async () => {
			await registry.ready;
			showQuickRun(
				{ registry, runner, states, favorites, groups },
				{
					run: (command, how) => start(command, how),
					stop: (command) => runner.stop(command.key),
					showOutput: (command) => runner.showOutput(command),
					openUrl,
					runGroup: (group) => trusted() && groups.run(group.key),
					stopGroup: (group) => groups.stop(group.key),
				},
			);
		}),
		vscode.commands.registerCommand('taskHub.stopAll', () => Promise.all(runner.runningCommands().map((c) => runner.stop(c.key)))),
		onCommand('taskHub.copyCommand', async (command) => {
			const args = runner.lastArgs(command.key) ?? [];
			const line = [command.commandLine, ...args.map((a) => quoteArg(a))].join(' ');
			await vscode.env.clipboard.writeText(line);
			vscode.window.setStatusBarMessage(`Copied: ${line}`, 3000);
		}),
		onCommand('taskHub.serviceLogs', (command) => {
			if (trusted()) {
				void runner.runAction(command, 'logs');
			}
		}),
		onCommand('taskHub.serviceStop', (command) => {
			if (trusted()) {
				void runner.runAction(command, 'stop');
			}
		}),
		onCommand('taskHub.saveAsCommand', (command) => saveAsCommand(command, runner, saved, registry)),
		onCommand('taskHub.deleteSavedCommand', async (command) => {
			if (!command.savedId) {
				return;
			}
			const where = saved.isPrivate(command.folder) ? 'this machine' : '.vscode/task-hub.json';
			const choice = await vscode.window.showWarningMessage(`Delete the saved command "${command.label}" from ${where}?`, { modal: true }, 'Delete');
			if (choice === 'Delete') {
				await saved.remove(command.folder, command.savedId);
				await registry.scan();
			}
		}),
		vscode.commands.registerCommand('taskHub.goToDefinition', async (node?: TreeNode) => {
			if (node?.kind === 'runGroup' && node.runGroup.file) {
				const line = node.runGroup.def.line ?? 0;
				await vscode.window.showTextDocument(node.runGroup.file, { selection: new vscode.Range(line, 0, line, 0) });
			} else if (node?.kind === 'group' && node.group.definedAt) {
				await vscode.window.showTextDocument(node.group.definedAt);
			} else if (node?.kind === 'command' && node.command.definedAt) {
				const { uri, range } = node.command.definedAt;
				await vscode.window.showTextDocument(uri, { selection: range });
			}
		}),
		vscode.commands.registerCommand('taskHub.addCommand', () => addCommand(saved, registry)),
		...registerGroupCommands({ ...deps, trusted }),
		vscode.commands.registerCommand('taskHub.refresh', async () => {
			await registry.scan();
			await services.refresh();
		}),
		vscode.commands.registerCommand('taskHub.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`),
		),

		runner.onDidFinish(({ command, state }) => {
			const settings = readSettings(command.folder.uri);
			const name = `${command.group.label} › ${command.label}`;
			if (state.status === 'failed') {
				if (settings.revealTerminal === 'onFailure') {
					runner.showOutput(command, true);
				}
				if (isExecutionPolicyError(command, runner.outputText(command.key))) {
					void offerExecutionPolicyBypass(command, runner);
				} else if (settings.notify !== 'never') {
					void vscode.window
						.showErrorMessage(`${name} failed (${failureReason(state)})`, 'Show Output', 'Run Again')
						.then((choice) => {
							if (choice === 'Show Output') {
								runner.showOutput(command);
							} else if (choice === 'Run Again') {
								void start(registry.get(command.key) ?? command, 'again');
							}
						});
				}
			} else if (state.status === 'passed' && settings.notify === 'all') {
				const took = formatDuration((state.endedAt ?? 0) - (state.startedAt ?? 0));
				void vscode.window.showInformationMessage(`${name} passed in ${took}`, 'Show Output').then((choice) => {
					if (choice) {
						runner.showOutput(command);
					}
				});
			}
			if (command.source === 'compose') {
				void services.refresh();
			}
		}),
	];
}

/** The + button: saves a new command for this project. */
async function addCommand(saved: SavedStore, registry: CommandRegistry): Promise<void> {
	const folder =
		(vscode.workspace.workspaceFolders?.length ?? 0) > 1
			? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Save the command for which folder?' })
			: vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return;
	}
	const command = await vscode.window.showInputBox({
		title: 'Add Command (1/2)',
		prompt: 'The command line to run, from the workspace folder',
		placeHolder: 'python manage.py runserver',
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? undefined : 'Type a command'),
	});
	if (!command) {
		return;
	}
	const label = await vscode.window.showInputBox({
		title: 'Add Command (2/2)',
		prompt: 'A name for the sidebar',
		value: command.trim(),
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? undefined : 'Type a name'),
	});
	if (!label) {
		return;
	}
	await saveAndReport(saved, registry, folder, { label: label.trim(), command: command.trim() });
}

/** Save as Command: the command with its last arguments, under a name, in "My commands". */
async function saveAsCommand(command: HubCommand, runner: Runner, saved: SavedStore, registry: CommandRegistry): Promise<void> {
	const args = runner.lastArgs(command.key) ?? [];
	const line = [command.commandLine, ...args.map((a) => quoteArg(a))].join(' ');
	const label = await vscode.window.showInputBox({
		title: 'Save as Command',
		prompt: `A name for: ${line}`,
		value: [command.label, ...args].join(' '),
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? undefined : 'Type a name'),
	});
	if (!label) {
		return;
	}
	const cwd = path.relative(command.folder.uri.fsPath, command.cwd.fsPath).split(path.sep).join('/');
	const settings = readSettings(command.folder.uri);
	await saveAndReport(saved, registry, command.folder, {
		label: label.trim(),
		command: line,
		cwd: cwd || undefined,
		longRunning: command.longRunning && !isLongRunning(label, settings.longRunningNames) ? true : undefined,
	});
}

async function saveAndReport(
	saved: SavedStore,
	registry: CommandRegistry,
	folder: vscode.WorkspaceFolder,
	command: Parameters<SavedStore['add']>[1],
): Promise<void> {
	await saved.add(folder, command);
	await registry.scan();
	if (saved.isPrivate(folder)) {
		void vscode.window.showInformationMessage(`Saved "${command.label}" on this machine.`);
		return;
	}
	const choice = await vscode.window.showInformationMessage(`Saved "${command.label}" to .vscode/task-hub.json.`, 'Open File');
	if (choice) {
		await vscode.window.showTextDocument(SavedStore.fileOf(folder));
	}
}

function isExecutionPolicyError(command: HubCommand, output: string): boolean {
	return (
		command.source === 'script' &&
		/\.ps1$/i.test(command.label) &&
		!!command.exec &&
		!command.exec.args.includes('Bypass') &&
		/execution polic|running scripts is disabled/i.test(stripAnsi(output))
	);
}

/** PowerShell refused the script: offer to run it once with -ExecutionPolicy Bypass. */
async function offerExecutionPolicyBypass(command: HubCommand, runner: Runner): Promise<void> {
	const choice = await vscode.window.showErrorMessage(
		`${command.label} was blocked by PowerShell's execution policy.`,
		'Run Once with Bypass',
		'Show Output',
	);
	if (choice === 'Show Output') {
		runner.showOutput(command);
	} else if (choice === 'Run Once with Bypass' && command.exec) {
		const [, ...rest] = command.exec.args; // drop -NoProfile, put it back first
		const exec = { file: command.exec.file, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...rest] };
		const bypass: HubCommand = {
			...command,
			exec,
			commandLine: [path.basename(exec.file).replace(/\.exe$/i, ''), ...exec.args].map((a) => quoteArg(a)).join(' '),
		};
		void runner.run(bypass, { args: runner.lastArgs(command.key) });
	}
}

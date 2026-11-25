import * as vscode from 'vscode';
import { readSettings } from '../config';
import { failureReason, formatDuration } from '../format';
import type { HubCommand } from '../model';
import type { CommandRegistry } from '../registry';
import type { Runner } from '../runner/runner';
import type { RunStateStore } from '../state';
import type { TreeNode } from './treeProvider';

interface Deps {
	registry: CommandRegistry;
	runner: Runner;
	states: RunStateStore;
	extensionId: string;
}

/** Commands that are declared in package.json but arrive with a later milestone (docs/DESIGN.md, "Milestones"). */
const PLANNED: Record<string, string> = {
	'taskHub.addCommand': 'Saved commands arrive in version 0.2.',
	'taskHub.quickRun': 'The quick-pick runner arrives in version 0.3.',
};

export function registerCommands({ registry, runner, states, extensionId }: Deps): vscode.Disposable[] {
	/** Runs a command unless the workspace is in Restricted Mode. Returns whether it started. */
	const start = (command: HubCommand, how: 'run' | 'restart' = 'run'): boolean => {
		if (!vscode.workspace.isTrusted) {
			void vscode.window
				.showWarningMessage(
					'Task Hub does not run commands in Restricted Mode, because running them executes code from this workspace.',
					'Manage Workspace Trust',
				)
				.then((choice) => choice && vscode.commands.executeCommand('workbench.trust.manage'));
			return false;
		}
		if (how === 'restart') {
			void runner.restart(command);
		} else {
			void runner.run(command);
		}
		if (readSettings(command.folder.uri).revealTerminal === 'always') {
			runner.showOutput(command, true);
		}
		return true;
	};

	return [
		vscode.commands.registerCommand('taskHub.run', (node?: TreeNode) => {
			const command = commandOf(node);
			if (command) {
				start(command);
			}
		}),
		vscode.commands.registerCommand('taskHub.stop', (node?: TreeNode) => {
			const command = commandOf(node);
			if (command) {
				void runner.stop(command.key);
			}
		}),
		vscode.commands.registerCommand('taskHub.restart', (node?: TreeNode) => {
			const command = commandOf(node);
			if (command) {
				start(command, 'restart');
			}
		}),
		vscode.commands.registerCommand('taskHub.showOutput', (node?: TreeNode) => {
			const command = commandOf(node);
			if (command) {
				runner.showOutput(command);
			}
		}),
		vscode.commands.registerCommand('taskHub.openUrl', async (node?: TreeNode) => {
			const command = commandOf(node);
			const url = command && states.get(command.key).url;
			if (!command || !url) {
				return;
			}
			if (readSettings(command.folder.uri).openUrlIn === 'simpleBrowser') {
				await vscode.commands.executeCommand('simpleBrowser.show', url);
			} else {
				await vscode.env.openExternal(vscode.Uri.parse(url));
			}
		}),
		vscode.commands.registerCommand('taskHub.goToDefinition', async (node?: TreeNode) => {
			if (node?.kind === 'group' && node.group.definedAt) {
				await vscode.window.showTextDocument(node.group.definedAt);
			} else if (node?.kind === 'command' && node.command.definedAt) {
				const { uri, range } = node.command.definedAt;
				await vscode.window.showTextDocument(uri, { selection: range });
			}
		}),
		vscode.commands.registerCommand('taskHub.copyCommand', async (node?: TreeNode) => {
			const command = commandOf(node);
			if (command) {
				await vscode.env.clipboard.writeText(command.commandLine);
				vscode.window.setStatusBarMessage(`Copied: ${command.commandLine}`, 3000);
			}
		}),
		vscode.commands.registerCommand('taskHub.refresh', () => registry.scan()),
		vscode.commands.registerCommand('taskHub.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`),
		),
		...Object.entries(PLANNED).map(([id, message]) =>
			vscode.commands.registerCommand(id, () => vscode.window.showInformationMessage(`Task Hub: ${message}`)),
		),

		runner.onDidFinish(({ command, state }) => {
			const settings = readSettings(command.folder.uri);
			const name = `${command.group.label} › ${command.label}`;
			if (state.status === 'failed') {
				if (settings.revealTerminal === 'onFailure') {
					runner.showOutput(command, true);
				}
				if (settings.notify !== 'never') {
					void vscode.window
						.showErrorMessage(`${name} failed (${failureReason(state)})`, 'Show Output', 'Run Again')
						.then((choice) => {
							if (choice === 'Show Output') {
								runner.showOutput(command);
							} else if (choice === 'Run Again') {
								start(registry.get(command.key) ?? command);
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
		}),
	];
}

function commandOf(node: TreeNode | undefined): HubCommand | undefined {
	return node?.kind === 'command' ? node.command : undefined;
}

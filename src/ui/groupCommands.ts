import { exec } from 'child_process';
import * as vscode from 'vscode';
import { parseGradleTasks, type GradleTaskCache } from '../detectors/gradle';
import { defaultWaitFor, type Groups } from '../groups';
import type { CommandGroup, HubCommand } from '../model';
import type { CommandRegistry } from '../registry';
import type { Runner } from '../runner/runner';
import type { GroupStep, SavedStore, WaitFor } from '../saved';
import type { TreeNode } from './treeProvider';

interface Deps {
	groups: Groups;
	registry: CommandRegistry;
	runner: Runner;
	saved: SavedStore;
	gradleTasks: GradleTaskCache;
	log: vscode.LogOutputChannel;
	/** Whether commands may run (not in Restricted Mode); explains why not when they can't. */
	trusted(): boolean;
}

export function registerGroupCommands({ groups, registry, runner, saved, gradleTasks, log, trusted }: Deps): vscode.Disposable[] {
	const groupOf = (node?: TreeNode) => (node?.kind === 'runGroup' ? node.runGroup : undefined);
	return [
		vscode.commands.registerCommand('taskHub.runGroup', (node?: TreeNode) => {
			const group = groupOf(node);
			if (group && trusted()) {
				void groups.run(group.key);
			}
		}),
		vscode.commands.registerCommand('taskHub.stopGroup', (node?: TreeNode) => {
			const group = groupOf(node);
			if (group) {
				void groups.stop(group.key);
			}
		}),
		vscode.commands.registerCommand('taskHub.deleteGroup', async (node?: TreeNode) => {
			const group = groupOf(node);
			if (!group) {
				return;
			}
			const where = group.file ? '.vscode/task-hub.json' : 'this machine';
			const choice = await vscode.window.showWarningMessage(`Delete the group "${group.def.label}" from ${where}?`, { modal: true }, 'Delete');
			if (choice === 'Delete') {
				await saved.removeGroup(group.folder, group.def.id);
			}
		}),
		vscode.commands.registerCommand('taskHub.addToGroup', (node?: TreeNode) => {
			if (node?.kind === 'command') {
				return addToGroup(node.command, groups, saved);
			}
			return undefined;
		}),
		vscode.commands.registerCommand('taskHub.loadAllTasks', async (node?: TreeNode) => {
			const load = node?.kind === 'group' ? node.group.loadAllTasks : undefined;
			if (!load || !trusted()) {
				return;
			}
			await loadAllTasks(node!.kind === 'group' ? node!.group.label : '', load, gradleTasks, registry, log);
		}),

		groups.onDidFinish(({ group, state }) => {
			if (state.status !== 'failed') {
				return;
			}
			const step = group.def.steps[state.step ?? 0];
			const command = step && groups.stepCommand(group, step);
			void vscode.window
				.showErrorMessage(`${group.def.label} stopped at step ${(state.step ?? 0) + 1}: ${state.message}`, ...(command ? ['Show Output'] : []), 'Run Again')
				.then((choice) => {
					if (choice === 'Show Output' && command) {
						runner.showOutput(command);
					} else if (choice === 'Run Again' && trusted()) {
						void groups.run(group.key);
					}
				});
		}),
	];
}

interface Choice<T> extends vscode.QuickPickItem {
	value: T;
}

/** Add to Group…: pick a group (or name a new one) and what to wait for, then append the step. */
async function addToGroup(command: HubCommand, groups: Groups, saved: SavedStore): Promise<void> {
	const existing = groups.all().filter((g) => g.folder.uri.toString() === command.folder.uri.toString());
	const target = await vscode.window.showQuickPick<Choice<{ id: string } | undefined>>(
		[
			...existing.map((g) => ({ label: g.def.label, description: `${g.def.steps.length} step${g.def.steps.length === 1 ? '' : 's'}`, value: { id: g.def.id } })),
			{ label: '$(add) New Group…', value: undefined },
		],
		{ title: `Add ${command.label} to a group`, placeHolder: 'Groups start their commands in order with one click' },
	);
	if (!target) {
		return;
	}
	let group: { id: string } | { label: string } | undefined = target.value;
	if (!group) {
		const label = await vscode.window.showInputBox({
			title: 'New Group',
			prompt: 'A name for the group',
			placeHolder: 'Start everything',
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim() ? undefined : 'Type a name'),
		});
		if (!label) {
			return;
		}
		group = { label: label.trim() };
	}

	const fallback = defaultWaitFor(command);
	const options: Choice<WaitFor>[] = [
		{ label: 'Wait until it finishes', description: 'exit — for one-shot steps like a migration; it must exit with code 0', value: 'exit' },
		{ label: 'Wait until it is ready', description: 'ready — a dev server: until it prints a local URL', value: 'ready' },
		{ label: 'Just start it', description: 'running — go on once it has started', value: 'running' },
	];
	options.sort((a, b) => (a.value === fallback ? -1 : b.value === fallback ? 1 : 0));
	options[0].description += ' (usual for this command)';
	const waitFor = await vscode.window.showQuickPick(options, { title: `Before the next step starts, ${command.label} should…` });
	if (!waitFor) {
		return;
	}
	const step: GroupStep = { run: command.id };
	if (waitFor.value !== fallback) {
		step.waitFor = waitFor.value;
	}
	await saved.addStep(command.folder, group, step);
	const name = 'label' in group ? group.label : existing.find((g) => g.def.id === (group as { id: string }).id)?.def.label;
	vscode.window.setStatusBarMessage(`Added ${command.label} to ${name}`, 3000);
}

/** Load All Tasks: asks Gradle for the project's whole task list once, and keeps it until a build file changes. */
async function loadAllTasks(
	label: string,
	load: NonNullable<CommandGroup['loadAllTasks']>,
	cache: GradleTaskCache,
	registry: CommandRegistry,
	log: vscode.LogOutputChannel,
): Promise<void> {
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Loading Gradle tasks for ${label}…`, cancellable: true },
		(_progress, token) =>
			new Promise<void>((resolve) => {
				log.info(`Load all tasks: ${load.commandLine} (in ${load.cwd})`);
				const child = exec(load.commandLine, { cwd: load.cwd, timeout: 10 * 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, async (error, stdout, stderr) => {
					const tasks = parseGradleTasks(stdout);
					if (error || !tasks.length) {
						if (!token.isCancellationRequested) {
							log.error(`Load all tasks failed: ${error?.message ?? 'no tasks in the output'}\n${stderr}`);
							void vscode.window.showErrorMessage(`Couldn't load the Gradle tasks of ${label}. See the Task Hub output for details.`);
						}
					} else {
						await cache.set(load.cacheKey, load.signature, tasks);
						await registry.scan();
					}
					resolve();
				});
				token.onCancellationRequested(() => child.kill());
			}),
	);
}

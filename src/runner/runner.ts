import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import { failureReason, formatDuration } from '../format';
import type { CommandAction, HubCommand, RunState } from '../model';
import { quoteArg } from '../shell';
import type { RunStateStore } from '../state';
import { CommandOutput, LineInput } from './hubPty';
import { isAlive, killTree } from './killTree';
import { OutputWatcher } from './outputWatcher';

/** After Stop sends SIGTERM, wait this long before SIGKILL. */
const KILL_GRACE_MS = 5000;

/** After the process exits, wait this long for the rest of its output before finishing. */
const CLOSE_GRACE_MS = 300;

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

interface ActiveRun {
	readonly command: HubCommand;
	stopRequested: boolean;
	readonly done: Promise<RunState>;
	/** Ends the run: the process tree, or the VS Code task. */
	kill(): void;
	readonly input?: LineInput;
}

/** How a run ended, before it becomes a RunState. */
interface Outcome {
	exitCode?: number | null;
	signal?: string | null;
	error?: Error;
}

export interface RunOptions {
	/** Arguments after the command line, e.g. the answers to a script's prompts. */
	args?: readonly string[];
}

export interface FinishedRun {
	command: HubCommand;
	state: RunState;
}

/**
 * Starts, stops and restarts commands. Each command runs as a child process in its own
 * folder; its output goes to a terminal that is only created when the user asks to see it.
 * Tasks from .vscode/tasks.json are handed to VS Code's task system instead.
 */
export class Runner implements vscode.Disposable {
	private readonly active = new Map<string, ActiveRun>();
	private readonly outputs = new Map<string, CommandOutput>();
	private readonly lastArgsByKey = new Map<string, readonly string[]>();
	private readonly finished = new vscode.EventEmitter<FinishedRun>();
	/** Fires when a run ends: passed, failed or stopped. */
	readonly onDidFinish = this.finished.event;

	constructor(
		private readonly states: RunStateStore,
		private readonly log: vscode.LogOutputChannel,
	) {}

	isRunning(key: string): boolean {
		return this.active.has(key);
	}

	/** The arguments of the command's last run, reused by Restart and Run Again. */
	lastArgs(key: string): readonly string[] | undefined {
		return this.lastArgsByKey.get(key);
	}

	/**
	 * Starts a command and resolves with its final state when it ends. A command that is
	 * already running isn't started twice: the call waits for the current run instead.
	 */
	run(command: HubCommand, options: RunOptions = {}): Promise<RunState> {
		const current = this.active.get(command.key);
		if (current) {
			return current.done;
		}
		const args = options.args ?? [];
		this.lastArgsByKey.set(command.key, args);
		const startedAt = Date.now();
		this.states.set(command.key, { status: 'running', startedAt });

		let resolveDone!: (state: RunState) => void;
		const done = new Promise<RunState>((resolve) => (resolveDone = resolve));
		let ended = false;
		const finish = (run: ActiveRun, outcome: Outcome, output?: CommandOutput) => {
			if (ended) {
				return;
			}
			ended = true;
			if (this.active.get(command.key) === run) {
				this.active.delete(command.key);
			}
			const state = this.toState(run, outcome, startedAt);
			const took = formatDuration((state.endedAt ?? startedAt) - startedAt);
			output?.append(`\r\n${summaryLine(state, took)}\r\n`);
			this.log.info(`${command.id} ${state.status}${state.status === 'failed' ? ` (${failureReason(state)})` : ''} after ${took}`);
			this.states.set(command.key, state);
			this.finished.fire({ command, state });
			resolveDone(state);
		};

		const run = command.vscodeTask
			? this.startTask(command, done, finish)
			: this.startProcess(command, args, done, finish);
		this.active.set(command.key, run);
		return done;
	}

	/** Runs one of the command's actions (a compose service's Logs or Stop) as a command of its own. */
	runAction(command: HubCommand, actionId: CommandAction['id']): Promise<RunState> | undefined {
		const action = command.actions?.find((a) => a.id === actionId);
		if (!action) {
			return undefined;
		}
		const derived = actionCommand(command, action);
		const done = this.run(derived);
		if (action.id === 'logs') {
			this.showOutput(derived, true);
		}
		return done;
	}

	/** Stops a running command and everything it started. Resolves with its final state. */
	stop(key: string): Promise<RunState | undefined> {
		const run = this.active.get(key);
		if (!run) {
			return Promise.resolve(undefined);
		}
		if (!run.stopRequested) {
			run.stopRequested = true;
			this.log.info(`Stop ${run.command.id}`);
			run.kill();
		}
		return run.done;
	}

	/** Stops the command if it runs, then starts it again with the same arguments. Resolves once it has started. */
	async restart(command: HubCommand): Promise<void> {
		await this.stop(command.key);
		void this.run(command, { args: this.lastArgs(command.key) });
	}

	/** Opens the command's terminal. */
	showOutput(command: HubCommand, preserveFocus = false): void {
		if (command.vscodeTask) {
			const { label } = command.vscodeTask;
			// VS Code names a task's terminal after the task ("build", or "build (api)" in a multi-root window).
			const terminal = vscode.window.terminals.find((t) => t.name === label || t.name.startsWith(`${label} (`));
			if (terminal) {
				terminal.show(preserveFocus);
			} else {
				void vscode.window.showInformationMessage(`The terminal of task "${label}" is closed. Run the task to see its output.`);
			}
			return;
		}
		this.outputFor(command).show(preserveFocus);
	}

	/** Passes what the user typed in a command's terminal to its process. */
	sendInput(key: string, data: string): void {
		this.active.get(key)?.input?.feed(data);
	}

	/** Everything the command printed in its last run. */
	outputText(key: string): string {
		return this.outputs.get(key)?.text() ?? '';
	}

	/** Running commands. */
	runningCommands(): HubCommand[] {
		return [...this.active.values()].map((run) => run.command);
	}

	private toState(run: ActiveRun, outcome: Outcome, startedAt: number): RunState {
		const endedAt = Date.now();
		if (run.stopRequested) {
			return { status: 'stopped', startedAt, endedAt };
		}
		if (outcome.error) {
			return { status: 'failed', startedAt, endedAt, error: outcome.error.message };
		}
		if (outcome.exitCode === 0 || (outcome.exitCode === undefined && !outcome.signal)) {
			return { status: 'passed', startedAt, endedAt, exitCode: outcome.exitCode ?? undefined };
		}
		return { status: 'failed', startedAt, endedAt, exitCode: outcome.exitCode ?? undefined, signal: outcome.signal ?? undefined };
	}

	private startProcess(
		command: HubCommand,
		args: readonly string[],
		done: Promise<RunState>,
		finish: (run: ActiveRun, outcome: Outcome, output?: CommandOutput) => void,
	): ActiveRun {
		const output = this.outputFor(command);
		const line = [command.commandLine, ...args.map((a) => quoteArg(a))].join(' ');
		output.clear();
		output.append(`${DIM}> ${line}${RESET}\r\n${DIM}  in ${command.cwd.fsPath}${RESET}\r\n\r\n`);
		this.log.info(`Run ${command.id}: ${line} (in ${command.cwd.fsPath})`);

		if (command.unavailable) {
			const run: ActiveRun = { command, stopRequested: false, done, kill: () => undefined };
			queueMicrotask(() => finish(run, { error: new Error(command.unavailable) }, output));
			return run;
		}

		const options = {
			cwd: command.cwd.fsPath,
			// Its own process group on Linux and macOS, so Stop can end everything it starts.
			detached: process.platform !== 'win32',
			windowsHide: true,
			env: { ...process.env, FORCE_COLOR: '1' },
			stdio: 'pipe' as const,
		};
		const child = command.exec
			? spawn(command.exec.file, [...command.exec.args, ...args], { ...options, shell: false })
			: spawn(line, { ...options, shell: true });

		const watcher = new OutputWatcher((url) => {
			const state = this.states.get(command.key);
			if (state.status === 'running' && this.active.get(command.key) === run) {
				this.states.set(command.key, { ...state, status: 'ready', url });
				this.log.info(`${command.id} is ready${url ? ` at ${url}` : ''}`);
			}
		}, command.readyPattern);

		const forward = (stream: NodeJS.ReadableStream | null) => {
			const decoder = new StringDecoder('utf8');
			stream?.on('data', (chunk: Buffer) => {
				const text = decoder.write(chunk);
				if (text) {
					watcher.push(text);
					output.append(toTerminal(text));
				}
			});
			stream?.on('end', () => {
				const rest = decoder.end();
				if (rest) {
					output.append(toTerminal(rest));
				}
			});
		};
		forward(child.stdout);
		forward(child.stderr);
		child.stdin?.on('error', () => {
			// The process closed its input or exited; typed text has nowhere to go.
		});

		const run: ActiveRun = {
			command,
			stopRequested: false,
			done,
			input: new LineInput({
				echo: (text) => output.append(text),
				submit: (text) => {
					if (child.stdin?.writable) {
						child.stdin.write(`${text}\n`);
					}
				},
				interrupt: () => void this.stop(command.key),
			}),
			kill: () => {
				const pid = child.pid;
				if (pid === undefined) {
					return;
				}
				killTree(pid, 'SIGTERM');
				if (process.platform !== 'win32') {
					// Whatever ignored SIGTERM gets SIGKILL, even if the shell itself already exited.
					setTimeout(() => {
						if (isAlive(-pid) || isAlive(pid)) {
							killTree(pid, 'SIGKILL');
						}
					}, KILL_GRACE_MS).unref();
				}
			},
		};

		let exitCode: number | null = null;
		let signal: NodeJS.Signals | null = null;
		let closeTimer: NodeJS.Timeout | undefined;
		const end = (error?: Error) => {
			clearTimeout(closeTimer);
			finish(run, error ? { error } : { exitCode, signal }, output);
		};
		child.on('error', (error) => end(error));
		child.on('exit', (code, sig) => {
			exitCode = code;
			signal = sig;
			// Usually 'close' follows at once; a leftover background process may keep the pipes open, though.
			closeTimer = setTimeout(() => end(), CLOSE_GRACE_MS);
		});
		child.on('close', () => end());
		return run;
	}

	private startTask(
		command: HubCommand,
		done: Promise<RunState>,
		finish: (run: ActiveRun, outcome: Outcome) => void,
	): ActiveRun {
		const { label } = command.vscodeTask!;
		this.log.info(`Run ${command.id}: VS Code task "${label}"`);
		let execution: vscode.TaskExecution | undefined;
		let exitCode: number | undefined;
		const ours = (e: vscode.TaskExecution) =>
			execution ? e === execution : e.task.name === label && sameFolder(e.task.scope, command.folder);

		const listeners = [
			vscode.tasks.onDidEndTaskProcess((e) => {
				if (ours(e.execution)) {
					exitCode = e.exitCode;
				}
			}),
			vscode.tasks.onDidEndTask((e) => {
				if (ours(e.execution)) {
					end({ exitCode });
				}
			}),
		];
		const end = (outcome: Outcome) => {
			vscode.Disposable.from(...listeners).dispose();
			finish(run, outcome);
		};
		const run: ActiveRun = {
			command,
			stopRequested: false,
			done,
			kill: () => {
				if (execution) {
					execution.terminate();
				}
				// Not started yet: the start below sees stopRequested and doesn't run it.
			},
		};

		void (async () => {
			try {
				const task = (await vscode.tasks.fetchTasks()).find(
					(t) => t.source === 'Workspace' && t.name === label && sameFolder(t.scope, command.folder),
				);
				if (!task) {
					throw new Error(`no task "${label}" in .vscode/tasks.json`);
				}
				if (run.stopRequested) {
					end({});
					return;
				}
				execution = await vscode.tasks.executeTask(task);
				if (run.stopRequested) {
					execution.terminate();
				}
			} catch (error) {
				end({ error: error instanceof Error ? error : new Error(String(error)) });
			}
		})();
		return run;
	}

	private outputFor(command: HubCommand): CommandOutput {
		let output = this.outputs.get(command.key);
		if (!output) {
			output = new CommandOutput(`Task Hub: ${command.group.label} › ${command.label}`);
			output.onInput = (data) => this.sendInput(command.key, data);
			this.outputs.set(command.key, output);
		}
		return output;
	}

	dispose(): void {
		// Leaving VS Code (or reloading) must not leave dev servers running in the background.
		for (const run of this.active.values()) {
			run.stopRequested = true;
			run.kill();
		}
		this.active.clear();
		for (const output of this.outputs.values()) {
			output.dispose();
		}
		this.outputs.clear();
		this.finished.dispose();
	}
}

/** A command's action as a command of its own: own key, own output ("postgres logs"). */
export function actionCommand(command: HubCommand, action: CommandAction): HubCommand {
	return {
		...command,
		key: `${command.key}::${action.id}`,
		id: `${command.id}::${action.id}`,
		label: `${command.label} ${action.id}`,
		commandLine: action.commandLine,
		exec: undefined,
		longRunning: action.longRunning,
		args: undefined,
		freeArgs: undefined,
		actions: undefined,
		service: undefined,
	};
}

function summaryLine(state: RunState, took: string): string {
	switch (state.status) {
		case 'passed':
			return `${DIM}Passed in ${took}.${RESET}`;
		case 'stopped':
			return `${DIM}Stopped after ${took}.${RESET}`;
		default:
			return `${RED}Failed (${failureReason(state)}) after ${took}.${RESET}`;
	}
}

function sameFolder(scope: vscode.Task['scope'], folder: vscode.WorkspaceFolder): boolean {
	return typeof scope === 'object' && scope.uri.toString() === folder.uri.toString();
}

/** Terminals need \r\n; processes print \n. */
function toTerminal(text: string): string {
	return text.replace(/\r?\n/g, '\r\n');
}

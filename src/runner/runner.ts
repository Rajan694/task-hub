import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import { failureReason, formatDuration } from '../format';
import type { HubCommand, RunState } from '../model';
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
	readonly child: ChildProcess;
	readonly input: LineInput;
	stopRequested: boolean;
	readonly done: Promise<RunState>;
}

export interface FinishedRun {
	command: HubCommand;
	state: RunState;
}

/**
 * Starts, stops and restarts commands. Each command runs as a child process in its own
 * folder; its output goes to a terminal that is only created when the user asks to see it.
 */
export class Runner implements vscode.Disposable {
	private readonly active = new Map<string, ActiveRun>();
	private readonly outputs = new Map<string, CommandOutput>();
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

	/**
	 * Starts a command and resolves with its final state when it ends. A command that is
	 * already running isn't started twice: the call waits for the current run instead.
	 */
	run(command: HubCommand): Promise<RunState> {
		const current = this.active.get(command.key);
		if (current) {
			return current.done;
		}

		const output = this.outputFor(command);
		output.clear();
		output.append(`${DIM}> ${command.commandLine}${RESET}\r\n${DIM}  in ${command.cwd.fsPath}${RESET}\r\n\r\n`);
		const startedAt = Date.now();
		this.states.set(command.key, { status: 'running', startedAt });
		this.log.info(`Run ${command.id}: ${command.commandLine} (in ${command.cwd.fsPath})`);

		const child = spawn(command.commandLine, {
			cwd: command.cwd.fsPath,
			shell: true,
			// Its own process group on Linux and macOS, so Stop can end everything it starts.
			detached: process.platform !== 'win32',
			windowsHide: true,
			env: { ...process.env, FORCE_COLOR: '1' },
			stdio: 'pipe',
		});

		const watcher = new OutputWatcher((url) => {
			const state = this.states.get(command.key);
			if (state.status === 'running' && this.active.get(command.key)?.child === child) {
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

		const input = new LineInput({
			echo: (text) => output.append(text),
			submit: (line) => {
				if (child.stdin?.writable) {
					child.stdin.write(`${line}\n`);
				}
			},
			interrupt: () => void this.stop(command.key),
		});

		let resolveDone!: (state: RunState) => void;
		const run: ActiveRun = {
			command,
			child,
			input,
			stopRequested: false,
			done: new Promise<RunState>((resolve) => (resolveDone = resolve)),
		};
		this.active.set(command.key, run);

		let exitCode: number | null = null;
		let signal: NodeJS.Signals | null = null;
		let closeTimer: NodeJS.Timeout | undefined;
		let ended = false;
		const finish = (error?: Error) => {
			if (ended) {
				return;
			}
			ended = true;
			clearTimeout(closeTimer);
			if (this.active.get(command.key) === run) {
				this.active.delete(command.key);
			}

			const endedAt = Date.now();
			let state: RunState;
			if (run.stopRequested) {
				state = { status: 'stopped', startedAt, endedAt };
			} else if (error) {
				state = { status: 'failed', startedAt, endedAt, error: error.message };
			} else if (exitCode === 0) {
				state = { status: 'passed', startedAt, endedAt, exitCode };
			} else {
				state = { status: 'failed', startedAt, endedAt, exitCode: exitCode ?? undefined, signal: signal ?? undefined };
			}

			const took = formatDuration(endedAt - startedAt);
			const summary =
				state.status === 'passed'
					? `${DIM}Passed in ${took}.${RESET}`
					: state.status === 'stopped'
						? `${DIM}Stopped after ${took}.${RESET}`
						: `${RED}Failed (${failureReason(state)}) after ${took}.${RESET}`;
			output.append(`\r\n${summary}\r\n`);
			this.log.info(`${command.id} ${state.status}${state.status === 'failed' ? ` (${failureReason(state)})` : ''} after ${took}`);

			this.states.set(command.key, state);
			this.finished.fire({ command, state });
			resolveDone(state);
		};

		child.on('error', (error) => finish(error));
		child.on('exit', (code, sig) => {
			exitCode = code;
			signal = sig;
			// Usually 'close' follows at once; a leftover background process may keep the pipes open, though.
			closeTimer = setTimeout(() => finish(), CLOSE_GRACE_MS);
		});
		child.on('close', () => finish());

		return run.done;
	}

	/** Stops a running command and everything it started. Resolves with its final state. */
	stop(key: string): Promise<RunState | undefined> {
		const run = this.active.get(key);
		if (!run) {
			return Promise.resolve(undefined);
		}
		if (!run.stopRequested) {
			run.stopRequested = true;
			const pid = run.child.pid;
			if (pid !== undefined) {
				this.log.info(`Stop ${run.command.id} (pid ${pid})`);
				killTree(pid, 'SIGTERM');
				if (process.platform !== 'win32') {
					// Whatever ignored SIGTERM gets SIGKILL, even if the shell itself already exited.
					setTimeout(() => {
						if (isAlive(-pid) || isAlive(pid)) {
							killTree(pid, 'SIGKILL');
						}
					}, KILL_GRACE_MS).unref();
				}
			}
		}
		return run.done;
	}

	/** Stops the command if it runs, then starts it again. Resolves once it has started. */
	async restart(command: HubCommand): Promise<void> {
		await this.stop(command.key);
		void this.run(command);
	}

	/** Opens the command's terminal. */
	showOutput(command: HubCommand, preserveFocus = false): void {
		this.outputFor(command).show(preserveFocus);
	}

	/** Passes what the user typed in a command's terminal to its process. */
	sendInput(key: string, data: string): void {
		this.active.get(key)?.input.feed(data);
	}

	/** Everything the command printed in its last run. */
	outputText(key: string): string {
		return this.outputs.get(key)?.text() ?? '';
	}

	/** Running commands. */
	runningCommands(): HubCommand[] {
		return [...this.active.values()].map((run) => run.command);
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
			if (run.child.pid !== undefined) {
				killTree(run.child.pid, 'SIGTERM');
			}
		}
		this.active.clear();
		for (const output of this.outputs.values()) {
			output.dispose();
		}
		this.outputs.clear();
		this.finished.dispose();
	}
}

/** Terminals need \r\n; processes print \n. */
function toTerminal(text: string): string {
	return text.replace(/\r?\n/g, '\r\n');
}

import * as vscode from 'vscode';
import { failureReason } from './format';
import type { HubCommand, RunState } from './model';
import type { CommandRegistry } from './registry';
import type { Runner } from './runner/runner';
import type { GroupStep, SavedGroup, SavedStore, WaitFor } from './saved';
import type { RunStateStore } from './state';

/** A `running` step must survive this long before the next step starts. */
const RUNNING_GRACE_MS = 1000;
/** How long a `ready` step may take when the group doesn't say. */
const DEFAULT_READY_TIMEOUT_SEC = 120;

export interface RunGroup {
	/** Unique in the window: the folder's URI plus the group's id. */
	key: string;
	folder: vscode.WorkspaceFolder;
	def: SavedGroup;
	/** task-hub.json, when the group is saved there. */
	file?: vscode.Uri;
}

export type GroupStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped';

export interface GroupRunState {
	status: GroupStatus;
	/** The step running, or the one that failed or was stopped (zero-based). */
	step?: number;
	/** Why the group stopped at `step`, e.g. "api › start: failed (exit 1)". */
	message?: string;
	startedAt?: number;
	endedAt?: number;
}

export interface FinishedGroup {
	group: RunGroup;
	state: GroupRunState;
}

interface ActiveRun {
	cancelled: boolean;
	cancel(): void;
	onCancel: Promise<'cancelled'>;
}

/** What a step waits for when the group doesn't say: one-shot commands until they exit, servers until they've started. */
export function defaultWaitFor(command: HubCommand): WaitFor {
	return command.longRunning ? 'running' : 'exit';
}

/**
 * Groups: several commands started in order with one click. Each step waits before the next
 * one starts — until its command exits with code 0 (`exit`), shows a local URL or its ready
 * text (`ready`), or has just started (`running`). A step that fails or times out stops the
 * group there. Stopping a group stops its running commands in reverse order.
 */
export class Groups implements vscode.Disposable {
	private groups: RunGroup[] = [];
	private readonly states = new Map<string, GroupRunState>();
	private readonly active = new Map<string, ActiveRun>();
	private readonly changed = new vscode.EventEmitter<string | undefined>();
	/** Fires with a group's key when its run state changes, or undefined when the list changed. */
	readonly onDidChange = this.changed.event;
	private readonly finished = new vscode.EventEmitter<FinishedGroup>();
	readonly onDidFinish = this.finished.event;
	private readonly disposables: vscode.Disposable[];
	/** Resolves when the latest reload is done. */
	ready: Promise<void>;

	constructor(
		private readonly store: SavedStore,
		private readonly registry: CommandRegistry,
		private readonly runner: Runner,
		private readonly runStates: RunStateStore,
	) {
		this.disposables = [this.changed, this.finished, registry.onDidChange(() => this.reload()), store.onDidChange(() => this.reload())];
		this.ready = this.reload();
	}

	all(): readonly RunGroup[] {
		return this.groups;
	}

	get(key: string): RunGroup | undefined {
		return this.groups.find((g) => g.key === key);
	}

	state(key: string): GroupRunState {
		return this.states.get(key) ?? { status: 'idle' };
	}

	/** The command a step runs, if it exists in the group's folder. */
	stepCommand(group: RunGroup, step: GroupStep): HubCommand | undefined {
		return this.registry.get(`${group.folder.uri.toString()}#${step.run}`);
	}

	/** Whether the group is starting its steps, or any of its commands is still running. */
	isRunning(key: string): boolean {
		const group = this.get(key);
		return this.active.has(key) || (!!group && group.def.steps.some((step) => this.isStepRunning(group, step)));
	}

	private isStepRunning(group: RunGroup, step: GroupStep): boolean {
		const command = this.stepCommand(group, step);
		return !!command && this.runner.isRunning(command.key);
	}

	/** Runs the group's steps in order. Resolves when every step is done waiting, or one fails. */
	async run(key: string): Promise<GroupRunState> {
		const group = this.get(key);
		if (!group || this.active.has(key)) {
			return this.state(key);
		}
		let cancel!: () => void;
		const onCancel = new Promise<'cancelled'>((resolve) => (cancel = () => resolve('cancelled')));
		const run: ActiveRun = { cancelled: false, cancel, onCancel };
		this.active.set(key, run);
		const startedAt = Date.now();

		const end = (state: Omit<GroupRunState, 'startedAt' | 'endedAt'>): GroupRunState => {
			this.active.delete(key);
			const final = { ...state, startedAt, endedAt: Date.now() };
			this.setState(key, final);
			this.finished.fire({ group, state: final });
			return final;
		};

		const { steps } = group.def;
		for (let i = 0; i < steps.length; i++) {
			if (run.cancelled) {
				return end({ status: 'stopped', step: i });
			}
			const step = steps[i];
			this.setState(key, { status: 'running', step: i, startedAt });
			const command = this.stepCommand(group, step);
			if (!command) {
				return end({ status: 'failed', step: i, message: `no command "${step.run}" in ${group.folder.name}` });
			}
			const name = `${command.group.label} › ${command.label}`;
			if (command.unavailable) {
				return end({ status: 'failed', step: i, message: `${name}: ${command.unavailable}` });
			}
			const done = this.runner.run(command, { args: step.args ?? this.runner.lastArgs(command.key) });
			const problem = await this.waitFor(command, step.waitFor ?? defaultWaitFor(command), done, step.timeoutSec, run);
			if (run.cancelled) {
				return end({ status: 'stopped', step: i });
			}
			if (problem) {
				return end({ status: 'failed', step: i, message: `${name}: ${problem}` });
			}
		}
		return end({ status: 'done' });
	}

	/** Stops the group: no more steps start, and its running commands stop, last step first. */
	async stop(key: string): Promise<void> {
		const group = this.get(key);
		const run = this.active.get(key);
		if (run) {
			run.cancelled = true;
			run.cancel();
		}
		if (!group) {
			return;
		}
		for (const step of [...group.def.steps].reverse()) {
			const command = this.stepCommand(group, step);
			if (command && this.runner.isRunning(command.key)) {
				await this.runner.stop(command.key);
			}
		}
		// A group that had finished starting its steps now reads "stopped" instead of "done".
		if (!run && this.state(key).status === 'done') {
			this.setState(key, { ...this.state(key), status: 'stopped', step: undefined, endedAt: Date.now() });
		}
	}

	/** Waits for a step; resolves with what went wrong, or undefined when the next step may start. */
	private async waitFor(command: HubCommand, waitFor: WaitFor, done: Promise<RunState>, timeoutSec: number | undefined, run: ActiveRun): Promise<string | undefined> {
		const outcome = (state: RunState) => (state.status === 'passed' ? undefined : state.status === 'stopped' ? 'stopped' : failureReason(state));
		const timeout = <T>(seconds: number | undefined, value: T): Promise<T> =>
			seconds ? new Promise((resolve) => setTimeout(() => resolve(value), seconds * 1000).unref()) : new Promise(() => undefined);

		// A compose service is up once `up -d` has exited.
		if (waitFor === 'exit' || command.service) {
			const result = await Promise.race([done, timeout(timeoutSec, 'timeout' as const), run.onCancel]);
			return result === 'timeout' ? `didn't finish within ${timeoutSec}s` : result === 'cancelled' ? 'stopped' : outcome(result);
		}
		if (waitFor === 'running') {
			const result = await Promise.race([done, new Promise<'started'>((resolve) => setTimeout(() => resolve('started'), RUNNING_GRACE_MS)), run.onCancel]);
			return result === 'started' ? undefined : result === 'cancelled' ? 'stopped' : outcome(result);
		}
		// ready: a local URL or the readyPattern in the output, or a clean exit.
		const seconds = timeoutSec ?? DEFAULT_READY_TIMEOUT_SEC;
		let subscription: vscode.Disposable | undefined;
		const ready = new Promise<'ready'>((resolve) => {
			const check = () => this.runStates.get(command.key).status === 'ready' && resolve('ready');
			subscription = this.runStates.onDidChange((key) => key === command.key && check());
			check();
		});
		try {
			const result = await Promise.race([ready, done, timeout(seconds, 'timeout' as const), run.onCancel]);
			if (result === 'ready') {
				return undefined;
			}
			return result === 'timeout' ? `not ready after ${seconds}s` : result === 'cancelled' ? 'stopped' : outcome(result);
		} finally {
			subscription?.dispose();
		}
	}

	reload(): Promise<void> {
		this.ready = (async () => {
			const groups: RunGroup[] = [];
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				if (folder.uri.scheme !== 'file') {
					continue;
				}
				const { groups: defs, file } = await this.store.groups(folder);
				for (const def of defs) {
					groups.push({ key: `${folder.uri.toString()}#group:${def.id}`, folder, def, file });
				}
			}
			this.groups = groups;
			this.changed.fire(undefined);
		})();
		return this.ready;
	}

	private setState(key: string, state: GroupRunState): void {
		this.states.set(key, state);
		this.changed.fire(key);
	}

	dispose(): void {
		for (const run of this.active.values()) {
			run.cancelled = true;
			run.cancel();
		}
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

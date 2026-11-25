import * as vscode from 'vscode';
import type { RunState } from './model';

const IDLE: RunState = Object.freeze({ status: 'idle' });

const HISTORY_KEY = 'taskHub.runHistory';
/** Commands whose last run is remembered; the oldest are dropped first. */
const MAX_REMEMBERED = 500;
const SAVE_DELAY_MS = 1000;

interface SavedHistory {
	savedAt: number;
	states: Record<string, RunState>;
}

/**
 * The last run of every command, by command key: status, exit code, start and end time,
 * the URL it served and the arguments it ran with. Saved in the workspace state, so it
 * survives a reload. A command that was still running when the window closed comes back as
 * stopped, since Task Hub stops everything it started when VS Code closes.
 */
export class RunStateStore implements vscode.Disposable {
	private readonly states = new Map<string, RunState>();
	private readonly changed = new vscode.EventEmitter<string>();
	/** Fires with the key of the command whose state changed. */
	readonly onDidChange = this.changed.event;
	private saveTimer: NodeJS.Timeout | undefined;

	constructor(private readonly memento?: vscode.Memento) {
		const saved = memento?.get<SavedHistory>(HISTORY_KEY);
		for (const [key, state] of Object.entries(saved?.states ?? {})) {
			if (state.status === 'running' || state.status === 'ready') {
				this.states.set(key, { ...state, status: 'stopped', url: undefined, endedAt: state.endedAt ?? saved?.savedAt });
			} else if (state.status !== 'idle') {
				this.states.set(key, state);
			}
		}
	}

	get(key: string): RunState {
		return this.states.get(key) ?? IDLE;
	}

	set(key: string, state: RunState): void {
		this.states.set(key, state);
		this.changed.fire(key);
		if (this.memento && !this.saveTimer) {
			this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
		}
	}

	/** Every command that has run, most recent first. */
	recent(): { key: string; state: RunState }[] {
		return [...this.states]
			.map(([key, state]) => ({ key, state }))
			.sort((a, b) => lastActivity(b.state) - lastActivity(a.state));
	}

	private save(): void {
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		const states = Object.fromEntries(
			this.recent()
				.slice(0, MAX_REMEMBERED)
				.map(({ key, state }) => [key, state]),
		);
		void this.memento?.update(HISTORY_KEY, { savedAt: Date.now(), states } satisfies SavedHistory);
	}

	dispose(): void {
		if (this.saveTimer) {
			this.save();
		}
		this.changed.dispose();
	}
}

function lastActivity(state: RunState): number {
	return state.endedAt ?? state.startedAt ?? 0;
}

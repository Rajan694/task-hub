import * as vscode from 'vscode';
import type { RunState } from './model';

const IDLE: RunState = Object.freeze({ status: 'idle' });

/**
 * The last run state of every command, by command key. Kept in memory for now; saving it per
 * workspace so it survives a reload arrives with the run history (milestone v0.3).
 */
export class RunStateStore implements vscode.Disposable {
	private readonly states = new Map<string, RunState>();
	private readonly changed = new vscode.EventEmitter<string>();
	/** Fires with the key of the command whose state changed. */
	readonly onDidChange = this.changed.event;

	get(key: string): RunState {
		return this.states.get(key) ?? IDLE;
	}

	set(key: string, state: RunState): void {
		this.states.set(key, state);
		this.changed.fire(key);
	}

	dispose(): void {
		this.changed.dispose();
	}
}

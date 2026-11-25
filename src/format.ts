import type { RunState } from './model';

/** 0.4s, 12.3s, 45s, 3m 05s, 1h 02m */
export function formatDuration(ms: number): string {
	if (ms < 10_000) {
		return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
	}
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** just now, 12s ago, 3m ago, 2h ago, 4d ago */
export function formatAgo(elapsedMs: number): string {
	const seconds = Math.round(elapsedMs / 1000);
	if (seconds < 5) {
		return 'just now';
	}
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	return `${Math.floor(hours / 24)}d ago`;
}

/** Why a run failed, in a few words: "exit 1", "SIGKILL", or the start error. */
export function failureReason(state: RunState): string {
	if (state.error) {
		return state.error;
	}
	if (state.signal) {
		return state.signal;
	}
	return state.exitCode === undefined ? 'unknown reason' : `exit ${state.exitCode}`;
}

/** Port label for a URL: "http://localhost:5173/" → ":5173". */
export function portLabel(url: string): string {
	const match = /:(\d+)(?:[/?#]|$)/.exec(url.replace(/^\w+:\/\//, ''));
	return match ? `:${match[1]}` : url;
}

/** The short status shown next to a command in the sidebar. */
export function statusText(state: RunState): string {
	const took = state.startedAt !== undefined && state.endedAt !== undefined ? formatDuration(state.endedAt - state.startedAt) : undefined;
	switch (state.status) {
		case 'idle':
			return '';
		case 'running':
			return 'running';
		case 'ready':
			return state.url ? `running · ${portLabel(state.url)}` : 'ready';
		case 'passed':
			return took ? `passed · ${took}` : 'passed';
		case 'failed':
			return state.error ? 'failed to start' : `failed (${failureReason(state)})`;
		case 'stopped':
			return 'stopped';
	}
}

import { execFile } from 'child_process';

/**
 * Ends a process and everything it started, so a dev server doesn't outlive its Stop button.
 *
 * On Linux and macOS commands start in their own process group (`detached: true`), so the
 * signal goes to the whole group. On Windows `taskkill /T /F` ends the tree; it has no gentle
 * first step, so the signal is ignored there.
 */
export function killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL', platform: NodeJS.Platform = process.platform): void {
	if (platform === 'win32') {
		execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
			// Already gone, or not ours to end: nothing more to do.
		});
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/** Whether a process with this id exists. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

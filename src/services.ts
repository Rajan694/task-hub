import { execFile } from 'child_process';
import * as vscode from 'vscode';
import type { CommandRegistry } from './registry';

/** While the view is visible, ask docker this often. */
const POLL_MS = 15_000;

/**
 * Which docker compose services are running, from `docker compose ps` in each compose file's
 * folder. Refreshed after every scan, after a compose command finishes, when the view becomes
 * visible, and every 15 seconds while it is.
 */
export class ServiceMonitor implements vscode.Disposable {
	private running = new Set<string>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[];
	private timer: NodeJS.Timeout | undefined;
	private refreshing: Promise<void> | undefined;
	private again = false;
	private readonly reported = new Set<string>();

	constructor(
		private readonly registry: CommandRegistry,
		private readonly log: vscode.LogOutputChannel,
	) {
		this.disposables = [
			this.changed,
			registry.onDidChange(() => void this.refresh()),
			vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refresh()),
		];
	}

	isRunning(key: string): boolean {
		return this.running.has(key);
	}

	/** Polls while the view is visible. */
	setVisible(visible: boolean): void {
		clearInterval(this.timer);
		this.timer = undefined;
		if (visible) {
			void this.refresh();
			this.timer = setInterval(() => void this.refresh(), POLL_MS);
		}
	}

	refresh(): Promise<void> {
		// Nothing can start in Restricted Mode, and docker reads the workspace's compose files: wait for trust.
		if (!vscode.workspace.isTrusted) {
			return Promise.resolve();
		}
		if (this.refreshing) {
			this.again = true;
			return this.refreshing;
		}
		this.refreshing = this.query().finally(() => {
			this.refreshing = undefined;
			if (this.again) {
				this.again = false;
				void this.refresh();
			}
		});
		return this.refreshing;
	}

	private async query(): Promise<void> {
		const byFolder = new Map<string, { name: string; key: string }[]>();
		for (const command of this.registry.all()) {
			if (command.service) {
				const list = byFolder.get(command.cwd.fsPath) ?? [];
				list.push({ name: command.service.name, key: command.key });
				byFolder.set(command.cwd.fsPath, list);
			}
		}
		const running = new Set<string>();
		await Promise.all(
			[...byFolder].map(async ([cwd, services]) => {
				const names = await this.runningServices(cwd);
				for (const service of services) {
					if (names.has(service.name)) {
						running.add(service.key);
					}
				}
			}),
		);
		if (running.size !== this.running.size || [...running].some((key) => !this.running.has(key))) {
			this.running = running;
			this.changed.fire();
		}
	}

	private runningServices(cwd: string): Promise<Set<string>> {
		return new Promise((resolve) => {
			execFile('docker', ['compose', 'ps', '--format', 'json'], { cwd, timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
				if (error) {
					// No docker, no daemon, or an invalid file: report it once, show nothing as running.
					if (!this.reported.has(cwd)) {
						this.reported.add(cwd);
						this.log.warn(`docker compose ps failed in ${cwd}: ${(stderr || error.message).trim()}`);
					}
					resolve(new Set());
					return;
				}
				resolve(new Set(parsePsOutput(stdout)));
			});
		});
	}

	dispose(): void {
		clearInterval(this.timer);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

/**
 * The running services in `docker compose ps --format json` output: one JSON object per line
 * in current Compose, a single JSON array in versions before 2.21.
 */
export function parsePsOutput(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}
	let entries: unknown[];
	try {
		entries = trimmed.startsWith('[') ? (JSON.parse(trimmed) as unknown[]) : trimmed.split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
	} catch {
		return [];
	}
	return entries
		.filter((e): e is { Service: string; State?: string } => !!e && typeof (e as { Service?: unknown }).Service === 'string')
		.filter((e) => (e.State ?? 'running').toLowerCase() === 'running')
		.map((e) => e.Service);
}

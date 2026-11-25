import * as vscode from 'vscode';
import { readSettings, RESCAN_SETTINGS } from './config';
import type { CommandDetector, HubCommand } from './model';

/** Wait this long after the last file change before detecting again. */
const DEBOUNCE_MS = 500;

/**
 * Runs the detectors over every workspace folder, keeps the merged list, and detects again
 * when a watched file, a workspace folder or a relevant setting changes.
 */
export class CommandRegistry implements vscode.Disposable {
	private commands: HubCommand[] = [];
	private byKey = new Map<string, HubCommand>();
	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires after every scan. */
	readonly onDidChange = this.changed.event;

	private readonly disposables: vscode.Disposable[] = [];
	private watchers: vscode.Disposable[] = [];
	private timer: NodeJS.Timeout | undefined;
	private running: Promise<void> | undefined;
	private queued: Promise<void> | undefined;

	/** Resolves when the first scan is done. */
	readonly ready: Promise<void>;

	constructor(
		private readonly detectors: readonly CommandDetector[],
		private readonly log: vscode.LogOutputChannel,
	) {
		this.disposables.push(
			this.changed,
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.restart()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (RESCAN_SETTINGS.some((setting) => e.affectsConfiguration(setting))) {
					this.restart();
				}
			}),
		);
		this.watch();
		this.ready = this.scan();
	}

	all(): readonly HubCommand[] {
		return this.commands;
	}

	get(key: string): HubCommand | undefined {
		return this.byKey.get(key);
	}

	/**
	 * Detects all commands again. A call during a scan queues one more scan after it, and the
	 * returned promise resolves when that one is done, so the result always reflects the call.
	 */
	scan(): Promise<void> {
		if (!this.running) {
			this.running = this.detectAll().finally(() => {
				this.running = undefined;
			});
			return this.running;
		}
		this.queued ??= this.running.then(() => {
			this.queued = undefined;
			return this.scan();
		});
		return this.queued;
	}

	private restart(): void {
		this.watch();
		this.scheduleScan(0);
	}

	private scheduleScan(delay = DEBOUNCE_MS): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.scan();
		}, delay);
	}

	private watch(): void {
		vscode.Disposable.from(...this.watchers).dispose();
		this.watchers = [];
		for (const folder of fileFolders()) {
			const { sources } = readSettings(folder.uri);
			for (const detector of this.detectors) {
				if (!sources.includes(detector.source)) {
					continue;
				}
				const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, detector.watchGlob));
				const onChange = (uri: vscode.Uri) => {
					// Installing packages touches thousands of package.json files under node_modules.
					if (!/[\\/]node_modules[\\/]/.test(uri.fsPath)) {
						this.scheduleScan();
					}
				};
				this.watchers.push(watcher, watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange));
			}
		}
	}

	private async detectAll(): Promise<void> {
		const started = Date.now();
		const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
		const tokenSource = new vscode.CancellationTokenSource();
		const found: HubCommand[] = [];
		try {
			for (const folder of fileFolders()) {
				const settings = readSettings(folder.uri);
				for (const detector of this.detectors) {
					if (!settings.sources.includes(detector.source)) {
						continue;
					}
					try {
						found.push(
							...(await detector.detect({
								folder,
								multiRoot,
								exclude: settings.exclude,
								longRunningNames: settings.longRunningNames,
								token: tokenSource.token,
								log: this.log,
							})),
						);
					} catch (error) {
						this.log.error(`The ${detector.source} detector failed in ${folder.name}:`, error);
					}
				}
			}
		} finally {
			tokenSource.dispose();
		}

		const byKey = new Map<string, HubCommand>();
		for (const command of found) {
			if (!byKey.has(command.key)) {
				byKey.set(command.key, command);
			}
		}
		this.byKey = byKey;
		this.commands = [...byKey.values()];
		this.log.info(`Found ${this.commands.length} commands in ${Date.now() - started} ms`);
		this.changed.fire();
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		vscode.Disposable.from(...this.watchers, ...this.disposables).dispose();
		this.watchers = [];
	}
}

/** Commands run as local processes, so only folders on disk are scanned (not virtual workspaces). */
function fileFolders(): readonly vscode.WorkspaceFolder[] {
	return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

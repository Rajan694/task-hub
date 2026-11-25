import * as vscode from 'vscode';
import type { HubCommand } from './model';
import type { CommandRegistry } from './registry';
import type { SavedStore } from './saved';

/**
 * The favorite commands of every workspace folder, read from the saved-commands store
 * (`favorites` in .vscode/task-hub.json) and reread when it or the command list changes.
 */
export class Favorites implements vscode.Disposable {
	private byFolder = new Map<string, string[]>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly disposables: vscode.Disposable[];
	/** Resolves when the latest reload is done. */
	ready: Promise<void>;

	constructor(
		private readonly store: SavedStore,
		private readonly registry: CommandRegistry,
	) {
		this.disposables = [this.changed, registry.onDidChange(() => this.reload()), store.onDidChange(() => this.reload())];
		this.ready = this.reload();
	}

	isFavorite(command: HubCommand): boolean {
		return this.byFolder.get(command.folder.uri.toString())?.includes(command.id) ?? false;
	}

	/** The favorite commands that exist right now, folder by folder, in the order they were added. */
	commands(): HubCommand[] {
		const result: HubCommand[] = [];
		for (const [folderUri, ids] of this.byFolder) {
			for (const id of ids) {
				const command = this.registry.get(`${folderUri}#${id}`);
				if (command) {
					result.push(command);
				}
			}
		}
		return result;
	}

	set(command: HubCommand, favorite: boolean): Promise<void> {
		return this.store.setFavorite(command.folder, command.id, favorite);
	}

	reload(): Promise<void> {
		this.ready = (async () => {
			const byFolder = new Map<string, string[]>();
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				if (folder.uri.scheme === 'file') {
					byFolder.set(folder.uri.toString(), await this.store.favorites(folder));
				}
			}
			this.byFolder = byFolder;
			this.changed.fire();
		})();
		return this.ready;
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

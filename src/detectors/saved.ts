import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand } from '../model';
import type { SavedStore } from '../saved';
import { isLongRunning, makeCommand, namedGroupLabel } from './common';

/** The "My commands" heading: commands saved with + or Save as Command. */
export function createSavedDetector(store: SavedStore): CommandDetector {
	return {
		source: 'saved',
		watchGlob: '.vscode/task-hub.json',

		async detect(context: DetectContext): Promise<HubCommand[]> {
			const { commands, file } = await store.list(context.folder);
			const group = {
				id: 'saved',
				label: namedGroupLabel(context, 'My commands'),
				description: file ? '.vscode/task-hub.json' : 'private',
				tooltip: file ? 'Saved in .vscode/task-hub.json, shared with everyone who uses this repository' : 'Saved on this machine only',
				definedAt: file,
			};
			return commands.map((saved) => {
				let readyPattern: RegExp | undefined;
				try {
					readyPattern = saved.readyPattern ? new RegExp(saved.readyPattern) : undefined;
				} catch {
					context.log.warn(`Ignoring the readyPattern of saved command "${saved.label}": not a valid regular expression`);
				}
				return makeCommand(context, {
					id: `saved:${saved.id}`,
					label: saved.label,
					source: 'saved',
					group,
					cwd: saved.cwd ? vscode.Uri.joinPath(context.folder.uri, saved.cwd) : context.folder.uri,
					commandLine: saved.command,
					definedAt: file && saved.line !== undefined ? new vscode.Location(file, new vscode.Position(saved.line, 0)) : undefined,
					longRunning: saved.longRunning ?? isLongRunning(saved.label, context.settings.longRunningNames),
					readyPattern,
					savedId: saved.id,
				});
			});
		},
	};
}

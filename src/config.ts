import * as vscode from 'vscode';
import type { SourceKind } from './model';

export const SECTION = 'taskHub';

export type RevealTerminal = 'never' | 'onFailure' | 'always';
export type NotifyLevel = 'failures' | 'all' | 'never';
export type OpenUrlIn = 'externalBrowser' | 'simpleBrowser';

export interface Settings {
	sources: readonly SourceKind[];
	/** `taskHub.exclude` plus the folders hidden by `files.exclude`. */
	exclude: readonly string[];
	longRunningNames: readonly string[];
	revealTerminal: RevealTerminal;
	notify: NotifyLevel;
	openUrlIn: OpenUrlIn;
}

/** Settings whose change means the command list has to be detected again. */
export const RESCAN_SETTINGS = [`${SECTION}.sources`, `${SECTION}.exclude`, `${SECTION}.longRunningNames`, 'files.exclude'];

export function readSettings(scope?: vscode.ConfigurationScope): Settings {
	const config = vscode.workspace.getConfiguration(SECTION, scope);
	const filesExclude = vscode.workspace.getConfiguration('files', scope).get<Record<string, unknown>>('exclude', {});
	return {
		sources: config.get<SourceKind[]>('sources', []),
		exclude: [
			...config.get<string[]>('exclude', []),
			...Object.entries(filesExclude)
				.filter(([, on]) => on === true)
				.map(([glob]) => glob),
		],
		longRunningNames: config.get<string[]>('longRunningNames', []),
		revealTerminal: config.get<RevealTerminal>('revealTerminal', 'onFailure'),
		notify: config.get<NotifyLevel>('notify', 'failures'),
		openUrlIn: config.get<OpenUrlIn>('openUrlIn', 'externalBrowser'),
	};
}

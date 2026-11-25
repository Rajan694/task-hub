import type * as vscode from 'vscode';

/** Where a command was found. Only `npm` has a detector so far; the others arrive with later milestones. */
export type SourceKind =
	| 'npm'
	| 'make'
	| 'just'
	| 'taskfile'
	| 'compose'
	| 'vscode'
	| 'saved'
	| 'python'
	| 'script'
	| 'maven'
	| 'gradle';

/** One heading in the sidebar, such as a package.json file. */
export interface CommandGroup {
	/** "npm:apps/web"; unique within its workspace folder. */
	id: string;
	/** "apps/web" */
	label: string;
	/** "package.json · pnpm" */
	description?: string;
	tooltip?: string;
	/** The file the group's commands come from, for Go to Definition. */
	definedAt?: vscode.Uri;
}

export interface HubCommand {
	/** Unique in the window: the workspace folder's URI plus `id`. Run state is stored under this. */
	key: string;
	/** "npm:apps/web:dev". Stable across reloads, so favorites and groups can refer to it. */
	id: string;
	/** "dev" */
	label: string;
	source: SourceKind;
	group: CommandGroup;
	folder: vscode.WorkspaceFolder;
	/** The folder the command runs in. */
	cwd: vscode.Uri;
	/** "pnpm run dev" */
	commandLine: string;
	/** Where the command is defined, for Go to Definition. */
	definedAt?: vscode.Location;
	/** What the command does, e.g. the script body "vite". */
	description?: string;
	/** Expected to keep running (a dev server or watcher) rather than finish. */
	longRunning: boolean;
	/** Output that means a long-running command is ready, besides a local URL. */
	readyPattern?: RegExp;
}

export interface DetectContext {
	folder: vscode.WorkspaceFolder;
	/** True when the window has more than one workspace folder; labels then start with the folder name. */
	multiRoot: boolean;
	/** Glob patterns of files and folders not to scan. */
	exclude: readonly string[];
	longRunningNames: readonly string[];
	token: vscode.CancellationToken;
	log: vscode.LogOutputChannel;
}

/** Finds the commands of one kind in one workspace folder. */
export interface CommandDetector {
	readonly source: SourceKind;
	/** Files whose changes mean the commands must be detected again, e.g. "**\/package.json". */
	readonly watchGlob: string;
	detect(context: DetectContext): Promise<HubCommand[]>;
}

export type RunStatus = 'idle' | 'running' | 'ready' | 'passed' | 'failed' | 'stopped';

export interface RunState {
	status: RunStatus;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number;
	/** Set when the process was ended by a signal it didn't handle. */
	signal?: string;
	/** Set when the process could not be started at all. */
	error?: string;
	/** The first local dev-server URL found in the output. */
	url?: string;
}

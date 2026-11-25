import type * as vscode from 'vscode';
import type { Settings } from './config';

/** Where a command was found. `python`, `maven` and `gradle` arrive with milestone v0.4. */
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

/** One argument a script or recipe takes, asked for before it runs. */
export interface ScriptArg {
	/** "Env", "-e", "env", "$1" */
	name: string;
	kind: 'choice' | 'text' | 'switch';
	/** For `choice`: from ValidateSet, `case "$1"` branches or a usage line. */
	choices?: string[];
	defaultValue?: string;
	required: boolean;
	/** Passed as `flag value` (or just `flag` for a switch) when set; as a positional value otherwise. */
	flag?: string;
	/** Takes several values (just's `+args`), split like a shell would. */
	variadic?: boolean;
}

/** A second command on the same row, such as a compose service's Stop and Logs. */
export interface CommandAction {
	id: 'stop' | 'logs';
	label: string;
	commandLine: string;
	longRunning: boolean;
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
	/** "pnpm run dev". For `exec` commands, the same command quoted for display and copying. */
	commandLine: string;
	/** Run this program with these arguments instead of `commandLine` in a shell (scripts), so values are never re-parsed. */
	exec?: { file: string; args: string[] };
	/** Where the command is defined, for Go to Definition. */
	definedAt?: vscode.Location;
	/** Short plain-language text shown on the row while idle: a Makefile `##` comment, what a script takes. */
	description?: string;
	/** What the command runs underneath, e.g. the npm script body "vite". */
	body?: string;
	/** Expected to keep running (a dev server or watcher) rather than finish. */
	longRunning: boolean;
	/** Output that means a long-running command is ready, besides a local URL. */
	readyPattern?: RegExp;
	/** Arguments to ask for before every run. */
	args?: ScriptArg[];
	/** Nothing is known about the arguments: ask for optional free text before every run. */
	freeArgs?: boolean;
	/** Whether Run with Arguments… makes sense (the command line can take extra words). */
	acceptsArgs: boolean;
	/** Why the command can't run on this machine, e.g. "needs bash". */
	unavailable?: string;
	/** Run through VS Code's own task system (tasks from .vscode/tasks.json). */
	vscodeTask?: { label: string };
	/** A docker compose service: its state comes from `docker compose ps`. */
	service?: { name: string };
	/** Saved in .vscode/task-hub.json (or private storage) under this id. */
	savedId?: string;
	actions?: CommandAction[];
}

export interface DetectContext {
	folder: vscode.WorkspaceFolder;
	/** True when the window has more than one workspace folder; labels then start with the folder name. */
	multiRoot: boolean;
	settings: Settings;
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

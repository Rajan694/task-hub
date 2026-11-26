import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parsePs1Params } from '../args/ps1Params';
import { parseShArgs } from '../args/shArgs';
import { argsSummary } from '../args/summary';
import type { CommandDetector, CommandGroup, DetectContext, HubCommand, ScriptArg } from '../model';
import { bashPath, powershellPath } from '../platform';
import { quoteArg } from '../shell';
import { excludeGlob, groupLabel, isLongRunning, makeCommand, relativeDir } from './common';

/** Only the start of a script is read for its arguments. */
const MAX_READ = 64 * 1024;

type ScriptKind = 'bash' | 'powershell' | 'cmd';

/** The Maven and Gradle wrappers, which the Maven and Gradle sources already run. */
const BUILD_WRAPPERS = new Set(['mvnw.cmd', 'gradlew.bat']);

function kindOf(file: string): ScriptKind | undefined {
	if (BUILD_WRAPPERS.has(path.basename(file).toLowerCase())) {
		return undefined;
	}
	switch (path.extname(file).toLowerCase()) {
		case '.sh':
		case '.bash':
			return 'bash';
		case '.ps1':
			return 'powershell';
		case '.bat':
		case '.cmd':
			return 'cmd';
		default:
			return undefined;
	}
}

/** How to start a script: the program and the arguments before the script's own. */
export function scriptLauncher(kind: ScriptKind, file: string): { exec?: { file: string; args: string[] }; unavailable?: string } {
	switch (kind) {
		case 'bash': {
			const bash = bashPath();
			return bash ? { exec: { file: bash, args: [file] } } : { unavailable: 'needs bash' };
		}
		case 'powershell': {
			const powershell = powershellPath();
			return powershell ? { exec: { file: powershell, args: ['-NoProfile', '-File', file] } } : { unavailable: 'needs pwsh' };
		}
		case 'cmd':
			return { exec: { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', file] } };
	}
}

/** The display name of a launcher: "bash", not "/usr/bin/bash". */
function programName(file: string): string {
	return path.basename(file).replace(/\.exe$/i, '');
}

async function readStart(file: string): Promise<string> {
	const handle = await fs.promises.open(file, 'r');
	try {
		const buffer = Buffer.alloc(MAX_READ);
		const { bytesRead } = await handle.read(buffer, 0, MAX_READ, 0);
		return buffer.toString('utf8', 0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Shell, PowerShell and batch scripts, one heading per folder. Each runs with an argument
 * list (`bash deploy.sh staging`), never through a shell string, so values are passed as typed.
 * `.bat` and `.cmd` files are listed on Windows only, without the `mvnw.cmd` and `gradlew.bat` wrappers.
 */
export const scriptsDetector: CommandDetector = {
	source: 'script',
	watchGlob: '**/*.{sh,bash,ps1,bat,cmd}',

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const { settings } = context;
		const include = excludeGlob(settings.scriptsInclude);
		if (!include) {
			return [];
		}
		const files = await vscode.workspace.findFiles(
			new vscode.RelativePattern(context.folder, include),
			excludeGlob(['**/node_modules/**', '**/.git/**', ...settings.exclude]),
			settings.scriptsMaxFiles,
			context.token,
		);
		const scripts = files
			.map((uri) => ({ uri, kind: kindOf(uri.fsPath), dir: relativeDir(context, path.dirname(uri.fsPath)) }))
			.filter((s): s is typeof s & { kind: ScriptKind } => s.kind !== undefined && (s.kind !== 'cmd' || process.platform === 'win32'))
			.sort((a, b) => (a.dir === b.dir ? path.basename(a.uri.fsPath).localeCompare(path.basename(b.uri.fsPath)) : a.dir === '' ? -1 : b.dir === '' ? 1 : a.dir.localeCompare(b.dir)));

		const groups = new Map<string, CommandGroup>();
		const commands: HubCommand[] = [];
		for (const { uri, kind, dir } of scripts) {
			const folderId = dir || 'root';
			let group = groups.get(folderId);
			if (!group) {
				group = { id: `script:${folderId}`, label: `${groupLabel(context, dir)}/`, description: 'scripts', tooltip: `Scripts in ${dir || context.folder.name}` };
				groups.set(folderId, group);
			}

			let args: ScriptArg[] | undefined;
			if (kind !== 'cmd') {
				try {
					const text = await readStart(uri.fsPath);
					args = kind === 'powershell' ? parsePs1Params(text) : parseShArgs(text);
				} catch (error) {
					context.log.warn(`Couldn't read ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			const fileName = path.basename(uri.fsPath);
			const cwd = settings.scriptsRunFrom === 'workspaceRoot' ? context.folder.uri.fsPath : path.dirname(uri.fsPath);
			// Forward slashes for bash, which Git Bash on Windows needs.
			const relativePath = path.relative(cwd, uri.fsPath) || fileName;
			const scriptPath = kind === 'bash' ? relativePath.split(path.sep).join('/') : relativePath;
			const { exec, unavailable } = scriptLauncher(kind, scriptPath);
			const commandLine = exec ? [programName(exec.file), ...exec.args].map((a) => quoteArg(a)).join(' ') : scriptPath;
			commands.push(
				makeCommand(context, {
					id: `script:${folderId}:${fileName}`,
					label: fileName,
					source: 'script',
					group,
					cwd: vscode.Uri.file(cwd),
					commandLine,
					exec,
					unavailable,
					definedAt: new vscode.Location(uri, new vscode.Position(0, 0)),
					description: unavailable ?? (args?.length ? argsSummary(args) : undefined),
					longRunning: isLongRunning(fileName.replace(/\.[^.]+$/, ''), settings.longRunningNames),
					args: args?.length ? args : undefined,
					// Nothing known about its arguments: ask for optional free text instead (not for parameterless PowerShell scripts).
					freeArgs: args === undefined || undefined,
				}),
			);
		}
		return commands;
	},
};

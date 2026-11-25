import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandGroup, DetectContext, HubCommand } from '../model';

/**
 * Whether a command name means "keeps running": an exact match with one of the names
 * (`dev`, `start`, `watch`, …), or a first or last part that matches (`dev:web`,
 * `start-prod`, `build:watch`). A last part of `run` doesn't count, since `test:run`
 * (Vitest) runs once.
 */
export function isLongRunning(name: string, longRunningNames: readonly string[]): boolean {
	const names = new Set(longRunningNames.map((n) => n.toLowerCase()));
	const lower = name.toLowerCase();
	if (names.has(lower)) {
		return true;
	}
	const parts = lower.split(/[:_-]/).filter(Boolean);
	if (parts.length < 2) {
		return false;
	}
	const last = parts[parts.length - 1];
	return names.has(parts[0]) || (last !== 'run' && names.has(last));
}

/** Joins exclude globs into the one pattern `workspace.findFiles` takes. */
export function excludeGlob(globs: readonly string[]): string | undefined {
	const unique = [...new Set(globs.map((g) => g.trim()).filter(Boolean))];
	if (unique.length === 0) {
		return undefined;
	}
	return unique.length === 1 ? unique[0] : `{${unique.join(',')}}`;
}

/** A folder's path inside the workspace folder, with forward slashes; '' for the workspace folder itself. */
export function relativeDir(context: DetectContext, dir: string): string {
	return path.relative(context.folder.uri.fsPath, dir).split(path.sep).join('/');
}

/** "apps/web", or the workspace folder's name for its root. Multi-root windows prefix the folder name. */
export function groupLabel(context: DetectContext, relative: string): string {
	if (!relative) {
		return context.folder.name;
	}
	return context.multiRoot ? `${context.folder.name}/${relative}` : relative;
}

/** Line and column of a character offset in a text. */
export function positionAt(text: string, offset: number): { line: number; character: number } {
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, character: Math.max(0, offset - lineStart) };
}

/** "VS Code tasks", or "api · VS Code tasks" in a multi-root window. */
export function namedGroupLabel(context: DetectContext, name: string): string {
	return context.multiRoot ? `${context.folder.name} · ${name}` : name;
}

/** Files in the workspace folder matching `glob`, skipping node_modules and the excluded folders, sorted by path. */
export async function findInFolder(context: DetectContext, glob: string, maxResults: number): Promise<vscode.Uri[]> {
	const files = await vscode.workspace.findFiles(
		new vscode.RelativePattern(context.folder, glob),
		excludeGlob(['**/node_modules/**', ...context.settings.exclude]),
		maxResults,
		context.token,
	);
	return files.sort((a, b) => compareRelative(relativeDir(context, a.fsPath), relativeDir(context, b.fsPath)));
}

/** Sorts paths so that files at the workspace root come first, then by path. */
export function compareRelative(a: string, b: string): number {
	const depth = (p: string) => (p.includes('/') ? 1 : 0);
	return depth(a) - depth(b) || a.localeCompare(b);
}

/**
 * Of several files in one folder that a tool would look for (e.g. GNUmakefile, makefile,
 * Makefile), keeps the one the tool uses: the first name in `preferred`.
 */
export function onePerFolder(files: readonly vscode.Uri[], preferred: readonly string[]): vscode.Uri[] {
	const best = new Map<string, vscode.Uri>();
	const rank = (uri: vscode.Uri) => preferred.indexOf(path.basename(uri.fsPath));
	for (const file of files) {
		const dir = path.dirname(file.fsPath);
		const current = best.get(dir);
		if (rank(file) >= 0 && (!current || rank(file) < rank(current))) {
			best.set(dir, file);
		}
	}
	return files.filter((file) => best.get(path.dirname(file.fsPath)) === file);
}

/** Reads a text file, or undefined when it can't be read. */
export async function readText(uri: vscode.Uri, context: DetectContext): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(uri.fsPath, 'utf8');
	} catch (error) {
		context.log.warn(`Skipping ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** The fields every detector fills in; `key` comes from the folder and `id`. */
export type CommandFields = Omit<HubCommand, 'key' | 'folder' | 'acceptsArgs'> & { acceptsArgs?: boolean };

export function makeCommand(context: DetectContext, fields: CommandFields): HubCommand {
	return {
		acceptsArgs: true,
		...fields,
		key: `${context.folder.uri.toString()}#${fields.id}`,
		folder: context.folder,
	};
}

/** A heading for the commands of one file, labeled by the file's path ("infra/docker-compose.yml"). */
export function fileGroup(context: DetectContext, source: string, file: vscode.Uri, description: string): CommandGroup {
	const relative = path.relative(context.folder.uri.fsPath, file.fsPath).split(path.sep).join('/');
	return {
		id: `${source}:${relativeDir(context, path.dirname(file.fsPath)) || 'root'}`,
		label: context.multiRoot ? `${context.folder.name}/${relative}` : relative,
		description,
		tooltip: relative,
		definedAt: file,
	};
}

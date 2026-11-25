import * as path from 'path';
import type { DetectContext } from '../model';

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

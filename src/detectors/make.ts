import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand } from '../model';
import { quoteArg } from '../shell';
import { fileGroup, findInFolder, isLongRunning, makeCommand, onePerFolder, readText, relativeDir } from './common';

/** The names GNU make looks for, in its order. */
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];

export interface MakeTarget {
	name: string;
	line: number;
	/** From a `## comment` after the target. */
	description?: string;
}

/**
 * The targets a person would run: rule names at the start of a line, skipping variable
 * assignments, special targets (.PHONY), pattern rules (%.o), file paths, targets built from
 * variables, and anything inside define … endef.
 */
export function parseMakeTargets(text: string): MakeTarget[] {
	const targets: MakeTarget[] = [];
	const seen = new Set<string>();
	let inDefine = false;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (inDefine) {
			inDefine = !/^\s*endef\b/.test(line);
			continue;
		}
		if (/^\s*define\b/.test(line)) {
			inDefine = true;
			continue;
		}
		// Recipes start with a tab; assignments (VAR = x, VAR := x, VAR ?= x) aren't rules.
		if (/^\t/.test(line) || /^\s*(?:export\s+|override\s+)?[\w.-]+\s*(?::{1,3}|[?+!])?=/.test(line)) {
			continue;
		}
		const match = /^([^\s#:=][^:#=]*?)\s*::?(?!=)([^#]*)(?:#(#?)\s*(.*))?$/.exec(line);
		if (!match) {
			continue;
		}
		const description = match[3] === '#' && match[4] ? match[4].trim() : undefined;
		for (const name of match[1].trim().split(/\s+/)) {
			if (/^\./.test(name) || /[%$/\\(){}]/.test(name) || /^(?:include|-include|sinclude|ifeq|ifneq|ifdef|ifndef|else|endif)$/.test(name) || seen.has(name)) {
				continue;
			}
			seen.add(name);
			targets.push({ name, line: i, description });
		}
	}
	return targets;
}

export const makeDetector: CommandDetector = {
	source: 'make',
	watchGlob: `**/{${MAKEFILES.join(',')}}`,

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const files = onePerFolder(await findInFolder(context, `**/{${MAKEFILES.join(',')}}`, 500), MAKEFILES);
		const commands: HubCommand[] = [];
		for (const file of files) {
			const text = await readText(file, context);
			if (text === undefined) {
				continue;
			}
			const group = fileGroup(context, 'make', file, 'make');
			const folderId = relativeDir(context, path.dirname(file.fsPath)) || 'root';
			for (const target of parseMakeTargets(text)) {
				commands.push(
					makeCommand(context, {
						id: `make:${folderId}:${target.name}`,
						label: target.name,
						source: 'make',
						group,
						cwd: vscode.Uri.file(path.dirname(file.fsPath)),
						commandLine: `make ${quoteArg(target.name)}`,
						definedAt: new vscode.Location(file, new vscode.Position(target.line, 0)),
						description: target.description,
						longRunning: isLongRunning(target.name, context.settings.longRunningNames),
					}),
				);
			}
		}
		return commands;
	},
};

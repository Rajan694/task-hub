import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand, ScriptArg } from '../model';
import { quoteArg } from '../shell';
import { fileGroup, findInFolder, isLongRunning, makeCommand, onePerFolder, readText, relativeDir } from './common';

const JUSTFILES = ['justfile', 'Justfile', 'JUSTFILE', '.justfile'];

export interface JustRecipe {
	name: string;
	line: number;
	/** The comment line above the recipe, or its [doc('…')] attribute. */
	description?: string;
	params: ScriptArg[];
}

/**
 * The public recipes of a justfile, with their parameters. Private recipes (a leading `_` or
 * the [private] attribute) are left out, as `just --list` does.
 */
export function parseJustRecipes(text: string): JustRecipe[] {
	const recipes: JustRecipe[] = [];
	const seen = new Set<string>();
	let comment: string | undefined;
	let attributes: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*$/.test(line)) {
			comment = undefined;
			attributes = [];
			continue;
		}
		if (/^\s/.test(line)) {
			continue; // recipe body
		}
		const commentMatch = /^#(?!!)\s?(.*)$/.exec(line);
		if (commentMatch) {
			comment = commentMatch[1].trim() || undefined;
			continue;
		}
		if (line.startsWith('[')) {
			attributes.push(...line.replace(/^\[|\]\s*$/g, '').split(/,\s*(?![^(]*\))/));
			continue;
		}
		const match = /^@?([A-Za-z_][\w-]*)((?:\s+[^:]*?)?)\s*:(?!=)/.exec(line);
		if (!match || /^(?:alias|set|export|import|mod)$/.test(match[1])) {
			comment = undefined;
			attributes = [];
			continue;
		}
		const name = match[1];
		const isPrivate = name.startsWith('_') || attributes.some((a) => a.trim() === 'private');
		const doc = attributes.map((a) => /^doc\(\s*(["'])(.*)\1\s*\)$/.exec(a.trim())?.[2]).find(Boolean);
		if (!isPrivate && !seen.has(name)) {
			seen.add(name);
			recipes.push({ name, line: i, description: doc ?? comment, params: parseParams(match[2]) });
		}
		comment = undefined;
		attributes = [];
	}
	return recipes;
}

/** `env target='prod' +files` → env (required), target (default prod), files (one or more). */
function parseParams(text: string): ScriptArg[] {
	const params: ScriptArg[] = [];
	for (const token of text.match(/[^\s=]+(?:=(?:'[^']*'|"[^"]*"|\S+))?/g) ?? []) {
		const match = /^([+*]?)\$?([A-Za-z_][\w-]*)(?:=(.*))?$/.exec(token);
		if (!match) {
			continue;
		}
		const [, variadic, name, rawDefault] = match;
		const defaultValue = rawDefault?.replace(/^(['"])(.*)\1$/, '$2');
		params.push({
			name,
			kind: 'text',
			defaultValue,
			required: defaultValue === undefined && variadic !== '*',
			variadic: variadic !== '' || undefined,
		});
	}
	return params;
}

export const justDetector: CommandDetector = {
	source: 'just',
	watchGlob: `**/{${JUSTFILES.join(',')}}`,

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const files = onePerFolder(await findInFolder(context, `**/{${JUSTFILES.join(',')}}`, 500), JUSTFILES);
		const commands: HubCommand[] = [];
		for (const file of files) {
			const text = await readText(file, context);
			if (text === undefined) {
				continue;
			}
			const group = fileGroup(context, 'just', file, 'just');
			const folderId = relativeDir(context, path.dirname(file.fsPath)) || 'root';
			for (const recipe of parseJustRecipes(text)) {
				commands.push(
					makeCommand(context, {
						id: `just:${folderId}:${recipe.name}`,
						label: recipe.name,
						source: 'just',
						group,
						cwd: vscode.Uri.file(path.dirname(file.fsPath)),
						commandLine: `just ${quoteArg(recipe.name)}`,
						definedAt: new vscode.Location(file, new vscode.Position(recipe.line, 0)),
						description: recipe.description,
						longRunning: isLongRunning(recipe.name, context.settings.longRunningNames),
						args: recipe.params.length ? recipe.params : undefined,
					}),
				);
			}
		}
		return commands;
	},
};

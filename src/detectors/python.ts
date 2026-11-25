import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, CommandGroup, DetectContext, HubCommand } from '../model';
import { findOnPath } from '../platform';
import { quoteArg } from '../shell';
import { fileGroup, findInFolder, isLongRunning, makeCommand, readText, relativeDir } from './common';

/** The Django commands people run most; others go through Run with Arguments… or a saved command. */
const DJANGO_COMMANDS = ['runserver', 'migrate', 'makemigrations', 'test'];

export interface TomlTask {
	name: string;
	line: number;
	description?: string;
}

/**
 * The tasks under one TOML table, e.g. `[tool.poe.tasks]`: its keys (`test = "pytest"`,
 * `lint = { cmd = "ruff .", help = "Lint" }`) and its sub-tables (`[tool.poe.tasks.build]`).
 * Keys starting with `_` (shared settings in PDM) are left out. Just enough TOML for these files.
 */
export function parseTomlTasks(text: string, table: string): TomlTask[] {
	const tasks: TomlTask[] = [];
	const seen = new Set<string>();
	const escaped = table.replace(/\./g, '\\.');
	const header = new RegExp(`^\\[\\s*${escaped}\\s*\\]\\s*(?:#.*)?$`);
	const subHeader = new RegExp(`^\\[\\s*${escaped}\\.(?:"([^"]+)"|'([^']+)'|([\\w-]+))\\s*\\]\\s*(?:#.*)?$`);
	let inTable = false;
	let subTask: TomlTask | undefined;
	let multiline: string | undefined;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (multiline) {
			if (line.includes(multiline)) {
				multiline = undefined;
			}
			continue;
		}
		const opens = /=\s*("""|''')/.exec(line);
		if (opens && line.split(opens[1]).length === 2) {
			multiline = opens[1];
		}
		if (line.startsWith('[')) {
			inTable = header.test(line);
			subTask = undefined;
			const sub = subHeader.exec(line);
			if (sub) {
				const name = sub[1] ?? sub[2] ?? sub[3];
				if (!name.startsWith('_') && !seen.has(name)) {
					seen.add(name);
					subTask = { name, line: i };
					tasks.push(subTask);
				}
			}
			continue;
		}
		if (subTask) {
			const help = /^help\s*=\s*(["'])(.*)\1/.exec(line);
			if (help) {
				subTask.description = help[2];
			}
			continue;
		}
		if (!inTable) {
			continue;
		}
		const key = /^(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*=/.exec(line);
		if (key) {
			const name = key[1] ?? key[2] ?? key[3];
			if (!name.startsWith('_') && !seen.has(name)) {
				seen.add(name);
				const help = /\bhelp\s*=\s*(["'])(.*?)\1/.exec(line);
				tasks.push({ name, line: i, description: help?.[2] });
			}
		}
	}
	return tasks;
}

/**
 * The project's own Python: a `.venv` or `venv` next to the file or at the workspace root,
 * else python3 (python on Windows). Returned relative to `cwd` when it's in the project.
 */
export function pythonFor(cwd: string, root: string): string {
	return venvProgram(cwd, root, 'python') ?? (process.platform === 'win32' ? 'python' : findOnPath('python3') ? 'python3' : 'python');
}

/** A program inside the project's virtual environment (`.venv/bin/poe`), relative to `cwd`, if it's there. */
function venvProgram(cwd: string, root: string, program: string): string | undefined {
	const bin = process.platform === 'win32' ? path.join('Scripts', `${program}.exe`) : path.join('bin', program);
	for (const base of [cwd, root]) {
		for (const venv of ['.venv', 'venv']) {
			const candidate = path.join(base, venv, bin);
			if (fs.existsSync(candidate)) {
				const relative = path.relative(cwd, candidate);
				return relative.startsWith('..') ? candidate : relative.split(path.sep).join('/');
			}
		}
	}
	return undefined;
}

/** Django's manage.py, and Poe the Poet and PDM tasks in pyproject.toml. */
export const pythonDetector: CommandDetector = {
	source: 'python',
	watchGlob: '**/{manage.py,pyproject.toml}',

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const root = context.folder.uri.fsPath;
		const commands: HubCommand[] = [];
		const files = await findInFolder(context, '**/{manage.py,pyproject.toml}', 200);
		const excluded = (file: vscode.Uri) => /[\\/](?:\.venv|venv|site-packages)[\\/]/.test(file.fsPath);
		for (const file of files.filter((f) => !excluded(f))) {
			const dir = path.dirname(file.fsPath);
			const folderId = relativeDir(context, dir) || 'root';
			const cwd = vscode.Uri.file(dir);
			const command = (id: string, label: string, commandLine: string, group: CommandGroup, line: number, description?: string) =>
				makeCommand(context, {
					id,
					label,
					source: 'python',
					group,
					cwd,
					commandLine,
					definedAt: new vscode.Location(file, new vscode.Position(line, 0)),
					description,
					longRunning: label === 'runserver' || isLongRunning(label, context.settings.longRunningNames),
				});

			if (path.basename(file.fsPath) === 'manage.py') {
				const group = fileGroup(context, 'django', file, 'django');
				const python = pythonFor(dir, root);
				for (const name of DJANGO_COMMANDS) {
					commands.push(command(`python:${folderId}:${name}`, name, `${quoteArg(python)} manage.py ${name}`, group, 0));
				}
				continue;
			}

			const text = await readText(file, context);
			if (text === undefined) {
				continue;
			}
			const poe = parseTomlTasks(text, 'tool.poe.tasks');
			if (poe.length) {
				const group = fileGroup(context, 'poe', file, 'poe');
				const program = quoteArg(venvProgram(dir, root, 'poe') ?? 'poe');
				for (const task of poe) {
					commands.push(command(`python:${folderId}:poe:${task.name}`, task.name, `${program} ${quoteArg(task.name)}`, group, task.line, task.description));
				}
			}
			const pdm = parseTomlTasks(text, 'tool.pdm.scripts');
			if (pdm.length) {
				const group = fileGroup(context, 'pdm', file, 'pdm');
				for (const script of pdm) {
					commands.push(command(`python:${folderId}:pdm:${script.name}`, script.name, `pdm run ${quoteArg(script.name)}`, group, script.line, script.description));
				}
			}
		}
		return commands;
	},
};

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, CommandGroup, DetectContext, HubCommand } from '../model';
import { quoteArg } from '../shell';
import { findInFolder, groupLabel, isLongRunning, makeCommand, positionAt, relativeDir } from './common';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/** Lockfiles in the order they are checked when a folder has more than one. */
const LOCKFILES: readonly [file: string, manager: PackageManager][] = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['package-lock.json', 'npm'],
	['npm-shrinkwrap.json', 'npm'],
];

/** Stop listing packages after this many, so huge repositories stay fast. */
const MAX_PACKAGES = 2000;

export interface PackageScript {
	name: string;
	/** The script's command, e.g. "vite build". */
	body: string;
	/** Zero-based position of the script's key in package.json. */
	line: number;
	character: number;
}

/** The scripts of a package.json, in file order, with where each one is. Throws on invalid JSON. */
export function parseScripts(text: string): PackageScript[] {
	const json = JSON.parse(text.replace(/^﻿/, '')) as { scripts?: unknown };
	const scripts = json?.scripts;
	if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
		return [];
	}
	const scriptsAt = Math.max(0, text.search(/"scripts"\s*:\s*\{/));
	let searchFrom = scriptsAt;
	const result: PackageScript[] = [];
	for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
		if (typeof body !== 'string') {
			continue;
		}
		const key = new RegExp(`${escapeRegExp(JSON.stringify(name))}\\s*:`, 'g');
		key.lastIndex = searchFrom;
		let match = key.exec(text);
		if (!match) {
			key.lastIndex = scriptsAt;
			match = key.exec(text);
		}
		const offset = match ? match.index : scriptsAt;
		if (match) {
			searchFrom = match.index + match[0].length;
		}
		result.push({ name, body, ...positionAt(text, offset) });
	}
	return result;
}

export interface ManagerInfo {
	manager: PackageManager;
	/** The file that decided it (a lockfile, or a package.json with a `packageManager` field); none for the npm default. */
	decidedBy?: string;
}

/**
 * Finds the package manager for the package in `dir`: the nearest `packageManager` field or
 * lockfile, walking up through parent folders, because in npm, pnpm, yarn and bun workspaces
 * the lockfile is only at the root. The walk stops at a repository root (a folder with `.git`),
 * the home folder or the file-system root; npm is the default.
 *
 * Pass the same `cache` for every package of one scan, so shared parents are read once.
 */
export function detectPackageManager(dir: string, cache = new Map<string, Promise<ManagerInfo>>()): Promise<ManagerInfo> {
	let result = cache.get(dir);
	if (!result) {
		result = (async () => {
			const here = await managerIn(dir);
			if (here) {
				return here;
			}
			const parent = path.dirname(dir);
			const stop = parent === dir || dir === os.homedir() || (await exists(path.join(dir, '.git')));
			return stop ? { manager: 'npm' as const } : detectPackageManager(parent, cache);
		})();
		cache.set(dir, result);
	}
	return result;
}

async function managerIn(dir: string): Promise<ManagerInfo | undefined> {
	const packageJson = path.join(dir, 'package.json');
	try {
		const field = (JSON.parse((await fs.promises.readFile(packageJson, 'utf8')).replace(/^﻿/, '')) as { packageManager?: unknown })
			.packageManager;
		// "pnpm@9.15.0", "yarn@4.5.0+sha512.…"
		const name = typeof field === 'string' ? field.split('@')[0].trim() : '';
		if ((MANAGERS as readonly string[]).includes(name)) {
			return { manager: name as PackageManager, decidedBy: packageJson };
		}
	} catch {
		// No package.json here, or not valid JSON: look for a lockfile instead.
	}
	for (const [file, manager] of LOCKFILES) {
		const lockfile = path.join(dir, file);
		if (await exists(lockfile)) {
			return { manager, decidedBy: lockfile };
		}
	}
	return undefined;
}

/** "pnpm run dev". Yarn gets `yarn run` too, so a script named like a yarn command (e.g. "install") still runs the script. */
export function runLine(manager: PackageManager, script: string, platform: NodeJS.Platform = process.platform): string {
	return `${manager} run ${quoteArg(script, platform)}`;
}

export const npmDetector: CommandDetector = {
	source: 'npm',
	watchGlob: `**/{package.json,${LOCKFILES.map(([file]) => file).join(',')}}`,

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const files = await findInFolder(context, '**/package.json', MAX_PACKAGES);
		const packages = files
			.map((uri) => ({ uri, relative: relativeDir(context, path.dirname(uri.fsPath)) }))
			.sort((a, b) => (a.relative === '' ? -1 : b.relative === '' ? 1 : a.relative.localeCompare(b.relative)));

		const managers = new Map<string, Promise<ManagerInfo>>();
		const commands: HubCommand[] = [];
		for (const { uri, relative } of packages) {
			if (context.token.isCancellationRequested) {
				return [];
			}
			let scripts: PackageScript[];
			try {
				scripts = parseScripts(await fs.promises.readFile(uri.fsPath, 'utf8'));
			} catch (error) {
				context.log.warn(`Skipping ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (scripts.length === 0) {
				continue;
			}
			const dir = path.dirname(uri.fsPath);
			const { manager, decidedBy } = await detectPackageManager(dir, managers);
			const packageId = relative || 'root';
			const group: CommandGroup = {
				id: `npm:${packageId}`,
				label: groupLabel(context, relative),
				description: `package.json · ${manager}`,
				tooltip: `${relative ? `${relative}/` : ''}package.json — runs with ${manager}${
					decidedBy ? ` (from ${path.relative(dir, decidedBy).split(path.sep).join('/')})` : ' (no lockfile found)'
				}`,
				definedAt: uri,
			};
			for (const script of scripts) {
				commands.push(
					makeCommand(context, {
						id: `npm:${packageId}:${script.name}`,
						label: script.name,
						source: 'npm',
						group,
						cwd: vscode.Uri.file(dir),
						commandLine: runLine(manager, script.name),
						definedAt: new vscode.Location(uri, new vscode.Position(script.line, script.character)),
						body: script.body,
						longRunning: isLongRunning(script.name, context.settings.longRunningNames),
					}),
				);
			}
		}
		return commands;
	},
};

function exists(file: string): Promise<boolean> {
	return fs.promises.access(file).then(
		() => true,
		() => false,
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

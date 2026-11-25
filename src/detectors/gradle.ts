import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand } from '../model';
import { findInFolder, groupLabel, makeCommand, readText, relativeDir } from './common';
import { buildToolProgram, filesSignature } from './java';

const SETTINGS = ['settings.gradle', 'settings.gradle.kts'];
const BUILD_FILES = ['build.gradle', 'build.gradle.kts'];

export interface GradleTask {
	name: string;
	description?: string;
}

/** `include ':api', 'lib:core'` or `include("api", ":lib:core")` → ['api', 'lib:core']. */
export function parseSettingsIncludes(text: string): string[] {
	const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const projects: string[] = [];
	for (const statement of code.matchAll(/\binclude\b(?!Build|Flat)\s*\(?([^)\n]*)/g)) {
		for (const name of statement[1].matchAll(/["']([^"']+)["']/g)) {
			const project = name[1].replace(/^:/, '');
			if (project && !projects.includes(project)) {
				projects.push(project);
			}
		}
	}
	return projects;
}

/** Which run tasks a build file adds: `run` with the application plugin, `bootRun` with Spring Boot. */
export function gradleRunTasks(text: string): string[] {
	const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const tasks: string[] = [];
	if (/\bid\s*\(?\s*["']application["']|^\s*application\s*$|apply\s*\(?\s*plugin\s*[:=]\s*["']application["']/m.test(code)) {
		tasks.push('run');
	}
	if (/\bid\s*\(?\s*["']org\.springframework\.boot["']|apply\s*\(?\s*plugin\s*[:=]\s*["']org\.springframework\.boot["']/.test(code)) {
		tasks.push('bootRun');
	}
	return tasks;
}

/**
 * The tasks in the output of `gradle tasks --all --console=plain`: the lines `name - description`
 * (or just `name`) under each "… tasks" heading. Tasks of other projects (`api:compileJava`) and
 * the Rules section are left out.
 */
export function parseGradleTasks(output: string): GradleTask[] {
	const tasks: GradleTask[] = [];
	const lines = output.split(/\r?\n/);
	let inSection = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/^-{3,}$/.test(line)) {
			const title = lines[i - 1]?.trim() ?? '';
			inSection = !!title && !/^-+$/.test(title) && !/^(?:rules|tasks runnable from)/i.test(title);
			continue;
		}
		if (!line) {
			inSection = false;
			continue;
		}
		const match = inSection ? /^([A-Za-z][\w.-]*)(?: - (.*))?$/.exec(line) : null;
		if (match && !tasks.some((t) => t.name === match[1])) {
			tasks.push({ name: match[1], description: match[2]?.trim() || undefined });
		}
	}
	return tasks;
}

interface CachedTasks {
	signature: string;
	tasks: GradleTask[];
}

const CACHE_KEY = 'taskHub.gradleTasks';

/**
 * The full task lists fetched by Load All Tasks, per Gradle project, kept in the workspace
 * state until a settings or build file changes (starting Gradle is slow).
 */
export class GradleTaskCache {
	constructor(private readonly state: vscode.Memento) {}

	get(key: string, signature: string): GradleTask[] | undefined {
		const entry = this.state.get<Record<string, CachedTasks>>(CACHE_KEY, {})[key];
		return entry?.signature === signature ? entry.tasks : undefined;
	}

	async set(key: string, signature: string, tasks: GradleTask[]): Promise<void> {
		const all = this.state.get<Record<string, CachedTasks>>(CACHE_KEY, {});
		await this.state.update(CACHE_KEY, { ...all, [key]: { signature, tasks } });
	}

	/** Forgets every loaded list. */
	async clear(): Promise<void> {
		await this.state.update(CACHE_KEY, undefined);
	}
}

/**
 * Gradle builds, one heading per project (the root and each `include`d subproject). Before
 * Load All Tasks, a project lists `taskHub.gradle.defaultTasks`, plus `run` or `bootRun` when
 * its build file applies the application or Spring Boot plugin. Every command runs from the
 * root, where the wrapper is, and names a subproject by its path (`./gradlew :api:test`).
 */
export function createGradleDetector(cache: GradleTaskCache): CommandDetector {
	return {
		source: 'gradle',
		watchGlob: `**/{${[...SETTINGS, ...BUILD_FILES].join(',')}}`,

		async detect(context: DetectContext): Promise<HubCommand[]> {
			const settingsFiles = await findInFolder(context, `**/{${SETTINGS.join(',')}}`, 200);
			const buildFiles = await findInFolder(context, `**/{${BUILD_FILES.join(',')}}`, 1000);
			const roots = new Map<string, vscode.Uri | undefined>(settingsFiles.map((f) => [path.dirname(f.fsPath), f]));
			// A build file outside every multi-project build is a project of its own.
			for (const file of buildFiles) {
				const dir = path.dirname(file.fsPath);
				if (![...roots.keys()].some((root) => dir === root || dir.startsWith(root + path.sep))) {
					roots.set(dir, undefined);
				}
			}
			const defaults = context.settings.gradleDefaultTasks;

			const commands: HubCommand[] = [];
			for (const [rootDir, settings] of roots) {
				const { program, wrapped } = buildToolProgram(rootDir, 'gradlew', 'gradle');
				const includes = settings ? parseSettingsIncludes((await readText(settings, context)) ?? '') : [];
				for (const projectPath of [':', ...includes.map((p) => `:${p}`)]) {
					const dir = projectPath === ':' ? rootDir : path.join(rootDir, ...projectPath.slice(1).split(':'));
					const buildFile = BUILD_FILES.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file));
					const runTasks = buildFile ? gradleRunTasks((await readText(vscode.Uri.file(buildFile), context)) ?? '') : [];
					const signature = filesSignature([...(settings ? [settings.fsPath] : []), ...(buildFile ? [buildFile] : [])]);
					const cacheKey = `${rootDir}|${projectPath}`;
					const loaded = cache.get(cacheKey, signature);
					const tasks: GradleTask[] = loaded ?? [...defaults, ...runTasks].map((name) => ({ name }));

					const folderPath = relativeDir(context, dir);
					const definedAt = buildFile ? vscode.Uri.file(buildFile) : settings;
					const prefix = projectPath === ':' ? '' : `${projectPath}:`;
					const group = {
						id: `gradle:${folderPath || 'root'}`,
						label: groupLabel(context, folderPath),
						description: `${buildFile ? path.basename(buildFile) : 'gradle'} · ${wrapped ? 'Gradle wrapper' : 'gradle'}${loaded ? ' · all tasks' : ''}`,
						tooltip: `Gradle project ${projectPath === ':' ? path.basename(rootDir) : projectPath}${loaded ? '' : ' — right-click → Load All Tasks for the full list'}`,
						definedAt,
						loadAllTasks: loaded
							? undefined
							: { cacheKey, signature, cwd: rootDir, commandLine: `${program} ${prefix}tasks --all --console=plain` },
					};
					for (const task of tasks) {
						commands.push(
							makeCommand(context, {
								id: `gradle:${folderPath || 'root'}:${task.name}`,
								label: task.name,
								source: 'gradle',
								group,
								cwd: vscode.Uri.file(rootDir),
								commandLine: `${program} ${prefix}${task.name}`,
								definedAt: definedAt ? new vscode.Location(definedAt, new vscode.Position(0, 0)) : undefined,
								description: task.description,
								longRunning: task.name === 'run' || task.name === 'bootRun' || runTasks.includes(task.name),
							}),
						);
					}
				}
			}
			return commands;
		},
	};
}

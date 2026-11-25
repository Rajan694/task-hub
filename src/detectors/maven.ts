import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand } from '../model';
import { quoteArg } from '../shell';
import { findInFolder, groupLabel, makeCommand, readText, relativeDir } from './common';
import { buildToolProgram } from './java';

const GOALS = ['clean', 'compile', 'test', 'package', 'install', 'verify'];

export interface PomInfo {
	artifactId?: string;
	/** `<module>` entries, as written (folder paths, or a path to another pom). */
	modules: string[];
	/** The Spring Boot Maven plugin is in the pom, so `spring-boot:run` is offered. */
	springBoot: boolean;
}

/** What Task Hub needs from a pom.xml: its own artifactId (not the parent's), its modules, and Spring Boot. */
export function parsePom(text: string): PomInfo {
	const xml = text
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<profiles>[\s\S]*?<\/profiles>/g, '')
		.replace(/<parent>[\s\S]*?<\/parent>/g, '');
	const artifactId = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(xml)?.[1];
	const modulesBlock = /<modules>([\s\S]*?)<\/modules>/.exec(xml)?.[1] ?? '';
	const modules = [...modulesBlock.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]);
	return { artifactId, modules, springBoot: /<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/.test(xml) };
}

/**
 * Maven projects, one heading per module. Every command runs from the project root, where
 * the wrapper and the root pom are, and names a module with `-pl`, because Maven must see
 * the whole multi-module build.
 */
export const mavenDetector: CommandDetector = {
	source: 'maven',
	watchGlob: '**/pom.xml',

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const poms = new Map<string, { file: vscode.Uri; info: PomInfo }>();
		for (const file of await findInFolder(context, '**/pom.xml', 1000)) {
			const text = await readText(file, context);
			if (text !== undefined) {
				poms.set(path.dirname(file.fsPath), { file, info: parsePom(text) });
			}
		}

		// A pom listed as another pom's module belongs to that build; the rest are roots.
		const childDirs = (dir: string) =>
			poms.get(dir)!.info.modules.map((m) => {
				const target = path.resolve(dir, m);
				return path.basename(target) === 'pom.xml' ? path.dirname(target) : target;
			});
		const modulesOfSomeone = new Set<string>();
		for (const dir of poms.keys()) {
			for (const child of childDirs(dir)) {
				modulesOfSomeone.add(child);
			}
		}

		const commands: HubCommand[] = [];
		for (const rootDir of [...poms.keys()].filter((dir) => !modulesOfSomeone.has(dir))) {
			const { program, wrapped } = buildToolProgram(rootDir, 'mvnw', 'mvn');
			const visited = new Set<string>();
			const visit = (dir: string) => {
				const pom = poms.get(dir);
				if (!pom || visited.has(dir)) {
					return;
				}
				visited.add(dir);
				const module = path.relative(rootDir, dir).split(path.sep).join('/');
				const folderPath = relativeDir(context, dir);
				const group = {
					id: `maven:${folderPath || 'root'}`,
					label: groupLabel(context, folderPath),
					description: `pom.xml · ${wrapped ? 'Maven wrapper' : 'mvn'}`,
					tooltip: `${pom.info.artifactId ?? path.basename(dir)}${module ? ` (module ${module} of ${path.basename(rootDir)})` : ''}`,
					definedAt: pom.file,
				};
				for (const goal of [...GOALS, ...(pom.info.springBoot ? ['spring-boot:run'] : [])]) {
					commands.push(
						makeCommand(context, {
							id: `maven:${folderPath || 'root'}:${goal}`,
							label: goal,
							source: 'maven',
							group,
							cwd: vscode.Uri.file(rootDir),
							commandLine: `${program}${module ? ` -pl ${quoteArg(module)}` : ''} ${goal}`,
							definedAt: new vscode.Location(pom.file, new vscode.Position(0, 0)),
							longRunning: goal === 'spring-boot:run',
						}),
					);
				}
				for (const child of childDirs(dir)) {
					visit(child);
				}
			};
			visit(rootDir);
		}
		return commands;
	},
};

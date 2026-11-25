import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand } from '../model';
import { quoteArg } from '../shell';
import { fileGroup, findInFolder, makeCommand, onePerFolder, readText, relativeDir } from './common';
import { mappingEntries } from './yaml';

/** The names `docker compose` looks for, in its order. */
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

export interface ComposeService {
	name: string;
	line: number;
	character: number;
	/** The image, or "build" when the service is built from a Dockerfile. */
	image?: string;
}

export function parseComposeServices(text: string): ComposeService[] {
	return mappingEntries(text, 'services').map((entry) => ({
		name: entry.key,
		line: entry.line,
		character: entry.character,
		image: entry.values.image ?? ('build' in entry.values ? 'build' : undefined),
	}));
}

/**
 * One row per service. Run starts it in the background (`up -d`); its state then comes from
 * `docker compose ps` (see ServiceMonitor), and the row offers Logs and Stop. Each command uses
 * the file's folder, where `docker compose` finds this same file by itself.
 */
export const composeDetector: CommandDetector = {
	source: 'compose',
	watchGlob: `**/{${COMPOSE_FILES.join(',')}}`,

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const files = onePerFolder(await findInFolder(context, `**/{${COMPOSE_FILES.join(',')}}`, 200), COMPOSE_FILES);
		const commands: HubCommand[] = [];
		for (const file of files) {
			const text = await readText(file, context);
			if (text === undefined) {
				continue;
			}
			const group = fileGroup(context, 'compose', file, 'docker compose');
			const folderId = relativeDir(context, path.dirname(file.fsPath)) || 'root';
			for (const service of parseComposeServices(text)) {
				const name = quoteArg(service.name);
				commands.push(
					makeCommand(context, {
						id: `compose:${folderId}:${service.name}`,
						label: service.name,
						source: 'compose',
						group,
						cwd: vscode.Uri.file(path.dirname(file.fsPath)),
						commandLine: `docker compose up -d ${name}`,
						definedAt: new vscode.Location(file, new vscode.Position(service.line, service.character)),
						description: service.image,
						longRunning: false,
						acceptsArgs: false,
						service: { name: service.name },
						actions: [
							{ id: 'logs', label: 'Logs', commandLine: `docker compose logs -f --tail 200 ${name}`, longRunning: true },
							{ id: 'stop', label: 'Stop Service', commandLine: `docker compose stop ${name}`, longRunning: false },
						],
					}),
				);
			}
		}
		return commands;
	},
};

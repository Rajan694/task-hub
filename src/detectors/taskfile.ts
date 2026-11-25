import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand } from '../model';
import { quoteArg } from '../shell';
import { fileGroup, findInFolder, isLongRunning, makeCommand, onePerFolder, readText, relativeDir } from './common';
import { mappingEntries } from './yaml';

/** The names Task looks for, in its order. */
const TASKFILES = [
	'Taskfile.yml',
	'taskfile.yml',
	'Taskfile.yaml',
	'taskfile.yaml',
	'Taskfile.dist.yml',
	'taskfile.dist.yml',
	'Taskfile.dist.yaml',
	'taskfile.dist.yaml',
];

export interface TaskfileTask {
	name: string;
	line: number;
	description?: string;
}

/** The tasks of a Taskfile, without the ones marked `internal: true`. */
export function parseTaskfile(text: string): TaskfileTask[] {
	return mappingEntries(text, 'tasks')
		.filter((entry) => entry.values.internal !== 'true')
		.map((entry) => ({ name: entry.key, line: entry.line, description: entry.values.desc || entry.values.summary || undefined }));
}

export const taskfileDetector: CommandDetector = {
	source: 'taskfile',
	watchGlob: `**/{${TASKFILES.join(',')}}`,

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const files = onePerFolder(await findInFolder(context, `**/{${TASKFILES.join(',')}}`, 500), TASKFILES);
		const commands: HubCommand[] = [];
		for (const file of files) {
			const text = await readText(file, context);
			if (text === undefined) {
				continue;
			}
			const group = fileGroup(context, 'taskfile', file, 'task');
			const folderId = relativeDir(context, path.dirname(file.fsPath)) || 'root';
			for (const task of parseTaskfile(text)) {
				commands.push(
					makeCommand(context, {
						id: `taskfile:${folderId}:${task.name}`,
						label: task.name,
						source: 'taskfile',
						group,
						cwd: vscode.Uri.file(path.dirname(file.fsPath)),
						commandLine: `task ${quoteArg(task.name)}`,
						definedAt: new vscode.Location(file, new vscode.Position(task.line, 0)),
						description: task.description,
						longRunning: isLongRunning(task.name, context.settings.longRunningNames),
					}),
				);
			}
		}
		return commands;
	},
};

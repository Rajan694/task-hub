import * as fs from 'fs';
import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';
import * as vscode from 'vscode';
import type { CommandDetector, DetectContext, HubCommand } from '../model';
import { makeCommand, namedGroupLabel, positionAt } from './common';

export interface TasksJsonTask {
	/** The name VS Code gives the task, used to find it again when it runs. */
	label: string;
	line: number;
	character: number;
	detail?: string;
	isBackground: boolean;
	/** What it runs, for the tooltip and Copy Command. */
	commandText: string;
}

/** The tasks in a tasks.json (comments and trailing commas allowed), without hidden ones. */
export function parseTasksJson(text: string): TasksJsonTask[] {
	const tree = parseTree(text, [], { allowTrailingComma: true });
	const list = tree && findNodeAtLocation(tree, ['tasks']);
	if (list?.type !== 'array') {
		return [];
	}
	const tasks: TasksJsonTask[] = [];
	for (const node of list.children ?? []) {
		const task = getNodeValue(node) as Record<string, unknown> | undefined;
		if (!task || typeof task !== 'object' || task.hide === true) {
			continue;
		}
		const script = typeof task.script === 'string' ? task.script : undefined;
		const label =
			typeof task.label === 'string' ? task.label : typeof task.taskName === 'string' ? task.taskName : task.type === 'npm' && script ? `npm: ${script}` : undefined;
		if (!label) {
			continue;
		}
		const args = Array.isArray(task.args) ? task.args.filter((a): a is string => typeof a === 'string') : [];
		const commandText = typeof task.command === 'string' ? [task.command, ...args].join(' ') : typeof task.type === 'string' ? `${task.type}: ${script ?? label}` : label;
		tasks.push({
			label,
			...positionAt(text, node.offset),
			detail: typeof task.detail === 'string' ? task.detail : undefined,
			isBackground: task.isBackground === true,
			commandText,
		});
	}
	return tasks;
}

/** Tasks from .vscode/tasks.json. They run through VS Code's own task system, as they would from Run Task. */
export const vscodeTasksDetector: CommandDetector = {
	source: 'vscode',
	watchGlob: '.vscode/tasks.json',

	async detect(context: DetectContext): Promise<HubCommand[]> {
		const file = vscode.Uri.joinPath(context.folder.uri, '.vscode', 'tasks.json');
		let text: string;
		try {
			text = await fs.promises.readFile(file.fsPath, 'utf8');
		} catch {
			return [];
		}
		const group = {
			id: 'vscode',
			label: namedGroupLabel(context, 'VS Code tasks'),
			description: '.vscode/tasks.json',
			tooltip: 'Tasks from .vscode/tasks.json, run by VS Code',
			definedAt: file,
		};
		return parseTasksJson(text).map((task) =>
			makeCommand(context, {
				id: `vscode:${task.label}`,
				label: task.label,
				source: 'vscode',
				group,
				cwd: context.folder.uri,
				commandLine: task.commandText,
				definedAt: new vscode.Location(file, new vscode.Position(task.line, task.character)),
				description: task.detail,
				longRunning: task.isBackground,
				acceptsArgs: false,
				vscodeTask: { label: task.label },
			}),
		);
	},
};

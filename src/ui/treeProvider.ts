import * as path from 'path';
import * as vscode from 'vscode';
import { failureReason, formatAgo, formatDuration, statusText } from '../format';
import type { CommandGroup, HubCommand, RunState, SourceKind } from '../model';
import type { CommandRegistry } from '../registry';
import type { ServiceMonitor } from '../services';
import type { RunStateStore } from '../state';

export interface GroupNode {
	readonly kind: 'group';
	readonly group: CommandGroup;
	readonly source: SourceKind;
	readonly folder: vscode.WorkspaceFolder;
	readonly children: CommandNode[];
}

export interface CommandNode {
	readonly kind: 'command';
	readonly command: HubCommand;
	readonly parent: GroupNode;
}

export type TreeNode = GroupNode | CommandNode;

const GROUP_ICONS: Record<SourceKind, string> = {
	npm: 'package',
	make: 'tools',
	just: 'checklist',
	taskfile: 'tasklist',
	compose: 'server',
	vscode: 'vscode',
	saved: 'bookmark',
	python: 'symbol-namespace',
	script: 'terminal',
	maven: 'symbol-package',
	gradle: 'symbol-package',
};

/** The Commands view: one heading per package.json, Makefile, compose file, script folder…; one row per command. */
export class CommandsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private roots: GroupNode[] = [];
	private byKey = new Map<string, CommandNode>();
	private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly disposables: vscode.Disposable[];

	constructor(
		private readonly registry: CommandRegistry,
		private readonly states: RunStateStore,
		private readonly services: ServiceMonitor,
	) {
		this.rebuild();
		this.disposables = [
			this.changed,
			registry.onDidChange(() => {
				this.rebuild();
				this.changed.fire(undefined);
			}),
			states.onDidChange((key) => {
				const node = this.byKey.get(key);
				if (node) {
					this.changed.fire(node);
				}
			}),
			services.onDidChange(() => {
				for (const node of this.byKey.values()) {
					if (node.command.service) {
						this.changed.fire(node);
					}
				}
			}),
		];
	}

	/** The row of a command, if it is in the tree. */
	nodeFor(key: string): CommandNode | undefined {
		return this.byKey.get(key);
	}

	getChildren(node?: TreeNode): TreeNode[] {
		if (!node) {
			return this.roots;
		}
		return node.kind === 'group' ? node.children : [];
	}

	getParent(node: TreeNode): TreeNode | undefined {
		return node.kind === 'command' ? node.parent : undefined;
	}

	getTreeItem(node: TreeNode): vscode.TreeItem {
		if (node.kind === 'group') {
			const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
			item.id = `group:${node.folder.uri.toString()}#${node.group.id}`;
			item.description = node.group.description;
			item.tooltip = node.group.tooltip;
			item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.source]);
			item.contextValue = node.group.definedAt ? 'group.file' : 'group';
			return item;
		}
		const { command } = node;
		const row = rowState(command, this.states.get(command.key), this.services.isRunning(command.key));
		const item = new vscode.TreeItem(command.label, vscode.TreeItemCollapsibleState.None);
		item.id = command.key;
		item.description = row.text;
		item.iconPath = row.icon;
		item.contextValue = row.contextValue;
		// The tooltip is built on hover (resolveTreeItem), so "12s ago" is current.
		return item;
	}

	resolveTreeItem(item: vscode.TreeItem, node: TreeNode): vscode.TreeItem {
		if (node.kind === 'command') {
			item.tooltip = commandTooltip(node.command, this.states.get(node.command.key), this.services.isRunning(node.command.key));
		}
		return item;
	}

	private rebuild(): void {
		const groups = new Map<string, GroupNode>();
		const byKey = new Map<string, CommandNode>();
		for (const command of this.registry.all()) {
			const groupKey = `${command.folder.uri.toString()}#${command.group.id}`;
			let group = groups.get(groupKey);
			if (!group) {
				group = { kind: 'group', group: command.group, source: command.source, folder: command.folder, children: [] };
				groups.set(groupKey, group);
			}
			const node: CommandNode = { kind: 'command', command, parent: group };
			group.children.push(node);
			byKey.set(command.key, node);
		}
		this.roots = [...groups.values()];
		this.byKey = byKey;
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

interface RowState {
	text: string;
	icon: vscode.ThemeIcon;
	contextValue: string;
}

/**
 * What a row shows. A compose service that docker reports as running shows "running" even
 * when Task Hub didn't start it; one that isn't running shows as idle unless its last start failed.
 */
export function rowState(command: HubCommand, state: RunState, serviceUp = false): RowState {
	const flags = rowFlags(command);
	if (command.service && state.status !== 'running' && state.status !== 'ready' && state.status !== 'failed') {
		return serviceUp
			? { text: 'running', icon: new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('testing.iconPassed')), contextValue: `cmd.up${flags}` }
			: { text: command.description ?? '', icon: new vscode.ThemeIcon('circle-outline'), contextValue: `cmd.idle${flags}` };
	}
	if (state.status === 'idle' && command.unavailable) {
		return { text: command.unavailable, icon: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')), contextValue: `cmd.idle${flags}` };
	}
	return {
		text: state.status === 'idle' ? (command.description ?? '') : statusText(state),
		icon: statusIcon(state),
		contextValue: contextValue(state) + flags,
	};
}

/**
 * The row's context value, which decides its buttons (see `menus` in package.json):
 * `cmd.idle`, `cmd.passed`, `cmd.failed`, `cmd.stopped`, `cmd.running`, `cmd.running.url`
 * once a dev-server URL was found, and `cmd.up` for a running compose service.
 * Flags follow: `+args` (Run with Arguments…), `+savable`, `+saved`, `+service`.
 */
export function contextValue(state: RunState): string {
	switch (state.status) {
		case 'running':
			return 'cmd.running';
		case 'ready':
			return state.url ? 'cmd.running.url' : 'cmd.running.ready';
		default:
			return `cmd.${state.status}`;
	}
}

function rowFlags(command: HubCommand): string {
	const flags: string[] = [];
	if (command.acceptsArgs) {
		flags.push('args');
	}
	if (command.savedId) {
		flags.push('saved');
	} else if (command.acceptsArgs) {
		flags.push('savable');
	}
	if (command.service) {
		flags.push('service');
	}
	return flags.map((f) => `+${f}`).join('');
}

function statusIcon(state: RunState): vscode.ThemeIcon {
	switch (state.status) {
		case 'idle':
			return new vscode.ThemeIcon('circle-outline');
		case 'running':
		case 'ready':
			return new vscode.ThemeIcon('sync~spin');
		case 'passed':
			return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
		case 'failed':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
		case 'stopped':
			return new vscode.ThemeIcon('debug-stop');
	}
}

function commandTooltip(command: HubCommand, state: RunState, serviceUp: boolean): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.appendMarkdown(`**${escape(command.label)}**`);
	if (command.longRunning) {
		md.appendMarkdown(' · long-running');
	}
	md.appendMarkdown('\n\n');
	md.appendCodeblock(command.commandLine, command.vscodeTask ? 'plaintext' : 'shellscript');
	if (command.body && command.body !== command.commandLine) {
		md.appendMarkdown(`Script: \`${command.body.replace(/`/g, "'")}\`\n\n`);
	}
	if (command.description) {
		md.appendText(`${command.args?.length ? 'Takes: ' : ''}${command.description}`);
		md.appendMarkdown('\n\n');
	}
	if (command.unavailable) {
		md.appendText(`Can't run here: ${command.unavailable}.`);
		md.appendMarkdown('\n\n');
	}
	const relative = path.relative(command.folder.uri.fsPath, command.cwd.fsPath).split(path.sep).join('/');
	md.appendMarkdown(`Runs in: \`${command.folder.name}${relative ? `/${relative}` : ''}\`${command.vscodeTask ? ' (by VS Code)' : ''}\n\n`);

	const now = Date.now();
	if (command.service && serviceUp) {
		md.appendMarkdown('The service is running (docker compose ps).');
		return md;
	}
	switch (state.status) {
		case 'idle':
			md.appendMarkdown('Not run yet.');
			break;
		case 'running':
		case 'ready':
			md.appendMarkdown(`Running for ${formatDuration(now - (state.startedAt ?? now))}`);
			if (state.url) {
				md.appendMarkdown(` at ${state.url}`);
			}
			break;
		default: {
			const outcome =
				state.status === 'passed' ? `Passed${state.exitCode === 0 ? ' (exit 0)' : ''}` : state.status === 'stopped' ? 'Stopped' : `Failed (${failureReason(state)})`;
			md.appendMarkdown(`${outcome} ${formatAgo(now - (state.endedAt ?? now))}`);
			if (state.startedAt !== undefined && state.endedAt !== undefined) {
				md.appendMarkdown(`, took ${formatDuration(state.endedAt - state.startedAt)}`);
			}
		}
	}
	return md;
}

function escape(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

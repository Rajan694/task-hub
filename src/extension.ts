import * as vscode from 'vscode';

/**
 * Commands declared in package.json that don't have a real handler yet. Each one gets
 * its handler as its milestone lands (see docs/DESIGN.md, "Milestones"); until then it
 * shows a short notice, so clicking it never fails with "command not found".
 */
const PLANNED_COMMANDS = [
	'taskHub.run',
	'taskHub.stop',
	'taskHub.restart',
	'taskHub.openUrl',
	'taskHub.showOutput',
	'taskHub.addCommand',
	'taskHub.quickRun',
] as const;

/** The Commands view. Empty until the detectors land, so the view shows its welcome text. */
class CommandsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	refresh(): void {
		this.changed.fire();
	}

	getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
		return item;
	}

	getChildren(): vscode.TreeItem[] {
		return [];
	}

	dispose(): void {
		this.changed.dispose();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Task Hub', { log: true });
	context.subscriptions.push(log);
	log.info(`Task Hub ${context.extension.packageJSON.version} activated`);

	const tree = new CommandsTreeProvider();
	context.subscriptions.push(
		tree,
		vscode.window.registerTreeDataProvider('taskHub.commands', tree),
		vscode.commands.registerCommand('taskHub.refresh', () => tree.refresh()),
	);

	for (const id of PLANNED_COMMANDS) {
		context.subscriptions.push(
			vscode.commands.registerCommand(id, () => {
				void vscode.window.showInformationMessage(`Task Hub: "${id}" is not implemented yet.`);
			}),
		);
	}
}

export function deactivate(): void {}

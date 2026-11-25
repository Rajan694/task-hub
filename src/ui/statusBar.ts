import * as vscode from 'vscode';
import { portLabel } from '../format';
import type { CommandRegistry } from '../registry';
import type { Runner } from '../runner/runner';
import type { RunStateStore } from '../state';

/** "$(sync~spin) 2 running", or just a play icon when nothing runs. */
export function statusBarText(running: number): string {
	return running ? `$(sync~spin) ${running} running` : '$(play)';
}

/** The status bar item: how many commands run; a click opens the quick-pick runner. */
export function registerStatusBar(runner: Runner, states: RunStateStore, registry: CommandRegistry): vscode.Disposable {
	const item = vscode.window.createStatusBarItem('taskHub.status', vscode.StatusBarAlignment.Left, 10);
	item.name = 'Task Hub';
	item.command = 'taskHub.quickRun';

	const update = () => {
		const running = runner.runningCommands();
		item.text = statusBarText(running.length);
		if (running.length) {
			const md = new vscode.MarkdownString('**Task Hub: running**\n\n');
			for (const command of running) {
				const url = states.get(command.key).url;
				md.appendText(`• ${command.group.label} › ${command.label}${url ? ` ${portLabel(url)}` : ''}\n`);
			}
			md.appendMarkdown('\nClick to run or stop a command.');
			item.tooltip = md;
		} else {
			item.tooltip = 'Task Hub: run a command';
		}
		if (running.length || registry.all().length) {
			item.show();
		} else {
			item.hide();
		}
	};
	update();
	return vscode.Disposable.from(item, states.onDidChange(update), registry.onDidChange(update));
}

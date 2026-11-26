import * as vscode from 'vscode';
import type { HubCommand, ScriptArg } from '../model';
import { splitArgs } from '../shell';
import { splitAlternatives } from './usage';

/** The answers given for each argument, by argument name; switches are true or false. */
export type ArgValues = Record<string, string | boolean>;

interface Remembered {
	values?: ArgValues;
	/** Free text typed for "Arguments" or Run with Arguments…. */
	text?: string;
}

const MEMORY_KEY = 'taskHub.lastArgs';

/** The last answers per command, kept in the workspace state so they survive a reload. */
export class ArgMemory {
	constructor(private readonly state: vscode.Memento) {}

	get(key: string): Remembered {
		return this.state.get<Record<string, Remembered>>(MEMORY_KEY, {})[key] ?? {};
	}

	async set(key: string, value: Remembered): Promise<void> {
		const all = this.state.get<Record<string, Remembered>>(MEMORY_KEY, {});
		await this.state.update(MEMORY_KEY, { ...all, [key]: { ...all[key], ...value } });
	}
}

/**
 * Asks for what the command takes before it runs: one prompt per argument (a pick list for
 * known choices, a text box otherwise, filled with the last value or the default) and one
 * multi-select for all switches. Commands with nothing known get one optional text box.
 * Resolves with the argument list, or undefined when the user pressed Escape.
 */
export async function askForArgs(command: HubCommand, memory: ArgMemory): Promise<string[] | undefined> {
	if (command.args?.length) {
		return askStructured(command, command.args, memory);
	}
	if (command.freeArgs) {
		return askFreeText(command, memory, 'Arguments (optional)');
	}
	return [];
}

/** Run with Arguments…: extra words after the command line, e.g. `-- --watch`. */
export function askExtraArgs(command: HubCommand, memory: ArgMemory): Promise<string[] | undefined> {
	return askFreeText(command, memory, `Arguments to add after: ${command.commandLine}`);
}

async function askFreeText(command: HubCommand, memory: ArgMemory, prompt: string): Promise<string[] | undefined> {
	const text = await vscode.window.showInputBox({
		title: command.label,
		prompt,
		value: memory.get(command.key).text ?? '',
		placeHolder: command.source === 'npm' ? '-- --watch' : undefined,
		ignoreFocusOut: true,
	});
	if (text === undefined) {
		return undefined;
	}
	await memory.set(command.key, { text });
	return splitArgs(text);
}

async function askStructured(command: HubCommand, args: readonly ScriptArg[], memory: ArgMemory): Promise<string[] | undefined> {
	const last = memory.get(command.key).values ?? {};
	const switches = args.filter((a) => a.kind === 'switch');
	const total = args.length - switches.length + (switches.length ? 1 : 0);
	const values: ArgValues = {};
	let step = 0;
	let switchesAsked = false;
	for (const arg of args) {
		const title = `${command.label} (${++step}/${total})`;
		if (arg.kind === 'switch') {
			if (switchesAsked) {
				step--;
				continue;
			}
			switchesAsked = true;
			const picked = await pickSwitches(title, switches, last);
			if (!picked) {
				return undefined;
			}
			for (const s of switches) {
				values[s.name] = picked.includes(s.name);
			}
			continue;
		}
		const previous = typeof last[arg.name] === 'string' ? (last[arg.name] as string) : arg.defaultValue;
		const value = arg.kind === 'choice' && arg.choices?.length ? await pickChoice(title, arg, previous) : await askText(title, arg, previous);
		if (value === undefined) {
			return undefined;
		}
		values[arg.name] = value;
	}
	await memory.set(command.key, { values });
	return buildArgv(args, values);
}

/**
 * The argument list from the answers, in the order the script declares them: `flag value`,
 * `flag=value` or a bare `flag` for options and switches, values for positional arguments, and
 * raw answers word by word as typed. An empty positional
 * value is left out, unless a later one is given, which keeps the positions right.
 */
export function buildArgv(args: readonly ScriptArg[], values: ArgValues): string[] {
	const argv: string[] = [];
	let skippedPositions = 0;
	for (const arg of args) {
		const value = values[arg.name];
		if (arg.kind === 'switch') {
			if (value === true) {
				argv.push(arg.flag ?? arg.name);
			}
			continue;
		}
		const text = typeof value === 'string' ? value : '';
		if (arg.raw) {
			argv.push(...splitArgs(text));
			continue;
		}
		const words = arg.variadic ? splitArgs(text) : text ? [text] : [];
		if (arg.flag) {
			if (words.length) {
				argv.push(...(arg.joined ? [`${arg.flag}=${words.join(' ')}`] : [arg.flag, ...words]));
			}
			continue;
		}
		if (!words.length) {
			skippedPositions++;
			continue;
		}
		for (; skippedPositions > 0; skippedPositions--) {
			argv.push('');
		}
		argv.push(...words);
	}
	return argv;
}

function askText(title: string, arg: ScriptArg, previous: string | undefined): Thenable<string | undefined> {
	return vscode.window.showInputBox({
		title,
		prompt: arg.required ? arg.name : `${arg.name} (optional)`,
		value: previous ?? '',
		placeHolder:
			arg.defaultValue !== undefined
				? `default: ${arg.defaultValue}`
				: arg.raw
					? `as typed, e.g. ${splitAlternatives(arg.name).join(' or ')}`
					: arg.variadic
						? 'one or more values, separated by spaces'
						: undefined,
		ignoreFocusOut: true,
		validateInput: (value) => (arg.required && !value.trim() ? `${arg.name} is required` : undefined),
	});
}

interface ValueItem extends vscode.QuickPickItem {
	value: string;
}

function pickChoice(title: string, arg: ScriptArg, previous: string | undefined): Promise<string | undefined> {
	const items: ValueItem[] = arg.choices!.map((choice) => ({
		label: choice,
		value: choice,
		description: choice === arg.defaultValue ? 'default' : undefined,
	}));
	if (!arg.required) {
		items.push({ label: '$(circle-slash) Leave empty', value: '' });
	}
	return new Promise((resolve) => {
		const pick = vscode.window.createQuickPick<ValueItem>();
		pick.title = title;
		pick.placeholder = arg.required ? arg.name : `${arg.name} (optional)`;
		pick.items = items;
		pick.ignoreFocusOut = true;
		const current = items.find((i) => i.value === previous);
		if (current) {
			pick.activeItems = [current];
		}
		pick.onDidAccept(() => {
			resolve(pick.selectedItems[0]?.value ?? pick.activeItems[0]?.value);
			pick.hide();
		});
		pick.onDidHide(() => {
			resolve(undefined);
			pick.dispose();
		});
		pick.show();
	});
}

interface SwitchItem extends vscode.QuickPickItem {
	name: string;
}

function pickSwitches(title: string, switches: readonly ScriptArg[], last: ArgValues): Promise<string[] | undefined> {
	return new Promise((resolve) => {
		const pick = vscode.window.createQuickPick<SwitchItem>();
		pick.title = title;
		pick.placeholder = 'Options to turn on (Enter to continue)';
		pick.canSelectMany = true;
		pick.ignoreFocusOut = true;
		pick.items = switches.map((s) => ({ label: s.flag ?? s.name, name: s.name }));
		pick.selectedItems = pick.items.filter((item) => last[item.name] === true);
		pick.onDidAccept(() => {
			resolve(pick.selectedItems.map((i) => i.name));
			pick.hide();
		});
		pick.onDidHide(() => {
			resolve(undefined);
			pick.dispose();
		});
		pick.show();
	});
}

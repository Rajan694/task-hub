import * as fs from 'fs';
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type ParseError } from 'jsonc-parser';
import * as vscode from 'vscode';
import { readSettings } from './config';
import { positionAt } from './detectors/common';

/** One entry of `commands` in .vscode/task-hub.json. */
export interface SavedCommand {
	id: string;
	label: string;
	command: string;
	/** Relative to the workspace folder; the folder itself when absent. */
	cwd?: string;
	longRunning?: boolean;
	readyPattern?: string;
}

export type WaitFor = 'exit' | 'ready' | 'running';

/** One step of a group: which command, and what to wait for before the next step starts. */
export interface GroupStep {
	/** A command id, e.g. "npm:apps/api:start", from the same workspace folder. */
	run: string;
	waitFor?: WaitFor;
	timeoutSec?: number;
	/** Arguments for the command; its last ones when absent. */
	args?: string[];
}

/** One entry of `groups` in .vscode/task-hub.json: commands started in order with one click. */
export interface SavedGroup {
	id: string;
	label: string;
	steps: GroupStep[];
	/** Zero-based line of the group in task-hub.json. */
	line?: number;
}

export interface SavedList {
	commands: (SavedCommand & { line?: number })[];
	/** The file they come from; undefined for private storage. */
	file?: vscode.Uri;
}

const PRIVATE_KEY = 'taskHub.savedCommands';
const FAVORITES_KEY = 'taskHub.favorites';
const GROUPS_KEY = 'taskHub.groups';
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

/**
 * Saved commands and favorites, per workspace folder: in `.vscode/task-hub.json` so a team can
 * commit and share them (the default), or in VS Code's workspace state with `taskHub.storage: private`.
 * Edits to the file keep its comments and formatting.
 */
export class SavedStore implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(private readonly state: vscode.Memento) {}

	static fileOf(folder: vscode.WorkspaceFolder): vscode.Uri {
		return vscode.Uri.joinPath(folder.uri, '.vscode', 'task-hub.json');
	}

	isPrivate(folder: vscode.WorkspaceFolder): boolean {
		return readSettings(folder.uri).storage === 'private';
	}

	async list(folder: vscode.WorkspaceFolder): Promise<SavedList> {
		if (this.isPrivate(folder)) {
			return { commands: this.privateCommands(folder) };
		}
		const file = SavedStore.fileOf(folder);
		const text = await readFile(file);
		if (text === undefined) {
			return { commands: [], file };
		}
		const errors: ParseError[] = [];
		const json = parse(text, errors, { allowTrailingComma: true }) as { commands?: unknown } | undefined;
		const tree = parseTree(text, [], { allowTrailingComma: true });
		const commands: SavedList['commands'] = [];
		const entries = Array.isArray(json?.commands) ? json.commands : [];
		entries.forEach((entry: unknown, index: number) => {
			const saved = validate(entry);
			if (saved) {
				const node = tree && findNodeAtLocation(tree, ['commands', index]);
				commands.push({ ...saved, line: node ? positionAt(text, node.offset).line : undefined });
			}
		});
		return { commands, file };
	}

	/** Saves a new command and returns it with its id (made from the label, unique in the folder). */
	async add(folder: vscode.WorkspaceFolder, command: Omit<SavedCommand, 'id'>): Promise<SavedCommand> {
		const id = uniqueId(command.label, new Set((await this.list(folder)).commands.map((c) => c.id)), 'command');
		const saved: SavedCommand = { id, ...withoutEmpty(command) };

		if (this.isPrivate(folder)) {
			await this.state.update(this.privateKey(folder), [...this.privateCommands(folder), saved]);
		} else {
			const file = SavedStore.fileOf(folder);
			let text = (await readFile(file)) ?? '{\n  "commands": []\n}\n';
			const tree = parseTree(text, [], { allowTrailingComma: true });
			const list = tree && findNodeAtLocation(tree, ['commands']);
			text =
				list?.type === 'array'
					? applyEdits(text, modify(text, ['commands', -1], saved, { ...FORMAT, isArrayInsertion: true }))
					: applyEdits(text, modify(text, ['commands'], [saved], FORMAT));
			await fs.promises.mkdir(vscode.Uri.joinPath(folder.uri, '.vscode').fsPath, { recursive: true });
			await fs.promises.writeFile(file.fsPath, text);
		}
		this.changed.fire();
		return saved;
	}

	async remove(folder: vscode.WorkspaceFolder, id: string): Promise<void> {
		if (this.isPrivate(folder)) {
			await this.state.update(
				this.privateKey(folder),
				this.privateCommands(folder).filter((c) => c.id !== id),
			);
		} else {
			const file = SavedStore.fileOf(folder);
			const text = await readFile(file);
			const json = text === undefined ? undefined : (parse(text, [], { allowTrailingComma: true }) as { commands?: unknown });
			const index = Array.isArray(json?.commands) ? json.commands.findIndex((c: unknown) => validate(c)?.id === id) : -1;
			if (text === undefined || index < 0) {
				return;
			}
			await fs.promises.writeFile(file.fsPath, applyEdits(text, modify(text, ['commands', index], undefined, FORMAT)));
		}
		this.changed.fire();
	}

	/** The ids of the folder's favorite commands, in their order ("npm:apps/web:dev"). */
	async favorites(folder: vscode.WorkspaceFolder): Promise<string[]> {
		if (this.isPrivate(folder)) {
			return this.state.get<string[]>(`${FAVORITES_KEY}:${folder.uri.toString()}`, []);
		}
		const text = await readFile(SavedStore.fileOf(folder));
		const json = text === undefined ? undefined : (parse(text, [], { allowTrailingComma: true }) as { favorites?: unknown });
		return Array.isArray(json?.favorites) ? json.favorites.filter((id: unknown): id is string => typeof id === 'string') : [];
	}

	/** Adds a command to the end of the favorites, or removes it. */
	async setFavorite(folder: vscode.WorkspaceFolder, id: string, favorite: boolean): Promise<void> {
		const current = await this.favorites(folder);
		if (current.includes(id) === favorite) {
			return;
		}
		const next = favorite ? [...current, id] : current.filter((f) => f !== id);
		if (this.isPrivate(folder)) {
			await this.state.update(`${FAVORITES_KEY}:${folder.uri.toString()}`, next);
		} else {
			const file = SavedStore.fileOf(folder);
			const text = (await readFile(file)) ?? '{}\n';
			await fs.promises.mkdir(vscode.Uri.joinPath(folder.uri, '.vscode').fsPath, { recursive: true });
			await fs.promises.writeFile(file.fsPath, applyEdits(text, modify(text, ['favorites'], next, FORMAT)));
		}
		this.changed.fire();
	}

	/** The folder's groups, with the line of each in task-hub.json. */
	async groups(folder: vscode.WorkspaceFolder): Promise<{ groups: SavedGroup[]; file?: vscode.Uri }> {
		if (this.isPrivate(folder)) {
			const value = this.state.get<unknown[]>(`${GROUPS_KEY}:${folder.uri.toString()}`, []);
			return { groups: value.map(validateGroup).filter((g): g is SavedGroup => g !== undefined) };
		}
		const file = SavedStore.fileOf(folder);
		const text = await readFile(file);
		if (text === undefined) {
			return { groups: [], file };
		}
		const json = parse(text, [], { allowTrailingComma: true }) as { groups?: unknown } | undefined;
		const tree = parseTree(text, [], { allowTrailingComma: true });
		const groups: SavedGroup[] = [];
		(Array.isArray(json?.groups) ? json.groups : []).forEach((entry: unknown, index: number) => {
			const group = validateGroup(entry);
			if (group) {
				const node = tree && findNodeAtLocation(tree, ['groups', index]);
				groups.push({ ...group, line: node ? positionAt(text, node.offset).line : undefined });
			}
		});
		return { groups, file };
	}

	/** Adds a step to a group, creating the group when `group` is a new label. Returns the group's id. */
	async addStep(folder: vscode.WorkspaceFolder, group: { id: string } | { label: string }, step: GroupStep): Promise<string> {
		const { groups } = await this.groups(folder);
		const index = 'id' in group ? groups.findIndex((g) => g.id === group.id) : -1;
		const id = index >= 0 ? groups[index].id : uniqueId('label' in group ? group.label : 'group', new Set(groups.map((g) => g.id)), 'group');
		const created = { id, label: 'label' in group ? group.label : id, steps: [step] };
		if (this.isPrivate(folder)) {
			const key = `${GROUPS_KEY}:${folder.uri.toString()}`;
			const next = groups.map(({ line: _line, ...g }) => (g.id === id ? { ...g, steps: [...g.steps, step] } : g));
			await this.state.update(key, index >= 0 ? next : [...next, created]);
		} else {
			// Find the group's index in the file itself, which may also hold entries Task Hub skipped as invalid.
			const file = SavedStore.fileOf(folder);
			let text = (await readFile(file)) ?? '{}\n';
			const json = parse(text, [], { allowTrailingComma: true }) as { groups?: unknown } | undefined;
			const list = Array.isArray(json?.groups) ? json.groups : undefined;
			const fileIndex = list ? list.findIndex((g: unknown) => validateGroup(g)?.id === id) : -1;
			if (fileIndex >= 0) {
				text = applyEdits(text, modify(text, ['groups', fileIndex, 'steps', -1], step, { ...FORMAT, isArrayInsertion: true }));
			} else if (list) {
				text = applyEdits(text, modify(text, ['groups', -1], created, { ...FORMAT, isArrayInsertion: true }));
			} else {
				text = applyEdits(text, modify(text, ['groups'], [created], FORMAT));
			}
			await fs.promises.mkdir(vscode.Uri.joinPath(folder.uri, '.vscode').fsPath, { recursive: true });
			await fs.promises.writeFile(file.fsPath, text);
		}
		this.changed.fire();
		return id;
	}

	async removeGroup(folder: vscode.WorkspaceFolder, id: string): Promise<void> {
		if (this.isPrivate(folder)) {
			const { groups } = await this.groups(folder);
			await this.state.update(
				`${GROUPS_KEY}:${folder.uri.toString()}`,
				groups.filter((g) => g.id !== id).map(({ line: _line, ...g }) => g),
			);
		} else {
			const file = SavedStore.fileOf(folder);
			const text = await readFile(file);
			const json = text === undefined ? undefined : (parse(text, [], { allowTrailingComma: true }) as { groups?: unknown });
			const index = Array.isArray(json?.groups) ? json.groups.findIndex((g: unknown) => validateGroup(g)?.id === id) : -1;
			if (text === undefined || index < 0) {
				return;
			}
			await fs.promises.writeFile(file.fsPath, applyEdits(text, modify(text, ['groups', index], undefined, FORMAT)));
		}
		this.changed.fire();
	}

	private privateKey(folder: vscode.WorkspaceFolder): string {
		return `${PRIVATE_KEY}:${folder.uri.toString()}`;
	}

	private privateCommands(folder: vscode.WorkspaceFolder): SavedCommand[] {
		const value = this.state.get<unknown[]>(this.privateKey(folder), []);
		return value.map(validate).filter((c): c is SavedCommand => c !== undefined);
	}

	dispose(): void {
		this.changed.dispose();
	}
}

/** A saved command with the fields it needs, or undefined. A missing id falls back to the label. */
function validate(entry: unknown): SavedCommand | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}
	const e = entry as Record<string, unknown>;
	if (typeof e.command !== 'string' || !e.command.trim()) {
		return undefined;
	}
	const label = typeof e.label === 'string' && e.label.trim() ? e.label : e.command;
	return {
		id: typeof e.id === 'string' && e.id ? e.id : label,
		label,
		command: e.command,
		cwd: typeof e.cwd === 'string' && e.cwd ? e.cwd : undefined,
		longRunning: typeof e.longRunning === 'boolean' ? e.longRunning : undefined,
		readyPattern: typeof e.readyPattern === 'string' && e.readyPattern ? e.readyPattern : undefined,
	};
}

const WAIT_FOR: readonly WaitFor[] = ['exit', 'ready', 'running'];

/** A group with a label and at least one valid step, or undefined. A missing id falls back to the label. */
function validateGroup(entry: unknown): SavedGroup | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}
	const e = entry as Record<string, unknown>;
	const steps = (Array.isArray(e.steps) ? e.steps : [])
		.map((raw: unknown): GroupStep | undefined => {
			const s = raw as Record<string, unknown> | undefined;
			if (!s || typeof s.run !== 'string' || !s.run) {
				return undefined;
			}
			return {
				run: s.run,
				waitFor: WAIT_FOR.includes(s.waitFor as WaitFor) ? (s.waitFor as WaitFor) : undefined,
				timeoutSec: typeof s.timeoutSec === 'number' && s.timeoutSec > 0 ? s.timeoutSec : undefined,
				args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : undefined,
			};
		})
		.filter((s): s is GroupStep => s !== undefined);
	const label = typeof e.label === 'string' && e.label.trim() ? e.label : undefined;
	if (!label || !steps.length) {
		return undefined;
	}
	return { id: typeof e.id === 'string' && e.id ? e.id : label, label, steps };
}

/** "Django server" → "django-server", or "django-server-2" when that's taken. */
function uniqueId(label: string, taken: ReadonlySet<string>, fallback: string): string {
	const base =
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || fallback;
	let id = base;
	for (let n = 2; taken.has(id); n++) {
		id = `${base}-${n}`;
	}
	return id;
}

function withoutEmpty<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== '')) as T;
}

async function readFile(file: vscode.Uri): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(file.fsPath, 'utf8');
	} catch {
		return undefined;
	}
}

import type { ScriptArg } from '../model';

/**
 * The arguments of a shell script. A `# Usage:` comment wins when there is one; otherwise the
 * `getopts` option string gives the options, and the positional `$1`…`$9` the script reads give
 * the rest, with choices from `case "$1" in` branches and names and defaults from lines like
 * `env=${1:-staging}`. Undefined when nothing is found.
 */
export function parseShArgs(text: string): ScriptArg[] | undefined {
	return fromUsage(text) ?? fromCode(text);
}

/** `# Usage: deploy.sh <env> [--dry-run] [-t <tag>] {start|stop}` */
function fromUsage(text: string): ScriptArg[] | undefined {
	const line = /^\s*#+\s*usage:\s*(.+)$/im.exec(text)?.[1];
	if (!line) {
		return undefined;
	}
	const tokens = tokenize(line.trim().replace(/^\$\([^)]*\)\s*/, ''));
	// The first word is the script's name ("deploy.sh", "$0", "$(basename "$0")").
	if (tokens.length && !/^[<[{-]/.test(tokens[0])) {
		tokens.shift();
	}
	const args: ScriptArg[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const optional = token.startsWith('[');
		const inner = optional ? token.slice(1, -1).trim() : token;
		if (/^\.\.\.$/.test(inner)) {
			continue;
		}
		const option = /^(-{1,2}[\w-]+)(?:[\s=]+(.+))?$/.exec(inner);
		if (option) {
			let value = option[2];
			// A bare option followed by its value: "-t <tag>".
			if (!optional && !value && tokens[i + 1]?.startsWith('<')) {
				value = tokens[++i];
			}
			args.push(
				value
					? { name: `${option[1]} ${value}`, kind: 'text', required: !optional, flag: option[1], ...choicesOf(value) }
					: { name: option[1], kind: 'switch', required: false, flag: option[1] },
			);
			continue;
		}
		const name = inner.replace(/^[<{]|[>}]$/g, '').replace(/\.\.\.$/, '').trim();
		if (!name || /^options?$/i.test(name)) {
			continue;
		}
		const variadic = /\.\.\.[>}\]]*$/.test(token) || undefined;
		args.push({ name: name.split('|').length > 1 ? 'value' : name, kind: 'text', required: !optional, variadic, ...choicesOf(token) });
	}
	return args.length ? args : undefined;
}

/** `{start|stop}` or `<staging|prod>` → a choice. */
function choicesOf(token: string): Partial<ScriptArg> {
	const inner = token.replace(/^[[<{]+|[\]>}]+$/g, '');
	const choices = inner.split('|').map((c) => c.trim());
	if (choices.length > 1 && choices.every((c) => /^[\w.:-]+$/.test(c))) {
		return { kind: 'choice', choices };
	}
	return {};
}

/** Splits a usage line into words, keeping [ … ], < … > and { … } groups whole. */
function tokenize(line: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < line.length) {
		if (/\s/.test(line[i])) {
			i++;
			continue;
		}
		const close = { '[': ']', '<': '>', '{': '}' }[line[i]];
		if (close) {
			let depth = 0;
			let j = i;
			for (; j < line.length; j++) {
				if (line[j] === line[i]) {
					depth++;
				} else if (line[j] === close && --depth === 0) {
					break;
				}
			}
			tokens.push(line.slice(i, j + 1));
			i = j + 1;
		} else {
			const end = line.slice(i).search(/\s/);
			const word = end < 0 ? line.slice(i) : line.slice(i, i + end);
			tokens.push(word);
			i += word.length;
		}
	}
	return tokens;
}

function fromCode(text: string): ScriptArg[] | undefined {
	// Without comments and single-quoted text, so `awk '{print $2}'` doesn't count as an argument.
	const code = withoutSingleQuoted(
		text
			.split(/\r?\n/)
			.filter((line) => !/^\s*#/.test(line))
			.join('\n'),
	);
	const args: ScriptArg[] = [];

	// getopts "e:dv" → -e takes a value; -d and -v are switches.
	const optstring = /\bgetopts\s+["']?:?([A-Za-z0-9:]+)["']?/.exec(code)?.[1];
	if (optstring) {
		for (const match of optstring.matchAll(/([A-Za-z0-9])(:?)/g)) {
			args.push(
				match[2]
					? { name: `-${match[1]}`, kind: 'text', required: false, flag: `-${match[1]}` }
					: { name: `-${match[1]}`, kind: 'switch', required: false, flag: `-${match[1]}` },
			);
		}
	}

	let highest = 0;
	for (const match of code.matchAll(/\$(?:\{([1-9])(?:[:-][^}]*)?\}|([1-9])(?!\d))/g)) {
		highest = Math.max(highest, Number(match[1] ?? match[2]));
	}
	const caseChoices = choicesFromCase(code);
	if (caseChoices && highest === 0) {
		highest = 1;
	}
	for (let n = 1; n <= highest; n++) {
		const named = new RegExp(`^\\s*(?:local\\s+|readonly\\s+|declare\\s+(?:-\\w+\\s+)?)?([A-Za-z_]\\w*)=["']?\\$\\{?${n}(?![0-9])`, 'm').exec(code)?.[1];
		const defaultValue = new RegExp(`\\$\\{${n}:?-([^}]*)\\}`).exec(code)?.[1]?.replace(/^(["'])(.*)\1$/, '$2');
		args.push({
			name: named ? named.toLowerCase() : `$${n}`,
			kind: n === 1 && caseChoices ? 'choice' : 'text',
			choices: n === 1 ? caseChoices : undefined,
			defaultValue: defaultValue && !defaultValue.includes('$') ? defaultValue : undefined,
			required: false,
		});
	}
	return args.length ? args : undefined;
}

/** `case "$1" in start) … ;; stop|halt) … ;; esac` → start, stop, halt (not `*`, not -h/--help). */
function choicesFromCase(code: string): string[] | undefined {
	const block = /\bcase\s+["']?\$\{?1(?::-[^}]*)?\}?["']?\s+in\b([\s\S]*?)\besac\b/.exec(code)?.[1];
	if (!block) {
		return undefined;
	}
	const choices: string[] = [];
	for (const match of block.matchAll(/^\s*\(?\s*([^\s()][^()]*?)\s*\)/gm)) {
		for (const alt of match[1].split('|').map((a) => a.trim().replace(/^(["'])(.*)\1$/, '$2'))) {
			if (/^[\w.:]+[\w.:-]*$/.test(alt) && !choices.includes(alt)) {
				choices.push(alt);
			}
		}
	}
	return choices.length ? choices : undefined;
}

/** Empties single-quoted strings (outside double quotes) and drops end-of-line comments. */
function withoutSingleQuoted(code: string): string {
	let out = '';
	let inDouble = false;
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (ch === '\\') {
			out += ch + (code[i + 1] ?? '');
			i++;
		} else if (ch === '"') {
			inDouble = !inDouble;
			out += ch;
		} else if (ch === '#' && !inDouble && (i === 0 || /\s/.test(code[i - 1]))) {
			// A comment after code: skip it (an apostrophe in "don't" would open a quote).
			while (i + 1 < code.length && code[i + 1] !== '\n') {
				i++;
			}
		} else if (ch === "'" && !inDouble) {
			const end = code.indexOf("'", i + 1);
			out += "''";
			i = end < 0 ? code.length : end;
		} else {
			out += ch;
		}
	}
	return out;
}

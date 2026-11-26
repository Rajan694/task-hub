import type { ScriptArg } from '../model';
import { parseUsage } from './usage';

/**
 * The arguments of a shell script. A usage synopsis wins when there is one (`# Usage:`,
 * `echo "Usage: …"`, see parseUsage); otherwise the `getopts` option string gives the options,
 * and the positional `$1`…`$9` the script reads outside its functions give the rest, with choices
 * from `case "$1" in` branches and names and defaults from lines like `env=${1:-staging}`.
 * Undefined when nothing is found.
 */
export function parseShArgs(text: string, fileName?: string): ScriptArg[] | undefined {
	return parseUsage(text, fileName) ?? fromCode(text);
}

function fromCode(text: string): ScriptArg[] | undefined {
	// Without comments and single-quoted text, so `awk '{print $2}'` doesn't count as an argument.
	// A function's $1 is its own argument, not the script's.
	const code = withoutFunctionBodies(
		withoutSingleQuoted(
			text
				.split(/\r?\n/)
				.filter((line) => !/^\s*#/.test(line))
				.join('\n'),
		),
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

/**
 * Blanks out the bodies of `name() { … }` and `function name { … }`, keeping the line breaks,
 * except functions the script hands its own arguments to (`main "$@"`). Braces are counted,
 * which `${var}` and `{ …; }` groups inside keep balanced.
 */
function withoutFunctionBodies(code: string): string {
	const blank = (keep: ReadonlySet<string>) => {
		const header = /^[ \t]*(?:function[ \t]+([\w.:-]+)(?:[ \t]*\(\))?|([\w.:-]+)[ \t]*\(\))\s*\{/gm;
		let out = '';
		let from = 0;
		for (let match = header.exec(code); match; match = header.exec(code)) {
			if (match.index < from) {
				continue; // A function inside one already passed.
			}
			let depth = 0;
			let end = match.index + match[0].length - 1;
			for (; end < code.length; end++) {
				if (code[end] === '{') {
					depth++;
				} else if (code[end] === '}' && --depth === 0) {
					break;
				}
			}
			const body = code.slice(match.index, end + 1);
			out += code.slice(from, match.index) + (keep.has(match[1] ?? match[2]) ? body : body.replace(/[^\n]/g, ' '));
			from = end + 1;
		}
		return out + code.slice(from);
	};
	const topLevel = blank(new Set());
	const forwarded = new Set([...topLevel.matchAll(/(?:^|[\s;&|(])([\w.:-]+)[ \t]+"\$[@*]"/gm)].map((m) => m[1]));
	return forwarded.size ? blank(forwarded) : topLevel;
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

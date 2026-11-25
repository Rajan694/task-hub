import type { ScriptArg } from '../model';

/**
 * The arguments of a PowerShell script, from its `param()` block: names, defaults,
 * `[ValidateSet()]` choices, `[switch]` and `Mandatory`. Undefined when the script has no
 * param block.
 */
export function parsePs1Params(text: string): ScriptArg[] | undefined {
	const code = stripComments(text);
	// The script's own param block comes before any function; a function's block isn't the script's.
	const functionAt = code.search(/^\s*function\s+[\w-]+/im);
	const paramMatch = /\bparam\s*\(/i.exec(code);
	if (!paramMatch || (functionAt >= 0 && paramMatch.index > functionAt)) {
		return undefined;
	}
	const body = balanced(code, paramMatch.index + paramMatch[0].length - 1, '(', ')');
	if (body === undefined) {
		return undefined;
	}
	const args: ScriptArg[] = [];
	for (const part of splitTopLevel(body, ',')) {
		const arg = parseParam(part.trim());
		if (arg) {
			args.push(arg);
		}
	}
	return args;
}

function parseParam(text: string): ScriptArg | undefined {
	let rest = text;
	let mandatory = false;
	let choices: string[] | undefined;
	let type = '';
	while (rest.startsWith('[')) {
		const inner = balanced(rest, 0, '[', ']');
		if (inner === undefined) {
			return undefined;
		}
		rest = rest.slice(inner.length + 2).trimStart();
		const attribute = /^\s*([\w.]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(inner);
		const name = attribute?.[1].toLowerCase() ?? '';
		const params = attribute?.[2] ?? '';
		if (name === 'parameter') {
			mandatory = /\bMandatory\b(?!\s*=\s*\$false)/i.test(params);
		} else if (name === 'validateset') {
			choices = [...params.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
		} else if (attribute && !attribute[2]) {
			type = name; // [string], [switch], [int], [string[]] (the [] is left out by the regex)
		}
	}
	const variable = /^\$([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(rest);
	if (!variable) {
		return undefined;
	}
	const [, name, rawDefault] = variable;
	const kind = type === 'switch' ? 'switch' : choices?.length ? 'choice' : 'text';
	return {
		name,
		kind,
		choices: kind === 'choice' ? choices : undefined,
		defaultValue: kind === 'switch' ? undefined : literal(rawDefault),
		required: mandatory && kind !== 'switch',
		flag: `-${name}`,
	};
}

/** A quoted string or a plain number; expressions like (Get-Date) or $PWD have no fixed default. */
function literal(raw: string | undefined): string | undefined {
	const text = raw?.trim();
	if (!text) {
		return undefined;
	}
	const quoted = /^'([^']*)'$|^"([^"$`]*)"$/.exec(text);
	if (quoted) {
		return quoted[1] ?? quoted[2];
	}
	return /^-?\d+(?:\.\d+)?$/.test(text) ? text : undefined;
}

/** Removes `<# … #>` and `# …` comments (outside strings). */
function stripComments(text: string): string {
	let out = '';
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			out += ch;
			if (ch === quote) {
				quote = undefined;
			}
		} else if (ch === '<' && text[i + 1] === '#') {
			const end = text.indexOf('#>', i + 2);
			i = end < 0 ? text.length : end + 1;
		} else if (ch === '#') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			out += '\n';
		} else {
			if (ch === "'" || ch === '"') {
				quote = ch;
			}
			out += ch;
		}
	}
	return out;
}

/** The text between the bracket at `open` and its matching close, or undefined if it never closes. */
function balanced(text: string, open: number, openCh: string, closeCh: string): string | undefined {
	let depth = 0;
	let quote: string | undefined;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			}
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === openCh) {
			depth++;
		} else if (ch === closeCh && --depth === 0) {
			return text.slice(open + 1, i);
		}
	}
	return undefined;
}

/** Splits on `separator` outside brackets and quotes. */
function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			}
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if ('([{'.includes(ch)) {
			depth++;
		} else if (')]}'.includes(ch)) {
			depth--;
		} else if (ch === separator && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.filter((p) => p.trim());
}

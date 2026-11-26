import type { ScriptArg } from '../model';

/**
 * The arguments a script states in its usage synopsis, for shell and PowerShell scripts alike.
 * The synopsis is the first `Usage:` line, whether a comment (`# Usage: …`), printed
 * (`echo "Usage: …"`, `Write-Host 'Usage: …'`) or bare in a heredoc, or the line after a
 * `Usage:` that stands alone. Without one, a comment that starts with the script's own name
 * and shows a `<…>`, `[…]` or `{…}` (`#   ./build.sh <dev|prod> [version]`) counts.
 * Undefined when there's no synopsis or it names no arguments.
 */
export function parseUsage(text: string, fileName?: string): ScriptArg[] | undefined {
	const line = findSynopsis(text.split(/\r?\n/), fileName);
	return line === undefined ? undefined : parseSynopsis(line);
}

/** Output commands that print a usage line. */
const PRINT = String.raw`(?:echo|printf|Write-(?:Host|Output|Error|Warning|Information))\b[^"'\n]*?(["'])`;

function findSynopsis(lines: readonly string[], fileName: string | undefined): string | undefined {
	for (let i = 0; i < lines.length; i++) {
		const rest = usageAfter(lines[i]);
		if (rest === undefined) {
			continue;
		}
		if (rest) {
			return rest;
		}
		// "Usage:" on its own line: the synopsis is on one of the next few.
		for (const next of lines.slice(i + 1, i + 4)) {
			const content = contentOf(next);
			if (content && (/[<[{]/.test(content) || startsWithName(content, fileName))) {
				return content;
			}
		}
	}
	if (fileName) {
		for (const line of lines) {
			const comment = /^\s*#+\s*(.+)$/.exec(line)?.[1];
			const synopsis = comment?.replace(/\s+#.*$/, '').trim();
			if (synopsis && startsWithName(synopsis, fileName) && /\s[<[{]/.test(synopsis)) {
				return synopsis;
			}
		}
	}
	return undefined;
}

/** What follows `Usage:` on a comment, printed or bare line ('' when nothing does); undefined for other lines. */
function usageAfter(line: string): string | undefined {
	const comment = /^\s*#+\s*usage:\s*(.*)$/i.exec(line);
	if (comment) {
		return comment[1].trim();
	}
	const printed = new RegExp(`^\\s*${PRINT}\\s*usage:\\s*(.*)$`, 'i').exec(line);
	if (printed) {
		return closeQuote(printed[2], printed[1]);
	}
	return /^\s*usage:\s*(.*)$/i.exec(line)?.[1].trim();
}

/** A line's text without a leading `#` or the output command around it. */
function contentOf(line: string): string {
	const comment = /^\s*#+\s?(.*)$/.exec(line);
	if (comment) {
		return comment[1].trim();
	}
	const printed = new RegExp(`^\\s*${PRINT}(.*)$`, 'i').exec(line);
	return printed ? closeQuote(printed[2], printed[1]) : line.trim();
}

/** Printed text without its closing quote, what follows it (`>&2`, `;`) and printf's `\n`. */
function closeQuote(text: string, quote: string): string {
	const end = text.lastIndexOf(quote);
	return (end < 0 ? text : text.slice(0, end)).replace(/\\[nt]/g, ' ').trim();
}

function startsWithName(line: string, fileName: string | undefined): boolean {
	if (!fileName) {
		return false;
	}
	const name = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^(?:\\.[\\\\/])?${name}(?:\\s|$)`).test(line);
}

/**
 * `deploy.sh <env> [-n|--dry-run] [-t <tag>] [--fe=web|mobile] {start|stop} <files>...`:
 * `<…>` and `{…}` are required, `[…]` optional, `a|b` choices, `...` one or more. Options are
 * never required.
 */
function parseSynopsis(line: string): ScriptArg[] | undefined {
	const tokens = tokenize(line.trim().replace(/^\$\([^)]*\)\s*/, ''));
	// The first word is the script's name ("deploy.sh", "$0", ".\run.ps1", printf's "%s").
	if (tokens.length && !/^[<[{-]/.test(tokens[0])) {
		tokens.shift();
	}
	const args: ScriptArg[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (/^(?:\.\.\.|…)$/.test(token)) {
			// "<platform> ...": the argument before takes one or more values.
			const last = args[args.length - 1];
			if (last && last.kind !== 'switch' && !last.flag) {
				last.variadic = true;
			}
			continue;
		}
		const optional = token.startsWith('[') && token.endsWith(']');
		const inner = optional ? token.slice(1, -1).trim() : token;
		const alternatives = splitAlternatives(/^[<{][\s\S]*[>}]$/.test(inner) ? inner.slice(1, -1) : inner);

		if (alternatives.length > 1 && alternatives.every((a) => a.startsWith('-'))) {
			if (alternatives.every((a) => /^-{1,2}[\w-]+$/.test(a))) {
				// "[-n|--dry-run]": one switch with aliases, passed as its longest name.
				if (!alternatives.every(isHelp)) {
					const flag = alternatives.reduce((a, b) => (b.length > a.length ? b : a));
					args.push({ name: alternatives.join('|'), kind: 'switch', required: false, flag });
				}
			} else {
				// "[--emulator[=<avd>]|--device=<serial>]": too varied to ask for piece by piece.
				args.push({ name: inner, kind: 'text', required: false, raw: true });
			}
			continue;
		}

		const option = /^(-{1,2}[\w-]+)(?:([\s=]+)(.+))?$/.exec(inner);
		if (option) {
			const flag = option[1];
			let separator = option[2];
			let value = option[3];
			// A bare option followed by its value: "-t <tag>".
			if (!optional && !value && tokens[i + 1]?.startsWith('<')) {
				separator = ' ';
				value = tokens[++i];
			}
			if (value) {
				const joined = separator.includes('=');
				// Never required: a usage line printed for one mode ("--set-commit <hash>") would
				// otherwise block running the script plainly. Only positional arguments are.
				args.push({
					name: `${flag}${joined ? '=' : ' '}${value}`,
					kind: 'text',
					required: false,
					flag,
					...choicesOf(value),
					...(joined ? { joined: true } : {}),
				});
			} else if (!isHelp(flag)) {
				args.push({ name: flag, kind: 'switch', required: false, flag });
			}
			continue;
		}
		if (inner.startsWith('-')) {
			// "[--emulator[=<avd>]]": an option whose value is optional.
			args.push({ name: inner, kind: 'text', required: false, raw: true });
			continue;
		}

		const name = inner.replace(/^[<{]|[>}]$/g, '').replace(/\.\.\.$/, '').trim();
		if (!name || /^options?$/i.test(name)) {
			continue;
		}
		const variadic = /\.\.\.[>}\]]*$/.test(token) || undefined;
		// An unnamed choice ("<staging|prod>") is named by its choices.
		args.push({ name, kind: 'text', required: !optional, variadic, ...choicesOf(token) });
	}
	return args.length ? args : undefined;
}

function isHelp(flag: string): boolean {
	return /^(?:-h|--help|-\?)$/.test(flag);
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

/** `--emulator[=<avd>]|--device=<serial>` → its alternatives, splitting on `|` outside brackets. */
export function splitAlternatives(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if ('[<{'.includes(ch)) {
			depth++;
		} else if (']>}'.includes(ch)) {
			depth--;
		} else if (ch === '|' && depth === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts.filter(Boolean);
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

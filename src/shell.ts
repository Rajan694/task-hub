/**
 * Quotes one argument for the shell that `spawn(line, { shell: true })` uses: `/bin/sh` on
 * Linux and macOS, `cmd.exe` on Windows. Plain words are left alone.
 */
export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
	if (/^[\w@+=:,./-]+$/.test(arg)) {
		return arg;
	}
	if (platform === 'win32') {
		return `"${arg.replace(/"/g, '""')}"`;
	}
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Splits typed text into arguments the way a POSIX shell would, without expanding anything:
 * whitespace separates, '…' and "…" group, a backslash escapes the next character
 * (except inside single quotes, and not on Windows, where it separates folders).
 * `-- --watch "my file"` → ["--", "--watch", "my file"].
 */
export function splitArgs(text: string, platform: NodeJS.Platform = process.platform): string[] {
	const args: string[] = [];
	let current = '';
	let started = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else {
				current += ch;
			}
		} else if (ch === '\\' && platform !== 'win32' && i + 1 < text.length && (quote !== '"' || /["\\$`]/.test(text[i + 1]))) {
			current += text[++i];
			started = true;
		} else if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
			} else {
				current += ch;
			}
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) {
				args.push(current);
				current = '';
				started = false;
			}
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) {
		args.push(current);
	}
	return args;
}

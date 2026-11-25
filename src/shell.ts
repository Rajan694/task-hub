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

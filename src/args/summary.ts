import type { ScriptArg } from '../model';

/**
 * What a script takes, in one line for its row: `env (staging, prod) [--dry-run]`,
 * `-Target [-Env (staging, prod)] [-Force]`, `[all|be|fe] [--fe=web|mobile] [-n|--dry-run]`.
 */
export function argsSummary(args: readonly ScriptArg[]): string {
	return args
		.map((arg) => {
			let text = arg.name;
			if (arg.flag) {
				// "-Target" for PowerShell, "-t <tag>", "--fe=web|mobile" and "-n|--dry-run" from a usage line, "-e <value>" from getopts.
				text = !arg.name.includes(arg.flag) ? arg.flag : arg.kind === 'text' && arg.name === arg.flag ? `${arg.flag} <value>` : arg.name;
			}
			if (arg.choices?.length && !text.includes(arg.choices.join('|'))) {
				text += ` (${arg.choices.join(', ')})`;
			}
			if (arg.variadic) {
				text += '…';
			}
			return arg.required ? text : `[${text}]`;
		})
		.join(' ');
}

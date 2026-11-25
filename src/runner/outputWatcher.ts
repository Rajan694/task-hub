const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{1,5}(?:[/?#][^\s'"<>`)\]]*)?/i;

/** Longest partial line kept while waiting for its end. */
const MAX_PARTIAL = 4096;

/** Removes terminal color and cursor codes. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/**
 * The first local dev-server URL in a line of output, ready to open: `0.0.0.0` and `[::]`
 * (listening on every interface) become `localhost`, and trailing punctuation is dropped.
 */
export function findLocalUrl(line: string): string | undefined {
	const match = LOCAL_URL.exec(stripAnsi(line));
	if (!match) {
		return undefined;
	}
	return match[0].replace(/[.,;:!]+$/, '').replace(/\/\/(?:0\.0\.0\.0|\[::\])/, '//localhost');
}

/**
 * Watches a command's output for the moment it is ready: the first local URL, or a line that
 * matches its `readyPattern`. Calls `onReady` once.
 */
export class OutputWatcher {
	private partial = '';
	private done = false;

	constructor(
		private readonly onReady: (url: string | undefined) => void,
		private readonly readyPattern?: RegExp,
	) {}

	push(text: string): void {
		if (this.done) {
			return;
		}
		const lines = (this.partial + text).split(/\r?\n|\r/);
		this.partial = lines.pop()!.slice(-MAX_PARTIAL);
		// The unfinished last line is checked too: some servers print their URL without a newline.
		for (const line of [...lines, this.partial]) {
			const url = findLocalUrl(line);
			if (url || this.readyPattern?.test(stripAnsi(line))) {
				this.done = true;
				this.onReady(url);
				return;
			}
		}
	}
}

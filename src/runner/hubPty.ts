import * as vscode from 'vscode';

/** Output kept per command, in characters; older output is dropped first. */
const MAX_BUFFER = 1_000_000;

const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/**
 * The output of one command, and the terminal that shows it.
 *
 * Output is kept in memory while the command runs, and the terminal is only created when the
 * user asks for it (or the command fails), so runs don't fill the terminal list. When it opens,
 * the terminal replays what was printed so far and then follows live. Closing the terminal only
 * closes the view: the command keeps running, and Show Output opens a new one.
 */
export class CommandOutput implements vscode.Disposable {
	private buffer = '';
	private terminal: vscode.Terminal | undefined;
	private isOpen = false;
	private readonly writer = new vscode.EventEmitter<string>();

	/** Receives what the user types in the terminal. */
	onInput: ((data: string) => void) | undefined;

	constructor(private readonly name: string) {}

	append(text: string): void {
		this.buffer += text;
		if (this.buffer.length > MAX_BUFFER) {
			const cut = this.buffer.indexOf('\n', this.buffer.length - Math.floor(MAX_BUFFER * 0.8));
			this.buffer = this.buffer.slice(cut < 0 ? this.buffer.length - MAX_BUFFER : cut + 1);
		}
		if (this.isOpen) {
			this.writer.fire(text);
		}
	}

	/** Starts over for a new run. */
	clear(): void {
		this.buffer = '';
		if (this.isOpen) {
			this.writer.fire(CLEAR_SCREEN);
		}
	}

	/** Everything printed since the last clear (with terminal codes). */
	text(): string {
		return this.buffer;
	}

	show(preserveFocus: boolean): void {
		if (!this.terminal) {
			const pty: vscode.Pseudoterminal = {
				onDidWrite: this.writer.event,
				open: () => {
					this.isOpen = true;
					if (this.buffer) {
						this.writer.fire(this.buffer);
					}
				},
				close: () => {
					this.isOpen = false;
					this.terminal = undefined;
				},
				handleInput: (data) => this.onInput?.(data),
			};
			this.terminal = vscode.window.createTerminal({
				name: this.name,
				pty,
				iconPath: new vscode.ThemeIcon('tools'),
				isTransient: true,
			});
		}
		this.terminal.show(preserveFocus);
	}

	dispose(): void {
		this.terminal?.dispose();
		this.terminal = undefined;
		this.writer.dispose();
	}
}

export interface LineInputSink {
	/** Shows typed text in the terminal (the process has no TTY to echo it). */
	echo(text: string): void;
	/** A finished line, without its line break. */
	submit(line: string): void;
	/** Ctrl+C */
	interrupt(): void;
}

/**
 * Turns keystrokes from the terminal into lines for the process's stdin, since there is no
 * real TTY doing it: typed characters are echoed, Backspace edits, Enter sends the line and
 * Ctrl+C interrupts. Arrow keys and other escape sequences are ignored.
 */
export class LineInput {
	private line = '';

	constructor(private readonly sink: LineInputSink) {}

	feed(data: string): void {
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];
			if (ch === '\x03') {
				this.line = '';
				this.sink.echo('^C\r\n');
				this.sink.interrupt();
			} else if (ch === '\r' || ch === '\n') {
				if (ch === '\r' && data[i + 1] === '\n') {
					i++;
				}
				this.sink.echo('\r\n');
				this.sink.submit(this.line);
				this.line = '';
			} else if (ch === '\x7f' || ch === '\b') {
				if (this.line) {
					this.line = this.line.slice(0, -1);
					this.sink.echo('\b \b');
				}
			} else if (ch === '\x1b') {
				// Skip the escape sequence: ESC [ params final-byte, or ESC plus one character.
				if (data[i + 1] === '[') {
					i += 2;
					while (i < data.length && !/[@-~]/.test(data[i])) {
						i++;
					}
				} else {
					i++;
				}
			} else if (ch >= ' ') {
				this.line += ch;
				this.sink.echo(ch);
			}
		}
	}
}

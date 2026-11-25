import * as assert from 'assert';
import { failureReason, formatAgo, formatDuration, portLabel, statusText } from '../format';
import { LineInput } from '../runner/hubPty';
import { findLocalUrl, OutputWatcher, stripAnsi } from '../runner/outputWatcher';
import { contextValue } from '../ui/treeProvider';

suite('output watcher', () => {
	test('finds local dev-server URLs, through color codes', () => {
		assert.strictEqual(
			findLocalUrl('  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'),
			'http://localhost:5173/',
		);
		assert.strictEqual(findLocalUrl('ready - started server on http://127.0.0.1:3000, url: x'), 'http://127.0.0.1:3000');
		assert.strictEqual(findLocalUrl('Listening on https://[::1]:8443/app.'), 'https://[::1]:8443/app');
		assert.strictEqual(findLocalUrl('Starting development server at http://0.0.0.0:8000/'), 'http://localhost:8000/');
		assert.strictEqual(findLocalUrl('(http://localhost:4200)'), 'http://localhost:4200');
	});

	test('ignores remote URLs and URLs without a port', () => {
		assert.strictEqual(findLocalUrl('see https://vitejs.dev/config/'), undefined);
		assert.strictEqual(findLocalUrl('http://localhost/'), undefined);
		assert.strictEqual(findLocalUrl('http://192.168.1.4:5173/'), undefined);
	});

	test('fires once, also when a line arrives in pieces', () => {
		const seen: (string | undefined)[] = [];
		const watcher = new OutputWatcher((url) => seen.push(url));
		watcher.push('compiling...\nLocal: http://local');
		watcher.push('host:5173/\nmore http://localhost:9999/\n');
		watcher.push('http://localhost:1/\n');
		assert.deepStrictEqual(seen, ['http://localhost:5173/']);
	});

	test('a URL printed without a newline counts', () => {
		const seen: (string | undefined)[] = [];
		new OutputWatcher((url) => seen.push(url)).push('Server at http://localhost:8080 ');
		assert.deepStrictEqual(seen, ['http://localhost:8080']);
	});

	test('a readyPattern line counts, with no URL', () => {
		const seen: (string | undefined)[] = [];
		const watcher = new OutputWatcher((url) => seen.push(url), /Compiled successfully/);
		watcher.push('Compiling…\n');
		assert.deepStrictEqual(seen, []);
		watcher.push('\x1b[32mCompiled successfully\x1b[0m in 2s\n');
		assert.deepStrictEqual(seen, [undefined]);
	});

	test('stripAnsi', () => {
		assert.strictEqual(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]0;title\x07done'), 'ok done');
	});
});

suite('terminal input', () => {
	function feed(...chunks: string[]) {
		const events: string[] = [];
		const input = new LineInput({
			echo: (text) => events.push(`echo:${JSON.stringify(text)}`),
			submit: (line) => events.push(`line:${line}`),
			interrupt: () => events.push('interrupt'),
		});
		for (const chunk of chunks) {
			input.feed(chunk);
		}
		return events.filter((e) => !e.startsWith('echo:'));
	}

	test('sends whole lines, with Backspace applied', () => {
		assert.deepStrictEqual(feed('y', 'ex\x7f', 's\r', 'no\r\n'), ['line:yes', 'line:no']);
	});

	test('Ctrl+C interrupts and drops the typed line', () => {
		assert.deepStrictEqual(feed('abc\x03', 'd\r'), ['interrupt', 'line:d']);
	});

	test('arrow keys and other escape sequences are ignored', () => {
		assert.deepStrictEqual(feed('a\x1b[A\x1b[1;5Cb\x1bOc\r'), ['line:abc']);
	});
});

suite('formatting', () => {
	test('formatDuration', () => {
		assert.strictEqual(formatDuration(420), '0.4s');
		assert.strictEqual(formatDuration(9_949), '9.9s');
		assert.strictEqual(formatDuration(45_000), '45s');
		assert.strictEqual(formatDuration(59_600), '1m 00s');
		assert.strictEqual(formatDuration(185_000), '3m 05s');
		assert.strictEqual(formatDuration(3_720_000), '1h 02m');
	});

	test('formatAgo', () => {
		assert.strictEqual(formatAgo(1_000), 'just now');
		assert.strictEqual(formatAgo(12_000), '12s ago');
		assert.strictEqual(formatAgo(180_000), '3m ago');
		assert.strictEqual(formatAgo(7_200_000), '2h ago');
		assert.strictEqual(formatAgo(3 * 86_400_000), '3d ago');
	});

	test('statusText and failureReason', () => {
		assert.strictEqual(statusText({ status: 'idle' }), '');
		assert.strictEqual(statusText({ status: 'running', startedAt: 1 }), 'running');
		assert.strictEqual(statusText({ status: 'ready', url: 'http://localhost:5173/' }), 'running · :5173');
		assert.strictEqual(statusText({ status: 'ready' }), 'ready');
		assert.strictEqual(statusText({ status: 'passed', startedAt: 0, endedAt: 3_200, exitCode: 0 }), 'passed · 3.2s');
		assert.strictEqual(statusText({ status: 'failed', exitCode: 1 }), 'failed (exit 1)');
		assert.strictEqual(statusText({ status: 'failed', signal: 'SIGKILL' }), 'failed (SIGKILL)');
		assert.strictEqual(statusText({ status: 'failed', error: 'spawn /bin/sh ENOENT' }), 'failed to start');
		assert.strictEqual(failureReason({ status: 'failed', error: 'spawn /bin/sh ENOENT' }), 'spawn /bin/sh ENOENT');
		assert.strictEqual(statusText({ status: 'stopped' }), 'stopped');
	});

	test('portLabel', () => {
		assert.strictEqual(portLabel('http://localhost:5173/'), ':5173');
		assert.strictEqual(portLabel('https://[::1]:8443/app'), ':8443');
		assert.strictEqual(portLabel('http://localhost:3000'), ':3000');
	});

	test('row context values match the menus in package.json', () => {
		assert.strictEqual(contextValue({ status: 'idle' }), 'cmd.idle');
		assert.strictEqual(contextValue({ status: 'running' }), 'cmd.running');
		assert.strictEqual(contextValue({ status: 'ready', url: 'http://localhost:1/' }), 'cmd.running.url');
		assert.strictEqual(contextValue({ status: 'ready' }), 'cmd.running.ready');
		assert.strictEqual(contextValue({ status: 'failed' }), 'cmd.failed');
	});
});

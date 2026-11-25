import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { excludeGlob, isLongRunning, positionAt } from '../detectors/common';
import { detectPackageManager, parseScripts, runLine } from '../detectors/npm';
import { quoteArg } from '../shell';

const LONG_RUNNING = ['dev', 'start', 'serve', 'watch', 'run', 'bootRun', 'spring-boot:run'];

suite('npm detector', () => {
	suite('parseScripts', () => {
		test('lists scripts in file order with the line of each key', () => {
			const text = [
				'{',
				'  "name": "web",',
				'  "scripts": {',
				'    "dev": "vite",',
				'    "build": "vite build",',
				'    "test:unit": "vitest run"',
				'  }',
				'}',
			].join('\n');
			assert.deepStrictEqual(parseScripts(text), [
				{ name: 'dev', body: 'vite', line: 3, character: 4 },
				{ name: 'build', body: 'vite build', line: 4, character: 4 },
				{ name: 'test:unit', body: 'vitest run', line: 5, character: 4 },
			]);
		});

		test('finds the key, not the same word earlier in the file or inside a script', () => {
			const text = ['{', '  "build": "not a script",', '  "scripts": {', '    "a": "echo build",', '    "build": "tsc"', '  }', '}'].join(
				'\n',
			);
			assert.deepStrictEqual(
				parseScripts(text).map((s) => [s.name, s.line]),
				[
					['a', 3],
					['build', 4],
				],
			);
		});

		test('no scripts, empty scripts, and non-string values give nothing', () => {
			assert.deepStrictEqual(parseScripts('{"name": "x"}'), []);
			assert.deepStrictEqual(parseScripts('{"scripts": {}}'), []);
			assert.deepStrictEqual(parseScripts('{"scripts": ["a"]}'), []);
			assert.deepStrictEqual(
				parseScripts('{"scripts": {"a": 1, "b": "echo b"}}').map((s) => s.name),
				['b'],
			);
		});

		test('handles a byte-order mark and throws on invalid JSON', () => {
			assert.strictEqual(parseScripts('﻿{"scripts": {"a": "x"}}').length, 1);
			assert.throws(() => parseScripts('{"scripts": {'));
		});
	});

	suite('detectPackageManager', () => {
		let root: string;
		setup(() => {
			root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-hub-')));
			// A repository root, so the walk never looks above the temp folder.
			fs.mkdirSync(path.join(root, '.git'));
		});
		teardown(() => fs.rmSync(root, { recursive: true, force: true }));

		const write = (file: string, text = '') => {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		};

		test('npm when nothing says otherwise', async () => {
			write('package.json', '{}');
			assert.deepStrictEqual(await detectPackageManager(root), { manager: 'npm' });
		});

		test('each lockfile picks its manager', async () => {
			for (const [lockfile, manager] of [
				['pnpm-lock.yaml', 'pnpm'],
				['yarn.lock', 'yarn'],
				['bun.lock', 'bun'],
				['bun.lockb', 'bun'],
				['package-lock.json', 'npm'],
			]) {
				const dir = path.join(root, manager + lockfile);
				fs.mkdirSync(dir);
				fs.writeFileSync(path.join(dir, lockfile), '');
				const info = await detectPackageManager(dir);
				assert.strictEqual(info.manager, manager, lockfile);
				assert.strictEqual(info.decidedBy, path.join(dir, lockfile));
			}
		});

		test('a nested package uses the lockfile at the workspace root', async () => {
			write('pnpm-lock.yaml');
			write('packages/ui/package.json', '{"name": "ui"}');
			const info = await detectPackageManager(path.join(root, 'packages/ui'));
			assert.deepStrictEqual(info, { manager: 'pnpm', decidedBy: path.join(root, 'pnpm-lock.yaml') });
		});

		test('the packageManager field wins over a lockfile in the same folder', async () => {
			write('package.json', '{"packageManager": "yarn@4.5.0+sha512.abc"}');
			write('package-lock.json', '{}');
			assert.strictEqual((await detectPackageManager(root)).manager, 'yarn');
		});

		test('the nearest folder wins', async () => {
			write('yarn.lock');
			write('tools/cli/bun.lock');
			write('tools/cli/package.json', '{}');
			assert.strictEqual((await detectPackageManager(path.join(root, 'tools/cli'))).manager, 'bun');
		});

		test('an unknown packageManager value is ignored', async () => {
			write('package.json', '{"packageManager": "deno@2"}');
			write('pnpm-lock.yaml');
			assert.strictEqual((await detectPackageManager(root)).manager, 'pnpm');
		});

		test('stops at the repository root', async () => {
			write('repo/.git/HEAD');
			write('repo/app/package.json', '{}');
			write('yarn.lock'); // above the repository: not used
			assert.deepStrictEqual(await detectPackageManager(path.join(root, 'repo/app')), { manager: 'npm' });
		});

		test('a shared cache reads each folder once and gives the same answers', async () => {
			write('pnpm-lock.yaml');
			write('a/package.json', '{}');
			write('b/package.json', '{}');
			const cache = new Map();
			const [a, b] = await Promise.all([
				detectPackageManager(path.join(root, 'a'), cache),
				detectPackageManager(path.join(root, 'b'), cache),
			]);
			assert.strictEqual(a.manager, 'pnpm');
			assert.strictEqual(b, a);
		});
	});

	test('runLine quotes script names that need it', () => {
		assert.strictEqual(runLine('pnpm', 'dev'), 'pnpm run dev');
		assert.strictEqual(runLine('yarn', 'test:unit'), 'yarn run test:unit');
		assert.strictEqual(runLine('npm', 'build all', 'linux'), "npm run 'build all'");
		assert.strictEqual(runLine('npm', 'build all', 'win32'), 'npm run "build all"');
	});

	test('quoteArg', () => {
		assert.strictEqual(quoteArg('@scope/pkg:build-1.0', 'linux'), '@scope/pkg:build-1.0');
		assert.strictEqual(quoteArg("it's", 'linux'), `'it'\\''s'`);
		assert.strictEqual(quoteArg('$(rm -rf x)', 'linux'), `'$(rm -rf x)'`);
		assert.strictEqual(quoteArg('a "b"', 'win32'), '"a ""b"""');
	});
});

suite('detector helpers', () => {
	test('isLongRunning', () => {
		for (const name of ['dev', 'start', 'serve', 'watch', 'DEV', 'dev:web', 'start-prod', 'build:watch', 'serve_docs', 'spring-boot:run', 'run']) {
			assert.strictEqual(isLongRunning(name, LONG_RUNNING), true, name);
		}
		for (const name of ['build', 'test', 'lint', 'prestart', 'test:run', 'developer', 'restart']) {
			assert.strictEqual(isLongRunning(name, LONG_RUNNING), false, name);
		}
	});

	test('excludeGlob', () => {
		assert.strictEqual(excludeGlob([]), undefined);
		assert.strictEqual(excludeGlob(['**/a/**']), '**/a/**');
		assert.strictEqual(excludeGlob(['**/a/**', ' **/b/** ', '**/a/**', '']), '{**/a/**,**/b/**}');
	});

	test('positionAt', () => {
		const text = 'ab\ncd\n\nef';
		assert.deepStrictEqual(positionAt(text, 0), { line: 0, character: 0 });
		assert.deepStrictEqual(positionAt(text, 4), { line: 1, character: 1 });
		assert.deepStrictEqual(positionAt(text, 7), { line: 3, character: 0 });
	});
});

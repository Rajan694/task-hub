import * as assert from 'assert';
import { parse } from 'jsonc-parser';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildArgv } from '../args/prompt';
import { parsePs1Params } from '../args/ps1Params';
import { parseShArgs } from '../args/shArgs';
import { argsSummary } from '../args/summary';
import { parseComposeServices } from '../detectors/compose';
import { gradleRunTasks, parseGradleTasks, parseSettingsIncludes } from '../detectors/gradle';
import { parsePom } from '../detectors/maven';
import { parseTomlTasks, pythonFor } from '../detectors/python';
import { parseJustRecipes } from '../detectors/just';
import { parseMakeTargets } from '../detectors/make';
import { parseTaskfile } from '../detectors/taskfile';
import { parseTasksJson } from '../detectors/vscodeTasks';
import { mappingEntries } from '../detectors/yaml';
import { SavedStore } from '../saved';
import { parsePsOutput } from '../services';
import { splitArgs } from '../shell';

const lines = (...l: string[]) => l.join('\n');

suite('Makefile', () => {
	test('targets with ## descriptions, skipping assignments, special and pattern rules', () => {
		const text = lines(
			'.PHONY: build test',
			'VERSION := 1.0',
			'CC ?= gcc',
			'export PATH := $(PATH)',
			'build: deps ## Build the app',
			'\t@echo building',
			'test lint: build ## Run checks',
			'%.o: %.c',
			'$(OUT): src',
			'out/app.js: src',
			'define HELP',
			'fake: not a target',
			'endef',
			'clean: # a plain comment',
			'deploy:: ## Double-colon rule',
			'build: again',
		);
		assert.deepStrictEqual(parseMakeTargets(text), [
			{ name: 'build', line: 4, description: 'Build the app' },
			{ name: 'test', line: 6, description: 'Run checks' },
			{ name: 'lint', line: 6, description: 'Run checks' },
			{ name: 'clean', line: 13, description: undefined },
			{ name: 'deploy', line: 14, description: 'Double-colon rule' },
		]);
	});
});

suite('justfile', () => {
	test('public recipes with doc comments and parameters', () => {
		const text = lines(
			'#!/usr/bin/env just',
			'set shell := ["bash", "-c"]',
			'alias b := build',
			'version := "1.0"',
			'',
			'# Build it',
			'build:',
			'    cargo build',
			'',
			'[doc("Ship it")]',
			'[group("release")]',
			'deploy env target=\'web\' +files="a b" *rest:',
			'    echo {{env}}',
			'',
			'_helper:',
			'    echo',
			'[private]',
			'secret:',
			'@quiet arg="x": build',
		);
		const recipes = parseJustRecipes(text);
		assert.deepStrictEqual(
			recipes.map((r) => [r.name, r.line, r.description]),
			[
				['build', 6, 'Build it'],
				['deploy', 11, 'Ship it'],
				['quiet', 18, undefined],
			],
		);
		assert.deepStrictEqual(recipes[1].params, [
			{ name: 'env', kind: 'text', defaultValue: undefined, required: true, variadic: undefined },
			{ name: 'target', kind: 'text', defaultValue: 'web', required: false, variadic: undefined },
			{ name: 'files', kind: 'text', defaultValue: 'a b', required: false, variadic: true },
			{ name: 'rest', kind: 'text', defaultValue: undefined, required: false, variadic: true },
		]);
	});
});

suite('YAML sources', () => {
	test('Taskfile tasks with descriptions, without internal ones', () => {
		const text = lines(
			"version: '3'",
			'vars:',
			'  NAME: x',
			'tasks:',
			'  build:',
			'    desc: Build everything # trailing comment',
			'    cmds:',
			'      - echo build',
			'  "db:migrate":',
			"    summary: 'Run migrations'",
			'  lint: eslint .',
			'  setup:',
			'    internal: true',
			'includes:',
			'  docs: ./docs',
		);
		assert.deepStrictEqual(parseTaskfile(text), [
			{ name: 'build', line: 4, description: 'Build everything' },
			{ name: 'db:migrate', line: 8, description: 'Run migrations' },
			{ name: 'lint', line: 10, description: undefined },
		]);
	});

	test('compose services with their image or build', () => {
		const text = lines(
			'x-common: &common',
			'  restart: always',
			'services:',
			'  # the database',
			'  postgres:',
			'    <<: *common',
			'    image: "postgres:16"',
			'    environment:',
			'      IMAGE: not-this',
			'  api:',
			'    build:',
			'      context: ./api',
			'  worker:',
			'    command: run',
			'volumes:',
			'  data:',
		);
		assert.deepStrictEqual(parseComposeServices(text), [
			{ name: 'postgres', line: 4, character: 2, image: 'postgres:16' },
			{ name: 'api', line: 9, character: 2, image: 'build' },
			{ name: 'worker', line: 12, character: 2, image: undefined },
		]);
	});

	test('no block, or a flow-style block, gives nothing', () => {
		assert.deepStrictEqual(mappingEntries('version: 3\n', 'services'), []);
		assert.deepStrictEqual(mappingEntries('services: {}\n', 'services'), []);
	});

	test('docker compose ps output, old and new formats', () => {
		assert.deepStrictEqual(
			parsePsOutput('{"Service":"db","State":"running"}\n{"Service":"api","State":"exited"}\n'),
			['db'],
		);
		assert.deepStrictEqual(parsePsOutput('[{"Service":"db","State":"running"},{"Service":"web","State":"running"}]'), ['db', 'web']);
		assert.deepStrictEqual(parsePsOutput(''), []);
		assert.deepStrictEqual(parsePsOutput('not json'), []);
	});
});

suite('tasks.json', () => {
	test('labels, details and background tasks; hidden tasks left out; comments allowed', () => {
		const text = lines(
			'{',
			'  // comment',
			'  "version": "2.0.0",',
			'  "tasks": [',
			'    { "label": "build", "type": "shell", "command": "make", "args": ["all"], "detail": "Builds" },',
			'    { "type": "npm", "script": "watch", "isBackground": true },',
			'    { "label": "secret", "command": "x", "hide": true },',
			'    { "type": "shell", "command": "no label" },',
			'  ],',
			'}',
		);
		assert.deepStrictEqual(parseTasksJson(text), [
			{ label: 'build', line: 4, character: 4, detail: 'Builds', isBackground: false, commandText: 'make all' },
			{ label: 'npm: watch', line: 5, character: 4, detail: undefined, isBackground: true, commandText: 'npm: watch' },
		]);
	});
});

suite('script arguments', () => {
	test('PowerShell param() block', () => {
		const text = lines(
			'<# .SYNOPSIS param($NotThis) #>',
			'#requires -Version 5',
			'[CmdletBinding()]',
			'param(',
			'  [Parameter(Mandatory = $true, HelpMessage = "Where, (really)")]',
			'  [string]$Target,',
			"  [ValidateSet('staging', \"prod\")]",
			"  [string]$Env = 'staging',",
			'  [int]$Retries = 3,',
			'  [string]$When = (Get-Date),',
			'  [Parameter(Mandatory=$false)][switch]$Force',
			')',
			'function Inner { param($X) }',
		);
		assert.deepStrictEqual(parsePs1Params(text), [
			{ name: 'Target', kind: 'text', choices: undefined, defaultValue: undefined, required: true, flag: '-Target' },
			{ name: 'Env', kind: 'choice', choices: ['staging', 'prod'], defaultValue: 'staging', required: false, flag: '-Env' },
			{ name: 'Retries', kind: 'text', choices: undefined, defaultValue: '3', required: false, flag: '-Retries' },
			{ name: 'When', kind: 'text', choices: undefined, defaultValue: undefined, required: false, flag: '-When' },
			{ name: 'Force', kind: 'switch', choices: undefined, defaultValue: undefined, required: false, flag: '-Force' },
		]);
	});

	test('PowerShell without a script param block', () => {
		assert.strictEqual(parsePs1Params('function Go { param($X) }\nGo'), undefined);
		assert.deepStrictEqual(parsePs1Params('param()\nWrite-Output hi'), []);
	});

	test('shell # Usage: line', () => {
		const args = parseShArgs(lines('#!/bin/sh', '# Usage: $(basename "$0") <env> [--dry-run] [-t <tag>] {start|stop} [files...]', 'echo $1'));
		assert.deepStrictEqual(args, [
			{ name: 'env', kind: 'text', required: true, variadic: undefined },
			{ name: '--dry-run', kind: 'switch', required: false, flag: '--dry-run' },
			{ name: '-t <tag>', kind: 'text', required: false, flag: '-t' },
			{ name: 'value', kind: 'choice', choices: ['start', 'stop'], required: true, variadic: undefined },
			{ name: 'files', kind: 'text', required: false, variadic: true },
		]);
	});

	test('shell getopts', () => {
		assert.deepStrictEqual(parseShArgs('while getopts ":e:dv" opt; do :; done'), [
			{ name: '-e', kind: 'text', required: false, flag: '-e' },
			{ name: '-d', kind: 'switch', required: false, flag: '-d' },
			{ name: '-v', kind: 'switch', required: false, flag: '-v' },
		]);
	});

	test('shell case "$1", named positionals and defaults; awk fields and comments ignored', () => {
		const text = lines(
			'#!/bin/bash',
			'# echo $9 in a comment',
			'target=${2:-staging}',
			"awk '{print $5}' file # don't count $7",
			'case "$1" in',
			'  start) run ;;',
			'  stop|halt) halt ;;',
			'  -h|--help) usage ;;',
			'  *) exit 1 ;;',
			'esac',
		);
		assert.deepStrictEqual(parseShArgs(text), [
			{ name: '$1', kind: 'choice', choices: ['start', 'stop', 'halt'], defaultValue: undefined, required: false },
			{ name: 'target', kind: 'text', choices: undefined, defaultValue: 'staging', required: false },
		]);
	});

	test('a script that takes nothing known', () => {
		assert.strictEqual(parseShArgs('echo "$@" $# $*'), undefined);
	});

	test('summary on the row', () => {
		assert.strictEqual(
			argsSummary([
				{ name: 'env', kind: 'choice', choices: ['staging', 'prod'], required: true },
				{ name: '--dry-run', kind: 'switch', required: false, flag: '--dry-run' },
				{ name: 'Target', kind: 'text', required: true, flag: '-Target' },
				{ name: 'files', kind: 'text', required: false, variadic: true },
			]),
			'env (staging, prod) [--dry-run] -Target [files…]',
		);
	});

	test('the argument list follows the declared order', () => {
		const args = [
			{ name: '-e', kind: 'text', required: false, flag: '-e' },
			{ name: 'Force', kind: 'switch', required: false, flag: '-Force' },
			{ name: 'one', kind: 'text', required: false },
			{ name: 'two', kind: 'text', required: false },
			{ name: 'three', kind: 'text', required: false },
			{ name: 'files', kind: 'text', required: false, variadic: true },
		] as const;
		assert.deepStrictEqual(buildArgv(args, { '-e': 'prod', Force: true, one: '', two: 'b', three: '', files: 'x "y z"' }), [
			'-e',
			'prod',
			'-Force',
			'',
			'b',
			'',
			'x',
			'y z',
		]);
		assert.deepStrictEqual(buildArgv(args, { '-e': '', Force: false, one: 'a', two: '', three: '', files: '' }), ['a']);
	});

	test('splitArgs', () => {
		assert.deepStrictEqual(splitArgs(`-- --watch "my file" 'it''s' a\\ b ""`, 'linux'), ['--', '--watch', 'my file', 'its', 'a b', '']);
		assert.deepStrictEqual(splitArgs('C:\\temp\\x "a b"', 'win32'), ['C:\\temp\\x', 'a b']);
		assert.deepStrictEqual(splitArgs('   '), []);
	});
});

suite('saved commands file', () => {
	let dir: string;
	let folder: vscode.WorkspaceFolder;
	let state: Map<string, unknown>;
	let store: SavedStore;
	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-hub-saved-')));
		folder = { uri: vscode.Uri.file(dir), name: 'tmp', index: 0 };
		state = new Map();
		const memento = {
			keys: () => [...state.keys()],
			get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback),
			update: async (key: string, value: unknown) => void state.set(key, value),
		};
		store = new SavedStore(memento as unknown as vscode.Memento);
	});
	teardown(() => {
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const file = () => path.join(dir, '.vscode', 'task-hub.json');

	test('creates the file, adds with unique ids, and removes', async () => {
		const first = await store.add(folder, { label: 'Django server', command: 'python manage.py runserver', cwd: 'backend' });
		const second = await store.add(folder, { label: 'Django server!', command: 'python manage.py runserver 8001' });
		assert.strictEqual(first.id, 'django-server');
		assert.strictEqual(second.id, 'django-server-2');
		const listed = await store.list(folder);
		assert.deepStrictEqual(
			listed.commands.map((c) => [c.id, c.cwd, c.line]),
			[
				['django-server', 'backend', 2],
				['django-server-2', undefined, 8],
			],
		);
		await store.remove(folder, 'django-server');
		assert.deepStrictEqual(
			(await store.list(folder)).commands.map((c) => c.id),
			['django-server-2'],
		);
	});

	test('keeps comments and other keys when editing', async () => {
		fs.mkdirSync(path.dirname(file()));
		fs.writeFileSync(file(), '{\n  // team commands\n  "favorites": ["npm:root:dev"],\n}\n');
		await store.add(folder, { label: 'hi', command: 'echo hi' });
		const text = fs.readFileSync(file(), 'utf8');
		assert.match(text, /\/\/ team commands/);
		assert.deepStrictEqual((parse(text) as { favorites: unknown }).favorites, ['npm:root:dev']);
		assert.deepStrictEqual(
			(await store.list(folder)).commands.map((c) => c.label),
			['hi'],
		);
	});

	test('skips invalid entries; a missing id falls back to the label', async () => {
		fs.mkdirSync(path.dirname(file()));
		fs.writeFileSync(file(), JSON.stringify({ commands: [{ label: 'no command' }, 7, { command: 'ls' }, { label: 'x', command: 'pwd', cwd: '' }] }));
		assert.deepStrictEqual(
			(await store.list(folder)).commands.map((c) => [c.id, c.label, c.command, c.cwd]),
			[
				['ls', 'ls', 'ls', undefined],
				['x', 'x', 'pwd', undefined],
			],
		);
	});
});

suite('Python, Maven and Gradle files', () => {
	test('Poe and PDM tasks in pyproject.toml', () => {
		const text = lines(
			'[project]',
			'name = "demo"',
			'',
			'[tool.poe.tasks]',
			'test = "pytest"',
			'lint = { cmd = "ruff check .", help = "Lint the code" }',
			'serve = { shell = """',
			'fake = "not a task"',
			'""" }',
			'check = [',
			'  "lint",',
			']',
			'',
			'[tool.poe.tasks.build]',
			'help = "Build the wheel"',
			'',
			'[tool.pdm.scripts]',
			'_ = { env_file = ".env" }',
			'"migrate:db" = { cmd = "alembic upgrade head", help = "Migrate" }',
			'[tool.pdm.scripts.start]',
			'cmd = "flask run"',
		);
		assert.deepStrictEqual(parseTomlTasks(text, 'tool.poe.tasks'), [
			{ name: 'test', line: 4, description: undefined },
			{ name: 'lint', line: 5, description: 'Lint the code' },
			{ name: 'serve', line: 6, description: undefined },
			{ name: 'check', line: 9, description: undefined },
			{ name: 'build', line: 13, description: 'Build the wheel' },
		]);
		assert.deepStrictEqual(
			parseTomlTasks(text, 'tool.pdm.scripts').map((t) => [t.name, t.description]),
			[
				['migrate:db', 'Migrate'],
				['start', undefined],
			],
		);
	});

	test('pom.xml: own artifactId, modules, Spring Boot; parent, comments and profiles ignored', () => {
		const pom = lines(
			'<project>',
			'  <parent><artifactId>spring-boot-starter-parent</artifactId></parent>',
			'  <artifactId>shop</artifactId>',
			'  <modules><module>api</module><module> libs/core </module></modules>',
			'  <!-- <module>old</module> -->',
			'  <profiles><profile><modules><module>extra</module></modules></profile></profiles>',
			'</project>',
		);
		assert.deepStrictEqual(parsePom(pom), { artifactId: 'shop', modules: ['api', 'libs/core'], springBoot: false });
		assert.strictEqual(parsePom('<project><artifactId>x</artifactId><artifactId>spring-boot-maven-plugin</artifactId></project>').springBoot, true);
	});

	test('settings.gradle includes, Groovy and Kotlin', () => {
		assert.deepStrictEqual(parseSettingsIncludes("include ':api', 'web'\n// include 'old'\ninclude 'lib:core'\nincludeBuild 'logic'"), ['api', 'web', 'lib:core']);
		assert.deepStrictEqual(parseSettingsIncludes('include("app", ":lib:core")\n/* include("x") */'), ['app', 'lib:core']);
	});

	test('build.gradle run tasks', () => {
		assert.deepStrictEqual(gradleRunTasks('plugins {\n    application\n    id("org.springframework.boot") version "3"\n}'), ['run', 'bootRun']);
		assert.deepStrictEqual(gradleRunTasks("apply plugin: 'application'"), ['run']);
		assert.deepStrictEqual(gradleRunTasks('dependencies { implementation("org.springframework.boot:spring-boot-starter") }'), []);
	});

	test('gradle tasks --all output', () => {
		const output = lines(
			'> Task :app:tasks',
			'',
			'------------------------------------------------------------',
			"Tasks runnable from project ':app'",
			'------------------------------------------------------------',
			'',
			'Build tasks',
			'-----------',
			'assemble - Assembles the outputs of this project.',
			'build - Assembles and tests this project.',
			'',
			'Other tasks',
			'-----------',
			'customTask',
			'lib:core:compileJava - Another project.',
			'',
			'Rules',
			'-----',
			'Pattern: clean<TaskName>: Cleans the output files of a task.',
			'',
			'BUILD SUCCESSFUL in 1s',
		);
		assert.deepStrictEqual(parseGradleTasks(output), [
			{ name: 'assemble', description: 'Assembles the outputs of this project.' },
			{ name: 'build', description: 'Assembles and tests this project.' },
			{ name: 'customTask', description: undefined },
		]);
	});

	test('the project Python: a .venv next to the file, then at the root', () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-hub-py-')));
		try {
			const app = path.join(dir, 'app');
			fs.mkdirSync(app);
			const bin = process.platform === 'win32' ? path.join('.venv', 'Scripts', 'python.exe') : path.join('.venv', 'bin', 'python');
			assert.ok(!pythonFor(app, dir).includes('.venv'));
			fs.mkdirSync(path.dirname(path.join(dir, bin)), { recursive: true });
			fs.writeFileSync(path.join(dir, bin), '');
			assert.strictEqual(pythonFor(app, dir), path.join(dir, bin), 'the root venv, by full path');
			fs.mkdirSync(path.dirname(path.join(app, bin)), { recursive: true });
			fs.writeFileSync(path.join(app, bin), '');
			assert.strictEqual(pythonFor(app, dir), bin.split(path.sep).join('/'), 'its own venv, relative');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

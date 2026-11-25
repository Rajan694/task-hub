import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// A small workspace with package.json files, opened for the detector and runner tests.
	workspaceFolder: './src/test/fixtures/workspace',
	// The tests run scripts, which Restricted Mode would block.
	launchArgs: ['--disable-workspace-trust'],
	mocha: { timeout: 20000 },
});

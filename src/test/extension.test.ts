import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'rajan694.task-hub';

suite('Task Hub', () => {
	test('is installed', () => {
		assert.ok(vscode.extensions.getExtension(EXTENSION_ID));
	});

	test('activates and registers its commands', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
		await extension.activate();
		assert.strictEqual(extension.isActive, true);

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('taskHub.refresh'));
		assert.ok(commands.includes('taskHub.run'));
	});
});

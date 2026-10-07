import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const execute = promisify(execFile);

test('ordinary Output filters complete backend lines while log records and raw editor text remain intact', async ({ target, testWorkspace, application, workbench }, testInfo) => {
	test.skip(target.appServerMode !== 'required', 'Requires the real App Server and its isolated test profile.');
	test.setTimeout(120_000);
	const packageDirectory = join(testWorkspace.directory, 'output-fixture');
	const executable = process.platform === 'win32' ? 'output-extension.exe' : 'output-extension';
	await mkdir(join(packageDirectory, '.ash-plugin'), { recursive: true });
	await mkdir(join(packageDirectory, 'bin'));
	await execute('rustc', ['--edition=2024', '-Dwarnings', resolve(import.meta.dirname, '../../../fixtures/output_extension.rs'), '-o', join(packageDirectory, 'bin', executable)], { timeout: 30_000 });
	// The shared fixture owns this temporary workspace and backend profile. The
	// installed executable has only its exact process permission, and consumes stdin.
	await writeFile(join(packageDirectory, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'ash/output-filter-fixture', version: '1.0.0', displayName: 'Output Filter Test',
		compatibility: { ash: '>=0.1.0' },
		contributions: {
			editorExtensions: [{
				id: 'output', runtime: 'hostRpc', entrypoint: `bin/${executable}`, runtimeApiVersion: 1,
				activationEvents: [{ type: 'startup' }], capabilities: ['command'],
			}],
		},
		permissions: [{ type: 'process', executable: `bin/${executable}` }],
	}));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('output-fixture');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed ash/output-filter-fixture 1.0.0');
	const manage = async (button: string): Promise<void> => {
		const review = await workbench.dialogs.confirm(application, 'Output Filter Test', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await workbench.quickaccess.select('Output Filter Test');
		});
		expect(review.detail).toContain(`bin/${executable}`);
		expect(review.detail).toContain('Package digest: sha256:');
	};
	await manage('Enable');
	await manage('Grant permissions');
	const selectChannel = async (label: string): Promise<void> => {
		await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
		await workbench.quickaccess.select(label);
	};
	await selectChannel('Output Filter Fixture');
	const output = page.locator('[data-view-id="ash.output"]');
	const filter = output.getByRole('searchbox', { name: 'Filter Output', exact: true });
	const visibleLines = async (): Promise<string[]> => (await output.locator('.view-line').allTextContents()).map(line => line.replaceAll('\u00a0', ' ')).filter(Boolean);
	await expect.poll(visibleLines).toEqual(['keep one', 'drop one', 'keep excluded', 'kee']);
	if (target.kind === 'browser') {
		// Read the production backend adapter; no events or Output state are injected.
		const snapshot = await page.evaluate(() => globalThis.ashWebWorkbenchHost!.api.extensionHost.list());
		const runtime = snapshot.extensions.find(extension => extension.outputEvents.some(event => event.operation.operation === 'create' && event.operation.label === 'Output Filter Fixture'));
		expect(runtime?.lifecycle).toBe('ready');
		expect(runtime?.incarnation).toBeGreaterThan(0);
		const sequences = runtime!.outputEvents.map(event => event.sequence);
		expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)).toBe(true);
		expect(runtime!.outputEvents.every(event => event.incarnation === runtime!.incarnation && event.activationGeneration === runtime!.activationGeneration)).toBe(true);
		const raw = runtime?.outputEvents.filter(event => event.operation.operation === 'append' && event.operation.channelId === 'plain').map(event => event.operation.operation === 'append' ? event.operation.text : '').join('');
		expect(raw).toBe('keep one\ndrop one\nkeep excluded\nkee');
		await testInfo.attach('backend-output-snapshot', { body: JSON.stringify(runtime), contentType: 'application/json' });
	}
	await filter.fill('keep');
	await expect.poll(visibleLines).toEqual(['keep one', 'keep excluded']);
	await filter.fill('keep !excluded');
	await expect.poll(visibleLines).toEqual(['keep one']);
	await workbench.quickaccess.runCommand('ash.output.fixture.append');
	await expect.poll(visibleLines).toEqual(['keep one', 'keep tail']);
	await workbench.quickaccess.runCommand('ash.output.fixture.finish');
	await expect.poll(visibleLines).toEqual(['keep one', 'keep tail', 'keep unfinished']);
	await selectChannel('Output Other Fixture');
	await expect.poll(visibleLines).toEqual(['keep other']);
	await selectChannel('Output Log Fixture');
	await expect.poll(visibleLines).toEqual(['keep log', 'log continuation']);
	await filter.fill('!continuation');
	await expect.poll(visibleLines).toEqual(['other log']);
	await selectChannel('Output Filter Fixture');
	await filter.fill('keep !excluded');
	await expect.poll(visibleLines).toEqual(['keep one', 'keep tail', 'keep unfinished']);
	await workbench.quickaccess.runCommand('workbench.action.output.openInEditor');
	const editor = workbench.editors.groupAt(0).content;
	await expect(editor.locator('.view-lines')).toContainText('drop one');
	await expect(editor.locator('.view-lines')).toContainText('keep excluded');
	await expect(editor.locator('.view-lines')).toContainText('drop two');
	await expect(editor.locator('.view-lines')).toContainText('keep unfinished');
	await filter.fill('absent');
	await expect(output.locator('.view-lines')).toHaveCount(0);
	await expect(editor.locator('.view-lines')).toContainText('drop two');
	await filter.fill('keep');
	await workbench.quickaccess.runCommand('ash.output.fixture.clear');
	await expect.poll(visibleLines).toEqual([]);
	await expect(editor.locator('.view-lines')).toBeEmpty();
	await workbench.quickaccess.runCommand('ash.output.fixture.append');
	await workbench.quickaccess.runCommand('ash.output.fixture.finish');
	await expect.poll(visibleLines).toEqual(['keep unfinished']);
	await workbench.quickaccess.runCommand('workbench.action.output.clear');
	await expect.poll(visibleLines).toEqual([]);
	await expect(editor.locator('.view-lines')).toBeEmpty();
	await workbench.quickaccess.runCommand('ash.output.fixture.dispose');
	await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
	await expect(workbench.quickaccess.items.filter({ hasText: 'Output Filter Fixture' })).toHaveCount(0);
	await workbench.quickaccess.close();
	await manage('Revoke permissions');
	await manage('Disable');
	await manage('Uninstall');
});

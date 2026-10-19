import { expect, test } from '@playwright/test';
import { prepareCodeExtension, startCodeExtension } from '../../fixtures/codeExtension.js';

test.beforeAll(() => { test.setTimeout(120_000); prepareCodeExtension(); });
test('plain editor receives real Rust Code features and releases them through four enable cycles', async ({ page }) => {
	let process: Awaited<ReturnType<typeof startCodeExtension>> | undefined;
	let generation = 0;
	await page.route('**/__code_extension', async route => {
		const { enabled } = route.request().postDataJSON();
		await process?.dispose();
		process = enabled ? await startCodeExtension() : undefined;
		await route.fulfill({
			json: {
				generation: ++generation, extensions: process ? [{
					id: 'ash.code', version: '1.0.0', packageDigest: `sha256:${'b'.repeat(64)}`, runtimeApiVersion: 1,
					activationGeneration: generation, incarnation: generation, lifecycle: 'ready', stderr: '', outputEvents: [], registrations: process.registrations,
				}] : []
			}
		});
	});
	await page.route('**/__code_invoke', async route => {
		await route.fulfill({ json: await process!.invoke('editor.contributions.v1', 'receiveData', route.request().postDataJSON()) });
	});
	try {
		await page.goto('/codeExtension.html');
		await page.waitForFunction(() => !!window.ashCodeExtension);
		const initial = await page.evaluate(() => window.ashCodeExtension.state());
		expect(initial.ids).not.toContain('editor.contrib.folding');
		expect(initial.rename).toBe(false);
		expect(initial.minimap).toBe(false);
		for (let cycle = 0; cycle < 4; cycle++) {
			const active = await page.evaluate(() => window.ashCodeExtension.enable(true));
			expect(active.modelId).toBe(initial.modelId);
			expect(active.placeholder).toBe(true);
			expect(active.folding).toBe(true);
			expect(active.rename).toBe(true);
			expect(active.minimap).toBe(true);
			expect((await page.evaluate(() => window.ashCodeExtension.type('('))).text).toBe('()');
			expect((await page.evaluate(() => window.ashCodeExtension.undo())).text).toBe('');
			const edited = await page.evaluate(() => window.ashCodeExtension.edit('draft'));
			expect(edited.text).toBe('draft');
			const retired = await page.evaluate(() => window.ashCodeExtension.enable(false));
			expect(retired.text).toBe('draft');
			expect(retired.version).toBe(edited.version);
			expect(retired.placeholder).toBe(false);
			expect(retired.folding).toBe(false);
			expect(retired.rename).toBe(false);
			expect(retired.minimap).toBe(false);
			expect(retired.ids).toEqual(initial.ids);
			const undone = await page.evaluate(() => window.ashCodeExtension.undo());
			expect(undone.text).toBe('');
			expect((await page.evaluate(() => window.ashCodeExtension.type('('))).text).toBe('(');
			expect((await page.evaluate(() => window.ashCodeExtension.undo())).text).toBe('');
		}
	} finally {
		await page.evaluate(() => window.ashCodeExtension?.dispose()).catch(() => undefined);
		await process?.dispose();
	}
});

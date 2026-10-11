import { expect, test } from '@playwright/test';

test('SCM commit form separator disappears after a clean Git snapshot and returns with resource groups', async ({ page }, testInfo) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		await page.evaluate(() => window.gitScmPaneIntegration.mount());
		const form = page.locator('#scm-pane .ash-scm-commit-form');
		const tree = page.locator('#scm-pane').getByRole('tree', { name: 'Source control changes', exact: true });
		await expect(form).toBeVisible();
		await expect(form).toHaveCSS('border-bottom-width', '1px');
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(true));
		await expect(tree.getByRole('treeitem')).toHaveCount(0);
		await expect(form).toHaveCSS('border-bottom-width', '0px');
		const boundaries = await page.locator('#scm-pane .ash-split-view-pane').evaluateAll(panes => panes.slice(1).map(pane => getComputedStyle(pane, '::before').height));
		expect(boundaries).toEqual(['1px', '1px']);
		await testInfo.attach('clean-source-control', { body: await page.locator('#scm-pane').screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(false));
		await expect(tree.locator('.ash-scm-change')).toHaveCount(1);
		await expect(form).toHaveCSS('border-bottom-width', '1px');
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`distributed Git Worker registers SCM, commands and history in ${language}`, async ({ page }) => {
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto('/gitExtension.html');
	try {
		const activation = await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
		expect(activation).toEqual([{ lifecycle: 'ready', failure: undefined, registrations: expect.arrayContaining(['sourceControl', 'command']) }]);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		const before = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(before.repositories[0].groups).toContain(language === 'zh-CN' ? '更改' : 'Changes');
		const history = await page.evaluate(() => window.gitExtensionIntegration.history());
		expect(history).toMatchObject([{ id: 'a'.repeat(40), subject: 'First commit' }]);
		await page.evaluate(() => window.gitExtensionIntegration.stage());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.some(call => call.method === 'git/stage'))).toBe(true);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.groups)).toContain(language === 'zh-CN' ? '暂存的更改' : 'Staged Changes');
		await page.evaluate(async () => {
			window.gitExtensionIntegration.answer(['feature']); await window.gitExtensionIntegration.invoke('git.branch', ['root']);
			window.gitExtensionIntegration.answer(['https://example.com/repo']); await window.gitExtensionIntegration.invoke('git.clone');
			window.gitExtensionIntegration.answer(['main']); await window.gitExtensionIntegration.invoke('git.init');
		});
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).calls.map(call => call.method)).toEqual(expect.arrayContaining(['git/branch/create', 'git/clone', 'git/init']));
		await page.evaluate(() => window.gitExtensionIntegration.disable());
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).repositories).toEqual([]);
		expect(errors).toEqual([]); expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`disabled Git leaves another SCM Worker and editable diff intact in ${language}`, async ({ page }) => {
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIsolation.addGeneric());
		await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.map(value => value.id))).toEqual(['root', 'snapshots']);
		const before = await page.evaluate(() => window.gitExtensionIsolation.runtimes());
		expect(before.every(runtime => runtime.lifecycle === 'ready')).toBe(true);
		await page.evaluate(() => window.gitExtensionIsolation.openEditor());
		await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('after');
		await expect.poll(() => page.evaluate(() => window.gitExtensionIsolation.editorState().text)).toBe('before\nafter');
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState().dirty)).toBe(true);
		await page.evaluate(() => window.gitExtensionIsolation.exerciseProvider());
		await page.evaluate(() => window.gitExtensionIntegration.disable());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.map(value => value.id))).toEqual(['snapshots']);
		const remaining = await page.evaluate(() => window.gitExtensionIsolation.runtimes());
		expect(remaining).toEqual([before.find(runtime => runtime.id === 'test.snapshots')]);
		expect(await page.evaluate(() => window.gitExtensionIsolation.retiredRequest())).toEqual({ invocationError: expect.stringContaining('retired activation'), backendError: expect.stringContaining('not authorized'), backendCalls: 0 });
		expect(await page.evaluate(() => ['file', 'git-change', 'snapshot'].map(scheme => window.gitExtensionIsolation.openSideVisible(scheme)))).toEqual([true, true, true]);
		expect(await page.evaluate(() => window.gitExtensionIsolation.providerState())).toEqual({ draft: 'retained draft', quickDiff: ['test.snapshots:snapshots'], decorations: 1 });
		expect(await page.evaluate(() => window.gitExtensionIsolation.exerciseProvider())).toEqual({ originals: ['test.snapshots:snapshots'], multi: ['one.ts'] });
		expect(await page.evaluate(() => window.gitExtensionIsolation.accept())).toBe('recorded');
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState())).toMatchObject({ text: 'before\nafter', dirty: true, savedText: 'before\n' });
		await expect.poll(() => page.evaluate(() => window.gitExtensionIsolation.editorState().diff)).toBe('ready');
		await page.evaluate(() => window.gitExtensionIsolation.undo());
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState().text)).toBe('before\n');
		await page.evaluate(() => window.gitExtensionIsolation.redo());
		await page.evaluate(() => window.gitExtensionIsolation.save());
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState())).toMatchObject({ text: 'before\nafter', dirty: false, savedText: 'before\nafter' });
		await page.evaluate(() => window.gitExtensionIsolation.enable());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.some(value => value.id === 'root'))).toBe(true);
		const restored = await page.evaluate(() => window.gitExtensionIsolation.runtimes());
		expect(restored.find(runtime => runtime.id === 'test.snapshots')).toEqual(remaining[0]);
		expect(restored.find(runtime => runtime.id === 'ash.git')?.incarnation).not.toBe(before.find(runtime => runtime.id === 'ash.git')?.incarnation);
		expect(errors).toEqual([]); expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`disabled Git stays inactive after reload while editing works in ${language}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
	await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.length)).toBe(1);
	await page.evaluate(() => window.gitExtensionIntegration.disable());
	await page.evaluate(() => window.gitExtensionIntegration.dispose());
	await page.reload();
	try {
		expect(await page.evaluate(language => window.gitExtensionIntegration.activate(language), language)).toEqual([]);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state())).toMatchObject({ repositories: [], calls: [], errors: [] });
		await page.evaluate(() => window.gitExtensionIsolation.openEditor());
		await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('saved without Git');
		await page.evaluate(() => window.gitExtensionIsolation.save());
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState())).toMatchObject({ dirty: false, savedText: 'before\nsaved without Git' });
		await page.evaluate(() => window.gitExtensionIsolation.enable());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.map(repository => repository.id))).toEqual(['root']);
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

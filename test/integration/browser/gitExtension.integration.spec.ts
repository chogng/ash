import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => {
		if (message.type() === 'error' && message.text().startsWith('SCM update failed')) errors.push(message.text());
	});
	return errors;
}

test('Worker queues a large client request batch without retiring its incarnation', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitSCMTransportIntegration.holdOutputs());
		const burst = page.evaluate(() => window.gitSCMTransportIntegration.burst());
		await expect.poll(() => page.evaluate(() => window.gitSCMTransportIntegration.waitingOutputs())).toBe(32);
		await page.evaluate(() => window.gitSCMTransportIntegration.releaseOutputs());
		expect(await burst).toEqual(Array.from({ length: 64 }, () => ({ result: 'value', value: null })));
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => { window.gitSCMTransportIntegration.releaseOutputs(); window.gitExtensionIntegration.dispose(); });
	}
});

test('SCM delivers changes queued while its initialization update is in flight', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitSCMTransportIntegration.hold());
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitSCMTransportIntegration.waiting())).toBe(1);
		await page.evaluate(() => window.gitExtensionIntegration.stage());
		await page.evaluate(() => window.gitSCMTransportIntegration.release());
		await expect.poll(async () => ({ groups: await page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.groups), errors: [...errors] })).toEqual({ groups: ['Staged Changes'], errors: [] });
		expect(errors).toEqual([]);
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
	} finally {
		await page.evaluate(() => { window.gitSCMTransportIntegration.release(); window.gitExtensionIntegration.dispose(); });
	}
});

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

for (const language of ['en', 'zh-CN']) test(`SCM commit message action handles layout, keyboard, cancellation and repository switching in ${language}`, async ({ page }, testInfo) => {
	const errors = collectErrors(page);
	const generateLabel = language === 'zh-CN' ? '生成提交信息' : 'Generate commit message';
	const stopLabel = language === 'zh-CN' ? '停止生成提交信息' : 'Stop generating commit message';
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIsolation.addGeneric());
		await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		await page.evaluate(() => window.gitScmPaneIntegration.mount());
		const input = page.locator('#scm-pane .ash-scm-input');
		const button = input.getByRole('button', { name: generateLabel, exact: true });
		await expect(button).toBeVisible();
		await expect(button).toBeDisabled();
		await expect(button).toHaveAttribute('title', language === 'zh-CN' ? '尚未配置提交信息生成器' : 'No commit message generator configured');
		await expect(button.locator('[data-ash-icon-id="sparkle"]')).toHaveCount(1);
		const editor = input.locator('.stanza-editor-input');
		await editor.focus();
		await page.keyboard.type('Keep my draft');
		await page.evaluate(() => window.gitScmPaneIntegration.configureGenerator());
		await expect(button).toBeEnabled();
		await page.keyboard.press('Tab');
		await expect(button).toBeFocused();
		const geometry = await input.evaluate(node => {
			const editor = node.querySelector('.ash-scm-input-editor')!.getBoundingClientRect();
			const button = node.querySelector('.ash-scm-input-action')!.getBoundingClientRect();
			const bounds = node.getBoundingClientRect();
			return { separated: editor.right <= button.left, contained: button.right <= bounds.right, width: button.width };
		});
		expect(geometry).toEqual({ separated: true, contained: true, width: 24 });
		for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.gitScmPaneIntegration.setTheme(theme), theme);
			await expect(button).toHaveCSS('outline-style', 'solid');
			const colors = await button.evaluate(node => {
				const style = getComputedStyle(node);
				const reference = document.createElement('span');
				reference.style.color = style.getPropertyValue('--ash-focusBorder');
				return { color: style.color, focus: style.outlineColor, expectedFocus: reference.style.color };
			});
			expect(colors.color).not.toBe('rgba(0, 0, 0, 0)');
			expect(colors.focus).toBe(colors.expectedFocus);
		}
		await page.evaluate(() => window.gitScmPaneIntegration.setWidth(220));
		await expect(button).toBeFocused();
		await page.keyboard.press('Enter');
		const stop = input.getByRole('button', { name: stopLabel, exact: true });
		await expect(stop).toBeEnabled();
		await expect(stop).toBeFocused();
		await expect(stop.locator('[data-ash-icon-id="stop-circle"]')).toHaveCount(1);
		await expect(input).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(false));
		await expect(stop).toBeEnabled();
		await expect.poll(() => page.evaluate(() => window.gitScmPaneIntegration.generationState())).toMatchObject({ count: 1, cancelled: false, groups: [{ id: 'changes', resources: [expect.stringContaining('one.ts')] }] });
		await testInfo.attach(`commit-message-generating-${language}`, { body: await input.screenshot(), contentType: 'image/png' });
		await page.keyboard.press('Space');
		await expect(stop).toBeDisabled();
		expect((await page.evaluate(() => window.gitScmPaneIntegration.generationState())).cancelled).toBe(true);
		await page.evaluate(() => window.gitScmPaneIntegration.finishGeneration());
		await expect(button).toBeEnabled();
		await expect(input).toHaveAttribute('aria-busy', 'false');
		await button.click();
		await expect(stop).toBeEnabled();
		await page.evaluate(() => window.gitScmPaneIntegration.selectRepository('snapshots'));
		expect((await page.evaluate(() => window.gitScmPaneIntegration.generationState())).cancelled).toBe(true);
		await expect(button).toBeDisabled();
		await expect(input).toHaveAttribute('aria-busy', 'false');
		await page.evaluate(() => window.gitScmPaneIntegration.selectRepository('root'));
		expect(await page.evaluate(() => window.gitScmPaneIntegration.draft())).toBe('Keep my draft');
		await page.evaluate(() => window.gitScmPaneIntegration.finishGeneration());
		await button.click();
		await expect(stop).toBeEnabled();
		await page.evaluate(() => window.gitScmPaneIntegration.finishGeneration());
		await expect(button).toBeEnabled();
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(true));
		await expect(button).toBeDisabled();
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(false));
		await button.click();
		await expect(stop).toBeEnabled();
		await page.evaluate(() => window.gitExtensionIntegration.dispose());
		expect((await page.evaluate(() => window.gitScmPaneIntegration.generationState())).cancelled).toBe(true);
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`distributed Git Worker registers SCM, commands and history in ${language}`, async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		const activation = await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
		expect(activation).toEqual([{ lifecycle: 'ready', failure: undefined, registrations: expect.arrayContaining(['sourceControl', 'command']) }]);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		const before = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(before.repositories[0].groups).toContain(language === 'zh-CN' ? '更改' : 'Changes');
		const history = await page.evaluate(() => window.gitExtensionIntegration.history());
		expect(history).toMatchObject([{ id: 'a'.repeat(40), subject: 'First commit' }]);
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.switchBranch', ['root']));
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).requests).toContainEqual({ operation: 'showQuickPick', placeholder: language === 'zh-CN' ? '选择 Git 分支' : 'Select a Git branch', items: [{ label: 'main', description: language === 'zh-CN' ? '当前分支' : 'Current' }, { label: 'occupied', description: 'origin/occupied', detail: language === 'zh-CN' ? '已在另一个工作树中检出' : 'Checked out in another worktree' }] });
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
	const errors = collectErrors(page);
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
	const errors = collectErrors(page);
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
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});


for (const activation of ['click', 'keyboard'] as const) test(`Git statusbar ${activation} synchronizes through the Worker and disables pending actions`, async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true); await window.gitExtensionIntegration.activate('en'); });
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		const branch = page.locator('[data-statusbar-item-id="ash.status.git.branch"] [role="button"]');
		await expect(sync).toHaveText('3↓ 2↑');
		if (activation === 'click') await sync.click();
		else { await sync.focus(); await page.keyboard.press('Enter'); }
		await expect(sync).toHaveAttribute('aria-disabled', 'true');
		await expect(branch).toHaveAttribute('aria-disabled', 'true');
		await expect(sync).toHaveAttribute('aria-label', 'Synchronizing Changes…');
		await sync.click({ force: true });
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/pull').length)).toBe(1);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/push'))).toEqual([]);
		await page.evaluate(() => window.gitStatusbarIntegration.release());
		await expect(sync).not.toHaveAttribute('aria-disabled');
		await expect(sync).toHaveText('');
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/pull' || call.method === 'git/push'))).toEqual([
			{ method: 'git/pull', params: { repositoryId: 'root', mode: 'sync' } },
			{ method: 'git/push', params: { repositoryId: 'root' } },
		]);
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

for (const activation of ['statusbar', 'command'] as const) test(`Git statusbar publishes a branch without upstream through the Worker via ${activation}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		const publish = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		await expect(publish).toHaveAttribute('aria-label', 'Publish Git branch main');
		if (activation === 'statusbar') await publish.click();
		else await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/command').map(call => call.params))).toEqual([
			{ repositoryId: 'root', command: { kind: 'publishBranch', remote: 'origin', name: 'main', branch: 'main', expectedHead: 'a'.repeat(40) } },
		]);
		await expect(publish).toHaveAttribute('aria-label', /Synchronize Git changes/);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git statusbar does not push after a failed pull through the Worker', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true, true); await window.gitExtensionIntegration.activate('en'); });
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		await expect(sync).toHaveText('3↓ 2↑');
		await sync.click();
		await expect(sync).toHaveAttribute('aria-disabled', 'true');
		await page.evaluate(() => window.gitStatusbarIntegration.release());
		await expect(sync).not.toHaveAttribute('aria-disabled');
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/push'))).toEqual([]);
		await expect(sync).toHaveText('3↓ 2↑');
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});


for (const command of ['git.pullRebase', 'git.syncRebase'] as const) test(`Git statusbar explicit rebase reaches the backend through ${command}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true); await window.gitExtensionIntegration.activate('en'); });
		await expect(page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]')).toHaveText('3↓ 2↑');
		const invocation = page.evaluate(id => window.gitExtensionIntegration.invoke(id, ['root']), command);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/pull'))).toEqual([
			{ method: 'git/pull', params: { repositoryId: 'root', mode: 'rebase' } },
		]);
		await page.evaluate(() => window.gitStatusbarIntegration.release());
		await invocation;
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/push').length)).toBe(command === 'git.syncRebase' ? 1 : 0);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});


test('Git rebase command labels are localized in Chinese', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('zh-CN'));
		const labels = await page.evaluate(() => window.gitStatusbarIntegration.commandLabels());
		expect(labels.filter(command => command.id === 'git.pullRebase' || command.id === 'git.syncRebase').sort((left, right) => left.id.localeCompare(right.id))).toEqual([
			{ id: 'git.pullRebase', title: '拉取（变基）' },
			{ id: 'git.syncRebase', title: '同步更改（变基）' },
		]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});


for (const language of ['en', 'zh-CN']) test(`Git rebase setting reads and writes the shared profile through Settings UI in ${language}`, async ({ page }, testInfo) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async lang => { await window.gitExtensionIntegration.activate(lang); window.gitSettingsIntegration.mount(lang); }, language);
		const label = language === 'zh-CN' ? '同步时变基' : 'Rebase When Sync';
		const toggle = page.getByRole('switch', { name: label, exact: true });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.focus();
		await page.keyboard.press('Space');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect.poll(() => page.evaluate(() => window.gitSettingsIntegration.profile())).toEqual({ autofetch: 'off', autofetchPeriod: 180, rebaseWhenSync: true });
		await expect(toggle).toBeEnabled();
		await page.evaluate(() => window.gitSettingsIntegration.externalChange(false));
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.click();
		await expect.poll(() => page.evaluate(() => window.gitSettingsIntegration.profile().rebaseWhenSync)).toBe(true);
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(toggle).toBeEnabled();
		await page.locator('#git-settings .ash-setting-item-actions-trigger').click();
		await page.evaluate(() => window.gitSettingsIntegration.reset());
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect.poll(() => page.evaluate(() => window.gitSettingsIntegration.profile())).toEqual({ autofetch: 'off', autofetchPeriod: 180, rebaseWhenSync: false });
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
		await testInfo.attach(`git-rebase-setting-${language}`, { body: await page.locator('#git-settings').screenshot(), contentType: 'image/png' });
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git rebase Settings UI keeps the saved value when writing fails', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { await window.gitExtensionIntegration.activate('en'); window.gitSettingsIntegration.mount(); });
		const toggle = page.getByRole('switch', { name: 'Rebase When Sync', exact: true });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await page.evaluate(() => window.gitSettingsIntegration.rejectWrites());
		await toggle.click();
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().errors.some(error => error.includes('Settings save rejected')))).toBe(true);
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		expect(await page.evaluate(() => window.gitSettingsIntegration.profile().rebaseWhenSync)).toBe(false);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});


test('Git rebase setting command rejects non-boolean input before saving', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('zh-CN'));
		await page.evaluate(async () => { try { await window.gitExtensionIntegration.invoke('git.updateRebaseWhenSync', ['true']); } catch { } });
		expect(await page.evaluate(() => window.gitSettingsIntegration.profile().rebaseWhenSync)).toBe(false);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'config/update'))).toEqual([]);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors.some(error => error.includes('布尔值')))).toBe(true);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN'] as const) test(`Changes opens the selected Turn in its canonical editor (${locale})`, async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(`/changes.html?locale=${locale}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
	const turn = page.getByRole('combobox', { name: locale === 'en' ? 'Changes from Turn' : '选择回合更改' });
	await turn.selectOption('second');
	const review = page.getByRole('button', { name: locale === 'en' ? 'Review all changes' : '查看全部更改', exact: true });
	await review.focus();
	await page.keyboard.press('Space');
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.reviews())).toEqual([{ resource: 'ash-session-changes:/session?thread=thread', changesetId: 'second' }]);
	await turn.selectOption('');
	await review.click();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.reviews())).toEqual([
		{ resource: 'ash-session-changes:/session?thread=thread', changesetId: 'second' },
		{ resource: 'ash-session-changes:/session?thread=thread', changesetId: undefined },
	]);
	expect(errors).toEqual([]);
});

test('Changes filters Turns, restores tree state and binds review markers to revision and conversation', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/changes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.ashChangesIntegration.multipleTurns());
	await expect(page.getByRole('treeitem')).toHaveCount(2);
	const mode = page.getByRole('combobox', { name: 'Changes view mode' });
	const turn = page.getByRole('combobox', { name: 'Changes from Turn' });
	await turn.selectOption('second');
	await expect(page.getByRole('treeitem')).toHaveCount(1);
	await page.getByRole('treeitem').click();
	await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
	await expect(page.getByRole('treeitem')).toContainText('Reviewed');
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.content())).toContain('Reviewed');
	await mode.selectOption('tree');
	await expect(page.getByRole('treeitem')).toHaveCount(3);
	const tree = page.getByRole('tree');
	await tree.focus();
	await tree.press('Home');
	await tree.press('ArrowLeft');
	await expect(page.getByRole('treeitem')).toHaveCount(1);
	await mode.selectOption('list');
	await expect(page.getByRole('treeitem')).toHaveAttribute('aria-selected', 'true');
	await mode.selectOption('tree');
	await expect(page.getByRole('treeitem')).toHaveCount(1);
	await page.evaluate(() => window.ashChangesIntegration.visible(false));
	await page.evaluate(() => window.ashChangesIntegration.visible(true));
	await expect(page.getByRole('treeitem')).toHaveCount(1);
	await turn.selectOption('');
	await expect(page.getByRole('treeitem')).toHaveCount(7);
	await mode.selectOption('list');
	await page.evaluate(() => window.ashChangesIntegration.selectSession('other'));
	await expect(page.getByRole('treeitem').filter({ hasText: 'Reviewed' })).toHaveCount(0);
	await page.evaluate(() => window.ashChangesIntegration.selectSession('session'));
	await expect(page.getByRole('treeitem').filter({ hasText: 'Reviewed' })).toHaveCount(1);
	await page.evaluate(() => window.ashChangesIntegration.revision(2));
	await expect(page.getByRole('treeitem').filter({ hasText: 'Reviewed' })).toHaveCount(0);
	await page.setViewportSize({ width: 320, height: 600 });
	for (const theme of ['light', 'dark', 'hc']) {
		await page.evaluate(theme => window.ashChangesIntegration.theme(theme), theme);
		await mode.focus();
		await mode.press('Tab');
		await page.keyboard.press('Shift+Tab');
		await expect(mode).not.toHaveCSS('outline-style', 'none');
	}
	expect(errors).toEqual([]);
});

test('Changes sends the prepared PR request to the initiating Thread and restores allowed form preferences', async ({ page }) => {
	await page.goto('/changes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const create = page.getByRole('button', { name: 'Create pull request', exact: true });
	await create.click();
	const form = page.getByRole('dialog', { name: 'Create pull request' });
	await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
	await form.getByRole('textbox', { name: 'Title', exact: true }).fill('Agent reviewed PR');
	await form.getByRole('textbox', { name: 'Description', exact: true }).fill('Changes to review');
	await form.getByRole('combobox', { name: 'Merge mode' }).selectOption('SQUASH');
	await form.getByRole('combobox', { name: 'Pull request action' }).selectOption('sendToChat');
	await form.getByRole('button', { name: 'Send to agent' }).click();
	await expect(form).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.agentRequests())).toEqual([{
		action: 'start', request: expect.objectContaining({ sessionId: 'session', threadId: 'thread', expectedSequence: 7, mode: 'agent', text: expect.stringContaining('Title: Agent reviewed PR\nDescription:\nChanges to review') }),
	}]);
	expect(await page.evaluate(() => window.ashChangesIntegration.created())).toEqual([]);
	await create.click();
	await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
	await expect(form.getByRole('combobox', { name: 'Merge mode' })).toHaveValue('SQUASH');
	await expect(form.getByRole('combobox', { name: 'Pull request action' })).toHaveValue('sendToChat');
	await page.evaluate(() => window.ashChangesIntegration.activeTurn(true));
	await form.getByRole('button', { name: 'Send to agent' }).click();
	await expect(form).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.agentRequests())).toEqual([
		{ action: 'start', request: expect.anything() }, { action: 'queue', request: expect.objectContaining({ sessionId: 'session', threadId: 'thread', expectedSequence: 7 }) },
	]);
});

test('Changes keeps keyboard selection through refresh and clears stale actions on failure', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/changes.html');
	await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
	const tree = page.getByRole('tree', { name: 'Changes' });
	const file = page.getByRole('treeitem');
	await expect(file).toHaveCount(1);
	await expect(page.locator('.ash-sessions-changes-summary')).toHaveText('1 file changes · +3 −2');
	await expect(page.locator('.ash-sessions-changes-repository-status')).toContainText('origin/feature: 1 incoming · 2 outgoing · 3 uncommitted files');
	await expect(page.locator('.ash-sessions-changes-summary')).toHaveCSS('font-size', '11px');
	await tree.focus();
	await tree.press('ArrowDown');
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.opened())).toBe(1);
	await expect(page.getByRole('button', { name: 'Preview selected changes' })).toBeEnabled();
	await page.evaluate(() => window.ashChangesIntegration.fail(false));
	await expect(file).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toBeFocused();
	await page.evaluate(() => window.ashChangesIntegration.fail(true));
	await expect(file).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Review all changes' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Preview selected changes' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Retry loading changes' })).toBeVisible();
	await page.evaluate(() => window.ashChangesIntegration.fail(false));
	await expect(file).toHaveCount(1);
	await page.setViewportSize({ width: 320, height: 600 });
	const path = page.locator('.ash-sessions-change-path');
	await expect(path).toHaveCSS('text-overflow', 'ellipsis');
	await expect(path).toHaveAttribute('title', 'src/a-long-directory-name/main.ts');
	await expect(page.getByRole('link', { name: 'Build · Successful · team/repo #7' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Tests · Failed · team/repo #7' })).toBeVisible();
	const build = page.getByRole('link', { name: 'Build · Successful · team/repo #7' });
	await build.focus();
	await page.evaluate(() => window.ashChangesIntegration.fail(false));
	await expect(build).toBeFocused();
	const checks = page.getByRole('button', { name: 'Checks', exact: true });
	await checks.focus();
	await checks.press('Enter');
	await expect(checks).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('link', { name: 'Tests · Failed · team/repo #7' })).toBeHidden();
	await checks.press('Space');
	await checks.press('Enter');
	await page.evaluate(() => window.ashChangesIntegration.visible(false));
	await page.evaluate(() => window.ashChangesIntegration.visible(true));
	await expect(page.getByRole('button', { name: 'Checks', exact: true })).toHaveAttribute('aria-expanded', 'false');
	await page.getByRole('button', { name: 'Checks', exact: true }).press('Enter');
	await expect(checks).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('button', { name: 'Sync changes', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.gitCalls())).toEqual(['git.pull:repository', 'git.push:repository']);
	await page.evaluate(() => window.ashChangesIntegration.setLocale());
	await expect(page.locator('.ash-sessions-changes-summary')).toHaveText('1 项文件更改 · +3 −2');
});

test('Changes creates and attaches the edited PR, and cancellation restores keyboard focus', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/changes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const create = page.getByRole('button', { name: 'Create pull request', exact: true });
	await create.focus();
	await create.press('Enter');
	const form = page.getByRole('dialog', { name: 'Create pull request' });
	await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
	await expect(form.getByRole('textbox', { name: 'Target branch' })).toHaveValue('main');
	await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(form.getByRole('button', { name: 'Create pull request' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(form).toBeHidden();
	await expect(create).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.created())).toEqual([]);
	await create.press('Enter');
	await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
	for (const name of ['light', 'dark', 'contrast']) {
		await page.evaluate(name => window.ashChangesIntegration.theme(name), name);
		await expect(form).toBeVisible();
		await expect(form).toHaveCSS('border-radius', '12px');
	}
	await page.setViewportSize({ width: 320, height: 600 });
	await expect.poll(() => form.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
	await form.getByRole('textbox', { name: 'Title', exact: true }).fill('Reviewed change');
	await form.getByRole('textbox', { name: 'Description', exact: true }).fill('Why this change is needed');
	await form.getByRole('textbox', { name: 'Target branch' }).fill('release');
	await form.getByRole('checkbox', { name: 'Create as draft' }).check();
	await expect(form.getByRole('combobox', { name: 'Merge mode' })).toBeDisabled();
	await form.getByRole('button', { name: 'Create pull request' }).click();
	await expect(form).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.created())).toEqual([{ repository: { host: 'github.com', owner: 'team', name: 'repo', accountId: 'account' }, request: { title: 'Reviewed change', body: 'Why this change is needed', head: 'feature', base: 'release', draft: true } }]);
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.attached())).toEqual([{ sessionId: 'session', reference: { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 8 } }]);
	expect(errors).toEqual([]);
});

test('Changes rejects a PR after a branch change and closes the form on account changes', async ({ page }) => {
	await page.goto('/changes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const create = page.getByRole('button', { name: 'Create pull request', exact: true });
	await create.click();
	const form = page.getByRole('dialog', { name: 'Create pull request' });
	await expect(form.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('feature');
	await page.evaluate(() => window.ashChangesIntegration.branch('other'));
	await form.getByRole('button', { name: 'Create pull request' }).click();
	await expect(form.getByRole('status')).toHaveText('The branch, remote or account changed. Reopen the pull request form.');
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.created())).toEqual([]);
	await page.evaluate(() => window.ashChangesIntegration.accountChanged());
	await expect(form).toBeHidden();
	await expect(create).toBeFocused();
});

test('Changes PR form and CI results use the selected Chinese locale', async ({ page }) => {
	await page.goto('/changes.html?locale=zh-CN');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('link', { name: 'Tests · 失败 · team/repo #7' })).toBeVisible();
	await expect(page.locator('.ash-sessions-changes-repository-status')).toContainText('origin/feature：1 个传入 · 2 个传出 · 3 个未提交文件');
	await page.getByRole('combobox', { name: '更改视图模式' }).selectOption('tree');
	await expect(page.getByRole('treeitem')).toHaveCount(4);
	await page.getByRole('button', { name: '创建拉取请求', exact: true }).click();
	const form = page.getByRole('dialog', { name: '创建拉取请求' });
	await expect(form.getByRole('textbox', { name: '标题', exact: true })).toHaveValue('feature');
	await expect(form.getByRole('textbox', { name: '目标分支' })).toHaveValue('main');
	await expect(form.getByRole('combobox', { name: '拉取请求操作' })).toHaveValue('create');
	await expect(form.getByRole('checkbox', { name: '创建为草稿' })).toBeVisible();
	await form.getByRole('button', { name: '取消', exact: true }).click();
	await expect(form).toBeHidden();
});

test('Changes enables the selected auto-merge method only for the captured local head', async ({ page }) => {
	await page.goto('/changes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const create = page.getByRole('button', { name: 'Create pull request', exact: true });
	const form = page.getByRole('dialog', { name: 'Create pull request' });
	await create.click();
	await form.getByRole('combobox', { name: 'Merge mode' }).selectOption('SQUASH');
	await form.getByRole('button', { name: 'Create pull request' }).click();
	await expect(form).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.autoMergeCalls())).toEqual([{ repository: { host: 'github.com', owner: 'team', name: 'repo', accountId: 'account' }, number: 8, merge: { commit: 'commit', method: 'squash' } }]);
	await create.click();
	await form.getByRole('combobox', { name: 'Merge mode' }).selectOption('SQUASH');
	await page.evaluate(() => window.ashChangesIntegration.publishedHead('different-commit'));
	await form.getByRole('button', { name: 'Create pull request' }).click();
	await expect(form).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.autoMergeCalls().length)).toBe(1);
	await expect.poll(() => page.evaluate(() => window.ashChangesIntegration.notifications().at(-1))).toContain('The published branch differs from the local commit. Review the pull request before merging.');
});

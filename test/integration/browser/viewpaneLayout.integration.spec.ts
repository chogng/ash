import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`Trace form scrolls and retains keyboard actions in a short pane (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/viewpaneLayout.html?locale=${locale}&hc`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const body = page.locator('.ash-agent-trace-navigation-view');
		await body.hover();
		await page.mouse.wheel(0, 1000);
		await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		const offline = body.getByRole('button').last();
		await expect(offline).toBeInViewport({ ratio: 1 });
		await body.getByRole('button').first().focus();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await expect(offline).toBeFocused();
		await expect(offline).toBeInViewport({ ratio: 1 });
		await offline.press('Enter');
		await expect.poll(() => page.evaluate(() => window.viewpaneLayoutIntegration.commands.at(-1))).toBe('fixture.offline');
		await testInfo.attach('short-trace-pane', { body: await page.locator('#root').screenshot(), contentType: 'image/png' });
		expect(errors).toEqual([]);
	});
	test(`Symphony form scrolls and submits from the keyboard in a short pane (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/viewpaneLayout.html?view=symphony&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const body = page.locator('.ash-symphony-tasks');
		await body.hover();
		await page.mouse.wheel(0, 1000);
		await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		const inputs = body.getByRole('textbox');
		await inputs.nth(1).fill('Layout fixture');
		await inputs.nth(2).fill('Retain keyboard access');
		const create = body.getByRole('button').last();
		await inputs.nth(2).focus();
		for (let step = 0; step < 3 && !(await create.evaluate(element => element === element.ownerDocument.activeElement)); step++) {
			await page.keyboard.press('Tab');
		}
		await expect(create).toBeFocused();
		await expect(create).toBeInViewport({ ratio: 1 });
		await create.press('Enter');
		await expect.poll(() => page.evaluate(() => window.viewpaneLayoutIntegration.submissions)).toEqual([{ title: 'Layout fixture', prompt: 'Retain keyboard access' }]);
		const header = page.locator('.ash-pane-view-header-button');
		await header.press('ArrowLeft');
		expect(await page.evaluate(() => window.viewpaneLayoutIntegration.watchers())).toBe(0);
		await header.press('ArrowRight');
		expect(await page.evaluate(() => window.viewpaneLayoutIntegration.watchers())).toBe(1);
		await create.focus();
		await testInfo.attach('short-symphony-pane', { body: await page.locator('#root').screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.viewpaneLayoutIntegration.dispose());
		expect(await page.evaluate(() => window.viewpaneLayoutIntegration.watchers())).toBe(0);
		expect(errors).toEqual([]);
	});
}

test('Sessions Changes retains its tree viewport beside review controls', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/viewpaneLayout.html?view=changes');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const viewport = page.locator('.ash-sessions-changes-tree .ash-tree');
	await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(120);
	await expect(page.locator('.ash-sessions-changes').getByRole('status')).toHaveText('30 changed files');
	await viewport.focus();
	await viewport.press('End');
	await expect(viewport.getByRole('treeitem').last()).toBeInViewport({ ratio: 1 });
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test('Debug Console keeps its output and expression reachable after a wrapping error', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/viewpaneLayout.html?view=console');
	const body = page.locator('.ash-debug-console');
	const input = body.getByRole('textbox');
	await input.fill('fixture');
	await input.press('Enter');
	await expect(body.getByRole('status')).toContainText('Evaluation failed.');
	await expect.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
	await expect.poll(() => body.getByRole('log').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(60);
	expect(errors).toEqual([]);
});

for (const [view, content] of [['problems', '.ash-problems-results'], ['bulk', '.ash-bulk-edit-list'], ['tasks', '.ash-tasks-list'], ['ports', '.ash-remote-ports-list']]) {
	test(`${view} retains a usable list beside wrapping controls or discovery errors`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/viewpaneLayout.html?view=${view}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const list = page.locator(content);
		await expect.poll(() => list.locator('..').evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
		if (await list.locator(':scope > *').count()) {
			await expect.poll(() => list.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(22);
		}
		expect(errors).toEqual([]);
	});
}

test('Empty Explorer keeps a long folder error scrollable without losing the opening action', async ({ page }) => {
	await page.goto('/viewpaneLayout.html?view=empty');
	const body = page.locator('.ash-empty-explorer');
	const open = body.getByRole('button', { name: 'Open Folder', exact: true });
	await open.press('Enter');
	await expect(body.getByRole('status')).toContainText('Folder opening failed.');
	await body.hover();
	await page.mouse.wheel(0, 1000);
	await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect(body.getByRole('status')).toBeInViewport();
	await page.mouse.wheel(0, -1000);
	await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
	await expect(body.locator('.ash-empty-explorer-message')).toBeInViewport({ ratio: 1 });
	await open.focus();
	await expect(open).toBeInViewport({ ratio: 1 });
});

test('SCM Agent Review keeps its empty message and action inside the minimum body', async ({ page }) => {
	await page.goto('/viewpaneLayout.html?view=review');
	const body = page.locator('.ash-scm-secondary-pane');
	await expect(body.locator('.ash-scm-empty')).toBeInViewport({ ratio: 1 });
	await expect(body.getByRole('button')).toBeInViewport({ ratio: 1 });
	expect(await body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
});

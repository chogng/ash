import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('multiple view panes resize independently and restore their layout after reload', async ({ target, workbench, reloadWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code workbench.');
	let page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	let container = page.locator('[data-view-container-id="ash.git"]');
	let changes = container.locator('[data-view-id="ash.gitView"]');
	let review = container.locator('[data-view-id="ash.gitAgentReview"]');
	let graph = container.locator('[data-view-id="ash.gitGraph"]');
	const header = (pane: typeof graph) => pane.locator('.ash-pane-view-header-button');
	const height = (pane: typeof graph) => pane.evaluate(element => element.getBoundingClientRect().height);
	await expect(header(changes)).toHaveAttribute('aria-expanded', 'true');
	await expect(header(review)).toHaveAttribute('aria-expanded', 'false');
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(() => height(review)).toBe(28);

	await header(graph).focus();
	await header(graph).press('ArrowRight');
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'true');
	await expect.poll(() => height(graph)).toBe(200);
	const sash = container.locator('.ash-sash').last();
	await expect(sash).toBeVisible();
	await expect(sash).toHaveAttribute('role', 'separator');
	await expect(sash).toHaveAttribute('aria-label', 'Resize panes');
	await expect(sash).toHaveAttribute('aria-description', /arrow keys/);
	await sash.focus();
	const originalHeight = await height(graph);
	await sash.press('ArrowUp');
	await expect.poll(() => height(graph)).toBeGreaterThan(originalHeight);
	await expect(sash).toBeFocused();

	const box = await sash.boundingBox();
	expect(box).not.toBeNull();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.mouse.down();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 45, { steps: 3 });
	await page.mouse.up();
	let resizedHeight = await height(graph);
	expect(resizedHeight).toBeGreaterThan(originalHeight + 40);
	await expect.poll(() => height(review)).toBe(28);
	const total = await container.evaluate(element => [...element.querySelectorAll('.ash-view-pane')].reduce((sum, pane) => sum + pane.getBoundingClientRect().height, 0) - element.getBoundingClientRect().height);
	expect(Math.abs(total)).toBeLessThan(1);
	await sash.dblclick();
	await expect.poll(async () => (await height(changes)) - (await height(graph))).toBeCloseTo(0, 0);
	await expect.poll(() => height(review)).toBe(28);
	resizedHeight = await height(graph);

	await header(graph).focus();
	await header(graph).press('ArrowLeft');
	await expect.poll(() => height(graph)).toBe(28);
	await header(graph).press('ArrowUp');
	await expect(header(review)).toBeFocused();
	await header(review).press('Home');
	await expect(header(changes)).toBeFocused();
	await page.getByRole('tab', { name: 'Search', exact: true }).first().click();
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'false');
	await header(graph).press('ArrowRight');
	await expect.poll(() => height(graph)).toBeCloseTo(resizedHeight, 0);

	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(theme);
		await picker.getByRole('combobox').press('Enter');
		await expect(picker).toHaveCount(0);
		await header(graph).focus();
		await expect(header(graph)).toHaveCSS('outline-style', 'solid');
	}

	await header(graph).press('ArrowLeft');
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	container = page.locator('[data-view-container-id="ash.git"]');
	changes = container.locator('[data-view-id="ash.gitView"]');
	review = container.locator('[data-view-id="ash.gitAgentReview"]');
	graph = container.locator('[data-view-id="ash.gitGraph"]');
	await workbench.waitForReady();
	await expect(container).toBeVisible();
	await expect(header(graph)).toHaveAttribute('aria-expanded', 'false');
	await header(graph).press('ArrowRight');
	await expect.poll(() => height(graph)).toBeCloseTo(resizedHeight, 0);
});

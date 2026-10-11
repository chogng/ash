import { expect, test } from "../../../automation/test.js";

test('Agent Sessions list shares Chat space and closes with Escape in Web and Electron', async ({ driver, target, workbench }, testInfo) => {
	test.skip(target.appServerMode !== "disabled", "The disconnected Code Workbench provides a deterministic Chat shell.");
	const page = workbench.page;
	if (!await page.locator(".ash-chat-view-pane").isVisible()) {
		await page.getByRole("button", { name: "Show Secondary Side Bar", exact: true }).click();
	}
	await expect(page.locator(".ash-chat-view-pane")).toBeVisible();

	const toggle = page.locator("[data-action-id='agentSessions.toggleAgentSessionsSidebar'] button");
	await expect(toggle).toBeVisible();
	await toggle.click();
	const sidebar = page.locator('.ash-chat-sessions-sidebar');
	await expect(sidebar).toBeVisible();
	const rows = sidebar.locator('.ash-agent-session-row');
	const count = await rows.count();
	await sidebar.getByRole('button', { name: 'New Session' }).click();
	await expect(rows).toHaveCount(count + 1);
	await sidebar.getByRole('searchbox').focus();
	await page.keyboard.press('ArrowDown');
	await expect(rows.first()).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(rows.nth(1)).toBeFocused();

	await driver.setWindowSize({ width: 680, height: 720 });
	await expect(page.locator('.ash-chat-body.compact.sessions-sidebar-visible')).toBeVisible();
	const composer = page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-input-part');
	await expect(composer).toBeVisible();
	expect(await sidebar.evaluate(element => Boolean(element.compareDocumentPosition(element.parentElement!.querySelector('.ash-chat-pane-host')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
	await expect.poll(async () => {
		const list = (await sidebar.boundingBox())!;
		const input = (await composer.boundingBox())!;
		const body = (await page.locator('.ash-chat-body').boundingBox())!;
		const row = (await rows.first().boundingBox())!;
		return list.y + list.height <= input.y + 1
			&& input.y + input.height <= body.y + body.height + 1
			&& row.x >= list.x && row.x + row.width <= list.x + list.width + 1;
	}).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('sessions-stacked.png') });
	await driver.setWindowSize({ width: 1800, height: 900 });
	const auxiliary = (await page.locator('[data-part="auxiliarybar"]').boundingBox())!;
	const sashes = page.locator('.ash-sash');
	const sashIndex = await sashes.evaluateAll((elements, edge) => elements.findIndex(element => {
		const bounds = element.getBoundingClientRect();
		return bounds.height > 100 && Math.abs(bounds.x + bounds.width / 2 - edge) < 8;
	}), auxiliary.x);
	expect(sashIndex).toBeGreaterThanOrEqual(0);
	const sash = (await sashes.nth(sashIndex).boundingBox())!;
	await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
	await page.mouse.down();
	await page.mouse.move(sash.x - 500, sash.y + sash.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect(page.locator('.ash-chat-body')).not.toHaveClass(/compact/);
	await expect.poll(async () => {
		const list = (await sidebar.boundingBox())!;
		const chat = (await page.locator('.ash-chat-pane-host').boundingBox())!;
		const input = (await composer.boundingBox())!;
		return chat.x + chat.width <= list.x + 1
			&& input.x >= chat.x && input.x + input.width <= list.x + 1;
	}).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('sessions-side-by-side.png') });
	await driver.setWindowSize({ width: 680, height: 720 });
	await expect(page.locator('.ash-chat-body')).toHaveClass(/compact/);
	for (let index = 0; index < 15; index++) {
		await sidebar.getByRole('button', { name: 'New Session' }).click();
	}
	await rows.last().scrollIntoViewIfNeeded();
	await expect(sidebar.getByRole('searchbox')).toBeInViewport();
	await expect(sidebar.getByRole('button', { name: 'New Session' })).toBeInViewport();
	await expect(composer).toBeInViewport();
	for (const [theme, id] of [['Ash Dark', 'ash-dark'], ['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']]) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const themeSearch = page.locator('.ash-quick-pick').getByRole('combobox');
		await themeSearch.fill(theme);
		await themeSearch.press('Enter');
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
		await expect(sidebar.getByRole('searchbox')).toBeInViewport();
		await expect(composer).toBeInViewport();
		await sidebar.getByRole('searchbox').focus();
		await expect(sidebar.getByRole('searchbox')).toHaveCSS('outline-style', 'solid');
	}
	await toggle.click();
	await toggle.click();
	await page.keyboard.press("Escape");
	await expect(sidebar).toBeHidden();
	await expect(toggle).toBeFocused();
});

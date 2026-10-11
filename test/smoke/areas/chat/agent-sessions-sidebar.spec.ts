import { expect, test } from "../../../automation/test.js";
import type { Page } from '@playwright/test';

test('Agent Sessions list shares Chat space and closes with Escape in Web and Electron', { tag: ['@browser-ui', '@electron-ui'] }, async ({ driver, target, workbench }, testInfo) => {
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
	await expandChat(page);
	await expect(page.locator('.ash-chat-body')).not.toHaveClass(/compact/);
	await expect.poll(async () => {
		const list = (await sidebar.boundingBox())!;
		const chat = (await page.locator('.ash-chat-pane-host').boundingBox())!;
		const input = (await composer.boundingBox())!;
		return chat.x + chat.width <= list.x + 1
			&& input.x >= chat.x && input.x + input.width <= list.x + 1;
	}).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('sessions-side-by-side.png') });
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsOrientationStacked');
	await expect(page.locator('.ash-chat-body')).toHaveClass(/sessions-stacked/);
	await expect.poll(async () => {
		const list = (await sidebar.boundingBox())!;
		const input = (await composer.boundingBox())!;
		return list.y + list.height <= input.y + 1;
	}).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsOrientationAuto');
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

test('Chat More Actions remembers Sessions layout and narrow list selection returns to Chat', { tag: ['@browser-ui', '@electron-ui'] }, async ({ driver, target, workbench, reloadWorkbench }, testInfo) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await driver.setWindowSize({ width: 680, height: 720 });
	const toggle = page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button');
	const more = page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button');
	const sidebar = page.locator('.ash-chat-sessions-sidebar');
	const paneHost = page.locator('.ash-chat-pane-host');
	const body = page.locator('.ash-chat-body');
	await toggle.click();
	await more.click();
	await page.getByRole('menuitem', { name: 'Sessions layout', exact: true }).click();
	await expect(page.getByRole('menuitemcheckbox', { name: 'Automatic', exact: true })).toHaveAttribute('aria-checked', 'true');
	await page.screenshot({ path: testInfo.outputPath('sessions-layout-menu.png') });
	await page.getByRole('menuitemcheckbox', { name: 'Side by side', exact: true }).click();
	await expect(body).toHaveClass(/sessions-list-only/);
	await expect(paneHost).toBeHidden();
	await expect(sidebar).toBeVisible();
	await sidebar.locator('.ash-agent-session-row').first().click();
	await expect(sidebar).toBeHidden();
	await expect(paneHost).toBeVisible();
	await expect.poll(() => paneHost.evaluate(element => element.contains(document.activeElement))).toBe(true);
	await toggle.click();
	await sidebar.getByRole('button', { name: 'New Session' }).click();
	await expect(sidebar).toBeHidden();
	await expect(paneHost).toBeVisible();
	const restored = await reloadWorkbench();
	const restoredPage = restored.workbench.page;
	if (!await restoredPage.locator('.ash-chat-view-pane').isVisible()) {
		await restoredPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await restoredPage.locator('.ash-chat-title-actions .ash-toolbar-more-actions button').click();
	await restoredPage.getByRole('menuitem', { name: 'Sessions layout', exact: true }).click();
	await expect(restoredPage.getByRole('menuitemcheckbox', { name: 'Side by side', exact: true })).toHaveAttribute('aria-checked', 'true');
	await restoredPage.getByRole('menuitemcheckbox', { name: 'Stacked', exact: true }).click();
	await restoredPage.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	await expect(restoredPage.locator('.ash-chat-body')).toHaveClass(/sessions-stacked/);
	const restoredSidebar = restoredPage.locator('.ash-chat-sessions-sidebar');
	await expect(restoredPage.locator('.ash-chat-pane-host')).toBeVisible();
	await expect(restoredSidebar).toBeVisible();
	await restoredSidebar.locator('.ash-agent-session-row').first().click();
	await expect(restoredSidebar).toBeHidden();
	await expect(restoredPage.locator('.ash-chat-pane-host')).toBeVisible();
});

test('Sessions layout menu uses the Chinese display language', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench, restartWorkbench }, testInfo) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: '显示辅助侧栏', exact: true }).click();
	}
	await page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button').click();
	await page.getByRole('menuitem', { name: '会话布局', exact: true }).click();
	await expect(page.getByRole('menuitemcheckbox', { name: '自动', exact: true })).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('menuitemcheckbox', { name: '左右排列', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitemcheckbox', { name: '上下排列', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('sessions-layout-menu-zh-CN.png') });
	await page.getByRole('menuitemcheckbox', { name: '上下排列', exact: true }).click();
	await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	await expect(page.locator('.ash-chat-body')).toHaveClass(/sessions-stacked/);
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsOrientationAuto');
	await page.setViewportSize({ width: 1800, height: 900 });
	await expandChat(page);
	const separator = page.getByRole('separator', { name: '调整会话列表宽度', exact: true });
	await expect(separator).toBeVisible();
	await expect(separator).toHaveAttribute('aria-valuetext', '320 像素');
});

test('Side by side Sessions width supports dragging, keyboard resizing, reset and reload', { tag: ['@browser-ui', '@electron-ui'] }, async ({ driver, target, workbench, reloadWorkbench }, testInfo) => {
	let page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	await driver.setWindowSize({ width: 1800, height: 900 });
	await expandChat(page);
	const sidebar = () => page.locator('.ash-chat-sessions-sidebar');
	const separator = () => page.getByRole('separator', { name: 'Resize Sessions list', exact: true });
	const width = async (): Promise<number> => (await sidebar().boundingBox())!.width;
	const drag = async (delta: number): Promise<void> => {
		const bounds = (await separator().boundingBox())!;
		const x = bounds.x + bounds.width / 2;
		const y = bounds.y + bounds.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + delta, y, { steps: 5 });
		await page.mouse.up();
	};
	await expect(separator()).toBeVisible();
	await expect.poll(width).toBe(320);
	await drag(-120);
	await expect.poll(width).toBe(440);
	await separator().focus();
	await page.keyboard.press('ArrowLeft');
	await expect.poll(width).toBe(450);
	await page.keyboard.press('Alt+ArrowRight');
	await expect.poll(width).toBe(449);
	await expect(separator()).toHaveAttribute('aria-valuenow', '449');
	await expect(separator()).toHaveAttribute('aria-valuetext', '449 pixels');
	await drag(2000);
	await expect.poll(width).toBe(220);
	await expect(separator()).toHaveClass(/ash-sash-maximum/);
	await drag(-2000);
	await expect.poll(async () => (await page.locator('.ash-chat-pane-host').boundingBox())!.width).toBeCloseTo(360, 2);
	await expect(separator()).toHaveClass(/ash-sash-minimum/);
	await separator().dblclick();
	await expect.poll(width).toBe(320);
	await drag(-120);
	await expect.poll(width).toBe(440);
	await separator().focus();
	await driver.setWindowSize({ width: 680, height: 720 });
	await expect(separator()).toBeHidden();
	await expect.poll(() => sidebar().evaluate(element => element.contains(document.activeElement))).toBe(true);
	await driver.setWindowSize({ width: 1800, height: 900 });
	await expandChat(page);
	await expect(separator()).toBeVisible();
	await expect.poll(width).toBe(440);
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsOrientationStacked');
	await expect(separator()).toBeHidden();
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsOrientationAuto');
	await expect(separator()).toBeVisible();
	await expect.poll(width).toBe(440);
	await page.screenshot({ path: testInfo.outputPath('sessions-resized.png') });
	await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	await expect(separator()).toBeHidden();
	const restored = await reloadWorkbench();
	page = restored.workbench.page;
	await page.setViewportSize({ width: 1800, height: 900 });
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	await expandChat(page);
	await expect(separator()).toBeVisible();
	await expect.poll(width).toBe(440);
});

async function expandChat(page: Page): Promise<void> {
	if (await page.locator('.ash-chat-body').evaluate(element => element.getBoundingClientRect().width >= 720)) {
		return;
	}
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
}

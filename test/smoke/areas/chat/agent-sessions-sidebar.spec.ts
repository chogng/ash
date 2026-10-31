import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

for (const presentation of ['Tabs', 'List']) {
	test(`Sessions button expands a narrow ${presentation} Chat into two retained columns`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench }, testInfo) => {
		const page = workbench.page;
		await driver.setWindowSize({ width: 1800, height: 900 });
		if (!await page.locator('.ash-chat-view-pane').isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		await resizeChat(page, 380);
		if (presentation === 'List') await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsPresentationList');
		const body = page.locator('.ash-chat-body');
		const chat = body.locator('.ash-chat-pane-host');
		const sidebar = body.locator('.ash-chat-sessions-sidebar');
		const input = new Editor(chat.locator('.ash-chat:visible'));
		await input.waitForEditorFocus();
		await input.waitForTypeInEditor('Keep the expansion draft');
		const originalEditor = await input.element.elementHandle();
		const toggle = page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button');
		await toggle.click();
		await expect(body).toHaveClass(/sessions-side-by-side/);
		await expect(sidebar).toBeVisible();
		await expect(body.getByRole('separator', { name: 'Resize sessions sidebar', exact: true })).toBeVisible();
		await expect.poll(async () => {
			const left = (await chat.boundingBox())!;
			const right = (await sidebar.boundingBox())!;
			return left.width >= 300 && right.width >= 200 && left.x + left.width <= right.x + 1;
		}).toBe(true);
		expect(await input.element.evaluate((element, original) => element === original, originalEditor)).toBe(true);
		await input.waitForEditorContents(text => text === 'Keep the expansion draft');
		if (presentation === 'Tabs') await expect(page.getByRole('tablist', { name: 'Opened sessions', exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath(`sessions-button-${presentation.toLowerCase()}.png`) });
		// Start from the stacked list shown in the reported screenshot, then use the same button.
		await resizeChat(page, 380);
		await expect(sidebar).toBeVisible();
		await expect(body).not.toHaveClass(/sessions-side-by-side/);
		await expect(toggle).toHaveAttribute('aria-label', 'Show Agent Sessions');
		await toggle.click();
		await expect(body).toHaveClass(/sessions-side-by-side/);
		await expect(toggle).toHaveAttribute('aria-label', 'Hide Agent Sessions');
		await toggle.click();
		await expect(sidebar).toBeHidden();
		await expect.poll(async () => (await body.boundingBox())!.width).toBeCloseTo(380, 0);
		expect(await input.element.evaluate((element, original) => element === original, originalEditor)).toBe(true);
		await input.waitForEditorContents(text => text === 'Keep the expansion draft');
		await toggle.click();
		await expect(body).toHaveClass(/sessions-side-by-side/);
		await page.keyboard.press('Escape');
		await expect(sidebar).toBeHidden();
		await expect(toggle).toBeFocused();
		await input.waitForEditorContents(text => text === 'Keep the expansion draft');
	});
}

test('Sessions shared Tree switches retained drafts, searches and pins the captured background chat', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, driver, workbench }, testInfo) => {
	const page = workbench.page;
	await driver.setWindowSize({ width: 1800, height: 900 });
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await resizeChat(page, 800);
	const body = page.locator('.ash-chat-body');
	const currentChat = body.locator('.ash-chat-pane-host > .ash-chat:visible');
	const input = new Editor(currentChat);
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Tree draft A');
	const firstId = await currentChat.getAttribute('data-untitled-session-id');
	const originalEditor = await input.element.elementHandle();
	expect(firstId).toBeTruthy();
	await workbench.quickaccess.runCommand('workbench.action.chat.new');
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Tree draft B');
	const secondId = await currentChat.getAttribute('data-untitled-session-id');
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsPresentationList');
	const sidebar = body.locator('.ash-chat-sessions-sidebar');
	const tree = sidebar.getByRole('tree', { name: 'Agent sessions', exact: true });
	await expect(tree).toBeVisible();
	await expect(tree.locator('[data-item]')).toHaveCount(2);
	await tree.locator(`[data-item="draft:${firstId}"]`).click();
	await input.waitForEditorContents(text => text === 'Tree draft A');
	await expect(sidebar).toBeVisible();
	expect(await input.element.evaluate((element, original) => element === original, originalEditor)).toBe(true);
	const search = sidebar.getByRole('searchbox');
	await search.fill('missing');
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(sidebar.getByRole('status')).toHaveText('No matching sessions');
	await search.fill('');
	await expect(tree.locator('[data-item]')).toHaveCount(2);
	await search.press('ArrowDown');
	await expect(tree).toBeFocused();
	await tree.press('Home');
	for (let row = 0; row < await tree.getByRole('treeitem').count(); row++) {
		if (await tree.locator('.ash-tree-row.focused [data-item]').evaluateAll(elements => elements[0]?.getAttribute('data-item') ?? null) === `draft:${secondId}`) break;
		await tree.press('ArrowDown');
	}
	await expect(tree.locator('.ash-tree-row.focused [data-item]')).toHaveAttribute('data-item', `draft:${secondId}`);
	await input.waitForEditorContents(text => text === 'Tree draft A');
	await tree.press(' ');
	await input.waitForEditorContents(text => text === 'Tree draft B');
	await expect(tree).toBeFocused();
	await tree.press('Enter');
	await input.waitForEditorContents(text => text === 'Tree draft B');
	await expect(input.input).toBeFocused();
	const background = tree.locator(`[data-item="draft:${firstId}"]`);
	await background.hover();
	await workbench.menus.select(application, () => background.click({ button: 'right' }), ['Pin chat']);
	await expect(tree.locator('h3').first()).toHaveText('Pinned');
	await input.waitForEditorContents(text => text === 'Tree draft B');
	await tree.locator('[data-item^="session:"]').click();
	await input.waitForEditorContents(text => text === 'Tree draft A');
	expect(await input.element.evaluate((element, original) => element === original, originalEditor)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('sessions-shared-tree.png') });
	const oldDrafts = await tree.locator('[data-item]').count();
	const viewport = sidebar.locator('.ash-agent-sessions-viewer');
	const bounds = (await viewport.boundingBox())!;
	await viewport.dblclick({ position: { x: 20, y: bounds.height - 30 } });
	await expect(tree.locator('[data-item]')).toHaveCount(oldDrafts + 1);
	await input.waitForEditorContents(text => text === '');
	await tree.locator('[data-item^="session:"]').click();
	await input.waitForEditorContents(text => text === 'Tree draft A');
	await resizeChat(page, 380);
	await expect(sidebar).toBeVisible();
	await tree.locator('[data-item^="session:"]').click();
	await expect(sidebar).toBeHidden();
	await expect(input.input).toBeFocused();
	await input.waitForEditorContents(text => text === 'Tree draft A');
});

test('Sessions Tree restores folded sections after reopening the Workbench', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench, reloadWorkbench }) => {
	await driver.setWindowSize({ width: 1800, height: 900 });
	if (!await workbench.page.locator('.ash-chat-view-pane').isVisible()) {
		await workbench.page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await resizeChat(workbench.page, 800);
	const input = new Editor(workbench.page.locator('.ash-chat-pane-host > .ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Retained through folded sections');
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsPresentationList');
	const section = workbench.page.getByRole('tree', { name: 'Agent sessions', exact: true }).getByRole('treeitem', { name: 'Drafts', exact: true });
	await section.click();
	await expect(section).toHaveAttribute('aria-expanded', 'false');
	const restored = await reloadWorkbench();
	const restoredSection = restored.workbench.page.getByRole('tree', { name: 'Agent sessions', exact: true }).getByRole('treeitem', { name: 'Drafts', exact: true });
	await expect(restoredSection).toHaveAttribute('aria-expanded', 'false');
	await restoredSection.click();
	await expect(restoredSection).toHaveAttribute('aria-expanded', 'true');
	await new Editor(restored.workbench.page.locator('.ash-chat-pane-host > .ash-chat:visible')).waitForEditorContents(text => text === 'Retained through folded sections');
});

test('Chat session tabs share one title row and retain drafts across navigation and closing', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench }, testInfo) => {
	const page = workbench.page;
	await driver.setWindowSize({ width: 1440, height: 900 });
	await workbench.openExplorer();
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const auxiliary = page.locator('[data-part="auxiliarybar"]');
	const tabs = auxiliary.locator('.ash-chat-view-tabs [role="tab"]');
	await expect(tabs).toHaveCount(1);
	await expect(auxiliary.locator('.ash-auxiliarybar-view-selector')).toBeHidden();
	await expect(auxiliary.locator('.ash-composite-bar')).toBeHidden();
	const header = (await auxiliary.locator('.ash-pane-composite-title').boundingBox())!;
	expect(Math.abs(header.y - (await auxiliary.boundingBox())!.y)).toBeLessThanOrEqual(1);
	const input = new Editor(auxiliary.locator('.ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Draft A');
	await auxiliary.locator('.ash-split-action-primary button').click();
	await expect(tabs).toHaveCount(2);
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Draft B');
	await tabs.first().click();
	await input.waitForEditorContents(text => text === 'Draft A');
	await tabs.last().focus();
	await page.keyboard.press('Enter');
	await input.waitForEditorContents(text => text === 'Draft B');
	await page.keyboard.press('Delete');
	await expect(tabs).toHaveCount(1);
	await input.waitForEditorContents(text => text === 'Draft A');
	const toggle = auxiliary.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button');
	const sidebar = auxiliary.locator('.ash-chat-sessions-sidebar');
	await toggle.click();
	await expect(sidebar.locator('.ash-agent-session-row')).toHaveCount(2);
	await expect(auxiliary.locator('.ash-chat-body')).toHaveClass(/sessions-side-by-side/);
	await sidebar.locator('.ash-agent-session-row').first().click();
	await expect(sidebar).toBeVisible();
	await expect(tabs).toHaveCount(2);
	await input.waitForEditorContents(text => text === 'Draft B');
	await toggle.click();
	await expect(sidebar).toBeHidden();
	await page.screenshot({ path: testInfo.outputPath('chat-session-tabs.png') });
});

test('Chat More switches Tabs and List while preserving drafts and the saved preference', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, reloadWorkbench }) => {
	let page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = new Editor(page.locator('.ash-chat-view-pane .ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Saved draft');
	const more = page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button');
	const choices = await workbench.menus.inspect(application, () => more.click(), ['Session display']);
	expect(choices.map(({ label, checked }) => [label, checked])).toEqual([['Tabs', true], ['List', false]]);
	await workbench.menus.select(application, () => more.click(), ['Session display', 'List']);
	await expect(page.locator('.ash-chat-view-tabs')).toBeHidden();
	await expect(page.locator('.ash-chat-view-title-button')).toBeVisible();
	await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	const sidebar = page.locator('.ash-chat-sessions-sidebar');
	await expect(sidebar).toBeVisible();
	await expect(input.element).toBeInViewport();
	await page.keyboard.press('Escape');
	await expect(sidebar).toBeHidden();
	await expect(page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button')).toBeFocused();
	await input.waitForEditorContents(text => text === 'Saved draft');
	const restored = await reloadWorkbench();
	page = restored.workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-view-title-button')).toBeVisible();
	await new Editor(page.locator('.ash-chat-view-pane .ash-chat:visible')).waitForEditorContents(text => text === 'Saved draft');
	const restoredMore = page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button');
	await restored.workbench.menus.select(restored.application, () => restoredMore.click(), ['Session display', 'Tabs']);
	await expect(page.locator('.ash-chat-view-tabs [role="tab"]')).toHaveCount(1);
});

test('Session display and tab actions use the Chinese display language', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, driver, workbench, restartWorkbench }) => {
	await driver.setWindowSize({ width: 1800, height: 900 });
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: '显示辅助侧栏', exact: true }).click();
	}
	await expect(page.getByRole('tablist', { name: '已打开的会话', exact: true })).toBeVisible();
	await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	await expect(page.locator('.ash-chat-body')).toHaveClass(/sessions-side-by-side/);
	await expect(page.locator('.ash-chat-sessions-sidebar')).toBeVisible();
	await expect(page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button')).toHaveAttribute('aria-label', '隐藏代理会话');
	const more = page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button');
	const choices = await workbench.menus.inspect(application, () => more.click(), ['会话显示方式']);
	expect(choices.map(({ label, checked }) => [label, checked])).toEqual([['标签页', true], ['列表', false]]);
	await workbench.menus.select(application, () => more.click(), ['会话显示方式', '列表']);
	await expect(page.locator('.ash-chat-view-tabs')).toBeHidden();
	await expect(page.locator('.ash-chat-view-title-button')).toBeVisible();
	await resizeChat(page, 800);
	const sash = page.locator('.ash-chat-body').getByRole('separator', { name: '调整会话侧栏宽度', exact: true });
	await expect(sash).toBeVisible();
	await sash.focus();
	await page.keyboard.press('ArrowLeft');
	await expect.poll(async () => (await page.locator('.ash-chat-sessions-sidebar').boundingBox())!.width).toBeCloseTo(310, 0);
});

test('List mode automatically docks sessions beside a wide Chat and preserves input across resizing', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench }, testInfo) => {
	const page = workbench.page;
	await driver.setWindowSize({ width: 1800, height: 900 });
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const body = page.locator('.ash-chat-body');
	const chat = body.locator('.ash-chat-pane-host');
	const sidebar = body.locator('.ash-chat-sessions-sidebar');
	const toggle = page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button');
	const input = new Editor(chat.locator('.ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Responsive draft');
	const originalEditor = await input.element.elementHandle();
	await resizeChat(page, 580);
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsPresentationList');
	await expect(sidebar).toBeHidden();
	await input.waitForEditorFocus();
	await resizeChat(page, 620);
	await expect(sidebar).toBeVisible();
	await expect(body).toHaveClass(/sessions-side-by-side/);
	await expect(sidebar).toHaveCSS('min-width', '200px');
	await expect(input.input).toBeFocused();
	const assertColumns = async (width = 300): Promise<void> => {
		await expect.poll(async () => {
			const listBounds = (await sidebar.boundingBox())!;
			const chatBounds = (await chat.boundingBox())!;
			const bodyBounds = (await body.boundingBox())!;
			return Math.abs(listBounds.width - width) <= 1
				&& chatBounds.width >= 300
				&& chatBounds.x + chatBounds.width <= listBounds.x + 1
				&& Math.abs(listBounds.y - bodyBounds.y) <= 1
				&& Math.abs(listBounds.height - bodyBounds.height) <= 1
				&& chatBounds.height >= bodyBounds.height - 1;
		}).toBe(true);
	};
	await assertColumns();
	const sash = body.getByRole('separator', { name: 'Resize sessions sidebar', exact: true });
	await expect(sash).toBeVisible();
	await resizeChat(page, 800);
	const handle = (await sash.boundingBox())!;
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2 - 40, handle.y + handle.height / 2, { steps: 5 });
	await page.mouse.up();
	await assertColumns(340);
	await sash.hover();
	await page.screenshot({ path: testInfo.outputPath('sessions-container-resized.png') });
	await sash.focus();
	await page.keyboard.press('ArrowRight');
	await assertColumns(330);
	await expect(sash).toBeFocused();
	await sash.dblclick();
	await assertColumns();
	await sidebar.locator('.ash-agent-session-row').first().click();
	await expect(sidebar).toBeVisible();
	await input.waitForEditorContents(text => text === 'Responsive draft');
	await page.screenshot({ path: testInfo.outputPath('sessions-responsive-sidebar.png') });
	for (const [theme, id] of [['Ash Dark', 'ash-dark'], ['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']]) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const search = page.locator('.ash-quick-pick').getByRole('combobox');
		await search.fill(theme);
		await search.press('Enter');
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
		await assertColumns();
	}
	await input.waitForEditorFocus();
	await resizeChat(page, 580);
	await expect(body).not.toHaveClass(/sessions-side-by-side/);
	await expect(sash).toBeHidden();
	await expect(sidebar).toBeVisible();
	await expect(input.element).toBeInViewport();
	await expect(input.input).toBeFocused();
	expect(await input.element.evaluate((element, original) => element === original, originalEditor)).toBe(true);
	await input.waitForEditorContents(text => text === 'Responsive draft');
	await page.screenshot({ path: testInfo.outputPath('sessions-responsive-stacked.png') });
	await resizeChat(page, 620);
	await toggle.click();
	await expect(sidebar).toBeHidden();
	await resizeChat(page, 580);
	await resizeChat(page, 700);
	await expect(sidebar).toBeHidden();
	await input.waitForEditorContents(text => text === 'Responsive draft');
});

test('Dragging Sessions switches to a saved stacked layout and can return to side-by-side', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench, reloadWorkbench }, testInfo) => {
	let page = workbench.page;
	await driver.setWindowSize({ width: 1800, height: 900 });
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await resizeChat(page, 800);
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsPresentationList');
	const body = page.locator('.ash-chat-body');
	const sidebar = body.locator('.ash-chat-sessions-sidebar');
	const chat = body.locator('.ash-chat-pane-host');
	const input = new Editor(chat.locator('.ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Keep this stacked draft');
	const originalEditor = await input.element.elementHandle();
	const sash = body.getByRole('separator', { name: 'Resize sessions sidebar', exact: true });
	const handle = (await sash.boundingBox())!;
	const x = handle.x + handle.width / 2;
	const y = handle.y + handle.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	try {
		await page.mouse.move(x + 200, y, { steps: 5 });
		await expect(body).toHaveClass(/sessions-side-by-side/);
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(200, 0);
		await page.mouse.move(x + 220, y, { steps: 5 });
		await expect(body).not.toHaveClass(/sessions-side-by-side/);
	} finally {
		await page.mouse.up();
	}
	await expect(sash).toBeHidden();
	await expect(sidebar).toBeVisible();
	await expect(input.input).toBeFocused();
	expect(await input.element.evaluate((element, original) => element === original, originalEditor)).toBe(true);
	await input.waitForEditorContents(text => text === 'Keep this stacked draft');
	await expect.poll(async () => {
		const listBounds = (await sidebar.boundingBox())!;
		const chatBounds = (await chat.boundingBox())!;
		const bodyBounds = (await body.boundingBox())!;
		return Math.abs(listBounds.width - bodyBounds.width) <= 1 && listBounds.y + listBounds.height <= chatBounds.y + 1;
	}).toBe(true);
	await resizeChat(page, 900);
	await expect(body).not.toHaveClass(/sessions-side-by-side/);
	await page.screenshot({ path: testInfo.outputPath('sessions-drag-stacked.png') });
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	await expect(page.locator('.ash-chat-body')).not.toHaveClass(/sessions-side-by-side/);
	await new Editor(page.locator('.ash-chat-view-pane .ash-chat:visible')).waitForEditorContents(text => text === 'Keep this stacked draft');
	await workbench.quickaccess.runCommand('agentSessions.showAgentSessionsSidebar');
	await expect(page.locator('.ash-chat-body')).toHaveClass(/sessions-side-by-side/);
	await expect(page.getByRole('separator', { name: 'Resize sessions sidebar', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('agentSessions.hideAgentSessionsSidebar');
	await expect(page.locator('.ash-chat-body')).not.toHaveClass(/sessions-side-by-side/);
});

test('Sidebars share a 220px minimum and Chat retains its draft across snapping', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench, reloadWorkbench }, testInfo) => {
	let page = workbench.page;
	await driver.setWindowSize({ width: 1800, height: 900 });
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const auxiliary = page.locator('[data-part="auxiliarybar"]');
	const sidebar = page.locator('.ash-chat-sessions-sidebar');
	const input = new Editor(auxiliary.locator('.ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Draft');
	// The minimum belongs to the whole Part, including its theme-dependent frame insets.
	const frameWidth = (await auxiliary.boundingBox())!.width - (await page.locator('.ash-chat-body').boundingBox())!.width;
	await resizeChat(page, 150, 220 - frameWidth);
	await expect.poll(async () => (await auxiliary.boundingBox())!.width).toBeCloseTo(220, 0);
	await expect(input.element).toBeInViewport();
	await expect(sidebar).toBeHidden();
	const primary = page.locator('[data-part="sidebar"]');
	const primaryBounds = (await primary.boundingBox())!;
	const primarySash = (await page.locator('.ash-primary-sidebar-sash').boundingBox())!;
	const primaryX = primarySash.x + primarySash.width / 2;
	const primaryY = primarySash.y + primarySash.height / 2;
	await page.mouse.move(primaryX, primaryY);
	await page.mouse.down();
	await page.mouse.move(primaryX + 150 - primaryBounds.width, primaryY, { steps: 5 });
	await page.mouse.up();
	await expect.poll(async () => (await primary.boundingBox())!.width).toBeCloseTo(220, 0);
	await page.screenshot({ path: testInfo.outputPath('sidebars-220px-minimum.png') });
	await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsPresentationList');
	await expect(sidebar).toBeHidden();
	await resizeChat(page, 580);
	await expect(sidebar).toBeHidden();
	await resizeChat(page, 620);
	await expect(sidebar).toBeVisible();
	await input.waitForEditorContents(text => text === 'Draft');
	await workbench.quickaccess.runCommand('agentSessions.hideAgentSessionsSidebar');
	const originalEditor = await input.element.elementHandle();
	const sash = await resizeChat(page, 0);
	await expect(auxiliary).toBeHidden();
	await expect(page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('chat-auxiliary-snapped-closed.png') });
	const handle = (await sash.boundingBox())!;
	// Half of the collapsed edge handle lies outside the window.
	const x = Math.min(handle.x + handle.width / 2, await page.evaluate(() => window.innerWidth) - 1);
	const y = handle.y + handle.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x - 200, y, { steps: 5 });
	await page.mouse.up();
	await expect(auxiliary).toBeVisible();
	expect(await input.element.evaluate((element, original) => element === original, originalEditor)).toBe(true);
	await input.waitForEditorContents(text => text === 'Draft');
	await page.screenshot({ path: testInfo.outputPath('chat-auxiliary-dragged-open.png') });
	await resizeChat(page, 0);
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	await new Editor(page.locator('.ash-chat-view-pane .ash-chat:visible')).waitForEditorContents(text => text === 'Draft');
});

async function resizeChat(page: import('@playwright/test').Page, width: number, expectedWidth = width): Promise<import('@playwright/test').Locator> {
	const body = page.locator('.ash-chat-body');
	const current = (await body.boundingBox())!;
	const auxiliary = (await page.locator('[data-part="auxiliarybar"]').boundingBox())!;
	const sashes = page.locator('.ash-sash');
	const index = await sashes.evaluateAll((elements, edge) => elements.findIndex(element => {
		const bounds = element.getBoundingClientRect();
		return bounds.height > 100 && Math.abs(bounds.x + bounds.width / 2 - edge) < 8;
	}), auxiliary.x);
	expect(index).toBeGreaterThanOrEqual(0);
	const sash = (await sashes.nth(index).boundingBox())!;
	const x = sash.x + sash.width / 2;
	const y = sash.y + sash.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + current.width - width, y, { steps: 5 });
	await page.mouse.up();
	if (width === 0) await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	else await expect.poll(async () => (await body.boundingBox())!.width).toBeCloseTo(expectedWidth, 0);
	return sashes.nth(index);
}

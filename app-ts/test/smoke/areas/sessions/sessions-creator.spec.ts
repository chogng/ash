import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test('Sessions mode and page-tab activation reuse Parts while retaining the conversation and dirty document', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const chat = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await chat.waitForEditorFocus();
	await chat.waitForTypeInEditor('Retained conversation draft');
	const parts = await page.locator('[data-part]').elementHandles();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	const document = new Editor(page.locator('[data-part="editor"]'));
	await document.waitForEditorFocus();
	await document.waitForTypeInEditor('Retained dirty document');
	await chat.waitForEditorFocus();
	await expect(navigation.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-current', 'page');
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	const creatorNavigation = page.locator('.ash-creator-navigation');
	await creatorNavigation.getByRole('button', { name: 'Design', exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Design/);
	await page.keyboard.press('Escape');
	await expect(creatorNavigation.getByRole('button', { name: 'Design', exact: true })).toBeFocused();
	await creatorNavigation.getByRole('button', { name: 'Design', exact: true }).press('Enter');
	await expect(page.locator('[data-part="sidebar"]')).toContainText('Layers');
	await expect(page.locator('[data-part="auxiliarybar"]')).toContainText('Page');
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await page.locator('[data-part="editor"]').getByRole('tab', { name: 'Creator', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Creator', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="sidebar"]')).toContainText('Layers');
	await page.locator('[data-part="editor"]').getByRole('tab', { name: 'Library', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Library', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="sidebar"]').getByRole('navigation', { name: 'Library categories' })).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toContainText('Asset details');
	for (const part of parts) {
		try { expect(await part.evaluate(element => element.isConnected && element === element.ownerDocument!.querySelector(`[data-part="${(element as HTMLElement).dataset.part}"]`))).toBe(true); }
		finally { await part.dispose(); }
	}
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await chat.waitForEditorContents(text => text === 'Retained conversation draft');
	await document.waitForEditorContents(text => text === 'Retained dirty document');
	await expect(page.getByRole('dialog', { name: 'Save Changes', exact: true })).toHaveCount(0);
	await page.locator('[data-part="editor"]').getByRole('tab', { name: /^Untitled-1(?:,|$)/u }).press('Delete');
	await page.getByRole('dialog', { name: 'Save Changes', exact: true }).getByRole('button', { name: "Don't Save", exact: true }).click();
});

test('Sessions Creator opens seven workspaces and retains each canvas independently', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	await expect(creator.getByRole('heading', { name: 'Creator', exact: true })).toBeVisible();
	await expect(creator.locator('.ash-creator-mode-card')).toHaveCount(7);
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"] .ash-creator')).toBeVisible();
	await expect(page.locator('[data-part="creator"], [data-part="library"]')).toHaveCount(0);
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	const design = creator.getByRole('button', { name: 'Design', exact: true });
	await design.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Each|Design/);
	await page.keyboard.press('Escape');
	await expect(design).toBeFocused();
	await design.press('Enter');
	for (const part of ['sidebar', 'auxiliarybar']) {
		await expect(page.locator(`[data-part="${part}"]`)).toBeVisible();
		await expect.poll(() => page.locator(`[data-part="${part}"]`).evaluate(element => Math.round(element.parentElement!.getBoundingClientRect().width))).toBe(240);
	}
	let workspace = creator.locator('.ash-creator-workspace:visible');
	let canvas = workspace.getByRole('region', { name: 'Design canvas' });
	await canvas.press('r');
	await canvas.press('+');
	const world = canvas.locator('.ash-canvas-world');
	const transform = await world.evaluate(element => (element as HTMLElement).style.transform);
	await creator.getByRole('button', { name: 'Creator home', exact: true }).click();
	await expect(design).toBeFocused();
	for (const [mode, action] of [['Whiteboard', 'Add note'], ['Slides', 'Add slide'], ['Brand', 'Square asset'], ['Sites', 'Add web page'], ['Prototype', 'Add screen']]) {
		await creator.getByRole('button', { name: mode, exact: true }).click();
		workspace = creator.locator('.ash-creator-workspace:visible');
		canvas = workspace.getByRole('region', { name: 'Design canvas' });
		await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
		await workspace.getByRole('button', { name: action, exact: true }).click();
		await expect(canvas.locator('[data-shape-id]').first()).toBeVisible();
		await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
		await creator.getByRole('button', { name: 'Creator home', exact: true }).click();
	}
	await creator.getByRole('button', { name: 'Make', exact: true }).click();
	await expect(creator.getByRole('textbox', { name: 'Describe what to build' })).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await creator.getByRole('button', { name: 'Creator home', exact: true }).click();
	await design.click();
	canvas = creator.locator('.ash-creator-workspace:visible').getByRole('region', { name: 'Design canvas' });
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await expect.poll(() => world.evaluate(element => (element as HTMLElement).style.transform)).toBe(transform);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	await creator.getByRole('button', { name: 'Creator home', exact: true }).click();
	await page.setViewportSize({ width: 620, height: 860 });
	await expect(creator).toHaveClass(/narrow/);
	await expect.poll(() => creator.locator('.ash-creator-modes').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2);
	await expect(design).toHaveCSS('min-height', '36px');
});

test('Sessions Design starts with Agent hidden on every entry and reopening while retaining context, drafts and width', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	let navigation = page.locator('.ash-sessions-activity-content');
	const initialChat = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await initialChat.waitForEditorFocus();
	await initialChat.waitForTypeInEditor('Review this design');
	const retainedInput = await initialChat.input.elementHandle();
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await canvas.press('r');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	const design = page.locator('[data-creator-mode="design"]');
	const show = design.getByRole('button', { name: 'Show Agent', exact: true });
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await show.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Show Agent opens the shared conversation beside the canvas/);
	await page.keyboard.press('Escape');
	await expect(show).toBeFocused();
	await show.press('Enter');
	await initialChat.waitForEditorContents(text => text === 'Review this design');
	expect(await initialChat.input.evaluate((element, retained) => element === retained, retainedInput)).toBe(true);
	await expect(navigation.getByRole('button', { name: 'Creator', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(canvas).toBeVisible();
	await expect.poll(() => design.locator('.ash-creator-workspace-actions').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
	const conversationWidth = () => page.locator('[data-part="sessions"]').evaluate(element => Math.round(element.parentElement!.getBoundingClientRect().width));
	const initialWidth = await conversationWidth();
	const conversationSash = page.locator('[data-part="sessions"]').locator('xpath=../../..').locator(':scope > .ash-sash:not(.ash-sash-disabled):visible').first();
	await conversationSash.press('ArrowRight');
	await expect.poll(conversationWidth).toBeGreaterThan(initialWidth);
	const resizedWidth = await conversationWidth();
	await expect(page.locator('[data-part="sidebar"]')).toContainText('Layers');
	await expect(page.locator('[data-part="auxiliarybar"]').getByRole('spinbutton', { name: 'X', exact: true })).toBeVisible();
	await design.getByRole('button', { name: 'Add design to Agent', exact: true }).click();
	await expect(page.locator('[data-part="sessions"]').getByRole('button', { name: 'Remove design-context.json', exact: true })).toBeVisible();
	await design.getByRole('button', { name: 'Hide Agent', exact: true }).press('Enter');
	await expect(canvas).toBeFocused();
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await show.press('Enter');
	await page.locator('.ash-creator').getByRole('button', { name: 'Creator home', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Whiteboard', exact: true }).click();
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await page.locator('.ash-creator').getByRole('button', { name: 'Creator home', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await show.press('Enter');
	await expect(design.getByRole('button', { name: 'Hide Agent', exact: true })).toBeVisible();
	await expect.poll(conversationWidth).toBe(resizedWidth);
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await initialChat.waitForEditorContents(text => text === 'Review this design');
	await retainedInput!.dispose();
	// Workspace switching retained the edit; finish the edit before exercising the normal close handshake.
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	navigation = page.locator('.ash-sessions-activity-content');
	await expect(navigation.getByRole('button', { name: 'Creator', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('region', { name: 'Design canvas' })).toBeVisible();
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await page.locator('[data-creator-mode="design"]').getByRole('button', { name: 'Show Agent', exact: true }).press('Enter');
	await expect.poll(conversationWidth).toBe(resizedWidth);
	await expect(page.locator('[data-part="sessions"]').getByRole('button', { name: 'Remove design-context.json', exact: true })).toBeVisible();
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === 'Review this design');
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(page.locator('[data-part="editor"]')).toBeHidden();
	await page.locator('[data-part="sessions"]').getByRole('button', { name: 'Remove design-context.json', exact: true }).click();
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await page.locator('[data-creator-mode="design"]').getByRole('button', { name: 'Show Agent', exact: true }).press('Enter');
	await expect(page.locator('[data-part="sessions"]')).toBeVisible();
	await expect(page.locator('[data-part="sessions"]').getByRole('button', { name: 'Remove design-context.json', exact: true })).toHaveCount(0);
});

test('Sessions Creator resets side panel widths and retains them across page changes and reopening', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const sidebar = page.locator('[data-part="sidebar"]');
	const leftSash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash:not(.ash-sash-disabled):visible').first();
	const rightSash = page.locator('[data-part="auxiliarybar"]').locator('xpath=../../..').locator(':scope > .ash-sash:not(.ash-sash-disabled):visible').last();
	const panelWidths = () => page.locator('.ash-workbench-part-frame').evaluateAll(frames => frames.filter(frame => frame.querySelector(':scope > [data-part="sidebar"], :scope > [data-part="auxiliarybar"]')).map(frame => Math.round(frame.getBoundingClientRect().width)));
	await expect.poll(panelWidths).toEqual([240, 240]);
	for (const width of [1226, 1400, 1100]) {
		let contentWidth = width;
		if ('windows' in application) {
			const window = await application.browserWindow(page);
			try {
				contentWidth = await window.evaluate((window, width) => {
					window.setSize(width, 800);
					return window.getContentSize()[0];
				}, width);
			} finally { await window.dispose(); }
		} else {
			await page.setViewportSize({ width, height: 800 });
		}
		// Electron DIP sizes and Chromium viewport sizes can round to adjacent pixels under Windows display scaling.
		await expect.poll(async () => Math.abs(await page.evaluate(() => window.innerWidth) - contentWidth)).toBeLessThanOrEqual(1);
		await expect.poll(panelWidths).toEqual([240, 240]);
	}
	await leftSash.focus();
	await leftSash.press('ArrowRight');
	await expect.poll(panelWidths).not.toEqual([240, 240]);
	await leftSash.dblclick();
	await rightSash.focus();
	await rightSash.press('ArrowLeft');
	await rightSash.dblclick();
	await expect.poll(panelWidths).toEqual([240, 240]);
	const canvas = page.locator('.ash-creator').getByRole('region', { name: 'Design canvas' });
	await canvas.press('t');
	const text = page.locator('[data-part="auxiliarybar"]').getByRole('textbox', { name: 'Text content', exact: true });
	await text.fill('A long dashboard headline whose complete layer name needs more room');
	await text.press('Tab');
	await leftSash.dblclick();
	await expect.poll(async () => (await panelWidths())[0]).toBeGreaterThan(240);
	await canvas.press('ControlOrMeta+z');
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	await leftSash.dblclick();
	await expect.poll(panelWidths).toEqual([240, 240]);
	await page.locator('.ash-creator').getByRole('button', { name: 'Creator home', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect.poll(panelWidths).toEqual([240, 240]);
	await leftSash.focus();
	await leftSash.press('ArrowRight');
	const resized = await panelWidths();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('.ash-creator').getByRole('heading', { name: 'Design', exact: true })).toBeVisible();
	await expect.poll(panelWidths).toEqual(resized);
});

test('Sessions Creator Slides presents reordered pages and Brand undoes an entire variant batch', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	await creator.getByRole('button', { name: 'Slides', exact: true }).click();
	const slides = creator.locator('[data-creator-mode="slides"].ash-creator-workspace');
	await slides.getByRole('button', { name: 'Add slide', exact: true }).click();
	await slides.getByRole('button', { name: 'Add slide', exact: true }).click();
	const selected = await slides.getByRole('combobox', { name: 'Pages', exact: true }).inputValue();
	await slides.getByRole('button', { name: 'Move slide earlier', exact: true }).click();
	await expect(slides.getByRole('combobox', { name: 'Pages', exact: true }).locator('option').first()).toHaveAttribute('value', selected);
	await slides.getByRole('button', { name: 'Present', exact: true }).click();
	const preview = slides.getByRole('region', { name: 'Presentation preview' });
	await expect(preview).toBeFocused();
	await expect(preview.getByRole('status')).toHaveText('1 of 2');
	await preview.press('ArrowRight');
	await expect(preview.getByRole('status')).toHaveText('2 of 2');
	await preview.press('Escape');
	await expect(preview).toBeHidden();
	await expect(slides.getByRole('combobox', { name: 'Pages', exact: true })).toBeFocused();
	await creator.getByRole('button', { name: 'Creator home', exact: true }).click();
	await creator.getByRole('button', { name: 'Brand', exact: true }).click();
	const brand = creator.locator('.ash-creator-workspace:visible');
	await brand.getByRole('button', { name: 'Square asset', exact: true }).click();
	await brand.getByRole('button', { name: 'Create size variants', exact: true }).click();
	const canvas = brand.getByRole('region', { name: 'Design canvas' });
	await expect(canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]')).toHaveCount(4);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]')).toHaveCount(1);
});

test('Sessions Creator Make runs preview and prepares a Code draft with source attached', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	await creator.getByRole('button', { name: 'Make', exact: true }).click();
	const make = creator.locator('.ash-creator-workspace:visible');
	await make.getByRole('button', { name: 'Edit canvas', exact: true }).click();
	await make.getByRole('region', { name: 'Design canvas' }).press('r');
	await expect(make.frameLocator('iframe').locator('[data-design-kind="rectangle"]')).toHaveCount(1);
	await make.getByRole('textbox', { name: 'Describe what to build' }).fill('Add a sign-in form to this page');
	await make.getByRole('button', { name: 'Build with Agent', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-current', 'page');
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === 'Add a sign-in form to this page');
	await expect(page.locator('.ash-sessions-chat-slot.active:visible')).toContainText('creator.html');
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	await creator.getByRole('button', { name: 'Make', exact: true }).click();
	await expect(make.getByRole('textbox', { name: 'Describe what to build' })).toHaveValue('Add a sign-in form to this page');
	await expect(make.frameLocator('iframe').locator('[data-design-kind="rectangle"]')).toHaveCount(1);
});

test('Sessions Creator uses Chinese mode names, actions and keyboard help', async ({ application, target, workbench, restartWorkbench }) => {
	let page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.locator('.ash-settings-editor');
	await settings.locator('[data-settings-category-id="general"]').click();
	const language = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await language.click();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await expect(language).toHaveText('简体中文');
	({ workbench, application } = await restartWorkbench());
	page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	await page.locator('.ash-modal-editor-close').click();
	if (target.kind === 'browser') { await page.locator('[data-action-id="ash.code.open-sessions"] button').click(); }
	else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	for (const title of ['设计', '白板', '幻灯片', '品牌', '网站', 'Make', '原型']) { await expect(creator.getByRole('button', { name: title, exact: true })).toBeVisible(); }
	await creator.getByRole('button', { name: '幻灯片', exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/选择工作空间/);
	await page.keyboard.press('Escape');
	await creator.getByRole('button', { name: '幻灯片', exact: true }).press('Enter');
	await expect(creator.getByRole('button', { name: '添加幻灯片', exact: true })).toBeVisible();
	await creator.getByRole('button', { name: '添加幻灯片', exact: true }).click();
	await expect(creator.getByRole('combobox', { name: '页面', exact: true })).toHaveText('第 1 页');
	await creator.getByRole('button', { name: 'Creator 首页', exact: true }).click();
	await creator.getByRole('button', { name: '设计', exact: true }).click();
	await creator.getByRole('button', { name: '显示 Agent', exact: true }).press('Enter');
	await expect(creator.getByRole('button', { name: '隐藏 Agent', exact: true })).toBeVisible();
	await creator.getByRole('button', { name: '添加设计到 Agent', exact: true }).click();
	await expect(page.locator('[data-part="sessions"]')).toContainText('design-context.json');
});

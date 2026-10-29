import { expect, test } from '../../../automation/test.js';
import { Menus } from '../../../automation/menus.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';

test('Sessions discards an unavailable saved entry and completes restoration without losing the draft', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const draft = 'Keep this draft when a saved entry disappears';
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText(draft);
	const identity = { scope: StorageScope.WORKSPACE, id: 'sessions' };
	await seedStorageOnNextLoad(application, page, identity, {
		'sessions.layout.activeEntry': { value: 'sessions.show.library', target: StorageTarget.MACHINE },
	});
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await workbench.reloadWindow(page);
	const navigation = page.locator('.ash-sessions-activity-content');
	await expect(navigation.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === draft);
	await expect.poll(async () => (await readStorageEntries(application, page, identity))['sessions.layout.activeEntry']?.value).toBe('sessions.open.chat');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('.ash-projects')).toBeVisible();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-projects')).toBeVisible();
	expect(errors).toEqual([]);
});

test('Sessions New opens ChatGPT and shares its retained EditorPane', { tag: ['@electron-app-server'] }, async ({ application, target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const chatgpt = navigation.getByRole('button', { name: 'New', exact: true });
	await expect(navigation.getByRole('button', { name: 'ChatGPT', exact: true })).toHaveCount(0);
	await chatgpt.click();
	const editor = page.locator('[data-part="editor"] .ash-chatgpt-widget');
	const sidebar = page.locator('[data-part="sidebar"] [data-view-container-id="sessions.chatgpt.navigation"]');
	await expect(editor).toBeVisible();
	await expect(sidebar).toBeVisible();
	await expect(chatgpt).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-editor-title-control:visible')).toHaveCount(0);
	await expect(sidebar.getByRole('searchbox')).toHaveCount(0);
	const retained = await editor.elementHandle();
	await expect(sidebar.locator('details')).toHaveCount(0);
	const input = editor.getByRole('textbox', { name: 'Ask ChatGPT', exact: true });
	await input.focus();
	await input.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/ChatGPT conversations are in the window sidebar/);
	await page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await testInfo.attach('chatgpt-parts', { body: await page.screenshot(), contentType: 'image/png' });
	await page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Hide sidebar', exact: true }).click();
	await expect(sidebar).toBeHidden();
	await expect(editor).toBeVisible();
	await page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await expect(sidebar).toBeVisible();
	const menus = new Menus(page);
	await menus.select(application, () => chatgpt.click({ button: 'right' }), ['Reload']);
	await expect(chatgpt).toHaveAttribute('aria-current', 'page');
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(editor).toBeHidden();
	await chatgpt.click();
	await expect(editor).toBeVisible();
	await expect(sidebar).toBeVisible();
	expect(await editor.evaluate((element, previous) => element === previous, retained)).toBe(true);
	await input.focus();
	await input.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/ChatGPT/);
	await page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('.ash-projects')).toBeVisible();
});

test('Sessions restores the Projects entry and its pane visibility through entry startup', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const draft = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await draft.waitForEditorFocus();
	await page.keyboard.insertText('Keep the conversation when Projects is restored');
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	page = await workbench.reopenAgentsWindow(application, page);
	const navigation = page.locator('.ash-sessions-activity-content');
	await expect(navigation.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await expect(page.locator('.ash-projects').getByRole('button', { name: 'New project', exact: true }).first()).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === 'Keep the conversation when Projects is restored');
});

test('Artifacts home keeps the conversation sidebar and offers Docs, Slides and Design', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const sidebar = page.locator('[data-part="sidebar"]');
	const originalList = await sidebar.locator('[data-view-container-id]:visible').elementHandle();
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	const home = page.locator('.ash-creator-home');
	await expect(home).toBeVisible();
	await expect(page.locator('.ash-creator-title')).toHaveText('Artifacts');
	await expect(sidebar.locator('[data-view-container-id="sessions.creator.navigation"]')).toHaveCount(0);
	expect(await sidebar.locator('[data-view-container-id]:visible').evaluate((element, retained) => element === retained, originalList)).toBe(true);
	await expect(home.locator('.ash-artifacts-create')).toHaveText(['Docs', 'Slides', 'Design']);
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-editor-tabs')).toBeHidden();
	await home.getByRole('tab', { name: 'All', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(home.getByRole('tab', { name: 'Yours', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(home.getByRole('tab', { name: 'Shared with you', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(home.getByText('No artifacts have been shared with you.')).toBeVisible();
	await home.getByRole('tab', { name: 'All', exact: true }).click();
	const design = home.getByRole('button', { name: 'Design', exact: true });
	await design.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Docs, Slides, Design/);
	await page.keyboard.press('Escape');
	await expect(design).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('artifacts-home.png') });
	await design.press('Enter');
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await canvas.press('r');
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await expect(home.locator('.ash-artifacts-card')).toHaveCount(1);
	await home.getByRole('button', { name: 'Search artifacts', exact: true }).click();
	await home.getByRole('searchbox').fill('missing_artifact');
	await expect(home.locator('.ash-artifacts-card')).toHaveCount(0);
	await expect(home.getByText('No artifacts match your search.')).toBeVisible();
	await home.getByRole('searchbox').fill('');
	await home.getByRole('button', { name: 'List view', exact: true }).click();
	await expect(home.locator('.ash-artifacts-results')).toHaveClass(/list-view/);
	await home.locator('.ash-artifacts-card').click();
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await home.getByRole('button', { name: 'Docs', exact: true }).click();
	const document = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
	await document.waitForEditorFocus();
	await document.waitForTypeInEditor('Retained artifact document');
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await expect(home.locator('.ash-artifacts-card')).toHaveCount(2);
	await home.locator('.ash-artifacts-card.docs').click();
	await document.waitForEditorContents(text => text === 'Retained artifact document');
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.setViewportSize({ width: 620, height: 860 });
	await expect.poll(() => home.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('artifacts-narrow.png') });
});

test('Artifacts keeps creation and ownership controls legible across themes', { tag: ['@electron-app-server'] }, async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	for (const [label, id] of [
		['Ash Dark', 'ash-dark'],
		['Ash High Contrast Dark', 'ash-high-contrast-dark'],
		['Ash High Contrast Light', 'ash-high-contrast-light'],
	] as const) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = workbench.page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(label);
		await workbench.quickaccess.select(label);
		await expect(workbench.page.locator('.ash-quick-pick')).toHaveCount(0);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
		const home = page.locator('.ash-creator-home');
		await expect(home.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute('aria-selected', 'true');
		await expect(home.locator('.ash-artifacts-create')).toHaveCount(3);
		for (const illustration of await home.locator('.ash-artifacts-create > .ash-artifacts-illustration').all()) {
			await expect(illustration).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
			if (id.includes('contrast')) {
				await expect(illustration).toHaveCSS('border-top-width', '1px');
			}
		}
		await page.screenshot({ path: testInfo.outputPath(`artifacts-${id}.png`) });
	}
});

test('Sessions pages keep Code tabs separate and retain dirty files and Design state', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const code = page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true });
	const creator = navigation.getByRole('button', { name: 'Artifacts', exact: true });
	const projects = navigation.getByRole('button', { name: 'Projects', exact: true });
	await code.click();
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	const codeEditor = page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)');
	const codeTabs = codeEditor.locator('.ash-editor-group:not(.ash-editor-group-locked) .ash-editor-title-control').getByRole('tab', { includeHidden: true });
	const file = new Editor(codeEditor);
	await file.waitForEditorFocus();
	await page.keyboard.insertText('Keep this unsaved Code file');
	const tabs = await codeTabs.allTextContents();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await creator.click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect(creator).toHaveAttribute('aria-current', 'page');
	await expect(codeEditor).toBeVisible();
	await expect(file.input).toBeHidden();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await expect(canvas).toBeVisible();
	await canvas.focus();
	await page.keyboard.press('r');
	await page.keyboard.press('+');
	const world = canvas.locator('.ash-canvas-world');
	const transform = await world.evaluate(element => (element as HTMLElement).style.transform);
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await expect(page.getByRole('tab', { name: 'Untitled design', exact: true, includeHidden: true })).toHaveCount(0);
	await expect(codeTabs).toHaveText(tabs);
	await projects.click();
	await expect(projects).toHaveAttribute('aria-current', 'page');
	await page.locator('.ash-projects').getByRole('button', { name: 'Search projects', exact: true }).click();
	const search = page.locator('.ash-projects').getByRole('searchbox');
	await search.fill('Keep this Projects search');
	await expect(canvas).toBeHidden();
	await expect(page.locator('.ash-projects').getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
	await code.click();
	await expect(codeEditor).toBeVisible();
	await file.waitForEditorContents(text => text === 'Keep this unsaved Code file');
	await expect(codeTabs).toHaveText(tabs);
	await creator.focus();
	await page.keyboard.press('Enter');
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect(canvas).toBeVisible();
	await expect.poll(() => world.evaluate(element => (element as HTMLElement).style.transform)).toBe(transform);
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await expect(page.locator('[data-part="auxiliarybar"]').getByRole('spinbutton', { name: 'X', exact: true })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await projects.click();
	await expect(search).toHaveValue('Keep this Projects search');
});

test('Sessions registered pages coordinate Parts and retain drafts through drag and keyboard ordering', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const items = navigation.locator('.ash-sessions-activity-top .ash-action-view-item');
	const trace = navigation.getByRole('button', { name: 'Trace', exact: true });
	await expect(trace).toHaveCount(0);
	const chat = navigation.getByRole('button', { name: 'New', exact: true });
	const creator = navigation.getByRole('button', { name: 'Artifacts', exact: true });
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('Retain the navigation draft');
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	const retainedChat = await chat.elementHandle();
	await navigation.locator('[data-action-id="sessions.open.creator"]').dragTo(navigation.locator('[data-action-id="sessions.newSession"]'), { targetPosition: { x: 8, y: 2 } });
	await expect(items.first()).toHaveAttribute('draggable', 'true');
	await expect
		.poll(() => items.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.actionId)))
		.toEqual(['sessions.open.creator', 'sessions.newSession', ...(target.kind === 'electron' ? ['sessions.open.chatgpt'] : []), 'sessions.open.projects']);
	await expect(chat).toHaveAttribute('aria-current', 'page');
	expect(await chat.evaluate((element, retained) => element === retained, retainedChat)).toBe(true);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)').getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await creator.click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect(creator).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)')).toBeVisible();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-creator')).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Untitled design', exact: true })).toHaveCount(0);
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeVisible();
	await expect(page.locator('[data-part="panel"]')).toBeHidden();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	await creator.focus();
	await new Menus(page).select(application, () => page.keyboard.press('Shift+F10'), ['Move later']);
	await expect(creator).toBeFocused();
	await expect
		.poll(() => items.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.actionId)))
		.toEqual(['sessions.newSession', 'sessions.open.creator', ...(target.kind === 'electron' ? ['sessions.open.chatgpt'] : []), 'sessions.open.projects']);
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await page.keyboard.press('Home');
	await expect(chat).toBeFocused();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await navigation.getByRole('button', { name: 'New', exact: true }).focus();
	await page.keyboard.press('End');
	const symphony = navigation.getByRole('button', { name: 'Symphony', exact: true });
	await expect(symphony).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(symphony).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-symphony-monitor')).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('[data-part="sessions"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)').getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	await new Menus(page).select(application, () => chat.click({ button: 'right' }), ['Activity Bar Position', 'Top']);
	await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
	await expect(navigation.locator('.ash-sessions-navigation[role="toolbar"]')).toHaveAttribute('aria-orientation', 'horizontal');
	await navigation.locator('[data-action-id="sessions.open.projects"]').dragTo(navigation.locator('[data-action-id="sessions.open.creator"]'), { targetPosition: { x: 2, y: 8 } });
	await expect
		.poll(() => items.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.actionId)))
		.toEqual(['sessions.newSession', 'sessions.open.projects', 'sessions.open.creator', ...(target.kind === 'electron' ? ['sessions.open.chatgpt'] : [])]);
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await chat.focus();
	await page.keyboard.press('ArrowRight');
	await expect(navigation.getByRole('button', { name: 'Projects', exact: true })).toBeFocused();
	await page.reload();
	await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await expect
		.poll(() => items.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.actionId)))
		.toEqual(['sessions.newSession', 'sessions.open.projects', 'sessions.open.creator', ...(target.kind === 'electron' ? ['sessions.open.chatgpt'] : [])]);
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	await new QuickAccess(page).runCommand('sessions.trace.import');
	await expect(trace).toHaveCount(0);
	const viewer = page.locator('.ash-agent-trace:visible');
	await expect(viewer).toBeVisible();
	const offline = {
		formatVersion: 3,
		sessionId: 'shell-navigation-offline',
		historyPrefixes: [],
		threads: [
			{
				threadId: 'shell-thread',
				events: [
					{
						eventId: 'shell-event',
						sequence: 1,
						recordedAt: 1,
						event: {
							type: 'threadCreated',
							threadId: 'shell-thread',
							title: 'Shell navigation offline fixture',
						},
					},
				],
			},
		],
	};
	await viewer.locator('input[type=file]').setInputFiles({
		name: 'shell-navigation.trace.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify(offline)),
	});
	await expect(viewer.getByRole('status')).toContainText('Imported');
	// Debug Logs hides its unused sidebar, including the Top navigation host.
	await new Menus(page).select(application, () => page.getByRole('button', { name: 'Accounts', exact: true }).click({ button: 'right' }), ['Activity Bar Position', 'Default']);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(viewer).toBeHidden();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)').getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await new QuickAccess(page).runCommand('sessions.open.trace');
	await expect(viewer).toBeVisible();
	await expect(trace).toHaveCount(0);
	await expect(page.locator('[data-part="editor"] .ash-editor-title-control').getByRole('tab', { name: 'Agent Debug Logs', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(viewer.getByRole('status')).toContainText('Imported');
	await retainedChat!.dispose();
});

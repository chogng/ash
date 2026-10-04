import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as browserTest } from '@playwright/test';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';
import { captureElectronMenu } from '../../../automation/menus.js';

test('Code Sessions starts with dialog dependencies and confirms closing a dirty editor', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	const editors = page.locator('[data-part="editor"]');
	const input = editors.locator('.stanza-editor-input');
	await expect(input).toBeVisible();
	await input.focus();
	await input.pressSequentially('Keep this unsaved draft');
	const tab = editors.getByRole('tab', { name: /^Untitled-1(?:,|$)/u });
	await tab.press('Delete');
	const dialog = page.getByRole('dialog', { name: 'Save Changes', exact: true });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(tab).toBeVisible();
	await expect(editors.locator('.stanza-editor-line-text').first()).toHaveText('Keep this unsaved draft');
	await tab.press('Delete');
	await dialog.getByRole('button', { name: "Don't Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(tab).toHaveCount(0);
});

test('Code sessions restore editor tabs through Back, Forward and reopening without focusing the editor', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = await workbench.openAgentsWindow(target.kind);
	let navigation = page.locator('.ash-sessions-activity-content');
	let editors = page.locator('[data-part="editor"]');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await page.locator('.ash-sessions-list-add').click();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(editors.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await page.locator('.ash-sessions-list-add').click();
	await editors.getByRole('tab', { name: 'Untitled-1', exact: true }).press('Delete');
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toBeVisible();
	const back = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Back', exact: true });
	await back.focus();
	await back.press('Enter');
	await expect(editors.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveCount(0);
	await expect(back).toBeFocused();
	const forward = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Forward', exact: true });
	await forward.focus();
	await forward.press('Enter');
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toBeVisible();
	await expect(editors.locator(':focus')).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	navigation = page.locator('.ash-sessions-activity-content');
	editors = page.locator('[data-part="editor"]');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toBeVisible();
});

test('Code panel stays below the main region and retains its views across session layouts', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = await workbench.openAgentsWindow(target.kind);
	let navigation = page.locator('.ash-sessions-activity-content');
	let panel = page.locator('[data-part="panel"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	let toggle = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Toggle Code panel', exact: true });
	await expect(panel).toBeHidden();
	const sidebarBefore = await sidebar.boundingBox();
	await toggle.focus();
	await toggle.press('Enter');
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('tab', { name: 'Terminal', exact: true })).toBeVisible();
	await expect(toggle).toBeFocused();
	const panelBefore = await panel.boundingBox();
	expect(await sidebar.boundingBox()).toEqual(sidebarBefore);
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	await expect(panel).toBeHidden();
	await expect(toggle).toBeVisible();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(panel).toBeHidden();
	await toggle.click();
	await expect(panel).toBeVisible();
	expect((await panel.boundingBox())?.height).toBe(panelBefore?.height);
	page = await workbench.reopenAgentsWindow(application, page);
	navigation = page.locator('.ash-sessions-activity-content');
	panel = page.locator('[data-part="panel"]');
	toggle = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Toggle Code panel', exact: true });
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	await expect(panel).toBeHidden();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(panel).toBeHidden();
	await toggle.click();
	await expect(panel).toBeVisible();
	await toggle.click();
	await expect(panel).toBeHidden();
	await navigation.getByRole('button', { name: 'Design', exact: true }).click();
	await expect(panel).toBeHidden();
	await expect(toggle).toHaveCount(0);
});

test('Code connects layout commands to View, Add tab and the panel shortcut', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	const editor = page.locator('[data-part="editor"]');
	const title = editor.locator('.ash-editor-title-control');
	const content = editor.locator('.ash-editor-group-content');
	const panel = page.locator('[data-part="panel"]');
	const menuButton = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Application menu', exact: true });
	const usesSystemMenu = 'windows' in application && process.platform === 'darwin';
	const openViewMenu = async (): Promise<void> => {
		await menuButton.click();
		await page.getByRole('menuitem', { name: 'View', exact: true }).hover();
	};
	const selectViewAction = async (name: string, checkbox = false): Promise<void> => {
		if (usesSystemMenu) {
			await captureElectronMenu(application, () => menuButton.click(), { label: name });
			await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
		} else {
			await openViewMenu();
			await page.getByRole(checkbox ? 'menuitemcheckbox' : 'menuitem', { name, exact: true }).click();
		}
	};
	const addChangesTab = async (): Promise<void> => {
		if (usesSystemMenu) {
			await captureElectronMenu(application, () => title.getByRole('button', { name: 'Add tab', exact: true }).click(), { label: 'Open Changes tab' });
		} else {
			await title.getByRole('button', { name: 'Add tab', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Open Changes tab', exact: true }).click();
		}
	};
	await expect(content).toBeHidden();
	await selectViewAction('Show editor');
	await expect(content).toBeVisible();
	if (usesSystemMenu) {
		const items = await captureElectronMenu(application, () => menuButton.click());
		const view = items.find(item => item.label === 'View')!.submenu!;
		expect(view.find(item => item.label === 'Hide editor')?.enabled).toBe(true);
		expect(view.some(item => item.label === 'Show editor')).toBe(false);
		await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
		await selectViewAction('Toggle Code panel', true);
	} else {
		await openViewMenu();
		await expect(page.getByRole('menuitem', { name: 'Hide editor', exact: true })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Show editor', exact: true })).toHaveCount(0);
		await page.getByRole('menuitemcheckbox', { name: 'Toggle Code panel', exact: true }).click();
	}
	await expect(panel).toBeVisible();
	await page.keyboard.press('Control+`');
	await expect(panel).toBeHidden();
	await addChangesTab();
	const changes = title.getByRole('tab', { name: 'Changes', exact: true });
	await expect(changes).toHaveAttribute('aria-selected', 'true');
	await changes.press('Delete');
	await expect(changes).toHaveCount(0);
	await addChangesTab();
	await expect(changes).toHaveAttribute('aria-selected', 'true');
	await selectViewAction('Hide editor');
	await expect(content).toBeHidden();
	const commands = new QuickAccess(page);
	await commands.open('>ash.sessions.hideEditor');
	await expect(commands.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('ash.sessions.hideEditor', { exact: true }) })).toHaveCount(0);
	await commands.close();
	await commands.runCommand('ash.sessions.showEditor');
	await expect(content).toBeVisible();
	await selectViewAction('Hide editor');
	await expect(content).toBeHidden();
	await selectViewAction('Open Files tab');
	await expect(content).toBeVisible();
	await expect(title.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	const codeActions = ['Toggle Code panel', 'Toggle Code side panel', 'Toggle details', 'Hide editor', 'Show editor', 'Open Files tab', 'Open Changes tab'];
	if (usesSystemMenu) {
		const items = await captureElectronMenu(application, () => menuButton.click());
		expect(items.find(item => item.label === 'View')!.submenu!.filter(item => codeActions.includes(item.label)).map(item => item.label)).toEqual(expect.arrayContaining(['Toggle Code panel', 'Open Files tab', 'Open Changes tab']));
		await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
	} else {
		await openViewMenu();
		for (const name of ['Toggle Code panel', 'Open Files tab', 'Open Changes tab']) await expect(page.getByRole('menu').getByText(name, { exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
	}
});

test('Code shares its tabs across all four editor and Details states', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
	let editor = page.locator('[data-part="editor"]');
	let title = editor.locator('.ash-editor-title-control');
	let content = editor.locator('.ash-editor-group-content');
	let details = page.locator('[data-part="auxiliarybar"]');
	const files = title.getByRole('tab', { name: 'Files', exact: true });
	let changes = title.getByRole('tab', { name: 'Changes', exact: true });
	await expect(files).toBeVisible();
	await expect(changes).toBeVisible();
	await expect(content).toBeHidden();
	await expect(details).toBeVisible();
	await changes.click();
	await expect(content).toBeHidden();
	await expect(details.getByRole('status')).toHaveText('Changes appear after the agent edits files.');
	await files.click();
	await files.press('Delete');
	await expect(files).toBeVisible();
	await expect(title.getByRole('button', { name: 'Close Editor', exact: true })).toHaveCount(2);
	for (const close of await title.getByRole('button', { name: 'Close Editor', exact: true }).all()) {
		await expect(close).toBeDisabled();
	}
	await title.getByRole('button', { name: 'Show editor', exact: true }).click();
	await expect(content).toBeVisible();
	await expect(details).toBeVisible();
	const landing = editor.getByText('Choose a file in Details to open it here.', { exact: true });
	await landing.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Files tab[\s\S]*Hide editor keeps/u);
	await page.keyboard.press('Escape');
	await expect(landing).toBeFocused();
	const combinedWidth = (await editor.boundingBox())!.width;
	const tabBounds = (await title.boundingBox())!;
	const detailBounds = (await details.boundingBox())!;
	expect(detailBounds.y).toBeGreaterThanOrEqual(tabBounds.y + tabBounds.height - 1);
	await title.getByRole('button', { name: 'Toggle details', exact: true }).click();
	await expect(details).toBeHidden();
	await expect(content).toBeVisible();
	expect((await editor.boundingBox())!.width).toBe(combinedWidth);
	await changes.click();
	await expect(details).toBeVisible();
	await expect(details.getByRole('status')).toHaveText('Changes appear after the agent edits files.');
	page = await workbench.reopenAgentsWindow(application, page);
	editor = page.locator('[data-part="editor"]');
	title = editor.locator('.ash-editor-title-control');
	content = editor.locator('.ash-editor-group-content');
	details = page.locator('[data-part="auxiliarybar"]');
	changes = title.getByRole('tab', { name: 'Changes', exact: true });
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(content).toBeVisible();
	await expect(details).toBeVisible();
	await expect(changes).toHaveAttribute('aria-selected', 'true');
	const comparison = editor.locator('.ash-sessions-changes-editor');
	await comparison.focus();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue('Changes appear after the agent edits files.');
	await page.keyboard.press('Escape');
	await expect(comparison).toBeFocused();
	let commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(title.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await title.getByRole('button', { name: 'Hide editor', exact: true }).click();
	await expect(content).toBeHidden();
	await expect(title.getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveCount(0);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(content).toBeVisible();
	await expect(title.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await expect(title.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveAttribute('aria-selected', 'true');
	await title.getByRole('button', { name: 'Toggle details', exact: true }).click();
	await expect(details).toBeHidden();
	await commands.runCommand('ash.sessions.toggleSidePane');
	await expect(editor).toBeHidden();
	await commands.runCommand('ash.sessions.toggleSidePane');
	await expect(editor).toBeVisible();
	await expect(details).toBeHidden();
	await expect(title.getByRole('tab', { name: 'Untitled-2', exact: true })).toBeVisible();
});

test.describe('Sessions from an Electron Workbench', () => {
	test.skip(({ target }) => target.kind === 'browser', 'The browser Sessions page has its own launch test below.');

	test('Sessions Code reuses Files and Changes and retains its Workbench editor across pages', async ({ application, target, workbench, testWorkspace }) => {
		test.skip(target.workbenchMode !== 'code');
		if (target.appServerMode === 'required') {
			await mkdir(join(testWorkspace.directory, 'nested'), { recursive: true });
			await writeFile(join(testWorkspace.directory, 'nested', 'child.ts'), 'export const child = 1;\n');
		}
		const page = await workbench.openAgentsWindow(target.kind);
		const failures: string[] = [];
		page.on('pageerror', error => failures.push(error.message));
		const auxiliary = page.locator('[data-part="auxiliarybar"]');
		const editors = page.locator('[data-part="editor"]');
		const navigation = page.locator('.ash-sessions-activity-content');
		await expect(auxiliary).toBeHidden();
		await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
		await navigation.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(auxiliary).toBeVisible();
		await expect(editors).toBeVisible();
		await expect(editors.locator('.ash-editor-group-content')).toBeHidden();
		const title = editors.locator('.ash-editor-title-control');
		const files = title.getByRole('tab', { name: 'Files', exact: true });
		const changes = title.getByRole('tab', { name: 'Changes', exact: true });
		await expect(files).toHaveAttribute('aria-selected', 'true');
		await changes.click();
		await expect(auxiliary.getByRole('status')).toHaveText('Changes appear after the agent edits files.');
		await expect(auxiliary.getByRole('button', { name: 'Review all changes', exact: true })).toBeDisabled();
		await files.click();
		if (target.appServerMode === 'required' && target.kind === 'electron') {
			const nested = auxiliary.getByRole('treeitem', { name: 'nested', exact: true });
			await nested.click();
			await expect(auxiliary.getByRole('treeitem', { name: /child\.ts$/u })).toBeVisible();
			const collapse = auxiliary.getByRole('button', { name: 'Collapse folders', exact: true });
			await collapse.focus();
			await page.keyboard.press('Enter');
			await expect(nested).toHaveAttribute('aria-expanded', 'false');
			await expect(auxiliary.getByRole('treeitem', { name: /child\.ts$/u })).toBeHidden();
			await auxiliary.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
			await expect(editors).toBeVisible();
			const editor = new Editor(editors);
			await editor.waitForEditorFocus();
			await editor.waitForEditorContents(text => text === 'const value = 1;\n');
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.insertText('const value = 42;\n');
			await page.keyboard.press('ControlOrMeta+S');
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 42;\n');
			const input = await editor.input.elementHandle();
			await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
			await expect(auxiliary).toBeHidden();
			await expect(editors).toBeHidden();
			await navigation.getByRole('button', { name: 'Code', exact: true }).click();
			await expect(editors).toBeVisible();
			await editor.waitForEditorContents(text => text === 'const value = 42;\n');
			expect(await editor.input.evaluate((element, original) => element === original, input)).toBe(true);
			await input?.dispose();
		} else {
			await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
			await expect(auxiliary).toBeHidden();
			await navigation.getByRole('button', { name: 'Code', exact: true }).click();
			await expect(files).toHaveAttribute('aria-selected', 'true');
		}
		expect(failures).toEqual([]);
	});
});

browserTest('Browser Sessions Code shows Files and Changes and retains the selected view across pages and reload', async ({ page }, testInfo) => {
	browserTest.skip(testInfo.project.name !== 'browser-ui');
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	await page.goto('/browser/sessions/sessions-code.html');
	const navigation = page.locator('.ash-sessions-activity-content');
	const auxiliary = page.locator('[data-part="auxiliarybar"]');
	const tabs = page.locator('[data-part="editor"] .ash-editor-title-control');
	await expect(auxiliary).toBeHidden();
	await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(auxiliary.locator('[data-view-id="sessions.files.explorer.empty"]').getByRole('status')).toHaveText('Folders and files will appear here.');
	await expect(auxiliary.locator('[data-view-id="ash.explorer"]')).toHaveCount(0);
	const emptyMessage = auxiliary.locator('.ash-sessions-files-empty-message');
	expect(await emptyMessage.evaluate(element => getComputedStyle(element).fontSize)).toBe('12px');
	await page.keyboard.press('ControlOrMeta+Shift+E');
	await expect(auxiliary.locator('[data-view-id="sessions.files.explorer.empty"]')).toBeFocused();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Files follow the selected session directory[\s\S]*Collapse folders/u);
	await page.keyboard.press('Escape');
	await expect(auxiliary.locator('[data-view-id="sessions.files.explorer.empty"]')).toBeFocused();
	const commands = new QuickAccess(page);
	for (const [theme, scheme] of [['Ash Light', 'light'], ['Ash Dark', 'dark'], ['Ash High Contrast Dark', 'high-contrast-dark'], ['Ash High Contrast Light', 'high-contrast-light']]) {
		await page.goto('/browser/workbench/workbench.html');
		await new Workbench(page).waitForReady();
		await commands.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(theme);
		await commands.select(theme);
		await expect(picker).toHaveCount(0);
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		await page.goto('/browser/sessions/sessions-code.html');
		await navigation.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		const colors = await emptyMessage.evaluate(element => ({
			text: getComputedStyle(element).color,
			background: getComputedStyle(element.closest('.ash-sessions-files-empty-view')!).backgroundColor,
		}));
		expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(colors.text).not.toBe(colors.background);
	}
	await tabs.getByRole('tab', { name: 'Changes', exact: true }).click();
	await expect(auxiliary.getByRole('status')).toHaveText('Changes appear after the agent edits files.');
	await expect(auxiliary.getByRole('button', { name: 'Review all changes', exact: true })).toBeDisabled();
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	await expect(auxiliary).toBeHidden();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(tabs.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute('aria-selected', 'true');
	await page.setViewportSize({ width: 1_000, height: 760 });
	await expect(auxiliary).toBeVisible();
	await page.reload();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(tabs.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute('aria-selected', 'true');
	expect(failures).toEqual([]);
});

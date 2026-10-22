import { expect, test } from '../../../automation/test.js';
import type { ElectronApplication } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Stanza navigation undo and reopened history preserve subsequent edits in Ash', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace }, testInfo) => {
	const page = workbench.page;
	const file = page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true });
	await file.dblclick();
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('base');
	await page.keyboard.type('abc');
	await page.keyboard.press('Home');
	await page.keyboard.type('X');
	await editor.waitForEditorContents(text => text === 'Xbaseabc');
	await page.keyboard.press('ControlOrMeta+z');
	await editor.waitForEditorContents(text => text === 'baseabc');
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await editor.waitForEditorContents(text => text === 'Xbaseabc');
	await page.keyboard.press('ControlOrMeta+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('Xbaseabc');

	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('a');
	await page.keyboard.press('ControlOrMeta+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('a');
	await page.keyboard.press('Enter');
	await editor.waitForEditorContents(text => text === 'a\n');
	await page.keyboard.press('ControlOrMeta+z');
	await editor.waitForEditorContents(text => text === 'a');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await file.dblclick();
	await editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await editor.waitForEditorContents(text => text === 'a\n');
	await page.keyboard.press('Enter');
	await editor.waitForEditorContents(text => text === 'a\n\n');
	await page.keyboard.press('ControlOrMeta+S');
	await expect.poll(async () => (await readFile(testWorkspace.file, 'utf8')).replace(/\r\n/g, '\n')).toBe('a\n\n');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await file.dblclick();
	await editor.waitForEditorContents(text => text === 'a\n\n');
	await page.screenshot({ path: testInfo.outputPath('stanza-restored-history.png') });
});

test('Unicode overtype preserves text and undo in Ash', { tag: ['@electron-ui', '@electron-app-server', '@browser-app-server'] }, async ({ target, workbench, testWorkspace, reloadWorkbench }, testInfo) => {
	const page = workbench.page;
	if (target.appServerMode === 'required') {
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	} else {
		await page.keyboard.press('ControlOrMeta+N');
	}
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.input.press('ControlOrMeta+A');
	await page.keyboard.insertText('ab😀e\u0301z\nend');
	await editor.input.press('ControlOrMeta+Home');
	await editor.input.press('ArrowRight');
	await editor.input.press('Insert');
	try {
		await page.keyboard.insertText('👩‍💻');
		await editor.waitForEditorContents(text => text === 'a👩‍💻😀e\u0301z\nend');
		await editor.input.press('ControlOrMeta+z');
		await editor.waitForEditorContents(text => text === 'ab😀e\u0301z\nend');
		await editor.input.press('ControlOrMeta+Shift+z');
		await editor.waitForEditorContents(text => text === 'a👩‍💻😀e\u0301z\nend');
	} finally {
		await editor.input.press('Insert');
	}
	await expect(editor.input).toBeFocused();
	if (target.appServerMode !== 'required') return;
	await editor.input.press('ControlOrMeta+S');
	await expect.poll(async () => (await readFile(testWorkspace.file, 'utf8')).replace(/\r\n/g, '\n')).toBe('a👩‍💻😀e\u0301z\nend');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'a👩‍💻😀e\u0301z\nend');
	({ workbench } = await reloadWorkbench('quit'));
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'a👩‍💻😀e\u0301z\nend');
	await workbench.page.screenshot({ path: testInfo.outputPath('stanza-saved-file-after-relaunch.png') });
});

for (const inputBackend of ['EditContext', 'textarea'] as const) {
	test.describe(`Chinese IME with ${inputBackend}`, () => {
		test('Chinese IME preserves selections, cancellation, undo and saved files in Ash', { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace }, testInfo) => {
			const page = workbench.page;
			if (inputBackend === 'textarea') {
				// Emulate a host without EditContext before the file editor is
				// constructed; its production factory must select the fallback.
				await page.evaluate(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
			const editor = workbench.editors.groupAt(0).editor;
			await editor.waitForEditorFocus();
			await expect(editor.input).toHaveJSProperty('tagName', inputBackend === 'textarea' ? 'TEXTAREA' : 'DIV');
			await editor.input.press('ControlOrMeta+A');
			await page.keyboard.insertText('前后\n第二行');
			await editor.input.press('ControlOrMeta+Home');
			await editor.input.press('ArrowRight');
			const session = await page.context().newCDPSession(page);
			try {
				for (const [text, offset] of [['你好', 1], ['您好', 1], ['您们好', 3]] as const) {
					await session.send('Input.imeSetComposition', { text, selectionStart: offset, selectionEnd: offset });
					await editor.waitForEditorContents(value => value === `前${text}后\n第二行`);
				}
				await session.send('Input.insertText', { text: '您们好' });
				await expect(editor.element).not.toHaveClass(/\bcomposing\b/u);
				await editor.input.press('ControlOrMeta+z');
				await editor.waitForEditorContents(value => value === '前后\n第二行');
				await editor.input.press('ControlOrMeta+Shift+z');
				const committed = '前您们好后\n第二行';
				await editor.waitForEditorContents(value => value === committed);

				await editor.input.press('ControlOrMeta+End');
				await editor.input.press('ControlOrMeta+Shift+Home');
				await session.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
				await session.send('Input.insertText', { text: '中文' });
				await editor.waitForEditorContents(value => value === '中文');
				await editor.input.press('ControlOrMeta+z');
				await editor.waitForEditorContents(value => value === committed);
				// Extending the restored selection toward the right must move its
				// active start, proving that undo kept the backward direction.
				await editor.input.press('Shift+ArrowRight');
				await page.keyboard.insertText('X');
				await editor.waitForEditorContents(value => value === '前X');
				await editor.input.press('ControlOrMeta+z');
				await editor.waitForEditorContents(value => value === committed);

				await editor.input.press('ControlOrMeta+Home');
				await editor.input.press('Shift+ArrowRight');
				await session.send('Input.imeSetComposition', { text: 'qian', selectionStart: 4, selectionEnd: 4 });
				await editor.waitForEditorContents(value => value === 'qian您们好后\n第二行');
				await editor.input.press('Escape');
				await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
				await editor.waitForEditorContents(value => value === committed);
				await editor.input.press('ControlOrMeta+Shift+z');
				await editor.waitForEditorContents(value => value === committed);
				await page.keyboard.insertText('后');
				const saved = '后您们好后\n第二行';
				await editor.waitForEditorContents(value => value === saved);
				await editor.input.press('ControlOrMeta+z');
				await editor.waitForEditorContents(value => value === committed);
				await editor.input.press('ControlOrMeta+Shift+z');
				await editor.waitForEditorContents(value => value === saved);
				await editor.input.press('ControlOrMeta+S');
				await expect.poll(async () => (await readFile(testWorkspace.file, 'utf8')).replace(/\r\n/g, '\n')).toBe(saved);
				await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
				await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
				await editor.waitForEditorContents(value => value === saved);
				await page.screenshot({ path: testInfo.outputPath(`chinese-ime-${inputBackend}.png`) });
			} finally { await session.detach(); }
		});
	});
}

test('editor and Chat input font settings apply independently and persist in Chinese', async ({ application, workbench, restartWorkbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('iii WWW 中文');
	const defaultSize = process.platform === 'darwin' ? 12 : 14;
	await expect(editor.element).toHaveCSS('font-size', `${defaultSize}px`);
	await expect(editor.element).toHaveCSS('line-height', `${Math.round(defaultSize * (process.platform === 'darwin' ? 1.5 : 1.35))}px`);
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat-input-editor .stanza-editor');
	await expect(chat).toHaveCSS('font-size', '13px');
	await expect(chat).toHaveCSS('line-height', '20px');
	const chatFamily = await chat.evaluate(element => getComputedStyle(element).fontFamily);
	expect(chatFamily).toMatch(/sans-serif/u);

	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
	const settings = workbench.settingsEditor.element;
	await settings.locator('[data-configuration-key="editor.fontFamily"]').fill('Arial');
	await settings.locator('[data-configuration-key="editor.fontFamily"]').press('Tab');
	await settings.locator('[data-configuration-key="editor.fontSize"]').fill('18');
	await settings.locator('[data-configuration-key="editor.fontSize"]').press('Tab');
	await settings.locator('[data-configuration-key="editor.lineHeight"]').fill('28');
	await settings.locator('[data-configuration-key="editor.lineHeight"]').press('Tab');
	await expect(editor.element).toHaveCSS('font-size', '18px');
	await expect(editor.element).toHaveCSS('line-height', '28px');
	await expect.poll(() => editor.element.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Arial,/u);
	await expect(chat).toHaveCSS('font-size', '13px');
	expect(await chat.evaluate(element => getComputedStyle(element).fontFamily)).toBe(chatFamily);
	await settings.locator('[data-configuration-key="editor.lineHeight"]').fill('0');
	await settings.locator('[data-configuration-key="editor.lineHeight"]').press('Tab');
	await expect(editor.element).toHaveCSS('line-height', `${Math.round(18 * (process.platform === 'darwin' ? 1.5 : 1.35))}px`);
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('chat-input');
	await expect(settings.locator('.ash-settings-page h3')).toHaveText('Message input');
	await expect(settings.locator('[data-settings-item-id]')).toHaveCount(3);
	await expect(settings.locator('[data-configuration-key="chat.input.fontFamily"]')).toHaveAttribute('placeholder', 'System default');
	await settings.locator('[data-configuration-key="chat.input.fontFamily"]').fill('Georgia');
	await settings.locator('[data-configuration-key="chat.input.fontFamily"]').press('Tab');
	await settings.locator('[data-configuration-key="chat.input.fontSize"]').fill('17');
	await settings.locator('[data-configuration-key="chat.input.fontSize"]').press('Tab');
	await settings.locator('[data-configuration-key="chat.input.lineHeight"]').fill('26');
	await settings.locator('[data-configuration-key="chat.input.lineHeight"]').press('Tab');
	await expect(chat).toHaveCSS('font-size', '17px');
	await expect(chat).toHaveCSS('line-height', '26px');
	await expect.poll(() => chat.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Georgia,/u);
	await expect(editor.element).toHaveCSS('font-size', '18px');
	await expect.poll(() => editor.element.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Arial,/u);
	await settings.locator('.ash-modal-editor-close').click();
	const chatInput = chat.locator('.stanza-editor-input');
	await chatInput.focus();
	await page.keyboard.insertText('A message 中文');
	await expect(chat.locator('.stanza-editor-line-text')).toHaveText('A message 中文');
	await editor.waitForEditorFocus();
	await page.keyboard.press('End');
	await page.keyboard.insertText('!');
	await expect(editor.lines).toHaveText(['iii WWW 中文!']);
	await expect(editor.input).toBeFocused();
	await expect.poll(() => editor.element.evaluate(element => {
		const line = element.querySelector('.stanza-editor-line-text')!;
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		let lastText = walker.nextNode()!;
		while (walker.nextNode()) lastText = walker.currentNode;
		const range = document.createRange();
		range.setStart(lastText, lastText.textContent!.length);
		range.collapse(true);
		return Math.abs(range.getBoundingClientRect().left - element.querySelector('.stanza-editor-caret.primary')!.getBoundingClientRect().left);
	})).toBeLessThan(2);
	await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", () => workbench.quickaccess.runCommand('workbench.action.closeActiveEditor'));
	await expect(editor.input).toHaveCount(0);

	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
	await expect(workbench.settingsEditor.element.locator('.ash-settings-page h3')).toHaveText('字体与排版');
	await expect(workbench.settingsEditor.element.getByRole('textbox', { name: '字体', exact: true })).toBeVisible();
	await expect(workbench.settingsEditor.element.getByRole('spinbutton', { name: '字号', exact: true })).toHaveValue('18');
	const row = workbench.settingsEditor.element.locator('[data-settings-item-id="editor.lineHeight"]');
	await expect(row).toContainText('设为 0 时根据字号自动计算');
	await expect(row.locator('input')).toHaveValue('0');
	await expect(workbench.settingsEditor.element.getByRole('textbox', { name: '字体', exact: true })).toHaveAttribute('placeholder', '系统默认');
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('chat-input');
	const chineseSettings = workbench.settingsEditor.element;
	await expect(chineseSettings.locator('.ash-settings-page h3')).toHaveText('消息输入');
	await expect(chineseSettings.getByRole('textbox', { name: '字体', exact: true })).toHaveValue('Georgia');
	await expect(chineseSettings.getByRole('spinbutton', { name: '字号', exact: true })).toHaveValue('17');
	await expect(chineseSettings.getByRole('spinbutton', { name: '行高', exact: true })).toHaveValue('26');
	const restoredChat = workbench.page.locator('.ash-chat-view-pane .ash-chat-input-editor .stanza-editor');
	await expect(restoredChat).toHaveCSS('font-size', '17px');
	await expect(restoredChat).toHaveCSS('line-height', '26px');
	await expect.poll(() => restoredChat.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Georgia,/u);
	await chineseSettings.getByRole('spinbutton', { name: '行高', exact: true }).fill('0');
	await chineseSettings.getByRole('spinbutton', { name: '行高', exact: true }).press('Tab');
	await expect(restoredChat).toHaveCSS('line-height', `${Math.round(17 * (process.platform === 'darwin' ? 1.5 : 1.35))}px`);
	await chineseSettings.getByRole('textbox', { name: '字体', exact: true }).fill('');
	await chineseSettings.getByRole('textbox', { name: '字体', exact: true }).press('Tab');
	await expect.poll(() => restoredChat.evaluate(element => getComputedStyle(element).fontFamily)).toBe(chatFamily);
});

test.describe('custom editor context menus', () => {
	test.use({ electronUserSettings: { 'window.menuStyle': 'custom' } });

	test('editor context menu preserves the right-click selection and runs matching edits and Copy As', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, application, workbench }) => {
		const page = workbench.page;
		await page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('alpha beta alpha');
		await editor.input.press('Home');
		for (let index = 0; index < 5; index++) await editor.input.press('Shift+ArrowRight');
		if (target.kind === 'browser') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		const readClipboard = (): Promise<string> => target.kind === 'electron'
			? (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
			: page.evaluate(() => navigator.clipboard.readText());
		const previousClipboard = await readClipboard();
		try {
			await editor.lines.first().click({ button: 'right', position: { x: 10, y: 5 } });
			const copy = page.getByRole('menuitem', { name: 'Copy', exact: true });
			if (target.kind === 'electron') {
				const modifier = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
				await expect(copy.locator('.ash-menu-keybinding')).toHaveText(`${modifier}C`);
				await expect(page.getByRole('menuitem', { name: 'Cut', exact: true }).locator('.ash-menu-keybinding')).toHaveText(`${modifier}X`);
				await expect(page.getByRole('menuitem', { name: 'Paste', exact: true }).locator('.ash-menu-keybinding')).toHaveText(`${modifier}V`);
			}
			await copy.click();
			await expect.poll(readClipboard).toBe('alpha');
			await expect(editor.input).toBeFocused();
			await editor.input.press('Shift+F10');
			const copyAs = page.getByRole('menuitem', { name: 'Copy As', exact: true });
			await copyAs.focus();
			await copyAs.press('ArrowRight');
			const highlight = page.getByRole('menuitem', { name: 'Copy with Syntax Highlighting', exact: true });
			await expect(highlight).toBeFocused();
			await highlight.press('Enter');
			await expect.poll(readClipboard).toBe('alpha');
			await expect(editor.input).toBeFocused();
			await editor.input.press('Shift+F10');
			await page.getByRole('menuitem', { name: 'Change All Occurrences', exact: true }).click();
			await page.keyboard.insertText('gamma');
			await expect(editor.lines).toHaveText(['gamma beta gamma']);
			await editor.input.press('ControlOrMeta+z');
			await expect(editor.lines).toHaveText(['alpha beta alpha']);
			await expect(editor.input).toBeFocused();
			await editor.input.press('Shift+F10');
			await page.getByRole('menuitem', { name: 'Command Palette...', exact: true }).click();
			await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(editor.input).toBeFocused();
		} finally {
			if (target.kind === 'electron') {
				await (application as ElectronApplication).evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
			} else {
				await page.evaluate(text => navigator.clipboard.writeText(text), previousClipboard);
			}
		}
	});

	test('editor context menu initializes Chinese actions and accessibility help after restart', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, restartWorkbench }) => {
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
		await picker.getByRole('combobox').fill('简体中文');
		await picker.getByRole('combobox').press('Enter');
		({ workbench } = await restartWorkbench());
		const page = workbench.page;
		await page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('alpha beta alpha');
		await editor.input.press('Home');
		await editor.input.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: '更改所有匹配项', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await editor.input.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: '无障碍帮助', exact: true }).getByRole('textbox')).toHaveValue(/Shift\+F10.*速览.*匹配/u);
		await page.keyboard.press('Escape');
		await expect(editor.input).toBeFocused();
	});

});

test('multiline paste undo and redo preserve the final editor line', async ({ target, workbench, application }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const original = 'alpha\nbravo\nlast';
	await page.keyboard.insertText(original);
	await editor.waitForEditorContents(contents => contents === original);
	for (const replace of [false, true]) {
		await editor.input.press('ControlOrMeta+Home');
		if (replace) {
			await editor.input.press('ControlOrMeta+A');
		}
		if (target.kind === 'electron') {
			await (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.writeText('one\ntwo\nthree'));
			await editor.input.press('ControlOrMeta+v');
		} else {
			await editor.input.evaluate(element => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/plain', 'one\ntwo\nthree');
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			});
		}
		const pasted = replace ? 'one\ntwo\nthree' : `one\ntwo\nthree${original}`;
		await editor.waitForEditorContents(contents => contents === pasted);
		await editor.input.press('ControlOrMeta+z');
		await editor.waitForEditorContents(contents => contents === original);
		await editor.input.press('ControlOrMeta+Shift+z');
		await editor.waitForEditorContents(contents => contents === pasted);
		await editor.input.press('ControlOrMeta+z');
		await editor.waitForEditorContents(contents => contents === original);
		await expect(editor.input).toBeFocused();
	}
});

test('theme color settings update editor colors and restore defaults when removed', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('prefix selected suffix');
	const overrides = [
		['editor.selectionBackground', '#123456', '--ash-editor-selectionBackground'],
		['editor.inactiveSelectionBackground', '#654321', '--ash-editor-inactiveSelectionBackground'],
		['editor.selectionForeground', '#fedcba', '--ash-editor-selectionForeground'],
		['scrollbar.background', '#112233', '--ash-scrollbar-background'],
		['scrollbarSlider.background', '#234567', '--ash-scrollbarSlider-background'],
		['scrollbarSlider.hoverBackground', '#345678', '--ash-scrollbarSlider-hoverBackground'],
		['scrollbarSlider.activeBackground', '#456789', '--ash-scrollbarSlider-activeBackground'],
		['widget.shadow', '#56789a', '--ash-widget-shadow'],
		['minimap.shadow', '#6789ab', '--ash-minimap-shadow'],
	] as const;
	const variables = overrides.map(([, , variable]) => variable);
	const readColors = () => editor.element.evaluate((element, tokens) => tokens.map(token => getComputedStyle(element).getPropertyValue(token).trim()), variables);
	const defaults = await readColors();
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="appearance"]').click();
	const colors = settings.locator('[data-configuration-key="workbench.colorCustomizations"]');
	await expect(colors).toBeVisible();
	for (const [id, color, cssVariable] of overrides) {
		await colors.getByRole('button', { name: 'Add Color', exact: true }).click();
		const row = colors.locator('.ash-string-map-row').last();
		await row.locator('[data-pattern-part="key"]').fill(id);
		await row.locator('[data-pattern-part="value"]').fill(color);
		await row.locator('[data-pattern-part="value"]').press('Tab');
		await expect.poll(() => editor.element.evaluate((element, token) =>
			getComputedStyle(element).getPropertyValue(token).trim(), cssVariable)).toBe(color);
	}
	await settings.locator('.ash-modal-editor-close').click();
	await editor.waitForEditorFocus();
	await page.keyboard.press('Home');
	for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight');
	for (let index = 0; index < 8; index++) await page.keyboard.press('Shift+ArrowRight');
	const selected = editor.element.locator('.view-lines .stanza-editor-selected-text');
	await expect(selected).toHaveText('selected');
	await expect(selected).toHaveCSS('color', 'rgb(254, 220, 186)');
	await expect(editor.element.locator('.stanza-editor-selection')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await editor.input.blur();
	await expect(editor.element.locator('.stanza-editor-selection')).toHaveCSS('background-color', 'rgb(101, 67, 33)');
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="appearance"]').click();
	await expect(colors.locator('.ash-string-map-row')).toHaveCount(overrides.length);
	for (let count = overrides.length; count > 0; count--) {
		await colors.locator('.ash-string-map-row').last().getByRole('button').click();
		await expect(colors.locator('.ash-string-map-row')).toHaveCount(count - 1);
	}
	await settings.locator('.ash-modal-editor-close').click();
	await expect.poll(readColors).toEqual(defaults);
	await expect(selected).toHaveCount(0);
	await expect(editor.lines.first()).toHaveText('prefix selected suffix');
});

test('Chat code block settings persist independently of input fonts and show Chinese labels', async ({ workbench, restartWorkbench }) => {
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('chat-code-blocks');
	const settings = workbench.settingsEditor.element;
	await expect(settings.locator('.ash-settings-page h3')).toHaveText('Code blocks');
	await expect(settings.locator('[data-settings-item-id]')).toHaveCount(4);
	await expect(settings.getByRole('textbox', { name: 'Font family', exact: true })).toHaveAttribute('placeholder', 'Use editor font');
	await expect(settings.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('0');
	await expect(settings.getByRole('spinbutton', { name: 'Line height', exact: true })).toHaveValue('0');
	await settings.getByRole('textbox', { name: 'Font family', exact: true }).fill('Georgia');
	await settings.getByRole('textbox', { name: 'Font family', exact: true }).press('Tab');
	await settings.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('19');
	await settings.getByRole('spinbutton', { name: 'Font size', exact: true }).press('Tab');
	await settings.getByRole('spinbutton', { name: 'Line height', exact: true }).fill('28');
	await settings.getByRole('spinbutton', { name: 'Line height', exact: true }).press('Tab');
	await settings.getByRole('combobox', { name: 'Word wrap', exact: true }).click();
	await workbench.page.getByRole('option', { name: 'On', exact: true }).click();
	await workbench.settingsEditor.selectCategory('chat-input');
	await expect(settings.getByRole('textbox', { name: 'Font family', exact: true })).toHaveValue('');
	await expect(settings.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('13');
	await expect(settings.getByRole('spinbutton', { name: 'Line height', exact: true })).toHaveValue('20');
	await settings.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('chat-code-blocks');
	const translated = workbench.settingsEditor.element;
	await expect(translated.locator('.ash-settings-page h3')).toHaveText('代码块');
	await expect(translated.getByRole('textbox', { name: '字体', exact: true })).toHaveValue('Georgia');
	await expect(translated.getByRole('textbox', { name: '字体', exact: true })).toHaveAttribute('placeholder', '跟随编辑器');
	await expect(translated.getByRole('spinbutton', { name: '字号', exact: true })).toHaveValue('19');
	await expect(translated.getByRole('spinbutton', { name: '行高', exact: true })).toHaveValue('28');
	await expect(translated.getByRole('combobox', { name: '自动换行', exact: true })).toHaveText('开启');
});

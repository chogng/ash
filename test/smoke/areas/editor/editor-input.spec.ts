import { expect, test } from '../../../automation/test.js';
import type { ElectronApplication } from '@playwright/test';

test('editor Enter preserves indentation and undo restores the input position', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('  value');
	await editor.input.press('Enter');
	await expect(editor.lines).toHaveText(['  value', '  ']);
	await expect(editor.input).toBeFocused();
	await editor.input.press('ControlOrMeta+z');
	await expect(editor.lines).toHaveText(['  value']);
	await page.keyboard.insertText('!');
	await expect(editor.lines).toHaveText(['  value!']);
	await expect(editor.input).toBeFocused();
});

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

test('editor context menu preserves the right-click selection and runs matching edits and Copy As', async ({ target, application, workbench }) => {
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

test('editor context menu initializes Chinese actions and accessibility help after restart', async ({ workbench, restartWorkbench }) => {
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

test('editor preserves space and tab indentation and places input at the rendered text', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const lines = ['plain', '    spaces', '\ttab', ' \t mixed  text ', '\t\tnested'];
	await page.keyboard.insertText(lines.join('\n'));
	await expect.poll(() => editor.lines.allTextContents()).toEqual(lines);
	const measurements = await editor.lines.evaluateAll(elements => {
		return elements.map(element => {
			const text = element.textContent!;
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			const nodes: Text[] = [];
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				nodes.push(node as Text);
			}
			const boundsAt = (offset: number) => {
				let remaining = offset;
				for (const node of nodes) {
					if (remaining <= node.length) {
						const range = document.createRange();
						range.setStart(node, remaining);
						range.collapse(true);
						return range.getBoundingClientRect();
					}
					remaining -= node.length;
				}
				throw new Error(`Missing rendered offset ${offset}`);
			};
			const start = boundsAt(0);
			const content = boundsAt(text.search(/\S/u));
			const last = boundsAt(text.length - 1);
			const end = boundsAt(text.length);
			return {
				indent: content.left - start.left,
				width: end.left - start.left,
				lastWidth: end.left - last.left,
				x: content.left + 0.25,
				y: content.top + content.height / 2,
				tabSize: Number(getComputedStyle(element).tabSize),
			};
		});
	});
	const characterWidth = measurements[0]!.lastWidth;
	const tabSize = measurements[0]!.tabSize;
	const columns = [5, 10, tabSize + 3, tabSize + 13, tabSize * 2 + 6];
	const indentation = [0, 4, tabSize, tabSize + 1, tabSize * 2];
	for (let index = 0; index < lines.length; index++) {
		expect(Math.abs(measurements[index]!.indent - indentation[index]! * characterWidth)).toBeLessThan(1);
		expect(Math.abs(measurements[index]!.width - columns[index]! * characterWidth)).toBeLessThan(1);
	}
	const point = measurements[4]!;
	await page.mouse.click(point.x, point.y);
	await expect.poll(() => editor.element.locator('.stanza-editor-caret.primary').evaluate((element, point) => {
		const bounds = element.getBoundingClientRect();
		return Math.abs(bounds.left + parseFloat(getComputedStyle(element).paddingLeft) - point.x);
	}, point)).toBeLessThan(1);
	await page.keyboard.insertText('!');
	await expect.poll(() => editor.lines.allTextContents()).toEqual([...lines.slice(0, 4), '\t\t!nested']);
	await editor.input.press('ControlOrMeta+z');
	await expect.poll(() => editor.lines.allTextContents()).toEqual(lines);
	await expect(editor.input).toBeFocused();
});

test('active indent guides keep a thin stroke without gutter symbol icons', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const lines = ['root', '    child', '        grandchild', '    sibling', 'root'];
	await page.keyboard.insertText(lines.join('\n'));
	await expect(editor.lines).toHaveText(lines);
	await editor.input.press('ControlOrMeta+Home');
	await editor.input.press('ArrowDown');
	await editor.input.press('ArrowDown');
	await editor.input.press('End');
	const active = editor.element.locator('.stanza-editor-indent-guide.active');
	await expect(active.first()).toBeAttached();
	const inactive = editor.element.locator('.stanza-editor-indent-guide:not(.active)');
	await expect(inactive.first()).toBeAttached();
	await expect(active.first()).toHaveCSS('border-left-width', '1px');
	await expect(inactive.first()).toHaveCSS('border-left-width', '1px');
	const inactiveColor = await inactive.first().evaluate(element => getComputedStyle(element).borderLeftColor);
	await expect(active.first()).not.toHaveCSS('border-left-color', inactiveColor);
	await expect(editor.element.locator('.stanza-editor-symbol-icon')).toHaveCount(0);
	await expect(editor.input).toBeFocused();
});

test('line numbers stay aligned while scrolling and gutter clicks edit the visible line', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText(Array.from({ length: 160 }, (_, index) => `line-${index + 1} ${'text '.repeat(40)}`).join('\n'));
	await editor.input.press('ControlOrMeta+Home');
	const scrollContainer = editor.element.locator(':scope > .ash-smooth-scrollable');
	await expect.poll(() => scrollContainer.evaluate(element => element.scrollTop)).toBe(0);
	await editor.element.hover();
	await page.mouse.wheel(0, 600);
	await expect.poll(() => scrollContainer.evaluate(element => element.scrollTop)).toBe(600);
	await expect.poll(() => editor.element.evaluate(root => {
		const bounds = root.getBoundingClientRect();
		const rows = [...root.querySelectorAll<HTMLElement>('.view-lines > .view-line')]
			.filter(row => row.getBoundingClientRect().top >= bounds.top && row.getBoundingClientRect().bottom <= bounds.bottom);
		return {
			hasVisibleLines: rows.length > 0,
			aligned: rows.every(row => {
				const number = root.querySelector<HTMLElement>(`.margin-view-overlays > .view-overlay-line[data-line-index="${row.dataset.lineIndex}"]`)!;
				return number.querySelector('.line-numbers')!.textContent === String(Number(row.dataset.lineIndex) + 1)
					&& number.getBoundingClientRect().top === row.getBoundingClientRect().top;
			}),
			scrollTop: root.scrollTop,
		};
	})).toEqual({ hasVisibleLines: true, aligned: true, scrollTop: 0 });
	const lineIndex = await editor.element.evaluate(root => {
		const bounds = root.getBoundingClientRect();
		return [...root.querySelectorAll<HTMLElement>('.view-lines > .view-line')]
			.find(row => row.getBoundingClientRect().top >= bounds.top)!.dataset.lineIndex!;
	});
	// Gutter overlays ignore pointer events; the editor resolves the clicked
	// position through its hit-test controller rather than a number element handler.
	const numberBounds = (await editor.element.locator(`.margin-view-overlays > .view-overlay-line[data-line-index="${lineIndex}"] .line-numbers`).boundingBox())!;
	await page.mouse.click(numberBounds.x + numberBounds.width / 2, numberBounds.y + numberBounds.height / 2);
	await page.keyboard.press('Home');
	await page.keyboard.insertText('!');
	await expect(editor.element.locator(`.view-lines > .view-line[data-line-index="${lineIndex}"] .stanza-editor-line-text`))
		.toHaveText(`!line-${Number(lineIndex) + 1} ${'text '.repeat(40)}`);
	await expect(editor.input).toBeFocused();
});

test('multiline text input is restored by one undo in the editor', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('one\ntwo\nthree');
	await editor.waitForEditorContents(contents => contents === 'one\ntwo\nthree');
	await editor.input.press('ControlOrMeta+z');
	await expect(editor.lines).toHaveText(['']);
	await editor.input.press('ControlOrMeta+Shift+z');
	await expect(editor.lines).toHaveText(['one', 'two', 'three']);
	await expect(editor.input).toBeFocused();
});

test('browser range replacement restores its text and selection through undo and redo', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('hello\nworld');
	await editor.input.press('ControlOrMeta+Home');
	await editor.input.press('End');
	await editor.input.evaluate(element => {
		const context = (element as HTMLElement & { editContext?: EventTarget; }).editContext;
		if (!context) throw new Error('Browser EditContext is unavailable');
		context.dispatchEvent(Object.assign(new Event('textupdate'), {
			text: 'hi', updateRangeStart: 0, updateRangeEnd: 5, selectionStart: 0, selectionEnd: 2,
		}));
	});
	await expect(editor.lines).toHaveText(['hi', 'world']);
	await page.keyboard.insertText('!');
	await expect(editor.lines).toHaveText(['!', 'world']);
	await editor.input.press('ControlOrMeta+z');
	await expect(editor.lines).toHaveText(['hi', 'world']);
	await editor.input.press('ControlOrMeta+z');
	await expect(editor.lines).toHaveText(['hello', 'world']);
	await editor.input.press('ControlOrMeta+Shift+z');
	await expect(editor.lines).toHaveText(['hi', 'world']);
	await page.keyboard.insertText('!');
	await expect(editor.lines).toHaveText(['!', 'world']);
	await expect(editor.input).toBeFocused();
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

test('minimap reflects equal-length text edits in the workbench', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('iiii\n\n \t \niiii');
	await expect(editor.lines).toHaveText(['iiii', '', ' \t ', 'iiii']);
	const canvas = editor.element.locator('.minimap canvas');
	const minimap = editor.element.locator('.minimap');
	await expect(minimap).toHaveCSS('overflow', 'hidden');
	await expect(minimap).toHaveCSS('background-color', await editor.element.evaluate(element => getComputedStyle(element).backgroundColor));
	const readPixels = () => canvas.evaluate(element => {
		const canvas = element as HTMLCanvasElement;
		return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
	});
	await expect.poll(async () => (await readPixels()).some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
	const original = await readPixels();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let index = 0; index < 4; index++) {
		await page.keyboard.press('Shift+ArrowRight');
	}
	await page.keyboard.insertText('WWWW');
	await expect(editor.lines.first()).toHaveText('WWWW');
	await expect.poll(readPixels).not.toEqual(original);
	await expect(editor.element.locator('.minimap')).toHaveAttribute('aria-hidden', 'true');
});

test('built-in themes apply scrollbar and minimap colors through hover and dragging', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText(Array.from({ length: 120 }, () => 'long text '.repeat(100)).join('\n'));
	await page.keyboard.press('ControlOrMeta+Home');
	const vertical = editor.element.locator('.ash-scrollbar-track-vertical');
	const thumb = vertical.locator('.ash-scrollbar-thumb');
	const minimap = editor.element.locator('.minimap');
	const slider = minimap.locator('.stanza-editor-minimap-slider');
	for (const { name, id, colors, shadow } of [
		{
			name: 'Ash Dark', id: 'ash-dark',
			colors: ['rgba(168, 169, 170, 0.52)', 'rgba(168, 169, 170, 0.56)', 'rgba(168, 169, 170, 0.61)'],
			shadow: 'rgba(0, 0, 0, 0.08) 0px 0px 6px 0px',
		},
		{
			name: 'Ash Light', id: 'ash-light',
			colors: ['rgba(100, 100, 100, 0.75)', 'rgba(100, 100, 100, 0.82)', 'rgba(100, 100, 100, 0.88)'],
			shadow: 'rgba(0, 0, 0, 0.08) 0px 0px 6px 0px',
		},
		{
			name: 'Ash High Contrast Dark', id: 'ash-high-contrast-dark',
			colors: ['rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgb(255, 255, 0)'], shadow: 'none',
		},
		{
			name: 'Ash High Contrast Light', id: 'ash-high-contrast-light',
			colors: ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 238)'], shadow: 'none',
		},
	] as const) {
		const [background, hover, active] = colors;
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const search = page.locator('.ash-quick-pick').getByRole('combobox');
		await search.fill(name);
		await search.press('Enter');
		await expect(workbench.element).toHaveAttribute('data-color-theme', id);
		await page.mouse.move(0, 0);
		await expect(thumb).toHaveCSS('background-color', background);
		await expect(slider).toHaveCSS('background-color', background);
		await expect(vertical).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect.poll(() => editor.element.locator('canvas.decorationsOverviewRuler').evaluate((element: HTMLCanvasElement) => {
			const pixels = element.getContext('2d')!.getImageData(2, Math.floor(element.height / 2), 1, 1).data;
			const probe = document.createElement('canvas').getContext('2d')!;
			probe.fillStyle = getComputedStyle(element.closest('.stanza-editor')!).backgroundColor;
			probe.fillRect(0, 0, 1, 1);
			return Array.from(pixels).join(',') === Array.from(probe.getImageData(0, 0, 1, 1).data).join(',');
		})).toBe(true);
		await expect.poll(() => minimap.evaluate(element => getComputedStyle(element, '::after').boxShadow)).toBe(shadow);
		await minimap.hover();
		await expect(slider).toHaveCSS('background-color', hover);
		await vertical.hover();
		await expect(thumb).toHaveCSS('background-color', hover);
		const bounds = (await thumb.boundingBox())!;
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await page.mouse.down();
		try {
			await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 20);
			await expect(thumb).toHaveCSS('background-color', active);
			await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		} finally {
			await page.mouse.up();
		}
		await editor.input.press('ControlOrMeta+Home');
	}
});

test('editor scrollbar track background follows the theme through hover and dragging', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText(Array.from({ length: 120 }, () => 'long text '.repeat(100)).join('\n'));
	await page.keyboard.press('ControlOrMeta+Home');
	const tracks = editor.element.locator('.ash-scrollbar-track');
	await expect(tracks).toHaveCount(2);
	for (const track of await tracks.all()) {
		await expect(track).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}
	await editor.element.evaluate(element => element.style.setProperty('--ash-scrollbar-background', '#123456'));
	try {
		for (const track of await tracks.all()) {
			await expect(track).toHaveCSS('background-color', 'rgb(18, 52, 86)');
			await expect(track).toHaveCSS('border-radius', '0px');
		}
		const vertical = editor.element.locator('.ash-scrollbar-track-vertical');
		await vertical.hover();
		await expect(vertical).toHaveCSS('background-color', 'rgb(18, 52, 86)');
		const thumb = (await vertical.locator('.ash-scrollbar-thumb').boundingBox())!;
		await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
		await page.mouse.down();
		try {
			await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 20);
			await expect(vertical).toHaveClass(/\bactive\b/u);
			await expect(vertical).toHaveCSS('background-color', 'rgb(18, 52, 86)');
			await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		} finally {
			await page.mouse.up();
		}
	} finally {
		await editor.element.evaluate(element => element.style.removeProperty('--ash-scrollbar-background'));
	}
	for (const track of await tracks.all()) {
		await expect(track).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}
});

test('minimap shadow indicates content beyond the right edge', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const minimap = editor.element.locator('.minimap');
	const scrollable = editor.element.locator(':scope > .ash-smooth-scrollable');
	const readShadow = () => minimap.evaluate(element => {
		const style = getComputedStyle(element, '::after');
		return { content: style.content, shadow: style.boxShadow, pointerEvents: style.pointerEvents, left: style.left };
	});
	await page.keyboard.insertText('short line');
	await expect.poll(async () => (await readShadow()).shadow).toBe('none');
	await page.keyboard.insertText(' long text'.repeat(100));
	await scrollable.evaluate(element => { element.scrollLeft = 0; });
	await expect.poll(() => scrollable.evaluate(element => element.scrollWidth > element.clientWidth && element.scrollLeft === 0)).toBe(true);
	await expect.poll(async () => (await readShadow()).shadow).not.toBe('none');
	expect(await readShadow()).toMatchObject({ content: '""', pointerEvents: 'none', left: '-6px' });
	await minimap.evaluate(element => element.style.setProperty('--ash-minimap-shadow', '#123456'));
	try {
		await expect.poll(async () => (await readShadow()).shadow).toBe('rgb(18, 52, 86) 0px 0px 6px 0px');
	} finally {
		await minimap.evaluate(element => element.style.removeProperty('--ash-minimap-shadow'));
	}
	await page.emulateMedia({ forcedColors: 'active' });
	await expect.poll(async () => (await readShadow()).shadow).toBe('none');
	await page.emulateMedia({ forcedColors: 'none' });
	await expect.poll(async () => (await readShadow()).shadow).not.toBe('none');
	await scrollable.evaluate(element => { element.scrollLeft = element.scrollWidth; });
	await expect.poll(() => scrollable.evaluate(element => element.scrollLeft + element.clientWidth >= element.scrollWidth)).toBe(true);
	await expect.poll(async () => (await readShadow()).shadow).toBe('none');
	await scrollable.evaluate(element => { element.scrollLeft = 0; });
	await expect.poll(async () => (await readShadow()).shadow).not.toBe('none');
});

test('minimap slider has modern corners and reaches the scrollbar bottom', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText(Array.from({ length: 1_200 }, () => 'long text '.repeat(100)).join('\n'));
	const minimap = editor.element.locator('.minimap');
	const slider = minimap.locator('.stanza-editor-minimap-slider');
	const thumb = editor.element.locator('.ash-scrollbar-track-vertical .ash-scrollbar-thumb');
	await expect(workbench.element).toHaveClass(/\bmodern-ui\b/u);
	await expect(slider).toHaveCSS('border-radius', '4px');
	await page.keyboard.press('ControlOrMeta+Home');
	await expect.poll(async () => (await slider.boundingBox())!.y - (await thumb.boundingBox())!.y).toBeCloseTo(0, 1);
	await page.keyboard.press('ControlOrMeta+End');
	await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop > 0 && element.scrollTop === element.scrollHeight - element.clientHeight)).toBe(true);
	await expect.poll(async () => {
		const map = (await slider.boundingBox())!;
		const bar = (await thumb.boundingBox())!;
		return map.y + map.height - bar.y - bar.height;
	}).toBeCloseTo(0, 1);
	await minimap.hover();
	await expect(slider).toHaveCSS('opacity', '1');
	const box = (await slider.boundingBox())!;
	const root = (await minimap.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, root.y - box.height);
	await page.mouse.up();
	await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(0);
	await expect(editor.element.locator('.stanza-editor-input')).toBeFocused();
});

test('clicking inside editor text places insertion at the clicked character', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const text = 'mode switcher > radiogroup';
	await page.keyboard.insertText(`${'context\n'.repeat(9)}${text}\n${'wide '.repeat(100)}`);
	await page.keyboard.press('ControlOrMeta+Home');
	const line = editor.lines.nth(9);
	await expect(line).toHaveText(text);
	for (const offset of [text.length, 20, 16]) {
		const point = await line.evaluate((element, offset) => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			let remaining = offset;
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const length = node.textContent!.length;
				if (remaining <= length) {
					const range = document.createRange();
					range.setStart(node, remaining);
					range.collapse(true);
					const rect = range.getBoundingClientRect();
					return { x: rect.left - 1, y: rect.top + rect.height / 2 };
				}
				remaining -= length;
			}
			throw new Error(`Missing rendered offset ${offset}`);
		}, offset);
		await page.mouse.move(point.x, point.y);
		await page.mouse.down();
		await page.mouse.move(point.x - 0.5, point.y + 0.25);
		await page.mouse.up();
		await page.keyboard.insertText('!');
		await expect(line).toHaveText(`${text.slice(0, offset)}!${text.slice(offset)}`);
		await page.keyboard.press('Backspace');
		await expect(editor.input).toBeFocused();
		await expect.poll(async () => {
			const caret = await editor.element.locator('.stanza-editor-caret.primary').boundingBox();
			return caret ? Math.abs(caret.x - point.x) : Number.POSITIVE_INFINITY;
		}).toBeLessThan(3);
		await expect(line).toHaveText(text);
	}
});

test('dragging editor text after horizontal scrolling replaces the selected characters', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const text = 'mode switcher > radiogroup';
	await page.keyboard.insertText(`${'wide '.repeat(100)}\n${text}`);
	const line = editor.lines.nth(1);
	await expect(line).toHaveText(text);
	await line.hover();
	const before = (await line.boundingBox())!.x;
	await page.mouse.wheel(60, 0);
	await expect.poll(async () => (await line.boundingBox())!.x).toBeLessThan(before - 40);
	const points = await line.evaluate(element => [16, 26].map(offset => {
		const node = element.firstChild!.firstChild!;
		const range = document.createRange();
		range.setStart(node, offset);
		range.collapse(true);
		const bounds = range.getBoundingClientRect();
		const row = element.closest('.view-line')!.getBoundingClientRect();
		return { x: bounds.left - 0.25, y: bounds.top + bounds.height / 2, top: row.top, height: row.height };
	}));
	await page.mouse.move(points[0]!.x, points[0]!.y);
	await page.mouse.down();
	await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => {
		const selection = await editor.element.locator('.stanza-editor-selection').boundingBox();
		const caret = await editor.element.locator('.stanza-editor-caret.primary').boundingBox();
		if (!selection || !caret) return Number.POSITIVE_INFINITY;
		return Math.max(
			Math.abs(selection.x - points[0]!.x),
			Math.abs(selection.width - (points[1]!.x - points[0]!.x)),
			Math.abs(selection.y - points[0]!.top),
			Math.abs(selection.height - points[0]!.height),
			Math.abs(caret.x - points[1]!.x),
			Math.abs(caret.y - points[1]!.top),
		);
	}).toBeLessThan(2);
	await expect.poll(() => editor.element.locator('.stanza-editor-selection').evaluate(element => {
		const rect = element.getBoundingClientRect();
		const pointerEvents = (element as HTMLElement).style.pointerEvents;
		// Test browser paint order even though the selection background ignores pointer input.
		(element as HTMLElement).style.pointerEvents = 'auto';
		try {
			const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			const textIndex = stack.findIndex(node => node.closest('.view-lines'));
			return textIndex >= 0 && stack.indexOf(element) > textIndex;
		} finally {
			(element as HTMLElement).style.pointerEvents = pointerEvents;
		}
	})).toBe(true);
	await page.keyboard.insertText('!');
	await expect(line).toHaveText('mode switcher > !');
});

test('Chinese drag selection does not jump when pointer capture starts or ends', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const text = '是否带个电饭锅电饭锅的方法蛋糕';
	await page.keyboard.insertText(text);
	await expect(editor.lines.first()).toHaveText(text);
	const point = await editor.lines.first().evaluate(element => {
		const node = element.firstChild!.firstChild!;
		const range = document.createRange();
		range.setStart(node, 0);
		range.setEnd(node, 1);
		const rect = range.getBoundingClientRect();
		return { x: rect.left + rect.width / 2 + 0.25, y: rect.top + rect.height / 2, width: rect.width, left: rect.left };
	});
	await page.mouse.move(point.x, point.y);
	await page.mouse.down();
	const caret = editor.element.locator('.stanza-editor-caret.primary');
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
	const anchor = await caret.boundingBox();
	expect(anchor).not.toBeNull();
	const anchorOffset = Math.abs(anchor!.x - point.left) < 1 ? 0 : 1;
	try {
		for (const distance of [0, point.width, 0]) {
			await page.mouse.move(point.x + distance, point.y + 0.05);
			await expect(editor.element.locator('.stanza-editor-selection')).toHaveCount(distance === 0 ? 0 : 1);
			await expect.poll(async () => (await caret.boundingBox())!.x).toBeCloseTo(anchor!.x + distance, 0);
			await expect(editor.input).toBeFocused();
		}
	} finally {
		await page.mouse.up();
	}
	await expect(editor.element.locator('.stanza-editor-selection')).toHaveCount(0);
	await expect.poll(async () => (await caret.boundingBox())!.x).toBe(anchor!.x);
	await page.keyboard.insertText('!');
	await expect(editor.lines.first()).toHaveText(`${text.slice(0, anchorOffset)}!${text.slice(anchorOffset)}`);
});

test('text editor automation follows input, replacement, and folding in its group', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const text = 'section\n    alpha beta\n    gamma\nend';
	await editor.waitForTypeInEditor('section');
	await editor.input.press('Enter');
	await editor.waitForTypeInEditor('    alpha beta');
	await editor.input.press('Enter');
	await editor.waitForTypeInEditor('gamma');
	await editor.input.press('Enter');
	await editor.input.press('Home');
	await editor.input.press('Shift+End');
	await editor.waitForTypeInEditor('end');
	await editor.waitForEditorContents(contents => contents === text);
	await editor.foldAtLine(1);
	await editor.waitForEditorContents(contents => contents.includes('section') && contents.includes('end') && !contents.includes('alpha beta'));
	await editor.unfoldAtLine(1);
	await editor.waitForEditorContents(contents => contents === text);
	await editor.input.press('ControlOrMeta+A');
	await editor.waitForTypeInEditor('replacement');
	await editor.waitForEditorContents(contents => contents === 'replacement');
	await expect(editor.input).toBeFocused();
});

test('theme color settings update editor colors and restore defaults when removed', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('prefix selected suffix');
	const overrides = [
		['editor.selectionBackground', '#123456', '--ash-editor-selection-background'],
		['editor.inactiveSelectionBackground', '#654321', '--ash-editor-inactive-selection-background'],
		['editor.selectionForeground', '#fedcba', '--ash-editor-selection-foreground'],
		['scrollbar.background', '#112233', '--ash-scrollbar-background'],
		['scrollbarSlider.background', '#234567', '--ash-scrollbar-slider-background'],
		['scrollbarSlider.hoverBackground', '#345678', '--ash-scrollbar-slider-hover-background'],
		['scrollbarSlider.activeBackground', '#456789', '--ash-scrollbar-slider-active-background'],
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

test('text editor automation keeps split group inputs and contents separate', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const first = workbench.editors.groupAt(0).editor;
	await first.waitForEditorFocus();
	await first.waitForTypeInEditor('first group');
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	await page.keyboard.press('ControlOrMeta+N');
	const second = workbench.editors.groupAt(1).editor;
	await expect(second.input).toHaveAttribute('aria-label', 'Untitled-2');
	await second.waitForEditorFocus();
	await second.waitForTypeInEditor('second group');
	await first.waitForEditorContents(contents => contents === 'first group');
	await second.waitForEditorContents(contents => contents === 'second group');
	await first.waitForEditorFocus();
	await expect(second.input).not.toBeFocused();
	await first.waitForTypeInEditor('!');
	await first.waitForEditorContents(contents => contents === 'first group!');
	await second.waitForEditorContents(contents => contents === 'second group');
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

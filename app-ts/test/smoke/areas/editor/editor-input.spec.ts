import { expect, test } from '../../../automation/test.js';
import type { ElectronApplication } from '@playwright/test';

test('multiline text input is restored by one undo in the editor', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('multiline paste undo and redo preserve the final editor line', async ({ target, workbench, application }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('minimap reflects equal-length text edits in the workbench', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('iiii\n\n \t \niiii');
	await expect(editor.lines).toHaveText(['iiii', '', ' \t ', 'iiii']);
	const canvas = editor.element.locator('.minimap canvas');
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

test('clicking inside editor text places insertion at the clicked character', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('dragging editor text after horizontal scrolling replaces the selected characters', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('text editor automation follows input, replacement, and folding in its group', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('theme color settings update selected text and restore defaults when removed', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('prefix selected suffix');
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-group-id="workbench"]').click();
	await settings.locator('[data-settings-category-id="appearance"]').click();
	const colors = settings.locator('[data-configuration-key="workbench.colorCustomizations"]');
	await expect(colors).toBeVisible();
	for (const [id, color, cssVariable] of [
		['editor.selectionBackground', '#123456', '--ash-editor-selection-background'],
		['editor.inactiveSelectionBackground', '#654321', '--ash-editor-inactive-selection-background'],
		['editor.selectionForeground', '#fedcba', '--ash-editor-selection-foreground'],
	] as const) {
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
	await expect(colors.locator('.ash-string-map-row')).toHaveCount(3);
	for (let count = 3; count > 0; count--) {
		await colors.locator('.ash-string-map-row').last().getByRole('button').click();
		await expect(colors.locator('.ash-string-map-row')).toHaveCount(count - 1);
	}
	await settings.locator('.ash-modal-editor-close').click();
	await expect(selected).toHaveCount(0);
	await expect(editor.lines.first()).toHaveText('prefix selected suffix');
});

test('text editor automation keeps split group inputs and contents separate', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const first = workbench.editors.groupAt(0).editor;
	await first.waitForEditorFocus();
	await first.waitForTypeInEditor('first group');
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groups).toHaveCount(2);
	await page.keyboard.press('ControlOrMeta+N');
	const second = workbench.editors.groupAt(1).editor;
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

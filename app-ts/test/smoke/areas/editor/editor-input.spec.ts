import { expect, test } from '../../../automation/test.js';

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

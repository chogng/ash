import { expect, test } from '../../../automation/test.js';

test('clicking inside editor text places insertion at the clicked character', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const text = 'mode switcher > radiogroup';
	await editor.waitForTypeInEditor(text);
	const line = editor.lines.first();
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
		await page.mouse.click(point.x, point.y);
		await expect(editor.input).toBeFocused();
		await expect.poll(async () => {
			const caret = await editor.element.locator('.stanza-editor-caret.primary').boundingBox();
			return caret ? Math.abs(caret.x - point.x) : Number.POSITIVE_INFINITY;
		}).toBeLessThan(3);
		await page.keyboard.insertText('!');
		await expect(line).toHaveText(`${text.slice(0, offset)}!${text.slice(offset)}`);
		await page.keyboard.press('Backspace');
		await expect(line).toHaveText(text);
	}
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

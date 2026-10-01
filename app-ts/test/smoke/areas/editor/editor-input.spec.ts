import { expect, test } from '../../../automation/test.js';
import type { ElectronApplication } from '@playwright/test';

test('editor preserves space and tab indentation and places input at the rendered text', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('line numbers stay aligned while scrolling and gutter clicks edit the visible line', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('browser range replacement restores its text and selection through undo and redo', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('hello\nworld');
	await editor.input.press('ControlOrMeta+Home');
	await editor.input.press('End');
	await editor.input.evaluate(element => {
		const context = (element as HTMLElement & { editContext?: EventTarget }).editContext;
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

test('editor scrollbar track background follows the theme through hover and dragging', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('minimap shadow indicates content beyond the right edge', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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
	expect(await readShadow()).toMatchObject({ content: '""', pointerEvents: 'none', left: '0px' });
	await minimap.evaluate(element => element.style.setProperty('--ash-widget-shadow', '#123456'));
	try {
		await expect.poll(async () => (await readShadow()).shadow).toBe('rgb(18, 52, 86) 6px 0px 6px -6px inset');
	} finally {
		await minimap.evaluate(element => element.style.removeProperty('--ash-widget-shadow'));
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

test('minimap slider has modern corners and reaches the scrollbar bottom', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

test('Chinese drag selection does not jump when pointer capture starts or ends', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
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

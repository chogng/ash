import { expect, test, type Page } from "@playwright/test";
import { getAxeResults, injectAxe } from "axe-playwright";
import { ScrollType, type IEditor } from '../../../src/ash/editor/common/editorCommon.js';
import { fileURLToPath } from 'node:url';

const pageErrors = new WeakMap<object, string[]>();

test('symbol highlights stay on the symbol when the gutter, minimap and horizontal scroll change', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.getModel()!.setLanguage('plaintext');
		editor.updateOptions({ wordWrap: 'off', smoothScrolling: false, occurrencesHighlight: 'singleFile', occurrencesHighlightDelay: 0, selectionHighlight: false });
		editor.setValue('use crate::UserAllowlist;\n    user_allowlist: UserAllowlist,\n' + 'long line '.repeat(100));
		editor.setPosition({ lineNumber: 2, column: 24 });
		editor.focus();
	});
	const editor = page.locator('.stanza-editor');
	await expect(editor.locator('.cdr.word-highlight-text')).toHaveCount(2);
	for (const side of ['disabled', 'left', 'right'] as const) {
		for (const gutter of [true, false]) {
			for (const scrollLeft of [0, 80]) {
				await page.evaluate(({ side, gutter, scrollLeft }) => {
					const control = window.ashTextModelIntegration.getControl();
					control.updateOptions({ lineNumbers: gutter ? 'on' : 'off', glyphMargin: gutter, fontSize: gutter ? 20 : 16, minimap: { enabled: side !== 'disabled', side: side === 'left' ? 'left' : 'right' } });
					control.layout({ width: gutter ? 700 : 420, height: 200 });
					control.setScrollPosition({ scrollLeft, scrollTop: 0 });
				}, { side, gutter, scrollLeft });
				await expect.poll(() => editor.evaluate(root => {
					return [...root.querySelectorAll<HTMLElement>('.cdr.word-highlight-text')].map(highlight => {
						const lineIndex = highlight.parentElement!.dataset.lineIndex;
						const text = root.querySelector(`.view-lines > .view-line[data-line-index="${lineIndex}"] > .stanza-editor-line-text`)!;
						const start = text.textContent!.indexOf('UserAllowlist');
						const end = start + 'UserAllowlist'.length;
						const range = document.createRange();
						const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
						let offset = 0;
						for (let node = walker.nextNode(); node; node = walker.nextNode()) {
							const length = node.textContent!.length;
							if (start >= offset && start < offset + length) range.setStart(node, start - offset);
							if (end > offset && end <= offset + length) range.setEnd(node, end - offset);
							offset += length;
						}
						const symbol = range.getBoundingClientRect();
						const background = highlight.getBoundingClientRect();
						const leftDelta = background.left - symbol.left;
						const rightDelta = background.right - symbol.right;
						return { lineIndex, leftDelta: Math.abs(leftDelta) < 1 ? 0 : leftDelta, rightDelta: Math.abs(rightDelta) < 1 ? 0 : rightDelta };
					});
				}), { message: `symbol geometry with minimap=${side}, gutter=${gutter}, scrollLeft=${scrollLeft}` }).toEqual([
					{ lineIndex: '0', leftDelta: 0, rightDelta: 0 },
					{ lineIndex: '1', leftDelta: 0, rightDelta: 0 },
				]);
			}
		}
	}
});

test('glyph decorations added and removed after rendering update without cursor or layout changes', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.getModel()!.setLanguage('plaintext');
		editor.updateOptions({ glyphMargin: true, wordWrap: 'off' });
		editor.setValue('first\nsecond\nthird');
	});
	const glyph = page.locator('.ash-delayed-glyph-probe');
	await expect(page.locator('.view-lines')).toContainText('third');
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	await page.evaluate(() => {
		const model = window.ashTextModelIntegration.getControl().getModel()!;
		model.deltaDecorations([], [{
			range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
			options: { description: 'delayed glyph invalidation', glyphMarginClassName: 'ash-delayed-glyph-probe' },
		}]);
	});
	await expect(glyph).toHaveCount(1);
	await page.evaluate(() => {
		const model = window.ashTextModelIntegration.getControl().getModel()!;
		const ids = model.getAllDecorations().filter(d => d.options.glyphMarginClassName === 'ash-delayed-glyph-probe').map(d => d.id);
		model.deltaDecorations(ids, []);
	});
	await expect(glyph).toHaveCount(0);
});

test('line numbers and glyph markers share text coordinates after vertical and horizontal scrolling', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.getModel()!.setLanguage('plaintext');
		editor.updateOptions({ lineHeight: 20, lineNumbers: 'on', glyphMargin: true, wordWrap: 'off', smoothScrolling: false, padding: { top: 0, bottom: 0 } });
		editor.setValue(Array.from({ length: 160 }, (_, index) => `line-${index + 1} ${'text '.repeat(100)}`).join('\n'));
		editor.createDecorationsCollection([{
			range: { startLineNumber: 31, startColumn: 1, endLineNumber: 31, endColumn: 1 },
			options: { description: 'scroll geometry probe', glyphMarginClassName: 'ash-scroll-glyph-probe' },
		}]);
		editor.setScrollPosition({ scrollTop: 600, scrollLeft: 80 });
	});
	const editor = page.locator('.stanza-editor');
	await expect(editor.locator('.view-line').first()).toContainText('line-31 ');
	await expect.poll(() => editor.evaluate(root => {
		const textRows = [...root.querySelectorAll<HTMLElement>('.view-lines > .view-line')];
		const numberRows = [...root.querySelectorAll<HTMLElement>('.margin-view-overlays > .view-overlay-line')];
		return textRows.map(row => {
			const numberRow = numberRows.find(number => number.dataset.lineIndex === row.dataset.lineIndex)!;
			return {
				number: numberRow.querySelector('.line-numbers')!.textContent,
				expected: String(Number(row.dataset.lineIndex) + 1),
				delta: numberRow.getBoundingClientRect().top - row.getBoundingClientRect().top,
			};
		}).filter(row => row.number !== row.expected || row.delta !== 0);
	})).toEqual([]);
	const geometry = await editor.evaluate(root => {
		const bounds = root.getBoundingClientRect();
		const row = root.querySelector('.view-lines > .view-line')!;
		const glyph = root.querySelector('.ash-scroll-glyph-probe')!;
		return { glyphTop: glyph.getBoundingClientRect().top - row.getBoundingClientRect().top, marginLeft: root.querySelector('.margin')!.getBoundingClientRect().left - bounds.left };
	});
	expect(geometry).toEqual({ glyphTop: 0, marginLeft: 0 });
	expect(await editor.evaluate(root => ({
		fixedRoot: root.scrollTop === 0 && root.scrollLeft === 0,
		marginOutsideContent: root.querySelector('.margin')!.parentElement === root,
		inputInScrollViewport: root.querySelector('.stanza-editor-input')!.parentElement === root.querySelector(':scope > .ash-smooth-scrollable'),
	}))).toEqual({ fixedRoot: true, marginOutsideContent: true, inputInScrollViewport: true });
});

test('scroll viewport and horizontal thumb exclude the fixed gutter after layout changes', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.getModel()!.setLanguage('plaintext');
		editor.updateOptions({ lineNumbers: 'on', glyphMargin: true, wordWrap: 'off', smoothScrolling: false, minimap: { enabled: false }, scrollbar: { horizontal: 'visible' } });
		editor.setValue(Array.from({ length: 100 }, () => 'long line '.repeat(100)).join('\n'));
	});
	const editor = page.locator('.stanza-editor');
	for (const side of ['disabled', 'left', 'right'] as const) {
		await page.evaluate(side => {
			const control = window.ashTextModelIntegration.getControl();
			control.updateOptions({ minimap: { enabled: side !== 'disabled', side: side === 'left' ? 'left' : 'right' } });
			control.setScrollPosition({ scrollLeft: 0, scrollTop: 400 });
		}, side);
		await expect.poll(() => editor.evaluate(root => {
			const layout = window.ashTextModelIntegration.getControl().getLayoutInfo();
			const viewport = root.querySelector<HTMLElement>(':scope > .ash-smooth-scrollable')!;
			const track = viewport.querySelector('.ash-scrollbar-track-horizontal')!;
			return {
				viewportLeft: viewport.getBoundingClientRect().left - root.getBoundingClientRect().left - layout.contentLeft,
				viewportWidth: viewport.clientWidth - (layout.width - layout.contentLeft),
				trackLeft: track.getBoundingClientRect().left - viewport.getBoundingClientRect().left,
			};
		})).toEqual({ viewportLeft: 0, viewportWidth: 0, trackLeft: 0 });
		const thumb = editor.locator('.ash-scrollbar-track-horizontal > .ash-scrollbar-thumb');
		const thumbBox = await thumb.boundingBox();
		assertBox(thumbBox, 'horizontal thumb');
		const rootBox = await editor.boundingBox();
		assertBox(rootBox, 'editor');
		await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(rootBox.x + rootBox.width + 200, thumbBox.y + thumbBox.height / 2);
		await page.mouse.up();
		await expect.poll(() => editor.evaluate(root => {
			const viewport = root.querySelector<HTMLElement>(':scope > .ash-smooth-scrollable')!;
			return { remaining: viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft, delta: window.ashTextModelIntegration.getControl().getScrollLeft() - viewport.scrollLeft };
		})).toEqual({ remaining: 0, delta: 0 });
	}
	await page.evaluate(() => window.ashTextModelIntegration.getControl().updateOptions({ lineNumbers: 'off', glyphMargin: false }));
	await expect.poll(() => editor.evaluate(root => {
		const viewport = root.querySelector<HTMLElement>(':scope > .ash-smooth-scrollable')!;
		return viewport.getBoundingClientRect().left - root.getBoundingClientRect().left - window.ashTextModelIntegration.getControl().getLayoutInfo().contentLeft;
	})).toBe(0);
});

for (const inputMode of ['EditContext', 'textarea'] as const) {
	test(`composition anchor follows the caret inside the scrolling body with ${inputMode}`, async ({ page }) => {
		if (inputMode === 'textarea') await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		await openEditor(page);
		await page.evaluate(() => {
			const editor = window.ashTextModelIntegration.getControl();
			editor.updateOptions({ wordWrap: 'off', smoothScrolling: false, minimap: { enabled: true, side: 'left' } });
			editor.setValue('long line '.repeat(100));
			editor.setPosition({ lineNumber: 1, column: 50 });
			editor.setScrollLeft(80);
			editor.focus();
		});
		const input = page.locator('.stanza-editor-input');
		await input.evaluate(element => {
			const target = (element as HTMLElement & { editContext?: EventTarget }).editContext ?? element;
			target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
		});
		await expect(page.locator('.stanza-editor')).toHaveClass(/\bcomposing\b/u);
		await expect.poll(() => input.evaluate(element => {
			const caret = element.closest('.stanza-editor')!.querySelector('.stanza-editor-caret')!;
			return Math.abs(element.getBoundingClientRect().left - caret.getBoundingClientRect().left);
		})).toBeLessThanOrEqual(1);
	});
}

test('margin numbers and view zones retain one coordinate origin beyond the large-file offset', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.getModel()!.setLanguage('plaintext');
		editor.updateOptions({ lineHeight: 20, lineNumbers: 'on', glyphMargin: true, wordWrap: 'off', smoothScrolling: false, padding: { top: 0, bottom: 0 }, minimap: { enabled: false } });
		editor.setValue(Array.from({ length: 30_000 }, (_, index) => `line-${index + 1}`).join('\n'));
		const zone = document.createElement('div');
		zone.className = 'ash-large-file-zone-probe';
		const margin = document.createElement('div');
		margin.className = 'ash-large-file-margin-zone-probe';
		editor.changeViewZones(accessor => accessor.addZone({ afterLineNumber: 26_001, heightInPx: 40, domNode: zone, marginDomNode: margin }));
		editor.setScrollTop(520_000);
	});
	const editor = page.locator('.stanza-editor');
	await expect(editor.locator('.view-line').first()).toContainText('line-26001');
	await expect.poll(() => editor.evaluate(root => {
		const text = root.querySelector('.view-lines > .view-line')!;
		const number = root.querySelector('.margin-view-overlays > .view-overlay-line')!;
		const zone = root.querySelector('.ash-large-file-zone-probe')!;
		const marginZone = root.querySelector('.ash-large-file-margin-zone-probe')!;
		return {
			number: number.querySelector('.line-numbers')!.textContent,
			numberDelta: number.getBoundingClientRect().top - text.getBoundingClientRect().top,
			zoneDelta: zone.getBoundingClientRect().top - marginZone.getBoundingClientRect().top,
			zoneAfterLine: zone.getBoundingClientRect().top - text.getBoundingClientRect().bottom,
			rootScrollTop: root.scrollTop,
		};
	})).toEqual({ number: '26001', numberDelta: 0, zoneDelta: 0, zoneAfterLine: 0, rootScrollTop: 0 });
});

for (const theme of ['light', 'dark', 'contrast', 'contrastLight'] as const) {
	test(`minimap renders distinct characters and preserves whitespace in ${theme}`, async ({ page }) => {
		await openEditor(page);
		await page.evaluate(theme => {
			const harness = window.ashTextModelIntegration;
			harness.setTheme(theme);
			const editor = harness.getControl();
			editor.getModel()!.setLanguage('plaintext');
			editor.updateOptions({ wordWrap: 'off', padding: { top: 0, bottom: 0 }, minimap: { enabled: true, scale: 4, renderCharacters: true } });
			editor.setValue('iiii\n\n \t \niiii');
		}, theme);
		const canvas = page.locator('.minimap canvas');
		const readPixels = () => canvas.evaluate(element => {
			const canvas = element as HTMLCanvasElement;
			return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
		});
		await expect.poll(async () => (await readPixels()).some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		// Glyph coverage already blends the foreground with the editor background.
		// A second alpha reduction would wash out the same syntax colors again.
		expect((await readPixels()).reduce((alpha, value, index) => index % 4 === 3 ? Math.max(alpha, value) : alpha, 0)).toBe(255);
		const original = await readPixels();
		const whitespaceIsEmpty = await canvas.evaluate(element => {
			const canvas = element as HTMLCanvasElement;
			const rowHeight = window.ashTextModelIntegration.getControl().getLayoutInfo().minimap.minimapLineHeight;
			const data = canvas.getContext('2d')!.getImageData(0, rowHeight, canvas.width, rowHeight * 2).data;
			return data.every((value, index) => index % 4 !== 3 || value === 0);
		});
		expect(whitespaceIsEmpty).toBe(true);
		await page.evaluate(() => {
			const editor = window.ashTextModelIntegration.getControl();
			editor.executeEdits('minimap-test', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }, text: 'WWWW' }]);
		});
		await expect.poll(readPixels).not.toEqual(original);
		await page.locator('.stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(readPixels).toEqual(original);
		await expect(page.locator('.minimap')).toHaveAttribute('aria-hidden', 'true');
	});
}

test('modern minimap corners apply to main and auxiliary hosts and leave flat hosts square', async ({ page }) => {
	await openEditor(page);
	await page.addStyleTag({ path: fileURLToPath(new URL('../../../src/ash/workbench/contrib/modernUI/browser/media/roundedCorners.css', import.meta.url)) });
	const host = page.locator('body');
	// This editor fixture has no Workbench theme service; provide its size token.
	await host.evaluate(element => element.style.setProperty('--ash-corner-radius-small', '4px'));
	const slider = page.locator('.stanza-editor-minimap-slider');
	for (const root of ['ash-workbench', 'ash-auxiliary-window-container']) {
		await host.evaluate((element, root) => element.setAttribute('class', `${root} modern-ui`), root);
		await expect(slider).toHaveCSS('border-radius', '4px');
		await host.evaluate(element => element.classList.remove('modern-ui'));
		await expect(slider).toHaveCSS('border-radius', '0px');
	}
});

test('syntax theme updates repaint text and minimap through shared line support', async ({ page }) => {
	await openEditor(page);
	const editor = page.locator('.stanza-editor');
	const token = editor.locator('.stanza-editor-token').filter({ hasText: /^fn$/u });
	await expect(token).toBeVisible();
	const workers = page.workers().filter(worker => worker.url().includes('textMateSyntaxWorkerMain'));
	expect(workers).toHaveLength(0);
	for (const [color, expected] of [['#149b37', 'rgb(20, 155, 55)'], ['#9a41da', 'rgb(154, 65, 218)']] as const) {
		await page.evaluate(color => window.ashTextModelIntegration.setSyntaxColor(color), color);
		await expect(token).toHaveCSS('color', expected);
		await expect.poll(() => editor.locator('.minimap canvas').evaluate((element, color) => {
			const canvas = element as HTMLCanvasElement;
			const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
			const channel = color === '#149b37' ? 1 : 2;
			for (let offset = 0; offset < pixels.length; offset += 4) {
				if (pixels[offset + 3]! > 0 && pixels[offset + channel]! > pixels[offset]! && pixels[offset + channel]! > pixels[offset + 3 - channel]!) return true;
			}
			return false;
		}, color)).toBe(true);
		expect(page.workers().filter(worker => worker.url().includes('textMateSyntaxWorkerMain'))).toEqual(workers);
	}
});

test('proportional minimap preserves glyph height and repaints its document window when scrolling', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.getModel()!.setLanguage('plaintext');
		editor.updateOptions({ lineHeight: 20, wordWrap: 'off', minimap: { enabled: true, size: 'proportional', scale: 2, renderCharacters: false }, padding: { top: 0, bottom: 0 } });
		editor.setValue(Array.from({ length: 2_000 }, (_, index) => index < 1_000 ? 'WWWWWWWW' : 'ii').join('\n'));
	});
	const canvas = page.locator('.minimap canvas');
	const readPixels = () => canvas.evaluate(element => {
		const canvas = element as HTMLCanvasElement;
		return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
	});
	await expect.poll(() => canvas.evaluate(element => {
		const canvas = element as HTMLCanvasElement;
		const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, 6).data;
		return Array.from({ length: 6 }, (_, row) => data.slice(row * canvas.width * 4, (row + 1) * canvas.width * 4).some((value, index) => index % 4 === 3 && value > 0)).filter(Boolean).length;
	})).toBe(4);
	const before = await readPixels();
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.setScrollTop(2_000 * 20);
	});
	await expect.poll(readPixels).not.toEqual(before);
	await page.evaluate(() => window.ashTextModelIntegration.getControl().setScrollTop(0));
	await expect.poll(readPixels).toEqual(before);
});

for (const deviceScaleFactor of [1, 2]) {
	for (const size of ['proportional', 'fit', 'fill'] as const) {
		test(`minimap shares scrollbar endpoints with size=${size} at pixel ratio ${deviceScaleFactor}`, async ({ browser }) => {
			const context = await browser.newContext({ deviceScaleFactor });
			const page = await context.newPage();
			try {
				await openEditor(page);
				for (const horizontal of ['auto', 'visible', 'hidden'] as const) {
					for (const longLines of [true, false]) {
						await page.evaluate(({ size, horizontal, longLines }) => {
							const editor = window.ashTextModelIntegration.getControl();
							editor.getModel()!.setLanguage('plaintext');
							editor.updateOptions({ lineHeight: 20, wordWrap: 'off', smoothScrolling: false, minimap: { enabled: true, size, showSlider: 'always' }, scrollbar: { horizontal, horizontalScrollbarSize: 14 }, padding: { top: 0, bottom: 0 } });
							editor.setValue(Array.from({ length: 1_200 }, () => longLines ? 'long text '.repeat(100) : 'short').join('\n'));
							editor.setScrollTop(0);
						}, { size, horizontal, longLines });
						const slider = page.locator('.stanza-editor-minimap-slider');
						const thumb = page.locator('.ash-scrollbar-track-vertical .ash-scrollbar-thumb');
						await expect.poll(async () => (await slider.boundingBox())!.y - (await thumb.boundingBox())!.y).toBeCloseTo(0, 1);
						await page.evaluate(() => window.ashTextModelIntegration.getControl().setScrollTop(1_000_000));
						await expect.poll(async () => {
							const bar = (await thumb.boundingBox())!;
							const track = (await page.locator('.ash-scrollbar-track-vertical').boundingBox())!;
							return bar.y + bar.height - track.y - track.height;
						}).toBeCloseTo(0, 1);
						await expect.poll(async () => {
							const map = (await slider.boundingBox())!;
							const bar = (await thumb.boundingBox())!;
							return map.y + map.height - bar.y - bar.height;
						}).toBeCloseTo(0, 1);
						// Dragging from the minimap uses the inverse of the same coordinate map.
						const box = (await slider.boundingBox())!;
						const root = (await page.locator('.minimap').boundingBox())!;
						await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
						await page.mouse.down();
						await page.mouse.move(box.x + box.width / 2, root.y - box.height);
						await page.mouse.up();
						await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getScrollTop())).toBe(0);
					}
				}
			} finally {
				await page.evaluate(() => window.ashTextModelIntegration?.dispose());
				await context.close();
			}
		});
	}
}

test('large-file minimap samples one source row per raster row and isolates long text', async ({ page }) => {
	await openEditor(page);
	const result = await page.evaluate(async () => {
		const editor = window.ashTextModelIntegration.getControl();
		const model = editor.getModel()!;
		model.setLanguage('plaintext');
		editor.updateOptions({ wordWrap: 'off', minimap: { enabled: true, size: 'fit' }, padding: { top: 0, bottom: 0 } });
		const original = model.tokenization.getLineTokens;
		const root = document.querySelector<HTMLElement>('.stanza-editor')!;
		const minimap = root.querySelector<HTMLElement>('.minimap')!;
		const canvas = minimap.querySelector('canvas')!;
		const painter = canvas.getContext('2d')!;
		const clear = painter.clearRect;
		const put = painter.putImageData;
		const readsPerPaint: number[] = [];
		let reads = 0;
		model.tokenization.getLineTokens = function (lineNumber) { reads++; return original.call(this, lineNumber); };
		painter.clearRect = function (...args) { reads = 0; clear.apply(this, args); };
		painter.putImageData = function (data, x, y) { readsPerPaint.push(reads); Reflect.apply(put, this, [data, x, y]); };
		try {
			editor.setValue(Array.from({ length: 20_000 }, (_, index) => `${index} ${'long text '.repeat(50)}`).join('\n'));
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			return { readsPerPaint, height: canvas.height, minimapBackground: getComputedStyle(minimap).backgroundColor, editorBackground: getComputedStyle(root).backgroundColor, overflow: getComputedStyle(minimap).overflow };
		} finally {
			model.tokenization.getLineTokens = original;
			painter.clearRect = clear;
			painter.putImageData = put;
		}
	});
	expect(result.readsPerPaint.length).toBeGreaterThan(0);
	expect(Math.max(...result.readsPerPaint)).toBeLessThanOrEqual(result.height);
	expect(result.minimapBackground).toBe(result.editorBackground);
	expect(result.overflow).toBe('hidden');
});

for (const renderCharacters of [true, false]) {
	test(`minimap preserves spaces, tabs and wide-character columns with renderCharacters=${renderCharacters}`, async ({ page }) => {
		await openEditor(page);
		await page.evaluate(renderCharacters => {
			const editor = window.ashTextModelIntegration.getControl();
			editor.getModel()!.setLanguage('plaintext');
			editor.updateOptions({ wordWrap: 'off', padding: { top: 0, bottom: 0 }, minimap: { enabled: true, scale: 4, renderCharacters } });
			editor.getModel()!.updateOptions({ tabSize: 4 });
			editor.setValue('i i\ni\ti\ni   i\n中i\n');
		}, renderCharacters);
		await expect.poll(() => page.locator('.minimap canvas').evaluate(element => {
			const canvas = element as HTMLCanvasElement;
			const layout = window.ashTextModelIntegration.getControl().getLayoutInfo().minimap;
			const rows = [];
			for (let row = 0; row < 5; row++) {
				const data = canvas.getContext('2d')!.getImageData(0, row * layout.minimapLineHeight, canvas.width, layout.minimapLineHeight).data;
				const columns = [];
				for (let x = 0; x < canvas.width; x += layout.minimapScale) {
					if (Array.from({ length: layout.minimapLineHeight }, (_, y) => data[(y * canvas.width + x) * 4 + 3]).some(alpha => alpha > 0)) {
						columns.push(x / layout.minimapScale);
					}
				}
				rows.push(columns);
			}
			return rows;
		})).toEqual([[0, 2], [0, 4], [0, 4], [0, 1, 2], []]);
	});
}

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", error => errors.push(error.stack ?? error.message));
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => {
		window.ashTextModelIntegration?.dispose();
	}).catch(() => undefined);
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

test("text-model editor public API, pane, undo, save, and browser worker", async ({ page }) => {
	const workers: string[] = [];
	page.on("worker", worker => workers.push(worker.url()));
	await openEditor(page);
	await expect(page.locator(".stanza-editor")).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.apiText)).toBe("editor-api");

	const input = page.locator(".stanza-editor-input");
	await input.focus();
	await page.keyboard.press("Control+Home");
	const caret = page.locator('.stanza-editor-caret.primary');
	await expect(caret).toHaveClass(/cursor-style-line/u);
	await page.keyboard.press('Insert');
	await expect(caret).toHaveClass(/cursor-style-block/u);
	await expect(caret).toHaveClass(/token-keyword/u);
	await expect(caret).toHaveText('f');
	await page.keyboard.press('Insert');
	await expect(caret).toHaveClass(/cursor-style-line/u);
	await page.keyboard.type("integrated");
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe("integratedfn main() {\n  answer();\n}\n");

	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe("fn main() {\n  answer();\n}\n");
	await page.evaluate(() => window.ashTextModelIntegration.save());
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSavedText())).toBe("fn main() {\n  answer();\n}\n");
	await expect.poll(() => workers.length).toBeGreaterThan(0);
});

for (const theme of ['light', 'dark', 'contrast', 'contrastLight'] as const) {
	test(`dragged selection backgrounds stay behind readable text in ${theme}`, async ({ page }) => {
		await openEditor(page);
		await page.evaluate(theme => {
			window.ashTextModelIntegration.setTheme(theme);
			const editor = window.ashTextModelIntegration.getControl();
			editor.updateOptions({ fontFamily: 'monospace', wordWrap: 'off', cursorBlinking: 'solid' });
			editor.setValue('session rename > selected content');
		}, theme);
		const line = page.locator('.view-lines .stanza-editor-line-text').first();
		await expect(line).toHaveText('session rename > selected content');
		const points = await line.evaluate(element => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			const nodes: Text[] = [];
			while (walker.nextNode()) nodes.push(walker.currentNode as Text);
			return [17, 33].map(offset => {
				const range = document.createRange();
				let remaining = offset;
				const node = nodes.find(node => {
					if (remaining <= node.length) return true;
					remaining -= node.length;
					return false;
				});
				if (!node) throw new Error(`Rendered line has no position at offset ${offset}`);
				range.setStart(node, remaining);
				range.collapse(true);
				const rect = range.getBoundingClientRect();
				return { x: rect.left - 0.25, y: rect.top + rect.height / 2 };
			});
		});
		await page.mouse.move(points[0]!.x, points[0]!.y);
		await page.mouse.down();
		await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 8 });
		await page.mouse.up();
		await expect.poll(() => page.evaluate(() => {
			const editor = window.ashTextModelIntegration.getControl();
			return editor.getModel()!.getValueInRange(editor.getSelection()!);
		})).toBe('selected content');
		const selection = page.locator('.stanza-editor-selection');
		await expect(selection).toHaveCount(1);
		for (const focused of [true, false]) {
			if (!focused) {
				await page.locator('.stanza-editor-input').evaluate(element => (element as HTMLElement).blur());
			}
			await expect(page.locator('.view-overlays')).toHaveClass(focused ? /focused/u : /^(?!.*focused)/u);
			await expect.poll(() => selection.evaluate((element, focused) => {
				const rect = element.getBoundingClientRect();
				const pointerEvents = (element as HTMLElement).style.pointerEvents;
				// Include the non-interactive background in the browser's paint-order hit test.
				(element as HTMLElement).style.pointerEvents = 'auto';
				try {
					const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
					const textIndex = stack.findIndex(node => node.closest('.view-lines'));
					const backgroundIndex = stack.indexOf(element);
					const root = element.closest('.stanza-editor')!;
					const backgroundToken = focused ? '--ash-editor-selection-background' : '--ash-editor-inactive-selection-background';
					return {
						textAboveBackground: textIndex >= 0 && backgroundIndex > textIndex,
						hasBackground: getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)',
						hasThemeColor: getComputedStyle(root).getPropertyValue(backgroundToken).trim().length > 0,
					};
				} finally {
					(element as HTMLElement).style.pointerEvents = pointerEvents;
				}
			}, focused)).toEqual({ textAboveBackground: true, hasBackground: true, hasThemeColor: true });
		}
	});
}

test('selection foreground applies only to selected characters and clears when selections or themes change', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue('prefix selected suffix\nsecond selected line');
		window.ashTextModelIntegration.updateOptions({ wordWrap: 'wordWrapColumn', wordWrapColumn: 16, cursorBlinking: 'solid' });
	});
	for (const theme of ['light', 'dark', 'contrast', 'contrastLight'] as const) {
		await page.evaluate(theme => {
			const harness = window.ashTextModelIntegration;
			harness.setTheme(theme);
			harness.setSelectionColors({ 'editor.selectionBackground': '#123456', 'editor.inactiveSelectionBackground': '#654321', 'editor.selectionForeground': '#fedcba' });
			harness.getControl().setSelections([{ selectionStartLineNumber: 1, selectionStartColumn: 8, positionLineNumber: 2, positionColumn: 7 }]);
			harness.getControl().focus();
		}, theme);
		const selectedText = page.locator('.view-lines .stanza-editor-selected-text');
		await expect.poll(async () => (await selectedText.allTextContents()).join('')).toBe('selected suffixsecond');
		for (const span of await selectedText.all()) await expect(span).toHaveCSS('color', 'rgb(254, 220, 186)');
		await expect(page.locator('.stanza-editor-selection').first()).toHaveCSS('background-color', 'rgb(18, 52, 86)');
		await page.locator('.stanza-editor-input').blur();
		await expect(page.locator('.stanza-editor-selection').first()).toHaveCSS('background-color', 'rgb(101, 67, 33)');
		await expect(selectedText.first()).toHaveCSS('color', 'rgb(254, 220, 186)');
		await page.evaluate(() => window.ashTextModelIntegration.getControl().setPosition({ lineNumber: 1, column: 1 }));
		await expect(selectedText).toHaveCount(0);
	}
	await page.evaluate(() => {
		window.ashTextModelIntegration.setTheme('light');
		window.ashTextModelIntegration.getControl().setSelection({ startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 16 });
	});
	await expect(page.locator('.stanza-editor-selection').first()).toBeVisible();
	await expect(page.locator('.view-lines .stanza-editor-selected-text')).toHaveCount(0);
});

for (const theme of ['light', 'dark', 'contrast', 'contrastLight'] as const) {
	test(`Chinese drag selection keeps character boundaries stable in ${theme}`, async ({ page }) => {
		await openEditor(page);
		const text = '是否带个电饭锅电饭锅的方法蛋糕';
		await page.evaluate(({ text, theme }) => {
			const harness = window.ashTextModelIntegration;
			harness.setTheme(theme);
			const editor = harness.getControl();
			editor.getModel()!.setLanguage('plaintext');
			editor.updateOptions({ fontSize: 13, wordWrap: 'off', cursorBlinking: 'solid' });
			editor.setValue(text);
		}, { text, theme });
		const line = page.locator('.view-lines .stanza-editor-line-text').first();
		await expect(line).toHaveText(text);
		const points = await line.evaluate(element => {
			const node = element.firstChild!.firstChild!;
			return [0, 3, 8, 12].map(offset => {
				const range = document.createRange();
				range.setStart(node, offset);
				range.setEnd(node, offset + 1);
				const rect = range.getBoundingClientRect();
				return { x: rect.left + rect.width / 2 + 0.25, y: rect.top + rect.height / 2, width: rect.width };
			});
		});
		for (const point of points) {
			await page.mouse.move(point.x, point.y);
			await page.mouse.down();
			const anchor = await page.evaluate(() => window.ashTextModelIntegration.getControl().getPosition());
			try {
				for (const distance of [0, point.width, 0]) {
					// Pointer capture changes the event target; tiny vertical motion must not change the column.
					await page.mouse.move(point.x + distance, point.y + 0.05);
					const expected = { lineNumber: 1, column: anchor!.column + (distance === 0 ? 0 : 1) };
					expect(await page.evaluate(() => window.ashTextModelIntegration.getControl().getPosition())).toEqual(expected);
					await expect(page.locator('.stanza-editor-selection')).toHaveCount(distance === 0 ? 0 : 1);
					await expect(page.locator('.stanza-editor-input')).toBeFocused();
				}
			} finally {
				await page.mouse.up();
			}
			expect(await page.evaluate(() => window.ashTextModelIntegration.getControl().getPosition())).toEqual(anchor);
			await expect(page.locator('.stanza-editor-selection')).toHaveCount(0);
		}
	});
}

for (const proportional of [false, true]) {
	test(`pointer insertion and caret share rendered text coordinates with proportional=${proportional}`, async ({ page }) => {
		await openEditor(page);
		const text = '\tmode switcher > radiogroup 中文🙂';
		await page.evaluate(({ text, proportional }) => {
			const editor = window.ashTextModelIntegration.getControl();
			editor.updateOptions({
				fontFamily: proportional ? 'Arial' : 'monospace',
				fontSize: proportional ? 18 : 16,
				letterSpacing: proportional ? 1 : 0,
				lineNumbers: proportional ? 'on' : 'off',
				lineNumbersMinChars: 8,
				glyphMargin: proportional,
				cursorStyle: proportional ? 'block' : 'line',
				wordWrap: 'off',
				smoothScrolling: false,
			});
			editor.setValue(`fn main() {}\n${text}\n${'wide '.repeat(100)}`);
			editor.setScrollLeft(40);
			if (proportional) {
				editor.getDomNode().style.transform = 'scale(1.25)';
				editor.getDomNode().style.transformOrigin = 'top left';
			}
		}, { text, proportional });
		const line = page.locator('.view-lines > .view-line .stanza-editor-line-text').nth(1);
		await expect(line).toHaveText(text);
		for (const offset of [text.length, 24, 18]) {
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
						return { x: rect.left - 0.5, y: rect.top + rect.height / 2 };
					}
					remaining -= length;
				}
				throw new Error(`Missing rendered offset ${offset}`);
			}, offset);
			await page.mouse.click(point.x, point.y);
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getPosition())).toEqual({ lineNumber: 2, column: offset + 1 });
			await expect.poll(async () => {
				const caret = await page.locator('.stanza-editor-caret.primary').boundingBox();
				return caret ? Math.abs(caret.x - point.x) : Number.POSITIVE_INFINITY;
			}).toBeLessThan(3);
			await expect(page.locator('.stanza-editor-input')).toBeFocused();
			await page.keyboard.insertText('!');
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getModel()!.getLineContent(2))).toBe(`${text.slice(0, offset)}!${text.slice(offset)}`);
			await page.keyboard.press('Backspace');
			await expect(line).toHaveText(text);
		}
	});

	test(`selection state, highlight, and active caret agree for pointer and keyboard with proportional=${proportional}`, async ({ page }) => {
		await openEditor(page);
		const text = '\tmode switcher > radiogroup 中文🙂';
		await page.evaluate(({ text, proportional }) => {
			const editor = window.ashTextModelIntegration.getControl();
			editor.updateOptions({
				fontFamily: proportional ? 'Arial' : 'monospace',
				fontSize: 18,
				letterSpacing: proportional ? 1 : 0,
				lineNumbers: 'on',
				lineNumbersMinChars: 8,
				glyphMargin: true,
				wordWrap: 'off',
				smoothScrolling: false,
				cursorBlinking: 'solid',
			});
			editor.setValue(`${text}\n${'wide '.repeat(100)}`);
			editor.setScrollLeft(40);
			if (proportional) {
				editor.getDomNode().style.transform = 'scale(1.25)';
				editor.getDomNode().style.transformOrigin = 'top left';
			}
		}, { text, proportional });
		const line = page.locator('.view-lines > .view-line .stanza-editor-line-text').first();
		await expect(line).toHaveText(text);
		const points = await line.evaluate(element => [18, 24].map(offset => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			let remaining = offset;
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const length = node.textContent!.length;
				if (remaining <= length) {
					const range = document.createRange();
					range.setStart(node, remaining);
					range.collapse(true);
					const rect = range.getBoundingClientRect();
					const row = element.closest('.view-line')!.getBoundingClientRect();
					return { x: rect.left, y: rect.top + rect.height / 2, top: row.top, height: row.height };
				}
				remaining -= length;
			}
			throw new Error(`Missing rendered offset ${offset}`);
		}));
		for (const gesture of ['forward', 'backward', 'keyboard'] as const) {
			const anchor = gesture === 'backward' ? 1 : 0;
			const active = 1 - anchor;
			await page.mouse.move(points[anchor]!.x - 0.25, points[anchor]!.y);
			await page.mouse.down();
			if (gesture !== 'keyboard') {
				await page.mouse.move(points[active]!.x - 0.25, points[active]!.y, { steps: 8 });
			}
			await page.mouse.up();
			if (gesture === 'keyboard') {
				for (let i = 0; i < 6; i += 1) {
					await page.keyboard.press('Shift+ArrowRight');
				}
			}
			await expect.poll(() => page.evaluate(() => {
				const editor = window.ashTextModelIntegration.getControl();
				const selection = editor.getSelection()!;
				return {
					anchor: { lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn },
					active: editor.getPosition(),
					text: editor.getModel()!.getValueInRange(selection),
				};
			})).toEqual({ anchor: { lineNumber: 1, column: anchor === 0 ? 19 : 25 }, active: { lineNumber: 1, column: active === 0 ? 19 : 25 }, text: text.slice(18, 24) });
			await expect(page.locator('.stanza-editor-selection')).toHaveCount(1);
			await expect.poll(async () => {
				const selection = await page.locator('.stanza-editor-selection').boundingBox();
				const caret = await page.locator('.stanza-editor-caret.primary').boundingBox();
				if (!selection || !caret) return Number.POSITIVE_INFINITY;
				return Math.max(
					Math.abs(selection.x - points[0]!.x),
					Math.abs(selection.width - (points[1]!.x - points[0]!.x)),
					Math.abs(selection.y - points[0]!.top),
					Math.abs(selection.height - points[0]!.height),
					Math.abs(caret.x - points[active]!.x),
					Math.abs(caret.y - points[active]!.top),
				);
			}).toBeLessThan(2);
			await page.keyboard.insertText('!');
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getModel()!.getLineContent(1))).toBe(`${text.slice(0, 18)}!${text.slice(24)}`);
			await page.keyboard.press('ControlOrMeta+z');
			await expect(line).toHaveText(text);
		}
	});
}

test('dragging across wrapped rows selects exact model columns in both directions', async ({ page }) => {
	await openEditor(page);
	const text = '0123456789'.repeat(8);
	await page.evaluate(text => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.updateOptions({ fontFamily: 'monospace', fontSize: 16, lineNumbers: 'on', glyphMargin: true, wordWrap: 'wordWrapColumn', wordWrapColumn: 20, cursorBlinking: 'solid' });
		editor.setValue(text);
	}, text);
	await expect.poll(() => page.locator('.view-lines > .view-line').count()).toBeGreaterThan(2);
	const rows = await page.locator('.view-lines > .view-line').evaluateAll(elements => elements.slice(0, 3).map((row, index) => {
		const text = row.querySelector('.stanza-editor-line-text')!;
		const node = text.firstChild!.firstChild!;
		const length = text.textContent!.length;
		const start = index === 0 ? 3 : 0;
		const end = index === 2 ? 7 : length;
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, end);
		const selected = range.getBoundingClientRect();
		const bounds = row.getBoundingClientRect();
		return { length, x: selected.left, width: selected.width, y: bounds.top, height: bounds.height };
	}));
	const endOffset = rows[0]!.length + rows[1]!.length + 7;
	const points = [
		{ x: rows[0]!.x - 0.25, y: rows[0]!.y + rows[0]!.height / 2 },
		{ x: rows[2]!.x + rows[2]!.width - 0.25, y: rows[2]!.y + rows[2]!.height / 2 },
	];
	for (const backward of [false, true]) {
		const anchor = backward ? 1 : 0;
		const active = 1 - anchor;
		await page.mouse.move(points[anchor]!.x, points[anchor]!.y);
		await page.mouse.down();
		await page.mouse.move(points[active]!.x, points[active]!.y, { steps: 8 });
		await page.mouse.up();
		await expect.poll(() => page.evaluate(() => {
			const editor = window.ashTextModelIntegration.getControl();
			const selection = editor.getSelection()!;
			return { anchor: selection.selectionStartColumn, active: editor.getPosition(), text: editor.getModel()!.getValueInRange(selection) };
		})).toEqual({ anchor: backward ? endOffset + 1 : 4, active: { lineNumber: 1, column: backward ? 4 : endOffset + 1 }, text: text.slice(3, endOffset) });
		await expect(page.locator('.stanza-editor-selection')).toHaveCount(3);
		await expect.poll(() => page.locator('.stanza-editor-selection').evaluateAll((elements, rows) => Math.max(...elements.flatMap((element, index) => {
			const bounds = element.getBoundingClientRect();
			const expected = rows[index]!;
			return [Math.abs(bounds.x - expected.x), Math.abs(bounds.y - expected.y), Math.abs(bounds.width - expected.width), Math.abs(bounds.height - expected.height)];
		})), rows)).toBeLessThan(2);
		await expect.poll(async () => {
			const caret = await page.locator('.stanza-editor-caret.primary').boundingBox();
			return caret ? Math.max(Math.abs(caret.x - points[active]!.x), Math.abs(caret.y - (backward ? rows[0]!.y : rows[2]!.y))) : Number.POSITIVE_INFINITY;
		}).toBeLessThan(2);
		await page.keyboard.insertText('!');
		await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(`${text.slice(0, 3)}!${text.slice(endOffset)}`);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(text);
	}
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.setValue('0123456789'.repeat(100));
		editor.setPosition({ lineNumber: 1, column: 1 });
		editor.setScrollTop(0);
	});
	await page.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+End');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getPosition())).toEqual({ lineNumber: 1, column: 1001 });
	await expect.poll(() => page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		const bounds = editor.getDomNode().getBoundingClientRect();
		const caret = editor.getDomNode().querySelector('.stanza-editor-caret.primary')!.getBoundingClientRect();
		return editor.getScrollTop() > 0 && caret.top >= bounds.top && caret.bottom <= bounds.bottom;
	})).toBe(true);
});

test('common editor navigation uses wrapped and folded coordinates and retains keyboard focus', async ({ page }) => {
	await openEditor(page);
	const result = await page.evaluate((scrollType: ScrollType) => {
		const widget = window.ashTextModelIntegration.getControl();
		const editor: IEditor = widget;
		widget.setValue(['long '.repeat(100), ...Array.from({ length: 79 }, (_, index) => `row ${index + 2}`)].join('\n'));
		editor.updateOptions({ wordWrap: 'wordWrapColumn', wordWrapColumn: 20, smoothScrolling: false });
		widget.setHiddenAreas([widget.getModel()!.validateRange({ startLineNumber: 2, startColumn: 1, endLineNumber: 10, endColumn: 1 })]);
		editor.setPosition({ lineNumber: 3, column: 2 });
		editor.revealPositionInCenter({ lineNumber: 40, column: 2 }, scrollType);
		widget.view.render(true, false);
		const top = widget.getScrollTop();
		const caretTop = widget.getTopForLineNumber(40) - top;
		const height = widget.getLayoutInfo().height;
		editor.revealRangeInCenterIfOutsideViewport({ startLineNumber: 40, startColumn: 1, endLineNumber: 40, endColumn: 3 }, scrollType);
		const unchangedTop = widget.getScrollTop();
		editor.revealRangeAtTop({ startLineNumber: 40, startColumn: 1, endLineNumber: 40, endColumn: 3 }, scrollType);
		return { top, caretTop, height, unchangedTop, atTop: widget.getTopForLineNumber(40) - widget.getScrollTop(), position: editor.getPosition() };
	}, ScrollType.Immediate);
	expect(result.top).toBeGreaterThan(0);
	expect(Math.abs(result.caretTop - result.height / 2)).toBeLessThan(25);
	expect(result.unchangedTop).toBe(result.top);
	expect(result.atTop).toBe(0);
	expect(result.position).toEqual({ lineNumber: 3, column: 2 });
	await page.locator('.stanza-editor-input').focus();
	await page.evaluate((scrollType: ScrollType) => {
		const editor: IEditor = window.ashTextModelIntegration.getControl();
		editor.onHide();
		editor.onVisible();
		editor.setPosition({ lineNumber: 40, column: 2 });
		editor.revealLineInCenter(40, scrollType);
	}, ScrollType.Immediate);
	await expect(page.locator('.stanza-editor-input')).toBeFocused();
	await page.keyboard.type('!');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getModel()?.getLineContent(40))).toBe('r!ow 40');
});

test('switching a Workbench file keeps keyboard input on the new editor and releases the old one', async ({ page }) => {
	await openEditor(page);
	await page.locator('.stanza-editor-input').focus();
	const switched = await page.evaluate(() => window.ashTextModelIntegration.switchToOther());

	expect(switched).toEqual({
		paneOwnsEditor: true,
		oldEditorDisposed: true,
		oldModelDisposed: true,
		oldDomConnected: false,
		editorCount: 1,
		value: 'fn other() {\n  answer();\n}\n',
	});
	await expect(page.locator('.stanza-editor')).toHaveCount(1);
	await expect(page.locator('.stanza-editor')).toHaveAttribute('aria-label', 'other.ts');
	await expect(page.locator('.stanza-editor-input')).toBeFocused();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('!');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('fn other() {\n  answer();\n}\n!');
});

test('Code bundle activates text editor contributions and releases their UI', async ({ page }) => {
	await openEditor(page);
	const ids = await page.evaluate(() => window.ashTextModelIntegration.getBundleIds());
	expect(ids).toContain('editor.contrib.clipboard');
	expect(await page.evaluate(() => window.ashTextModelIntegration.hasClipboardContribution())).toBe(true);
	expect(ids).toContain('editor.contrib.findController');
	expect(ids).not.toContain('editor.contrib.documentFormatting');
	expect(ids).not.toContain('editor.contrib.collaboration');
	expect(await page.evaluate(() => window.ashTextModelIntegration.hasPlaceholderContribution())).toBe(true);
	await expect(page.locator('.stanza-editor')).toBeVisible();
	await expect(page.locator('.stanza-structured-format-toolbar')).toHaveCount(0);
	const find = page.locator('.stanza-editor-find-widget');
	await expect(find).toHaveAttribute('role', 'dialog');
	await page.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+f');
	await expect(find).toBeVisible();
	await find.locator('input[aria-label="Find"]').fill('fn');
	await page.keyboard.press('Escape');
	await expect(find).toBeHidden();

	await page.evaluate(() => window.ashTextModelIntegration.dispose());
	await expect(page.locator('.stanza-editor')).toHaveCount(0);
	await expect(find).toHaveCount(0);
});

test('textarea fallback routes type and composition through the standard input pipeline', async ({ page }) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, 'EditContext');
	});
	await openEditor(page);
	const editor = page.locator('.stanza-editor');
	const input = page.locator('textarea.stanza-editor-input');
	await input.focus();
	await expect(input).toHaveCSS('position', 'absolute');
	await expect(input).toHaveCSS('opacity', '0');
	await expect(input).toHaveCSS('width', '1px');
	await page.evaluate(() => window.ashTextModelIntegration.setCursors([{ lineIndex: 0, columnIndex: 0 }]));
	await page.keyboard.type('x');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^xfn main/u);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^fn main/u);

	await input.evaluate(element => {
		element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
	});
	await expect(editor).toHaveClass(/\bcomposing\b/u);
	await expect(input).toHaveCSS('opacity', '1');
	await expect(input).toBeFocused();
	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.value = 'xy';
		textArea.setSelectionRange(1, 1);
		textArea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'xy' }));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^xyfn main/u);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 1,
	});
	await input.evaluate(element => {
		element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'xy' }));
	});
	await expect(editor).not.toHaveClass(/\bcomposing\b/u);
	await expect(input).toHaveCSS('opacity', '0');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^fn main/u);
});

test("cursor layer retains nodes, animates stable moves, and resolves multi-cursor colors", async ({ page }) => {
	await openEditor(page);
	await expect(page.locator(".stanza-editor")).toBeVisible();
	await expect(page.locator(".stanza-editor-token.token-keyword")).toHaveText("fn");
	const editor = page.locator(".stanza-editor");
	const layer = editor.locator(".stanza-editor-cursors-layer");
	const retainedCaret = layer.locator('.stanza-editor-caret[data-selection-index="0"]');
	await expect(layer).toHaveClass(/cursor-smooth-caret-animation/u);
	await retainedCaret.evaluate(element => { element.dataset.retainedIdentity = "true"; });
	const lineHeight = await editor.locator('.view-line').first().evaluate(element => element.getBoundingClientRect().height);

	await page.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ArrowDown');
	const stableMove = await retainedCaret.evaluate(element => {
		const caret = element as HTMLElement;
		return { top: caret.style.top, transitionProperty: caret.style.transitionProperty };
	});
	expect(stableMove).toEqual({ top: `${lineHeight}px`, transitionProperty: "" });
	await expect(retainedCaret).toHaveAttribute("data-retained-identity", "true");

	await editor.evaluate(element => {
		element.style.setProperty("--ash-editor-multi-cursor-primary-foreground", "#010203");
		element.style.setProperty("--ash-editor-multi-cursor-secondary-foreground", "#040506");
	});
	const countChangeTransitions = await page.evaluate(() => {
		window.ashTextModelIntegration.setCursors([
			{ lineIndex: 0, columnIndex: 0 },
			{ lineIndex: 1, columnIndex: 2 },
		], 1);
		return [...document.querySelectorAll<HTMLElement>(".stanza-editor-caret")]
			.map(caret => caret.style.transitionProperty);
	});
	expect(countChangeTransitions).toEqual(["none", "none"]);
	const primary = layer.locator(".stanza-editor-caret.cursor-primary");
	const secondary = layer.locator(".stanza-editor-caret.cursor-secondary");
	await expect(primary).toHaveCount(1);
	await expect(secondary).toHaveCount(1);
	await expect(primary).toHaveCSS("background-color", "rgb(1, 2, 3)");
	await expect(secondary).toHaveCSS("background-color", "rgb(4, 5, 6)");

	await page.locator(".stanza-editor-input").focus();
	await page.keyboard.press("Insert");
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue("fn main() {\n  A👩‍🔧B answer();\n}\n");
		window.ashTextModelIntegration.setCursors([{ lineIndex: 1, columnIndex: 4 }]);
	});
	await expect(retainedCaret).toHaveText("👩‍🔧");
	await page.keyboard.press("Insert");

	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 60 }, (_, index) => `fn main() { answer(); } // ${index}`).join("\n"));
		window.ashTextModelIntegration.setCursors([{ lineIndex: 59, columnIndex: 0 }]);
	});
	await expect(retainedCaret).toHaveAttribute("data-retained-identity", "true");
	await expect(retainedCaret).toHaveCSS("display", "none");
	await page.evaluate(() => window.ashTextModelIntegration.revealPosition(59, 0));
	await expect(retainedCaret).toHaveCSS("display", "block");
	await expect(retainedCaret).toHaveAttribute("data-retained-identity", "true");
});

test("text-model editor supports Rust syntax and symbol navigation without gutter symbol icons", async ({ page }) => {
	await openEditor(page);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSyntaxAnalysisCount())).toBeGreaterThan(0);
	await expect(page.locator(".stanza-editor-token.token-keyword")).toHaveText("fn");
	await expect(page.locator(".cdr.squiggly-error")).toHaveCount(1);
	await expect(page.locator(".stanza-editor-symbol-icon")).toHaveCount(0);

	const input = page.locator(".stanza-editor-input");
	await input.focus();
	await page.keyboard.press("ControlOrMeta+Shift+o");
	const symbol = page.locator('.ash-quick-pick-row-label');
	await expect(symbol).toHaveText('main');
	await page.keyboard.press('Enter');
	await expect(symbol).toHaveCount(0);
	await expect(input).toBeFocused();
	expect(await page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 3,
		endLineIndex: 0,
		endColumnIndex: 7,
	});
});

test("short documents have no false scroll range and use a proportional hover slider", async ({ page }) => {
	await openEditor(page);
	await expect(page.locator(".stanza-editor")).toBeVisible();
	const geometry = await page.locator(".stanza-editor").evaluate(editor => {
		const scrollDomNode = editor.querySelector<HTMLElement>(':scope > .ash-smooth-scrollable')!;
		const minimap = editor.querySelector<HTMLElement>(".minimap");
		const slider = editor.querySelector<HTMLElement>(".stanza-editor-minimap-slider");
		if (!minimap || !slider) throw new Error("Missing minimap geometry");
		return {
			clientHeight: editor.clientHeight,
			scrollHeight: scrollDomNode.scrollHeight,
			scrollTop: scrollDomNode.scrollTop,
			sliderHidden: slider.hidden,
			sliderHeight: slider.getBoundingClientRect().height,
			minimapHeight: minimap.getBoundingClientRect().height,
		};
	});

	expect(geometry.scrollHeight).toBe(geometry.clientHeight);
	expect(geometry.scrollTop).toBe(0);
	expect(geometry.sliderHidden).toBe(false);
	expect(geometry.sliderHeight).toBeLessThan(geometry.minimapHeight);
	const minimap = page.locator('.minimap');
	const slider = page.locator('.stanza-editor-minimap-slider');
	await page.locator('.stanza-editor').evaluate(element => {
		element.style.setProperty('--ash-minimap-slider-background', '#010203');
		element.style.setProperty('--ash-minimap-slider-hover-background', '#040506');
		element.style.setProperty('--ash-minimap-slider-active-background', '#070809');
	});
	await expect(slider).toHaveCSS('opacity', '0');
	await expect(slider).toHaveCSS('background-color', 'rgb(1, 2, 3)');
	await minimap.hover();
	await expect(slider).toHaveCSS('opacity', '1');
	await expect(slider).toHaveCSS('background-color', 'rgb(4, 5, 6)');

	await page.evaluate(() => window.ashTextModelIntegration.setValue(`fn main() {\n  answer();\n}\n${Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')}`));
	const editor = page.locator('.stanza-editor');
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollHeight)).toBeGreaterThan(geometry.clientHeight);
	const sliderBox = await slider.boundingBox();
	const minimapBox = await minimap.boundingBox();
	assertBox(sliderBox, 'minimap slider');
	assertBox(minimapBox, 'minimap');
	await page.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2);
	await page.mouse.down();
	await expect(minimap).toHaveClass(/stanza-editor-minimap-dragging/u);
	await expect(slider).toHaveCSS('background-color', 'rgb(7, 8, 9)');
	await page.mouse.move(sliderBox.x + sliderBox.width / 2, minimapBox.y + minimapBox.height / 2, { steps: 5 });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect.poll(() => slider.evaluate(element => Number.parseFloat(getComputedStyle(element).top))).toBeGreaterThan(0);
	await page.mouse.move(sliderBox.x + sliderBox.width / 2, minimapBox.y + minimapBox.height - 1, { steps: 5 });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop === element.scrollHeight - element.clientHeight)).toBe(true);
	await page.mouse.up();
	await expect(minimap).not.toHaveClass(/stanza-editor-minimap-dragging/u);
});

test('editor auto scrollbars reveal on hover, focus and scrolling and remain draggable', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n')));
	const editor = page.locator('.stanza-editor');
	const horizontal = editor.getByRole('scrollbar', { name: 'Horizontal scrollbar' });
	const vertical = editor.getByRole('scrollbar', { name: 'Vertical scrollbar' });
	await page.mouse.move(0, 0);
	await expect(vertical).toHaveCSS('opacity', '0');
	await editor.hover();
	for (const track of [horizontal, vertical]) {
		await expect(track).toHaveCSS('opacity', '1');
		await expect(track).toHaveCSS('pointer-events', 'auto');
	}
	await page.mouse.move(0, 0);
	await expect(vertical).toHaveCSS('opacity', '0');
	await vertical.focus();
	await expect(vertical).toHaveCSS('opacity', '1');
	await vertical.press('ArrowDown');
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(40);
	await expect(vertical).toHaveAttribute('aria-valuenow', '40');
	await vertical.evaluate(element => element.blur());
	await expect(vertical).toHaveCSS('opacity', '0');
	await page.evaluate(() => window.ashTextModelIntegration.setScrollLeft(160));
	await expect(horizontal).toHaveCSS('opacity', '1');
	await expect(horizontal).toHaveAttribute('aria-valuenow', '160');
	await editor.hover();
	const thumb = vertical.locator('.ash-scrollbar-thumb');
	const box = await thumb.boundingBox();
	assertBox(box, 'vertical scrollbar thumb');
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 5 });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(40);
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollLeft)).toBe(160);
	await page.mouse.up();
	const remainingTracks = await editor.evaluate(element => {
		window.ashTextModelIntegration.setScrollLeft(200);
		window.ashTextModelIntegration.dispose();
		return element.querySelectorAll('[role="scrollbar"]').length;
	});
	expect(remainingTracks).toBe(0);
});

test('editor vertical scrollbar has an opaque overview background with and without the minimap', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.setValue(Array.from({ length: 100 }, () => 'long text '.repeat(100)).join('\n'));
		editor.updateOptions({ overviewRulerBorder: false, hideCursorInOverviewRuler: true });
	});
	const overview = page.locator('.decorationsOverviewRuler');
	for (const theme of ['dark', 'light', 'contrast', 'contrastLight'] as const) {
		await page.evaluate(theme => window.ashTextModelIntegration.setTheme(theme), theme);
		for (const side of ['disabled', 'left', 'right'] as const) {
			await page.evaluate(side => window.ashTextModelIntegration.getControl().updateOptions({
				minimap: { enabled: side !== 'disabled', side: side === 'left' ? 'left' : 'right' },
			}), side);
			await expect.poll(() => overview.evaluate((canvas: HTMLCanvasElement) => {
				const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
				const probe = document.createElement('canvas').getContext('2d')!;
				probe.fillStyle = getComputedStyle(canvas.closest('.stanza-editor')!).backgroundColor;
				probe.fillRect(0, 0, 1, 1);
				const background = probe.getImageData(0, 0, 1, 1).data;
				const sample = canvas.getContext('2d')!.getImageData(2, Math.floor(canvas.height / 2), 1, 1).data;
				return {
					matchesEditor: sample.every((value, index) => value === background[index]),
					opaque: pixels.length > 0 && pixels.every((value, index) => index % 4 !== 3 || value === 255),
				};
			}), { message: `opaque scrollbar background for ${theme}, minimap=${side}` }).toEqual({
				matchesEditor: true,
				opaque: true,
			});
		}
	}
	await page.evaluate(() => window.ashTextModelIntegration.setSelectionColors({ 'editorOverviewRuler.background': '#123456' }));
	await expect.poll(() => overview.evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(2, 2, 1, 1).data))).toEqual([18, 52, 86, 255]);
});

test('editor scrollbar track colors follow theme overrides in all color schemes', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'long text '.repeat(100)).join('\n'));
		window.ashTextModelIntegration.setScrollbar({ horizontal: 'visible', vertical: 'visible' });
	});
	const tracks = page.locator('.stanza-editor .ash-scrollbar-track');
	await expect(tracks).toHaveCount(2);
	for (const theme of ['dark', 'light', 'contrast', 'contrastLight'] as const) {
		await page.evaluate(theme => window.ashTextModelIntegration.setTheme(theme), theme);
		for (const track of await tracks.all()) {
			await expect(track).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		}
		await page.evaluate(() => window.ashTextModelIntegration.setSelectionColors({ 'scrollbar.background': '#123456' }));
		for (const track of await tracks.all()) {
			await expect(track).toHaveCSS('background-color', 'rgb(18, 52, 86)');
			await expect(track).toHaveCSS('border-radius', '0px');
		}
	}
	await page.evaluate(() => window.ashTextModelIntegration.setTheme('dark'));
	for (const track of await tracks.all()) {
		await expect(track).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}
});

test('editor scrollbar configuration updates visibility and track dimensions', async ({ page }) => {
	await openEditor(page);
	const horizontal = page.locator('.ash-smooth-scrollable > .ash-scrollbar-track-horizontal');
	const vertical = page.locator('.ash-smooth-scrollable > .ash-scrollbar-track-vertical');
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({
		horizontal: 'visible', vertical: 'visible', horizontalScrollbarSize: 18, verticalScrollbarSize: 22,
	}));
	await expect(horizontal).toBeVisible();
	await expect(vertical).toBeVisible();
	await expect(horizontal).toHaveCSS('opacity', '1');
	await expect(vertical).toHaveCSS('opacity', '1');
	await expect(horizontal).toHaveCSS('height', '18px');
	await expect(vertical).toHaveCSS('width', '22px');
	await expect(horizontal).toHaveCSS('right', '22px');
	await expect(vertical).toHaveCSS('bottom', '18px');
	await expect(vertical).toHaveAttribute('aria-disabled', 'true');
	await expect(vertical).toHaveCSS('pointer-events', 'none');
	const minimapBox = await page.locator('.minimap').boundingBox();
	const verticalBox = await vertical.boundingBox();
	assertBox(minimapBox, 'minimap');
	assertBox(verticalBox, 'vertical scrollbar');
	expect(minimapBox.x + minimapBox.width).toBeCloseTo(verticalBox.x, 0);

	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.setScrollbar({ horizontal: 'hidden', vertical: 'hidden' });
	});
	await expect(horizontal).toBeHidden();
	await expect(vertical).toBeHidden();
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ horizontal: 'auto', vertical: 'auto' }));
	await page.locator('.stanza-editor').hover();
	await expect(horizontal).toBeVisible();
	await expect(vertical).toBeVisible();
	await expect(vertical).toHaveCSS('pointer-events', 'auto');
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ horizontalScrollbarSize: 0, verticalScrollbarSize: 0 }));
	await expect(horizontal).toHaveCSS('height', '0px');
	await expect(vertical).toHaveCSS('width', '0px');
	await expect(horizontal).toBeHidden();
	await expect(vertical).toBeHidden();
	await expect(horizontal).toHaveAttribute('tabindex', '-1');
	await expect(vertical).toHaveAttribute('tabindex', '-1');
});

test('editor scrollbar uses wheel policy, slider dimensions and page clicks from configuration', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({
			mouseWheelScrollSensitivity: 2,
			fastScrollSensitivity: 3,
			scrollbar: { vertical: 'visible', horizontal: 'visible', verticalSliderSize: 6, horizontalSliderSize: 4, scrollByPage: true },
		});
	});
	const editor = page.locator('.stanza-editor');
	const horizontal = editor.getByRole('scrollbar', { name: 'Horizontal scrollbar' });
	const vertical = editor.getByRole('scrollbar', { name: 'Vertical scrollbar' });
	await expect(horizontal.locator('.ash-scrollbar-thumb')).toHaveCSS('height', '4px');
	await expect(vertical.locator('.ash-scrollbar-thumb')).toHaveCSS('width', '6px');
	await editor.dispatchEvent('wheel', { deltaY: 20, deltaMode: 0 });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(40);
	await editor.dispatchEvent('wheel', { deltaY: 10, deltaMode: 0, altKey: true });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(100);
	await editor.dispatchEvent('wheel', { deltaY: 10, deltaMode: 0, shiftKey: true });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollLeft)).toBe(20);
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ handleMouseWheel: false }));
	await editor.dispatchEvent('wheel', { deltaY: 20, deltaMode: 0 });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(100);
	const box = await vertical.boundingBox();
	assertBox(box, 'vertical scrollbar');
	await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(520);
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ scrollByPage: false }));
	await page.locator('.decorationsOverviewRuler').dispatchEvent('pointerdown', {
		button: 0, buttons: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height - 3,
	});
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(520);
});

test('smooth scrolling keeps continuous and subpixel wheel input immediate', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({ smoothScrolling: true, inertialScroll: false, scrollPredominantAxis: false });
	});
	const editor = page.locator('.stanza-editor');
	await expect(editor.getByRole('scrollbar', { name: 'Vertical scrollbar' })).toBeVisible();
	await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
	for (const [deltaY, expected] of [[12, 12], [0.2, 13], [-0.2, 12]]) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(expected);
	}
	await editor.dispatchEvent('wheel', { deltaX: 0.2, deltaY: 0.2, deltaMode: 0 });
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual({ left: 1, top: 13 });
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ mouseWheelScrollSensitivity: 0.1 }));
	await editor.dispatchEvent('wheel', { deltaY: 1, deltaMode: 0 });
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(14);
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ mouseWheelScrollSensitivity: 1 }));
	await editor.dispatchEvent('wheel', { deltaY: 5, deltaMode: 1 });
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(14);
	await page.clock.runFor(160);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(94);
});

test('editor scrollbar arrows support click, hold, keyboard and runtime removal', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.setScrollbar({
			vertical: 'visible', horizontal: 'visible', verticalHasArrows: true, horizontalHasArrows: true, arrowSize: 18,
		});
	});
	const editor = page.locator('.stanza-editor');
	const down = editor.getByRole('button', { name: 'Scroll down', exact: true });
	const up = editor.getByRole('button', { name: 'Scroll up', exact: true });
	const right = editor.getByRole('button', { name: 'Scroll right', exact: true });
	await expect(down).toHaveCSS('height', '18px');
	await expect(up).toBeDisabled();
	await down.click();
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(40);
	await right.focus();
	await page.keyboard.press('Enter');
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollLeft)).toBe(40);
	const thumb = editor.locator('.ash-scrollbar-track-vertical .ash-scrollbar-thumb');
	const upBox = await up.boundingBox();
	const thumbBox = await thumb.boundingBox();
	assertBox(upBox, 'up arrow');
	assertBox(thumbBox, 'vertical thumb');
	expect(thumbBox.y).toBeGreaterThanOrEqual(upBox.y + upBox.height);

	await down.hover();
	await page.mouse.down();
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(80);
	await page.mouse.up();
	const released = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.waitForTimeout(180);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(released);
	await page.mouse.down();
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ verticalHasArrows: false, horizontalHasArrows: false }));
	await expect(down).toBeHidden();
	const disabled = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.waitForTimeout(400);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(disabled);
	await page.mouse.up();
	await expect(editor.locator('.ash-scrollbar-track-vertical')).toHaveCSS('top', '0px');
	await page.evaluate(() => {
		window.ashTextModelIntegration.setScrollbar({ verticalHasArrows: true });
		window.ashTextModelIntegration.setTheme('contrast');
	});
	await down.focus();
	await expect(down).toHaveCSS('outline-style', 'solid');
	const vertical = editor.getByRole('scrollbar', { name: 'Vertical scrollbar' });
	await vertical.focus();
	await page.keyboard.press('End');
	await expect(down).toBeDisabled();
	await up.focus();
	await page.keyboard.press('Space');
	await expect(down).toBeEnabled();
	await down.hover();
	await page.mouse.down();
	await page.evaluate(() => window.ashTextModelIntegration.dispose());
	await page.waitForTimeout(400);
	await page.mouse.up();
	await expect(page.locator('.ash-scrollbar-arrow')).toHaveCount(0);
});

test('editor inertial scrolling decays and stops on reversal, direct input and configuration changes', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({ inertialScroll: true, smoothScrolling: false });
	});
	const editor = page.locator('.stanza-editor');
	await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(160);
	const forward = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	expect(forward).toBeGreaterThan(12);
	await editor.dispatchEvent('wheel', { deltaY: -8, deltaMode: 0 });
	await page.clock.runFor(80);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeLessThan(forward - 8);
	await editor.dispatchEvent('keydown', { key: 'Escape' });
	const interrupted = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.clock.runFor(200);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(interrupted);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ inertialScroll: false }));
	const disabled = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.clock.runFor(500);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(disabled);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(500);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(disabled + 12);
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({ inertialScroll: true }));
	await editor.dispatchEvent('wheel', { deltaY: 3, deltaMode: 1 });
	const discrete = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.clock.runFor(500);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(discrete);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(1500);
	const settled = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.clock.runFor(500);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(settled);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.evaluate(() => window.ashTextModelIntegration.setValue('short\nshort\nshort'));
	await page.clock.runFor(500);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(0);
	await page.evaluate(() => window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'line').join('\n')));
	await page.clock.runFor(32);
	await editor.getByRole('scrollbar', { name: 'Vertical scrollbar' }).dispatchEvent('keydown', { key: 'End' });
	await page.clock.runFor(32);
	const bottom = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await editor.dispatchEvent('wheel', { deltaY: 12, deltaMode: 0 });
	await page.clock.runFor(1500);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(bottom);
	await editor.dispatchEvent('wheel', { deltaY: -12, deltaMode: 0 });
	await page.evaluate(() => window.ashTextModelIntegration.dispose());
	await page.clock.runFor(1500);
	await expect(page.locator('.ash-smooth-scrollable')).toHaveCount(0);
});

test('editor distinguishes accelerating pixel input from fixed wheel steps before applying sensitivity', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 1000 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.updateOptions({ inertialScroll: true, smoothScrolling: false, mouseWheelScrollSensitivity: 2 });
	});
	await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
	const editor = page.locator('.stanza-editor');
	// At the top edge the same unconsumed event reaches both wheel listeners.
	await editor.dispatchEvent('wheel', { deltaY: -60, deltaMode: 0 });
	await editor.dispatchEvent('wheel', { deltaY: 120, deltaMode: 0 });
	const edgeInput = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.clock.runFor(32);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(edgeInput);
	// Large integer pixel deltas remain continuous when their step varies.
	for (const deltaY of [134, 83, 62, 72, 101]) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		const immediate = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
		await page.clock.runFor(32);
		expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(immediate);
	}
	await editor.dispatchEvent('keydown', { key: 'Escape' });
	await page.clock.runFor(150);
	for (const deltaY of [40, 80, 160, 40]) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		const immediate = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
		await page.clock.runFor(80);
		expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(immediate);
	}
	// Fractional notch sizes become discrete after the repeated step is observed.
	for (const [index, deltaY] of [60, 60, 120, 120, 60].entries()) {
		await editor.dispatchEvent('wheel', { deltaY, deltaMode: 0 });
		const immediate = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
		await page.clock.runFor(32);
		if (index > 0) {
			expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(immediate);
		}
	}
	await editor.dispatchEvent('wheel', { deltaY: 47, deltaX: 9, deltaMode: 0 });
	const switched = await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop);
	await page.clock.runFor(32);
	expect(await editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(switched);
});

test('editor surface and diagnostic colors follow the current Ash theme', async ({ page }) => {
	await openEditor(page);
	const editor = page.locator('.stanza-editor');
	const diagnostic = page.locator('.cdr.squiggly-error');
	await expect(diagnostic).toHaveCount(1);
	for (const theme of ['dark', 'light', 'contrast'] as const) {
		await page.evaluate(value => window.ashTextModelIntegration.setTheme(value), theme);
		const colors = await editor.evaluate(element => {
			const style = getComputedStyle(element);
			const marker = element.querySelector('.squiggly-error');
			if (!marker) throw new Error('Missing diagnostic');
			const probe = element.ownerDocument.createElement('span');
			probe.style.color = 'var(--ash-editor-foreground)';
			probe.style.backgroundColor = 'var(--ash-editor-background)';
			probe.style.borderColor = 'var(--ash-error-foreground)';
			element.append(probe);
			const expected = getComputedStyle(probe);
			const result = {
				actual: [style.color, style.backgroundColor, getComputedStyle(marker).borderBottomColor],
				expected: [expected.color, expected.backgroundColor, expected.borderColor],
			};
			probe.remove();
			return result;
		});
		expect(colors.actual).toEqual(colors.expected);
	}
});

test('editor-owned colors preserve focused cursors, line borders and rulers in all four themes', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => window.ashTextModelIntegration.updateOptions({
		rulers: [12], renderLineHighlight: 'all', cursorBlinking: 'solid',
	}));
	const input = page.locator('.stanza-editor-input');
	await input.focus();
	const cursor = page.locator('.cursors-layer > .cursor').first();
	const line = page.locator('.view-overlays .current-line-exact').first();
	const ruler = page.locator('.stanza-editor-ruler').first();
	const palettes = [
		{ theme: 'dark', cursor: 'rgb(174, 175, 173)', line: 'rgb(40, 40, 40)', ruler: 'rgb(90, 90, 90)', border: '2px' },
		{ theme: 'light', cursor: 'rgb(0, 0, 0)', line: 'rgb(238, 238, 238)', ruler: 'rgb(211, 211, 211)', border: '2px' },
		{ theme: 'contrast', cursor: 'rgb(255, 255, 255)', line: 'rgb(243, 133, 24)', ruler: 'rgb(255, 255, 255)', border: '1px' },
		{ theme: 'contrastLight', cursor: 'rgb(15, 74, 133)', line: 'rgb(15, 74, 133)', ruler: 'rgb(41, 41, 41)', border: '1px' },
	] as const;
	for (const palette of palettes) {
		await page.evaluate(theme => window.ashTextModelIntegration.setTheme(theme), palette.theme);
		await expect(input).toBeFocused();
		await expect(cursor).toHaveCSS('background-color', palette.cursor);
		await expect(line).toHaveCSS('border-top-color', palette.line);
		await expect(line).toHaveCSS('border-top-width', palette.border);
		await expect(ruler).toHaveCSS('background-color', palette.ruler);
	}
});

test('selection, gutter, whitespace and line numbers resolve editor colors in all four themes', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue('alpha beta\nsecond line');
		window.ashTextModelIntegration.updateOptions({ renderWhitespace: 'all', lineNumbers: 'on' });
		window.ashTextModelIntegration.setCursors([{ lineIndex: 0, columnIndex: 0 }]);
	});
	const editor = page.locator('.stanza-editor');
	const input = page.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Shift+ArrowRight');
	await expect(page.locator('.stanza-editor-selection').first()).toBeVisible();
	await expect(page.locator('.stanza-editor-whitespace').first()).toBeVisible();
	for (const theme of ['dark', 'light', 'contrast', 'contrastLight'] as const) {
		await page.evaluate(theme => window.ashTextModelIntegration.setTheme(theme), theme);
		for (const focused of [true, false]) {
			if (focused) await input.focus();
			else await input.blur();
			await expect(editor.locator('.view-overlays').first()).toHaveClass(focused ? /\bfocused\b/u : /^(?!.*\bfocused\b)/u);
			const colors = await editor.evaluate((element, focused) => {
				const entries = [
					['.stanza-editor-selection', 'background-color', focused ? '--ash-editor-selection-background' : '--ash-editor-inactive-selection-background'],
					['.margin', 'background-color', '--ash-editor-gutter-background'],
					['.stanza-editor-whitespace', 'color', '--ash-editor-whitespace-foreground'],
					['.line-numbers.active-line-number', 'color', '--ash-editor-line-number-active-foreground'],
					['.line-numbers:not(.active-line-number)', 'color', '--ash-editor-line-number-foreground'],
				];
				return entries.map(([selector, property, token]) => {
					const target = element.querySelector(selector!);
					if (!target) throw new Error(`Missing ${selector}`);
					const probe = element.ownerDocument.createElement('span');
					probe.style.setProperty(property!, `var(${token})`);
					element.append(probe);
					const result = {
						actual: getComputedStyle(target).getPropertyValue(property!),
						expected: getComputedStyle(probe).getPropertyValue(property!),
						registered: getComputedStyle(target).getPropertyValue(token!).trim().length > 0,
					};
					probe.remove();
					return result;
				});
			}, focused);
			for (const color of colors) {
				expect(color.registered).toBe(true);
				expect(color.actual).toBe(color.expected);
				expect(color.actual).not.toBe('rgba(0, 0, 0, 0)');
			}
		}
	}
});

test('Workbench editor actions update the open editor and Go to Line retains keyboard focus', async ({ page }) => {
	await openEditor(page);
	const input = page.locator('.stanza-editor-input');
	const minimap = page.locator('.stanza-editor .minimap');
	await input.focus();
	await page.evaluate(() => window.ashTextModelIntegration.runWorkbenchCommand('editor.action.toggleMinimap'));
	await expect(minimap).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getViewSettings().minimap)).toBe(false);
	await page.evaluate(() => window.ashTextModelIntegration.runWorkbenchCommand('editor.action.toggleMinimap'));
	await expect(minimap).toBeVisible();

	await page.evaluate(() => window.ashTextModelIntegration.setValue('alpha  beta\nsecond line'));
	await page.evaluate(() => window.ashTextModelIntegration.runWorkbenchCommand('editor.action.toggleRenderWhitespace'));
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getViewSettings().renderWhitespace)).toBe('none');
	await page.evaluate(() => window.ashTextModelIntegration.runWorkbenchCommand('editor.action.toggleRenderWhitespace'));
	await expect(page.locator('.stanza-editor-whitespace').first()).toBeVisible();
	await page.evaluate(() => window.ashTextModelIntegration.runWorkbenchCommand('editor.action.toggleRenderControlCharacter'));
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getViewSettings().renderControlCharacters)).toBe(false);
	const text = `${'alpha '.repeat(80)}\nsecond line`;
	await page.evaluate(value => window.ashTextModelIntegration.setValue(value), text);
	await input.focus();
	await page.evaluate(() => window.ashTextModelIntegration.runWorkbenchCommand('editor.action.toggleWordWrap'));
	await expect(page.locator('.stanza-editor.word-wrapped')).toBeVisible();
	await expect(page.locator('.stanza-editor-accessibility-status')).toHaveText('Word wrap on');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getViewSettings())).toMatchObject({ wordWrap: 'off', wordWrapOverride: 'on' });
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getViewSettings().wrappingColumn)).toBeGreaterThan(0);
	await input.press('Alt+Z');
	await expect(page.locator('.stanza-editor.word-wrapped')).toHaveCount(0);
	await expect(page.locator('.stanza-editor-accessibility-status')).toHaveText('Word wrap off');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getViewSettings())).toMatchObject({ wordWrap: 'off', wordWrapOverride: 'inherit', wrappingColumn: -1 });
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(text);

	await input.focus();
	await page.evaluate(() => window.ashTextModelIntegration.runWorkbenchCommand('workbench.action.gotoLine'));
	const dialog = page.locator('.stanza-editor-goto-line-widget');
	await expect(dialog).toBeVisible();
	const lineInput = dialog.getByRole('textbox', { name: 'Line number and optional column' });
	await expect(lineInput).toBeFocused();
	await lineInput.fill('2:1');
	await lineInput.press('Enter');
	await expect(dialog).toBeHidden();
	await expect(input).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection().startLineIndex)).toBe(1);
});

test("glyph margin, line numbers, and folding controls keep VS Code gutter order", async ({ page }) => {
	await openEditor(page);
	const glyphMargin = page.locator(".glyph-margin");
	const foldingControl = page.locator('.ash-icon-folding-expanded').first();
	await expect(glyphMargin).toBeVisible();
	await expect(foldingControl).toBeVisible();
	const firstLine = page.locator(".view-line[data-logical-line-index='0']");
	await expect(page.locator('.view-lines')).toHaveCSS('cursor', 'text');
	const firstLineNumber = page.locator(".margin-view-overlays .view-overlay-line[data-line-index='0'] .line-numbers");
	await expect(firstLineNumber).toHaveText("1");
	const foldingBox = await foldingControl.boundingBox();
	const glyphMarginBox = await glyphMargin.boundingBox();
	const lineNumberBox = await firstLineNumber.boundingBox();
	const textBox = await firstLine.locator(".stanza-editor-line-text").boundingBox();
	assertBox(foldingBox, "folding control");
	assertBox(glyphMarginBox, "glyph margin");
	assertBox(lineNumberBox, "line number");
	assertBox(textBox, "line text");

	expect(glyphMarginBox.x + glyphMarginBox.width).toBe(lineNumberBox.x);
	expect(lineNumberBox.x + lineNumberBox.width).toBeLessThanOrEqual(foldingBox.x);
	expect(foldingBox.x + foldingBox.width).toBeLessThanOrEqual(textBox.x);

	const editor = page.locator(".stanza-editor");
	const input = page.locator(".stanza-editor-input");
	await input.focus();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type("x".repeat(200));
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
	await page.evaluate(() => window.ashTextModelIntegration.setScrollLeft(160));
	await expect.poll(async () => (await glyphMargin.boundingBox())?.x).toBe(glyphMarginBox.x);
	const editorBox = await editor.boundingBox();
	const scrolledGlyphMarginBox = await glyphMargin.boundingBox();
	const scrolledFoldingBox = await foldingControl.boundingBox();
	const scrolledLineNumberBox = await firstLineNumber.boundingBox();
	assertBox(editorBox, "editor");
	assertBox(scrolledGlyphMarginBox, "scrolled glyph margin");
	assertBox(scrolledFoldingBox, "scrolled folding control");
	assertBox(scrolledLineNumberBox, "scrolled line number");

	expect(scrolledGlyphMarginBox.x).toBe(editorBox.x);
	expect(scrolledGlyphMarginBox.x + scrolledGlyphMarginBox.width).toBe(scrolledLineNumberBox.x);
	expect(scrolledLineNumberBox.x + scrolledLineNumberBox.width).toBe(scrolledFoldingBox.x);
});

test('view zones use the standard accessor, whitespace geometry, and disposal chain', async ({ page }) => {
	await openEditor(page);
	const editor = page.locator('.stanza-editor');
	const baseGeometry = await editor.evaluate(element => {
		const firstLine = element.querySelector<HTMLElement>('.view-line[data-logical-line-index="0"]');
		if (!firstLine) throw new Error('Missing first editor line');
		const positionedLayers = [
			'.stanza-editor-content',
			'.stanza-native-ime-text-area',
			'.stanza-native-edit-context',
			'.minimap',
			'.decorationsOverviewRuler',
			'.ash-smooth-scrollable > .ash-scrollbar-track-horizontal',
			'.ash-smooth-scrollable > .ash-scrollbar-track-vertical',
		].map(selector => {
			const layer = element.querySelector<HTMLElement>(selector);
			if (!layer) throw new Error(`Missing editor layer '${selector}'`);
			return getComputedStyle(layer).position;
		});
		return {
			clientWidth: element.clientWidth,
			contentLeft: window.ashTextModelIntegration.getControl().getLayoutInfo().contentLeft,
			clientHeight: element.clientHeight,
			lineHeight: firstLine.getBoundingClientRect().height,
			lineCount: element.querySelectorAll('.view-line[data-logical-line-index]').length,
			positionedLayers,
		};
	});
	expect(baseGeometry.clientWidth).toBe(900);
	expect(baseGeometry.clientHeight).toBe(420);
	expect(baseGeometry.positionedLayers).toEqual(Array.from({ length: 7 }, () => 'absolute'));
	await page.evaluate(() => window.ashTextModelIntegration.showViewZone());
	const zone = page.locator('.ash-view-zone-probe');
	await expect(zone).toHaveAttribute('data-visible-view-zone', 'true');
	await expect(zone).toHaveCSS('top', `${baseGeometry.lineHeight}px`);
	await expect(zone).toHaveCSS('height', '500px');
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => ({ scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight }))).toEqual({
		scrollWidth: 1_200 - baseGeometry.contentLeft,
		scrollHeight: baseGeometry.lineHeight * baseGeometry.lineCount + 500,
	});
	await page.evaluate(() => window.ashTextModelIntegration.removeViewZone());
	await expect(zone).toHaveCount(0);
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => ({ scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight }))).toEqual({
		scrollWidth: baseGeometry.clientWidth - baseGeometry.contentLeft,
		scrollHeight: baseGeometry.clientHeight,
	});
});

test('accessible zone widgets expose their action to keyboard and accessibility APIs', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => window.ashTextModelIntegration.showAccessibleZoneWidget());
	const zone = page.locator('.stanza-editor-zone-widget');
	await expect(zone).toBeVisible();
	await expect(zone).not.toHaveAttribute('aria-hidden', 'true');
	const action = page.getByRole('button', { name: 'Accessible zone action' });
	await action.focus();
	await expect(action).toBeFocused();
});

test('content and glyph margin widgets use the standard editor ports in Chromium', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => window.ashTextModelIntegration.showWidgets());
	const editor = page.locator('.stanza-editor');
	const contentWidget = page.locator('.ash-content-widget-probe');
	const glyphWidget = page.locator('.ash-glyph-widget-probe');
	await expect(contentWidget).toBeVisible();
	await expect(glyphWidget).toBeVisible();
	await expect(page.locator('.ash-model-glyph-lower')).toHaveCount(0);
	await expect(page.locator('.ash-model-glyph-higher')).toBeVisible();
	const initial = await editor.evaluate(element => {
		const line = element.querySelector<HTMLElement>('.view-line[data-logical-line-index="0"]');
		const glyph = element.querySelector<HTMLElement>('.ash-glyph-widget-probe');
		const content = element.querySelector<HTMLElement>('.ash-content-widget-probe');
		if (!line || !glyph || !content) throw new Error('Widget probe geometry is incomplete');
		return {
			lineTop: line.getBoundingClientRect().top,
			lineHeight: line.getBoundingClientRect().height,
			glyphTop: glyph.getBoundingClientRect().top,
			contentWidth: content.getBoundingClientRect().width,
			contentHeight: content.getBoundingClientRect().height,
		};
	});
	expect(initial.glyphTop).toBe(initial.lineTop);
	expect(initial.contentWidth).toBeGreaterThan(0);
	expect(initial.contentHeight).toBeGreaterThan(0);
	await page.evaluate(() => window.ashTextModelIntegration.moveGlyphWidget(2));
	await expect.poll(() => glyphWidget.evaluate(element => element.getBoundingClientRect().top)).toBe(initial.lineTop + initial.lineHeight * 2);
	await page.evaluate(() => window.ashTextModelIntegration.removeWidgets());
	await expect(contentWidget).toHaveCount(0);
	await expect(glyphWidget).toHaveCount(0);
	await expect(page.locator('.ash-model-glyph-higher')).toHaveCount(0);
});

test('model decorations render through the standard overlay in Chromium', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => window.ashTextModelIntegration.showModelDecorations());
	const inline = page.locator('.ash-model-decoration-inline');
	const wholeLine = page.locator('.ash-model-decoration-whole');
	const collapsed = page.locator('.ash-model-decoration-collapsed');
	const lineDecoration = page.locator('.ash-model-line-decoration');
	const firstLineDecoration = page.locator('.ash-model-first-line-decoration');
	const blockDecoration = page.locator('.ash-model-block-decoration');
	await expect(inline).toHaveCount(1);
	await expect(wholeLine).toHaveCount(1);
	await expect(collapsed).toHaveCount(1);
	await expect(lineDecoration).toHaveCount(2);
	await expect(firstLineDecoration).toHaveCount(1);
	await expect(lineDecoration.first()).toHaveAttribute('title', 'Model line decoration');
	await expect(blockDecoration).toHaveCount(1);
	const geometry = await page.locator('.stanza-editor').evaluate(element => {
		const inlineDecoration = element.querySelector<HTMLElement>('.ash-model-decoration-inline');
		const wholeLineDecoration = element.querySelector<HTMLElement>('.ash-model-decoration-whole');
		const collapsedDecoration = element.querySelector<HTMLElement>('.ash-model-decoration-collapsed');
		if (!inlineDecoration || !wholeLineDecoration || !collapsedDecoration) throw new Error('Model decoration geometry is incomplete');
		return {
			inlineWidth: inlineDecoration.getBoundingClientRect().width,
			wholeLineWidth: wholeLineDecoration.getBoundingClientRect().width,
			collapsedWidth: collapsedDecoration.getBoundingClientRect().width,
		};
	});
	expect(geometry.inlineWidth).toBeGreaterThan(0);
	expect(geometry.wholeLineWidth).toBeGreaterThan(geometry.inlineWidth);
	expect(geometry.collapsedWidth).toBeGreaterThan(0);
	await page.evaluate(() => window.ashTextModelIntegration.removeModelDecorations());
	await expect(inline).toHaveCount(0);
	await expect(wholeLine).toHaveCount(0);
	await expect(collapsed).toHaveCount(0);
	await expect(lineDecoration).toHaveCount(0);
	await expect(firstLineDecoration).toHaveCount(0);
	await expect(blockDecoration).toHaveCount(0);
});

test("text-model editor has the accessibility contract", async ({ page }) => {
	await openEditor(page);
	const editor = page.locator(".stanza-editor");
	const input = page.locator(".stanza-editor-input");
	await expect(editor).toHaveAttribute("role", "region");
	await expect(editor).toHaveAttribute("aria-label", /.+/);
	await expect(input).toHaveAttribute("aria-multiline", "true");
	await expect(input).toHaveAttribute("aria-roledescription", "code editor");
	await expect(editor.locator('.stanza-editor-token.token-keyword').filter({ hasText: 'fn' }).first()).toBeVisible();
	await input.focus();
	const screenReaderContent = input.locator('.stanza-native-screen-reader-content');
	await expect(screenReaderContent).toContainText('fn main()');
	await page.waitForTimeout(110);
	await screenReaderContent.evaluate(element => {
		const text = element.firstChild;
		if (!text) throw new Error('Simple screen-reader content has no text node');
		const selection = element.ownerDocument.getSelection();
		if (!selection) throw new Error('Document selection is unavailable');
		selection.setBaseAndExtent(text, 1, text, 3);
		element.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 3,
	});
	await screenReaderContent.evaluate(element => { element.dataset.contentKind = 'simple'; });

	await page.evaluate(() => window.ashTextModelIntegration.setRenderRichScreenReaderContent(true));
	await expect(input.locator('[data-content-kind="simple"]')).toHaveCount(0);
	await expect(screenReaderContent.locator('span[data-line-index]')).not.toHaveCount(0);
	const viewportBracket = page.locator('.view-line .stanza-editor-bracket-level-1').first();
	const richBracket = screenReaderContent.locator('.stanza-editor-bracket-level-1').first();
	await expect(richBracket).toHaveCSS('color', await viewportBracket.evaluate(element => getComputedStyle(element).color));
	expect(await richBracket.evaluate(element => getComputedStyle(element).color)).not.toBe(await editor.evaluate(element => getComputedStyle(element).color));
	await page.waitForTimeout(110);
	await screenReaderContent.evaluate(element => {
		const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const text = walker.nextNode();
		if (!text) throw new Error('Rich screen-reader content has no text node');
		const selection = element.ownerDocument.getSelection();
		if (!selection) throw new Error('Document selection is unavailable');
		selection.setBaseAndExtent(text, 0, text, 2);
		element.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 0,
		endLineIndex: 0,
		endColumnIndex: 2,
	});
	await screenReaderContent.evaluate(element => { element.dataset.contentKind = 'rich'; });

	await page.evaluate(() => window.ashTextModelIntegration.setRenderRichScreenReaderContent(false));
	await expect(input.locator('[data-content-kind="rich"]')).toHaveCount(0);
	await expect(screenReaderContent).toContainText('fn main()');
	await expect(screenReaderContent.locator('span[data-line-index]')).toHaveCount(0);

	await injectAxe(page);
	const accessibility = await getAxeResults(page, undefined, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } });
	expect(accessibility.violations.filter(violation => violation.impact === "critical")).toEqual([]);
	const contrast = await getAxeResults(page, undefined, { runOnly: { type: "rule", values: ["color-contrast"] } });
	expect(contrast.violations).toEqual([]);
});

test('textarea system-caret movement updates the editor only while focused', async ({ page }) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, 'EditContext');
	});
	await openEditor(page);
	const input = page.locator('textarea.stanza-editor-input');
	await expect(input).toHaveCount(1);
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: 'fn' }).first()).toBeVisible();
	await input.focus();
	await page.waitForTimeout(110);
	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(1, 3, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 3,
	});

	await input.blur();
	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(0, 1, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection())).toEqual({
		startLineIndex: 0,
		startColumnIndex: 1,
		endLineIndex: 0,
		endColumnIndex: 3,
	});
});

test('textarea clipboard events pass through TextAreaInput semantic events', async ({ page }) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, 'EditContext');
	});
	await openEditor(page);
	const input = page.locator('textarea.stanza-editor-input');
	await input.focus();
	await page.waitForTimeout(110);
	const copied = await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(1, 3, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
		const clipboardData = new DataTransfer();
		const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
		textArea.dispatchEvent(event);
		return { defaultPrevented: event.defaultPrevented, text: clipboardData.getData('text/plain') };
	});
	expect(copied).toEqual({ defaultPrevented: true, text: 'n ' });

	await input.evaluate(element => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', 'ZZ');
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^fZZmain\(\)/u);
	await expect(input).toHaveValue(/^fZZmain\(\)/u);
	await page.waitForTimeout(110);

	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setSelectionRange(0, 3, 'forward');
		textArea.ownerDocument.dispatchEvent(new Event('selectionchange'));
		textArea.dispatchEvent(new ClipboardEvent('cut', {
			bubbles: true,
			cancelable: true,
			clipboardData: new DataTransfer(),
		}));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^main\(\)/u);
});

function assertBox(box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null, name: string): asserts box is { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
	expect(box, `Expected ${name} geometry`).not.toBeNull();
}


test('large multiline keyboard input replaces the selection and keeps the editor responsive', async ({ page }) => {
	await openEditor(page);
	const input = page.locator('.stanza-editor-input');
	await input.focus();
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	const content = Array.from({ length: 200 }, (_, index) => `line${index}${'文🙂x'.repeat(60)}`).join('\n');
	await page.keyboard.insertText(content);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(content);
	await page.keyboard.insertText('!');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(content + '!');
	await expect(page.locator('.view-line[data-logical-line-index="199"]')).toBeVisible();
});

async function openEditor(page: Page): Promise<void> {
	await page.goto('/textModel.html');
	await page.waitForFunction(() => window.ashTextModelIntegration !== undefined);
}

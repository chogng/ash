import { attachRustSyntax, test } from '../../fixtures/browser/rustSyntaxProcessFixture.js';
import { expect, type Page } from '@playwright/test';
import { getAxeResults, injectAxe } from 'axe-playwright';
import { ScrollType, type IEditor } from '../../../src/ash/editor/common/editorCommon.js';

const pageErrors = new WeakMap<object, string[]>();

for (const inputMode of ['EditContext', 'textarea'] as const) {
	test(`composition anchor follows the caret inside the scrolling body with ${inputMode}`, async ({ page }) => {
		if (inputMode === 'textarea')
			await page.addInitScript(() => {
				Reflect.deleteProperty(window, 'EditContext');
			});
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
		await expect
			.poll(() =>
				input.evaluate(element => {
					const caret = element.closest('.stanza-editor')!.querySelector('.stanza-editor-caret')!;
					return Math.abs(element.getBoundingClientRect().left - caret.getBoundingClientRect().left);
				}),
			)
			.toBeLessThanOrEqual(1);
	});
}

test('syntax theme updates repaint text and minimap through shared line support', async ({ page }) => {
	await openEditor(page);
	const editor = page.locator('.stanza-editor');
	const token = editor.locator('.stanza-editor-token').filter({ hasText: /^fn$/u });
	await expect(token).toBeVisible();
	const workers = page.workers().filter(worker => worker.url().includes('textMateSyntaxWorkerMain'));
	expect(workers).toHaveLength(0);
	for (const [color, expected] of [
		['#149b37', 'rgb(20, 155, 55)'],
		['#9a41da', 'rgb(154, 65, 218)'],
	] as const) {
		await page.evaluate(color => window.ashTextModelIntegration.setSyntaxColor(color), color);
		await expect(token).toHaveCSS('color', expected);
		await expect
			.poll(() =>
				editor.locator('.minimap canvas').evaluate((element, color) => {
					const canvas = element as HTMLCanvasElement;
					const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
					const channel = color === '#149b37' ? 1 : 2;
					for (let offset = 0; offset < pixels.length; offset += 4) {
						if (pixels[offset + 3]! > 0 && pixels[offset + channel]! > pixels[offset]! && pixels[offset + channel]! > pixels[offset + 3 - channel]!) return true;
					}
					return false;
				}, color),
			)
			.toBe(true);
		expect(page.workers().filter(worker => worker.url().includes('textMateSyntaxWorkerMain'))).toEqual(workers);
	}
});

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
});

test.afterEach(async ({ page }) => {
	await page
		.evaluate(() => {
			window.ashTextModelIntegration?.dispose();
		})
		.catch(() => undefined);
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

test('save code actions apply fixes and organize imports before the keyboard save writes the file', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(async () => {
		await window.ashTextModelIntegration.enableSaveCodeActions();
		window.ashTextModelIntegration.setValue('use z;\nuse a;\nfn main() { let unused = 1; }\n');
	});
	await page.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+s');
	const saved = 'use a;\nuse z;\nfn main() { let _unused = 1; }\n';
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSavedText())).toBe(saved);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(saved);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('use z;\nuse a;\nfn main() { let _unused = 1; }\n');
});

test('text-model editor public API, pane, undo, save, and browser worker', async ({ page }) => {
	const workers: string[] = [];
	page.on('worker', worker => workers.push(worker.url()));
	await openEditor(page);
	await expect(page.locator('.stanza-editor')).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.apiText)).toBe('editor-api');

	const input = page.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Control+Home');
	const caret = page.locator('.stanza-editor-caret.primary');
	await expect(caret).toHaveClass(/cursor-style-line/u);
	await page.keyboard.press('Insert');
	await expect(caret).toHaveClass(/cursor-style-block/u);
	await expect(caret).toHaveClass(/token-keyword/u);
	await expect(caret).toHaveText('f');
	await page.keyboard.press('Insert');
	await expect(caret).toHaveClass(/cursor-style-line/u);
	await page.keyboard.type('integrated');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('integratedfn main() {\n  answer();\n}\n');

	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('fn main() {\n  answer();\n}\n');
	await page.evaluate(() => window.ashTextModelIntegration.save());
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSavedText())).toBe('fn main() {\n  answer();\n}\n');
	// Editing and saving do not need a Worker. Formatting requests minimal edits
	// from the browser Worker, so verify that work and its concrete result.
	await page.evaluate(() => {
		window.ashTextModelIntegration.enableFormatting('en');
		void window.ashTextModelIntegration.formatDocument();
	});
	const formatter = page.locator('.ash-quick-pick').getByRole('combobox');
	await formatter.fill('alpha.format');
	await formatter.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('ALPHA');
	await expect.poll(() => workers.some(url => url.includes('editorWebWorkerMain'))).toBe(true);
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

test('Explicit Code assembly installs text contributions without document controls and releases their UI', async ({ page }) => {
	await openEditor(page);
	const ids = await page.evaluate(() => window.ashTextModelIntegration.getBundleIds());
	expect(ids).toContain('editor.contrib.clipboard');
	expect(await page.evaluate(() => window.ashTextModelIntegration.hasClipboardContribution())).toBe(true);
	expect(ids).toContain('editor.contrib.findController');
	expect(ids).toContain('editor.contrib.format');
	expect(ids).not.toContain('editor.contrib.documentFormatting');
	expect(ids).not.toContain('editor.contrib.collaboration');
	expect(await page.evaluate(() => window.ashTextModelIntegration.hasPlaceholderContribution())).toBe(true);
	await expect(page.locator('.stanza-editor')).toBeVisible();
	await expect(page.locator('.stanza-structured-format-toolbar')).toHaveCount(0);
	const find = page.locator('.stanza-editor-find-widget');
	await expect(find).toHaveCount(0);
	await page.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+f');
	await expect(find).toHaveAttribute('role', 'dialog');
	await expect(find).toBeVisible();
	await find.locator('input[aria-label="Find"]').fill('fn');
	await page.keyboard.press('Escape');
	await expect(find).toBeHidden();

	await page.evaluate(() => window.ashTextModelIntegration.dispose());
	await expect(page.locator('.stanza-editor')).toHaveCount(0);
	await expect(find).toHaveCount(0);
});

for (const inputBackend of ['EditContext', 'textarea'] as const) {
	test(`Chinese IME caret revisions preserve surrounding text and undo through ${inputBackend}`, async ({ page }) => {
		if (inputBackend === 'textarea')
			await page.addInitScript(() => {
				Reflect.deleteProperty(window, 'EditContext');
			});
		await openEditor(page);
		await page.evaluate(() => {
			const editor = window.ashTextModelIntegration.getControl();
			editor.setValue('前后');
			editor.setPosition({ lineNumber: 1, column: 2 });
			editor.focus();
		});
		const session = await page.context().newCDPSession(page);
		try {
			for (const [text, offset] of [
				['你好', 1],
				['您好', 1],
				['您们好', 3],
			] as const) {
				await session.send('Input.imeSetComposition', { text, selectionStart: offset, selectionEnd: offset });
				await expect
					.poll(() =>
						page.evaluate(() => ({
							text: window.ashTextModelIntegration.getValue(),
							position: window.ashTextModelIntegration.getControl().getPosition(),
						})),
					)
					.toEqual({ text: `前${text}后`, position: { lineNumber: 1, column: 2 + offset } });
			}
			await session.send('Input.insertText', { text: '您们好' });
			await expect(page.locator('.stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
			const input = page.locator('.stanza-editor-input');
			await input.press('ControlOrMeta+z');
			await expect
				.poll(() =>
					page.evaluate(() => ({
						text: window.ashTextModelIntegration.getValue(),
						position: window.ashTextModelIntegration.getControl().getPosition(),
					})),
				)
				.toEqual({ text: '前后', position: { lineNumber: 1, column: 2 } });
			await input.press('ControlOrMeta+Shift+z');
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('前您们好后');
			await page.evaluate(() => {
				const editor = window.ashTextModelIntegration.getControl();
				editor.setValue('中文');
				editor.setSelection({
					selectionStartLineNumber: 1,
					selectionStartColumn: 2,
					positionLineNumber: 1,
					positionColumn: 1,
				});
			});
			await session.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('zhong文');
			await input.press('Escape');
			await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
			await expect
				.poll(() =>
					page.evaluate(() => {
						const editor = window.ashTextModelIntegration.getControl();
						const selection = editor.getSelection()!;
						return {
							text: editor.getValue(),
							selection: [selection.selectionStartColumn, selection.positionColumn],
							canRedo: editor.getModel()!.canRedo(),
						};
					}),
				)
				.toEqual({ text: '中文', selection: [2, 1], canRedo: false });
		} finally {
			await session.detach();
		}
	});

	for (const [unchanged, cancelKey] of [
		[false, 'Escape'],
		[true, 'Escape'],
		[false, 'Process'],
		[true, 'Process'],
	] as const) {
		test(`Chinese composition cancellation restores selection and history through ${inputBackend} with ${cancelKey}${unchanged ? ' without a text change' : ''}`, async ({ page }) => {
			if (inputBackend === 'textarea')
				await page.addInitScript(() => {
					Reflect.deleteProperty(window, 'EditContext');
				});
			await openEditor(page);
			await page.evaluate(() => {
				const editor = window.ashTextModelIntegration.getControl();
				editor.setValue('中文');
				editor.setPosition({ lineNumber: 1, column: 3 });
				editor.focus();
			});
			const input = page.locator('.stanza-editor-input');
			await page.keyboard.insertText('!');
			await page.evaluate(() =>
				window.ashTextModelIntegration.getControl().setSelection({
					selectionStartLineNumber: 1,
					selectionStartColumn: 2,
					positionLineNumber: 1,
					positionColumn: 1,
				}),
			);
			await input.evaluate(
				(element, { unchanged, cancelKey }) => {
					const native = (
						element as HTMLElement & {
							editContext?: EventTarget & {
								readonly selectionStart: number;
								readonly selectionEnd: number;
								updateText(start: number, end: number, text: string): void;
								updateSelection(start: number, end: number): void;
							};
						}
					).editContext;
					const target = native ?? element;
					const textarea = element as HTMLTextAreaElement;
					const start = Math.min(native?.selectionStart ?? textarea.selectionStart, native?.selectionEnd ?? textarea.selectionEnd);
					let end = Math.max(native?.selectionStart ?? textarea.selectionStart, native?.selectionEnd ?? textarea.selectionEnd);
					target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
					for (const text of unchanged ? ['中'] : ['n', 'ni', '你']) {
						if (native) {
							native.updateText(start, end, text);
							native.updateSelection(start + text.length, start + text.length);
							target.dispatchEvent(
								Object.assign(new Event('textupdate'), {
									text,
									updateRangeStart: start,
									updateRangeEnd: end,
									selectionStart: start + text.length,
									selectionEnd: start + text.length,
								}),
							);
							end = start + text.length;
						} else {
							textarea.setRangeText(text, start, end, 'end');
							end = start + text.length;
							target.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
						}
					}
					element.dispatchEvent(
						new KeyboardEvent('keydown', {
							bubbles: true,
							key: cancelKey,
							isComposing: cancelKey === 'Escape',
						}),
					);
					if (cancelKey === 'Process') {
						// The Windows IME consumes Escape, removes the candidate, then
						// completes with empty data. There is no Escape keydown in the editor.
						if (native) {
							native.updateText(start, end, '');
							native.updateSelection(start, start);
							target.dispatchEvent(
								Object.assign(new Event('textupdate'), {
									text: '',
									updateRangeStart: start,
									updateRangeEnd: end,
									selectionStart: start,
									selectionEnd: start,
								}),
							);
						} else {
							textarea.setRangeText('', start, end, 'end');
							target.dispatchEvent(
								new InputEvent('input', {
									bubbles: true,
									data: '',
									inputType: 'insertCompositionText',
									isComposing: true,
								}),
							);
						}
					}
					target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
				},
				{ unchanged, cancelKey },
			);
			await expect
				.poll(() =>
					page.evaluate(() => {
						const editor = window.ashTextModelIntegration.getControl();
						const selection = editor.getSelection()!;
						return {
							text: editor.getValue(),
							selection: [selection.selectionStartColumn, selection.positionColumn],
							canRedo: editor.getModel()!.canRedo(),
						};
					}),
				)
				.toEqual({ text: '中文!', selection: [2, 1], canRedo: false });
			await expect(page.locator('.stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
			await input.press('ControlOrMeta+Shift+z');
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('中文!');
			await input.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('中文');
			await input.press('ControlOrMeta+Shift+z');
			await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('中文!');
		});
	}

	test(`Unicode overtype preserves text and history through ${inputBackend}`, async ({ page }) => {
		if (inputBackend === 'textarea')
			await page.addInitScript(() => {
				Reflect.deleteProperty(window, 'EditContext');
			});
		await openEditor(page);
		const input = page.locator('.stanza-editor-input');
		await input.focus();
		await input.press('Insert');
		try {
			for (const composition of [false, true]) {
				for (const text of ['e\u0301', '👩‍💻', '🇨🇳', '😀', '中']) {
					await page.evaluate(() => {
						const editor = window.ashTextModelIntegration.getControl();
						editor.setValue('ab😀e\u0301z\nend');
						editor.setPosition({ lineNumber: 1, column: 2 });
						editor.focus();
					});
					if (composition) {
						await input.evaluate((element, text) => {
							const native = (
								element as HTMLElement & {
									editContext?: EventTarget & {
										readonly selectionStart: number;
										readonly selectionEnd: number;
										updateText(start: number, end: number, text: string): void;
										updateSelection(start: number, end: number): void;
									};
								}
							).editContext;
							const target = native ?? element;
							target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
							if (native) {
								const start = native.selectionStart;
								const end = native.selectionEnd;
								native.updateText(start, end, text);
								native.updateSelection(start + text.length, start + text.length);
								native.dispatchEvent(
									Object.assign(new Event('textupdate'), {
										text,
										updateRangeStart: start,
										updateRangeEnd: end,
										selectionStart: start + text.length,
										selectionEnd: start + text.length,
									}),
								);
							} else {
								const textarea = element as HTMLTextAreaElement;
								textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
								target.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
							}
							target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
						}, text);
					} else {
						await page.keyboard.insertText(text);
					}
					await expect
						.poll(() =>
							page.evaluate(() => ({
								text: window.ashTextModelIntegration.getValue(),
								selection: window.ashTextModelIntegration.getControl().getPosition(),
							})),
						)
						.toEqual({
							text: `a${text}😀e\u0301z\nend`,
							selection: { lineNumber: 1, column: 2 + text.length },
						});
					await input.press('ControlOrMeta+z');
					await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('ab😀e\u0301z\nend');
					await input.press('ControlOrMeta+Shift+z');
					await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(`a${text}😀e\u0301z\nend`);
					await expect(input).toBeFocused();
				}
			}
		} finally {
			await input.press('Insert');
		}
	});
}

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
	await expect(input).toHaveCSS('opacity', '0');
	await expect(input).toHaveCSS('width', '1px');
	await expect(input).toBeFocused();
	await input.evaluate(element => {
		const textArea = element as HTMLTextAreaElement;
		textArea.setRangeText('xy', textArea.selectionStart, textArea.selectionEnd, 'end');
		textArea.setSelectionRange(1, 1);
		textArea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'xy' }));
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^xyfn main/u);
	await expect
		.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection()))
		.toEqual({
			startLineIndex: 0,
			startColumnIndex: 1,
			endLineIndex: 0,
			endColumnIndex: 1,
		});
	await expect
		.poll(() =>
			input.evaluate(element => {
				const caret = element.closest('.stanza-editor')!.querySelector('.stanza-editor-caret.primary')!;
				return Math.abs(element.getBoundingClientRect().left - caret.getBoundingClientRect().left);
			}),
		)
		.toBeLessThan(2);
	await input.evaluate(element => {
		element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'xy' }));
	});
	await expect(editor).not.toHaveClass(/\bcomposing\b/u);
	await expect(input).toHaveCSS('opacity', '0');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^fn main/u);
});

test('text-model editor supports Rust syntax and symbol navigation without gutter symbol icons', async ({ page }) => {
	await openEditor(page);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSyntaxAnalysisCount())).toBe(0);
	await expect(page.locator('.stanza-editor-token.token-keyword')).toHaveText('fn');
	await expect(page.locator('.cdr.squiggly-error')).toHaveCount(0);
	await expect(page.locator('.stanza-editor-symbol-icon')).toHaveCount(0);

	const input = page.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.press('ControlOrMeta+Shift+o');
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

test('editor scrollbar configuration updates visibility and track dimensions', async ({ page }) => {
	await openEditor(page);
	const horizontal = page.locator('.ash-smooth-scrollable > .ash-scrollbar-track-horizontal');
	const vertical = page.locator('.ash-smooth-scrollable > .ash-scrollbar-track-vertical');
	await page.evaluate(() =>
		window.ashTextModelIntegration.setScrollbar({
			horizontal: 'visible',
			vertical: 'visible',
			horizontalScrollbarSize: 18,
			verticalScrollbarSize: 22,
		}),
	);
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
			scrollbar: {
				vertical: 'visible',
				horizontal: 'visible',
				verticalSliderSize: 6,
				horizontalSliderSize: 4,
				scrollByPage: true,
			},
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
	await vertical.click({ position: { x: box.width / 2, y: box.height - 3 } });
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(520);
	await page.evaluate(() => window.ashTextModelIntegration.setScrollbar({ scrollByPage: false }));
	await page.locator('.decorationsOverviewRuler').dispatchEvent('pointerdown', {
		button: 0,
		buttons: 1,
		clientX: box.x + box.width / 2,
		clientY: box.y + box.height - 3,
	});
	await expect.poll(() => editor.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(520);
});

test('editor scrollbar arrows support click, hold, keyboard and runtime removal', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		window.ashTextModelIntegration.setValue(Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'));
		window.ashTextModelIntegration.setScrollbar({
			vertical: 'visible',
			horizontal: 'visible',
			verticalHasArrows: true,
			horizontalHasArrows: true,
			arrowSize: 18,
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
	const dialog = page.getByRole('dialog', { name: /^Type a line number and optional column/u });
	await expect(dialog).toBeVisible();
	const lineInput = dialog.getByRole('combobox', { name: /^Type a line number and optional column/u });
	await expect(lineInput).toBeFocused();
	await lineInput.fill(':2:1');
	await lineInput.press('Enter');
	await expect(dialog).toBeHidden();
	await expect(input).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection().startLineIndex)).toBe(1);
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
	await expect
		.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection()))
		.toEqual({
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
	await expect
		.poll(() => page.evaluate(() => window.ashTextModelIntegration.getSelection()))
		.toEqual({
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
		textArea.dispatchEvent(
			new ClipboardEvent('cut', {
				bubbles: true,
				cancelable: true,
				clipboardData: new DataTransfer(),
			}),
		);
	});
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toMatch(/^main\(\)/u);
});

function assertBox(
	box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null,
	name: string,
): asserts box is { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
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

for (const editContext of [true, false]) {
	test(`editor Tab navigation has one input stop with ${editContext ? 'NativeEditContext' : 'textarea'}`, async ({ page }) => {
		if (!editContext) {
			await page.addInitScript(() => {
				Reflect.deleteProperty(window, 'EditContext');
			});
		}
		await openEditor(page);
		await page.evaluate(() => {
			const editor = window.ashTextModelIntegration.getControl();
			editor.updateOptions({
				tabFocusMode: true,
				tabIndex: 0,
				minimap: { enabled: false },
				scrollbar: { vertical: 'hidden', horizontal: 'hidden' },
			});
			const before = document.createElement('button');
			before.textContent = 'Before editor';
			const after = document.createElement('button');
			after.textContent = 'After editor';
			const root = document.getElementById('editor-root')!;
			root.before(before);
			root.after(after);
			editor.focus();
		});
		const input = page.locator('.stanza-editor-input');
		const before = page.getByRole('button', { name: 'Before editor', exact: true });
		const after = page.getByRole('button', { name: 'After editor', exact: true });
		await expect(input).toBeFocused();
		await expect(input).toHaveJSProperty('tagName', editContext ? 'DIV' : 'TEXTAREA');
		await input.press('Shift+Tab');
		await expect(before).toBeFocused();
		await before.press('Tab');
		await expect(input).toBeFocused();
		await input.press('Tab');
		await expect(after).toBeFocused();
		await after.press('Shift+Tab');
		await expect(input).toBeFocused();
		await expect(page.locator('.stanza-editor')).toHaveAttribute('tabindex', '-1');
		await expect(input).toHaveAttribute('tabindex', '0');
		await expect(input).toHaveAttribute('aria-multiline', 'true');
		await input.press('Shift+Tab');
		await expect(before).toBeFocused();
		await page.evaluate(() => window.ashTextModelIntegration.getControl().updateOptions({ tabIndex: -1 }));
		await before.press('Tab');
		await expect(after).toBeFocused();
		await after.press('Shift+Tab');
		await expect(before).toBeFocused();
		await page.evaluate(() => window.ashTextModelIntegration.getControl().updateOptions({ tabIndex: 0, readOnly: true }));
		await before.press('Tab');
		await expect(input).toBeFocused();
		await expect(input).toHaveAttribute('aria-readonly', 'true');
		await input.press('Tab');
		await expect(after).toBeFocused();
	});
}

test('extension snippet completions accept, navigate placeholders and undo in the workbench editor', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.getModel()!.setLanguage('javascript');
		editor.setValue('cla');
		editor.setPosition({ lineNumber: 1, column: 4 });
		editor.focus();
	});
	await page.keyboard.press('Control+Space');
	const option = page.locator('.stanza-editor-completion-option').filter({ hasText: 'Class Definition' });
	await expect(option).toHaveCount(1);
	await expect(option).toHaveAttribute('role', 'option');
	await expect(option).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Enter');
	const expanded = 'class name {\n\tconstructor(parameters) {\n\t\t\n\t}\n}';
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe(expanded);
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getSelection())).toMatchObject({ startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 });
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('cla');
	await page.keyboard.press('Control+Space');
	await expect(option).toHaveCount(1);
	await page.keyboard.press('Enter');
	await page.keyboard.type('Widget');
	await page.keyboard.press('Tab');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getSelection())).toMatchObject({ startLineNumber: 2, startColumn: 14, endLineNumber: 2, endColumn: 24 });
	await page.keyboard.press('Shift+Tab');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getControl().getSelection())).toMatchObject({ startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 13 });
	await page.keyboard.press('Tab');
	await page.keyboard.type('value');
	await page.keyboard.press('Tab');
	await page.keyboard.type('// body');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('class Widget {\n\tconstructor(value) {\n\t\t// body\n\t}\n}');
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashTextModelIntegration.dispose());
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`formatters select, persist a language default, restore focus and undo in ${locale}`, async ({ page }) => {
		await page.goto('/textModel.html');
		await page.waitForFunction(() => !!window.ashTextModelIntegration);
		await page.evaluate(locale => {
			window.ashTextModelIntegration.enableFormatting(locale);
			window.ashTextModelIntegration.setValue('original');
			window.ashTextModelIntegration.getControl().focus();
			void window.ashTextModelIntegration.formatDocument();
		}, locale);
		const input = page.locator('.ash-quick-pick').getByRole('combobox');
		await expect(input).toHaveAttribute('placeholder', locale === 'en' ? 'Select a Formatter' : '选择格式化程序');
		await input.fill(locale === 'en' ? 'Configure Default Formatter' : '配置默认格式化程序');
		await input.press('Enter');
		await expect(input).toHaveAttribute('placeholder', locale === 'en' ? 'Select the Default Formatter for rust' : '选择 rust 的默认格式化程序');
		await input.fill('beta.format');
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('BETA');
		expect(await page.evaluate(() => window.ashTextModelIntegration.defaultFormatter())).toBe('beta.format');
		await expect(page.locator('#editor-root .stanza-editor-input').first()).toBeFocused();
		await page.evaluate(() => window.ashTextModelIntegration.getControl().getModel()!.undo());
		expect(await page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('original');
		await page.evaluate(() => window.ashTextModelIntegration.formatDocument());
		await expect(page.locator('.ash-quick-pick')).not.toBeVisible();
		expect(await page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('BETA');
	});
}

test('format on type uses the input event and is one undo step with the typed trigger', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.waitForFunction(() => !!window.ashTextModelIntegration);
	await page.evaluate(() => {
		window.ashTextModelIntegration.enableFormatting('en');
		window.ashTextModelIntegration.setValue('alpha');
		const editor = window.ashTextModelIntegration.getControl();
		editor.updateOptions({ formatOnType: true });
		editor.setPosition({ lineNumber: 1, column: 6 });
		editor.focus();
	});
	await page.keyboard.type(';');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('ALPHA;');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashTextModelIntegration.getValue())).toBe('alpha');
});

test('formatter choice cancels on cursor changes and readonly formatting does not open a picker', async ({ page }) => {
	await page.goto('/textModel.html');
	await page.waitForFunction(() => !!window.ashTextModelIntegration);
	await page.evaluate(() => {
		window.ashTextModelIntegration.enableFormatting('en');
		void window.ashTextModelIntegration.formatDocument();
	});
	await expect(page.locator('.ash-quick-pick')).toBeVisible();
	await page.evaluate(() => window.ashTextModelIntegration.getControl().setPosition({ lineNumber: 2, column: 1 }));
	await expect(page.locator('.ash-quick-pick')).not.toBeVisible();
	await page.evaluate(async () => {
		window.ashTextModelIntegration.getControl().updateOptions({ readOnly: true });
		await window.ashTextModelIntegration.formatDocument();
	});
	await expect(page.locator('.ash-quick-pick')).not.toBeVisible();
});

test('minimap section headers use comment tokens and live MARK, region, pattern and font settings', async ({ page }) => {
	await openEditor(page);
	await page.evaluate(() => {
		const editor = window.ashTextModelIntegration.getControl();
		editor.updateOptions({ minimap: { enabled: true, size: 'fit', maxColumn: 160 } });
		editor.setValue(
			[
				'// MARK: First',
				'fn first() {}',
				'// #region Region',
				'fn second() {}',
				'// #endregion',
				'let fake = "MARK: Fake";',
				'// PART Third',
				...Array.from({ length: 100 }, () => 'fn more() {}'),
			].join('\n'),
		);
	});
	const labels = () =>
		page.evaluate(() =>
			window.ashTextModelIntegration
				.getControl()
				.getModel()!
				.getAllDecorations()
				.map(decoration => decoration.options.minimap?.sectionHeaderText)
				.filter(Boolean)
				.sort(),
		);
	await expect.poll(labels).toEqual(['First', 'Region']);
	const pixels = () => page.locator('.minimap canvas').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
	const original = await pixels();
	await page.evaluate(() => window.ashTextModelIntegration.getControl().updateOptions({ minimap: { sectionHeaderFontSize: 20, sectionHeaderLetterSpacing: 3 } }));
	await expect.poll(pixels).not.toBe(original);
	await page.evaluate(() => window.ashTextModelIntegration.getControl().updateOptions({ minimap: { showRegionSectionHeaders: false, showMarkSectionHeaders: false } }));
	await expect.poll(labels).toEqual([]);
	const withoutHeaders = await pixels();
	await page.evaluate(() => window.ashTextModelIntegration.getControl().updateOptions({ minimap: { showMarkSectionHeaders: true, markSectionHeaderRegex: 'PART (?<label>.*)' } }));
	await expect.poll(labels).toEqual(['Third']);
	await expect.poll(pixels).not.toBe(withoutHeaders);
	await page.evaluate(() => window.ashTextModelIntegration.getControl().setValue('// PART Renamed\nfn next() {}'));
	await expect.poll(labels).toEqual(['Renamed']);
	await page.evaluate(() => window.ashTextModelIntegration.getControl().updateOptions({ minimap: { enabled: false } }));
	await expect.poll(labels).toEqual([]);
});

test('minimap inline diagnostics and gutter changes keep distinct positions through wrapping, folding and themes', async ({ page }) => {
	await openEditor(page);
	for (const theme of ['light', 'dark', 'contrast', 'contrastLight'] as const) {
		await page.evaluate(theme => window.ashTextModelIntegration.setTheme(theme), theme);
		for (const wrap of ['off', 'on'] as const) {
			for (const folded of [false, true]) {
				await page.evaluate(
					({ wrap, folded }) => {
						const editor = window.ashTextModelIntegration.getControl();
						editor.getModel()!.setLanguage('plaintext');
						editor.updateOptions({
							wordWrap: wrap,
							lineHeight: 20,
							smoothScrolling: false,
							padding: { top: 0, bottom: 0 },
							minimap: { enabled: true, size: 'fit', scale: 1 },
						});
						editor.setValue(Array.from({ length: 20 }, () => 'a'.repeat(180)).join('\n'));
						editor.setHiddenAreas(
							folded
								? [
										editor.getModel()!.validateRange({
											startLineNumber: 2,
											startColumn: 1,
											endLineNumber: 4,
											endColumn: 181,
										}),
									]
								: [],
						);
						editor.getModel()!.deltaDecorations(
							[],
							[
								{
									range: { startLineNumber: 8, startColumn: 10, endLineNumber: 8, endColumn: 160 },
									options: {
										description: 'audit diagnostic',
										minimap: { color: '#ff00ff', position: 1 },
									},
								},
								{
									range: { startLineNumber: 8, startColumn: 1, endLineNumber: 8, endColumn: 2 },
									options: {
										description: 'audit change',
										minimap: { color: '#00ffff', position: 2 },
									},
								},
							],
						);
					},
					{ wrap, folded },
				);
				await expect
					.poll(
						() =>
							page.locator('.minimap canvas').evaluate((canvas: HTMLCanvasElement) => {
								const editor = window.ashTextModelIntegration.getControl();
								const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
								const inline: number[] = [];
								const gutter = new Set<number>();
								for (let offset = 0; offset < data.length; offset += 4) {
									if (data[offset + 3] !== 255 || data[offset + 2] !== 255) continue;
									if (data[offset] === 255 && data[offset + 1] === 0) inline.push(offset / 4);
									if (data[offset] === 0 && data[offset + 1] === 255) gutter.add((offset / 4) % canvas.width);
								}
								const expectedTop = Math.floor((editor.getTopForLineNumber(8) / 20) * editor.getLayoutInfo().minimap.minimapLineHeight);
								return {
									inline: inline.some(pixel => pixel % canvas.width > 5),
									gutter: [...gutter].sort((a, b) => a - b),
									top: inline.length ? Math.floor(inline[0]! / canvas.width) - expectedTop : null,
								};
							}),
						{ message: `${theme}, wrap=${wrap}, folded=${folded}` },
					)
					.toEqual({ inline: true, gutter: [2, 3, 4], top: 0 });
			}
		}
	}
});

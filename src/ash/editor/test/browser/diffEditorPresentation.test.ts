import { expect, type Locator } from '@playwright/test';
import { suite, test, teardown } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('native multi-file review preview', () => {
	const browserTests = useBrowserTests();
	teardown(async () => { await browserTests.page.evaluate(() => window.ashDiffIntegration?.dispose()); });

	test('preview copies unmounted source lines and opens the same editable model with undo intact', async () => {
		const { page } = browserTests;
		await page.goto('/diff.html?locale=zh-CN');
		await page.waitForFunction(() => !!window.ashDiffIntegration);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('review'));
		const host = page.locator('#title-comparison');
		const preview = host.locator('.ash-diff-review-preview').first();
		await expect(preview).toBeVisible();
		await expect(host.locator('.stanza-editor')).toHaveCount(0);
		expect(await host.locator('.ash-diff-review-row').count()).toBeLessThan(100);
		await preview.focus();
		await preview.press('ControlOrMeta+a');
		const copied = await preview.evaluate(node => {
			const data = new DataTransfer();
			node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
			return data.getData('text/plain');
		});
		expect(copied.split('\n')).toHaveLength(400);
		expect(copied).toContain('const changed = "审阅 🤖";');
		expect(copied).toContain('const line399');
		await preview.locator('.modified [data-review-row="100"] .ash-diff-review-number').click();
		await preview.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readReviewState().shared)).toBe(true);
		expect((await page.evaluate(() => window.ashDiffIntegration.readReviewState())).selection?.[0].startLineNumber).toBe(101);
		await page.evaluate(() => window.ashDiffIntegration.editReviewInFullEditor('const edited = "<b>unsaved 中文 🤖</b>";'));
		expect((await page.evaluate(() => window.ashDiffIntegration.readReviewState())).canUndo).toBe(true);
		await page.evaluate(() => window.ashDiffIntegration.returnToReview());
		await expect(host.locator('.ash-diff-review-text').filter({ hasText: 'unsaved 中文' }).first()).toBeVisible();
		await expect(host.locator('b')).toHaveCount(0);
		await host.getByRole('button', { name: '打开完整编辑器', exact: true }).first().click();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readReviewState().shared)).toBe(true);
		await page.evaluate(() => window.ashDiffIntegration.undoReviewInFullEditor());
		expect((await page.evaluate(() => window.ashDiffIntegration.readReviewState())).text).toContain('const changed = "审阅 🤖";');
		await page.evaluate(() => window.ashDiffIntegration.returnToReview());
		await expect(host.locator('.modified .ash-diff-review-text').filter({ hasText: '审阅 🤖' }).first()).toBeVisible();
		await page.screenshot({ path: browserTests.info.outputPath('native-review-zh.png') });
	});

	test('preview keeps the remaining file content visible while its sticky viewport leaves the screen', async () => {
		const { page } = browserTests;
		await page.goto('/diff.html');
		await page.waitForFunction(() => !!window.ashDiffIntegration);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('review'));
		const host = page.locator('#title-comparison .stanza-multi-diff-editor');
		await expect(host.locator('.ash-diff-review-preview').first()).toBeVisible();
		const section = host.locator('.stanza-multi-diff-editor-section').first();
		const bottom = await section.evaluate(node => (node as HTMLElement).offsetTop + (node as HTMLElement).offsetHeight);
		const column = section.locator('.ash-diff-review-column.modified');
		const gutter = column.locator('.ash-diff-review-number').first();
		const gutterLeft = (await gutter.boundingBox())!.x;
		await column.evaluate(node => { node.scrollLeft = 120; });
		await expect.poll(async () => (await gutter.boundingBox())!.x).toBeCloseTo(gutterLeft, 1);
		expect(await column.evaluate(node => node.scrollLeft)).toBe(120);
		await column.evaluate(node => { node.scrollLeft = 0; });
		// Exercise both directions through the last viewport and the next file's header.
		for (const top of [bottom - 250, bottom - 150, bottom - 50, bottom + 20, bottom - 100, bottom - 220]) {
			await host.evaluate((node, top) => { node.scrollTop = top; }, top);
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			const missing = await host.evaluate(node => {
				const viewport = node.getBoundingClientRect();
				return [...node.querySelectorAll('.stanza-multi-diff-editor-section')].map(section => {
					const body = section.querySelector('.stanza-multi-diff-editor-body')!.getBoundingClientRect();
					const header = section.querySelector('.stanza-multi-diff-editor-header')!.getBoundingClientRect();
					const start = Math.max(viewport.top, body.top, header.bottom);
					const end = Math.min(viewport.bottom, body.bottom);
					if (end <= start) return 0;
					const column = section.querySelector('.ash-diff-review-column.modified')!;
					const clip = column.getBoundingClientRect();
					const intervals = [...column.querySelectorAll('.ash-diff-review-row')].map(row => {
						const bounds = row.getBoundingClientRect();
						return [Math.max(start, clip.top, bounds.top), Math.min(end, clip.bottom, bounds.bottom)] as const;
					}).filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
					let cursor = start;
					let covered = 0;
					for (const [from, to] of intervals) {
						if (to > cursor) { covered += to - Math.max(from, cursor); cursor = to; }
					}
					return end - start - covered;
				});
			});
			expect(Math.max(...missing), `unpainted content at scroll ${top}`).toBeLessThanOrEqual(2);
		}
	});

	test('preview preserves fold geometry, themes and navigation while wrapping delegates to the full editor', async () => {
		const { page } = browserTests;
		await page.goto('/diff.html');
		await page.waitForFunction(() => !!window.ashDiffIntegration);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('review'));
		const host = page.locator('#title-comparison');
		const viewport = host.locator('.stanza-multi-diff-editor');
		await expect(host.locator('.ash-diff-review-preview').first()).toBeVisible();
		const disclosure = host.locator('.ash-diff-review-column.original .hidden-region').first();
		await disclosure.click();
		await expect(host.locator('.ash-diff-review-text').filter({ hasText: 'const line0 ' }).first()).toBeVisible();
		for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light']) {
			await page.evaluate(theme => window.ashDiffIntegration.setTheme(theme), theme);
			const geometry = await host.locator('.ash-diff-review-preview').first().evaluate(node => {
				const style = getComputedStyle(node);
				const row = node.querySelector('.ash-diff-review-row')!.getBoundingClientRect();
				return { foreground: style.color, background: style.backgroundColor, lineHeight: parseFloat(style.lineHeight), height: row.height };
			});
			expect(geometry.height).toBe(geometry.lineHeight);
			expect(geometry.foreground).not.toBe(geometry.background);
		}
		await viewport.evaluate(node => { node.scrollTop = 2000; });
		await expect(host.locator('.ash-diff-review-row')).not.toHaveCount(0);
		await page.evaluate(() => window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.wordWrap', 'on'));
		await expect(host.locator('.ash-diff-review-preview')).toHaveCount(0);
		await expect(host.locator('.stanza-diff-editor').first()).toBeVisible();
		await page.evaluate(() => window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.wordWrap', 'off'));
		await expect(host.locator('.stanza-editor')).toHaveCount(0);
		await expect(host.locator('.ash-diff-review-preview').first()).toBeVisible();
		await expect(host.getByRole('button', { name: 'Open Full Editor', exact: true }).first()).toHaveAttribute('type', 'button');
	});
});

suite('diff character backgrounds', () => {
	const browserTests = useBrowserTests();
	teardown(async () => {
		await browserTests.page.evaluate(() => window.ashDiffIntegration?.dispose());
	});

	for (const sideBySide of [false, true]) {
		test(`character backgrounds cover the display row in ${sideBySide ? 'side by side' : 'inline'} diff`, async () => {
			const { page } = browserTests;
			await page.goto('/diff.html?locale=zh-CN');
			await page.waitForFunction(() => !!window.ashDiffIntegration);
			await page.locator('#single').evaluate(node => { node.style.height = '520px'; });
			await page.evaluate(sideBySide => {
				window.ashDiffIntegration.setViewMode(sideBySide, false, 900);
				window.ashDiffIntegration.setComparisonText('shared\n    .by_index(0)\nlast', 'shared\n    .by_name(&name)\nlast');
			}, sideBySide);
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
			const original = page.locator(sideBySide ? '#single .original' : '#single .modified .stanza-diff-inline-original-line');
			const modified = page.locator('#single .modified');
			for (const lineHeight of [24, 36]) {
				await page.evaluate(lineHeight => window.ashDiffIntegration.setFontOptions({ fontSize: 17, lineHeight }), lineHeight);
				for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light']) {
					await page.evaluate(theme => window.ashDiffIntegration.setTheme(theme), theme);
					await assertRowBackgrounds(original.locator('.stanza-diff-inline-removed'), lineHeight);
					await assertRowBackgrounds(modified.locator('.stanza-diff-inline-added'), lineHeight);
				}
			}
			await page.screenshot({ path: browserTests.info.outputPath(`${sideBySide ? 'side-by-side' : 'inline'}.png`) });
		});

		test(`wrapped character backgrounds retain row geometry and source text in ${sideBySide ? 'side by side' : 'inline'} diff`, async () => {
			const { page } = browserTests;
			await page.goto('/diff.html');
			await page.waitForFunction(() => !!window.ashDiffIntegration);
			const originalText = '    const value = "' + 'before 😀 '.repeat(20) + '";';
			await page.locator('#single').evaluate(node => { node.style.height = '600px'; });
			await page.evaluate(({ sideBySide, originalText }) => {
				window.ashDiffIntegration.setViewMode(sideBySide, false, 900);
				window.ashDiffIntegration.setFontOptions({ fontSize: 17, lineHeight: 36 });
				window.ashDiffIntegration.setWrapping('wordWrapColumn', 24);
				window.ashDiffIntegration.setTheme('vs');
				window.ashDiffIntegration.setComparisonText(originalText, originalText.replaceAll('before 😀', 'after 🤖'));
			}, { sideBySide, originalText });
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
			const original = page.locator(sideBySide ? '#single .original' : '#single .modified .stanza-diff-inline-original-line');
			await assertRowBackgrounds(original.locator('.stanza-diff-inline-removed'), 36);
			await assertRowBackgrounds(page.locator('#single .modified .stanza-diff-inline-added'), 36);
			if (!sideBySide) {
				const rows = original.locator('.ash-diff-original-row');
				expect(await rows.count()).toBeGreaterThan(2);
				await expect(original).toHaveText(originalText);
				const geometry = await original.evaluate(node => {
					const parent = node.getBoundingClientRect();
					return [...node.querySelectorAll('.ash-diff-original-row')].every(row => {
						const range = document.createRange();
						range.selectNodeContents(row);
						const text = range.getBoundingClientRect();
						return text.right <= parent.right + 1 && text.bottom <= parent.bottom + 1;
					});
				});
				expect(geometry).toBe(true);
				const copied = await original.evaluate(node => {
					const selection = document.getSelection()!;
					const range = document.createRange();
					range.selectNodeContents(node);
					selection.removeAllRanges();
					selection.addRange(range);
					const data = new DataTransfer();
					document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, cancelable: true }));
					selection.removeAllRanges();
					return data.getData('text/plain');
				});
				expect(copied).toBe(originalText);
			}
		});
	}
});

suite('diff action visibility', () => {
	const browserTests = useBrowserTests();
	teardown(async () => {
		await browserTests.page.evaluate(() => window.ashDiffIntegration?.dispose());
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`gutter actions and legacy arrows follow layout, writability and their own settings (${locale})`, async () => {
			const { page } = browserTests;
			await page.goto(`/diff.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashDiffIntegration);
			await page.evaluate(() => {
				window.ashDiffIntegration.setEditorFeatures({ glyphMargin: false, renderMarginRevertIcon: false });
				window.ashDiffIntegration.setViewMode(false, false, 900);
				window.ashDiffIntegration.setComparisonText('shared\nbefore\nlast', 'shared\nafter\nlast');
			});
			const editor = page.locator('#single');
			const gutter = editor.locator('.ash-diff-gutter');
			const revert = editor.getByRole('button', { name: locale === 'zh-CN' ? '还原更改' : 'Revert change', exact: true });
			await expect(revert).toHaveCount(1);
			await expect(revert.locator('[data-ash-icon-id="discard"]')).toHaveCount(1);
			for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light']) {
				await page.evaluate(theme => window.ashDiffIntegration.setTheme(theme), theme);
				await expect(gutter).toBeVisible();
				expect(await editor.evaluate(node => {
					const gutter = node.querySelector('.ash-diff-gutter')!.getBoundingClientRect();
					const modified = node.querySelector('.modified')!.getBoundingClientRect();
					return { width: gutter.width, gap: modified.left - gutter.right };
				})).toEqual({ width: 35, gap: 0 });
			}
			await revert.focus();
			await page.keyboard.press('Space');
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('shared\nbefore\nlast');
			await page.evaluate(() => window.ashDiffIntegration.undo());
			await expect(revert).toHaveCount(1);

			await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: true }));
			await expect(gutter).toBeHidden();
			await expect(revert).toHaveCount(0);
			expect(await editor.locator('.stanza-diff-editor-side.modified').evaluate(node => node.getBoundingClientRect().left - node.parentElement!.getBoundingClientRect().left)).toBe(0);

			await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: false, renderGutterMenu: false, renderMarginRevertIcon: true }));
			await expect(gutter).toBeHidden();
			await expect(revert).toHaveCount(0);
			await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
			await expect(revert).toHaveCount(1);
			await expect(gutter).toBeHidden();
			await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderGutterMenu: true, renderMarginRevertIcon: false }));
			await expect(gutter).toBeVisible();
			await expect(revert).toHaveCount(1);
			await expect(revert.locator('[data-ash-icon-id="arrow-right"]')).toHaveCount(1);
		});
	}
});

suite('multi diff resource headers', () => {
	const browserTests = useBrowserTests();
	teardown(async () => {
		await browserTests.page.evaluate(() => window.ashDiffIntegration?.dispose());
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`shows the current filename and directory, with the old resource only for renames (${locale})`, async () => {
			const { page } = browserTests;
			await page.goto(`/diff.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashDiffIntegration);
			await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('paths'));
			const host = page.locator('#title-comparison');
			const headers = host.locator('.stanza-multi-diff-editor-header');
			const titles = headers.locator('.stanza-multi-diff-editor-title');
			await expect(titles.first().locator('.ash-icon-label-text')).toHaveText(['chat.json']);
			await expect(titles.first().locator('.ash-icon-label-description')).toHaveText(['extensions/language-pack-zh-cn/translations']);
			await expect(titles.first().locator('.ash-multi-diff-resource.original')).toHaveCount(0);
			await expect(titles.nth(1).locator('.ash-icon-label-text')).toHaveText(['second.ts', 'second.ts']);
			await expect(titles.nth(1).locator('.ash-icon-label-description')).toHaveText(['src/renamed folder/包含空格的目录', 'src/previous folder/包含空格的目录']);
			await expect(titles.nth(1).locator('.ash-multi-diff-rename-status')).toHaveText('R');
			await expect(titles.nth(1).locator('.original .ash-icon-label')).toHaveClass(/strikethrough/);
			await expect(host.locator('.stanza-multi-diff-editor-labels')).toHaveCount(0);
			for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light'] as const) {
				await page.evaluate(theme => window.ashDiffIntegration.setTitleTheme(theme), theme);
				for (const width of [320, 680, 1000]) {
					await host.evaluate((node, width) => { node.style.width = `${width}px`; }, width);
					await page.evaluate(width => window.ashDiffIntegration.resizeTitleComparison(width), width);
					await expect.poll(() => headers.evaluateAll(nodes => nodes.every(node => {
						const header = node.getBoundingClientRect();
						return [...node.querySelectorAll('.stanza-multi-diff-editor-title .ash-icon-label-text, .stanza-multi-diff-editor-title .ash-icon-label-description')].every(label => {
							const bounds = label.getBoundingClientRect();
							return bounds.top >= header.top && bounds.bottom <= header.bottom && bounds.height < header.height
								&& bounds.left >= header.left && bounds.right <= header.right;
						});
					}))).toBe(true);
				}
			}
			await expect(titles.first().locator('.ash-icon-label')).toHaveAttribute('title', 'extensions/language-pack-zh-cn/translations/chat.json');
			const toggle = headers.first().getByRole('button').first();
			await toggle.focus();
			await page.keyboard.press('Enter');
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			await page.keyboard.press('Space');
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');
			await page.evaluate(() => window.ashDiffIntegration.setTitleTheme('vs'));
			await host.evaluate(node => { node.style.width = '680px'; });
			await page.evaluate(() => window.ashDiffIntegration.resizeTitleComparison(680));
			await host.screenshot({ path: browserTests.info.outputPath(`multi-diff-headers-${locale}.png`) });
		});
	}
});

async function assertRowBackgrounds(backgrounds: Locator, lineHeight: number): Promise<void> {
	await expect(backgrounds.first()).toBeVisible();
	await expect.poll(() => backgrounds.evaluateAll((nodes, lineHeight) => nodes.every(node => {
		const box = node.getBoundingClientRect();
		const row = node.closest('.view-overlay-line, .view-line, .ash-diff-original-row, .stanza-diff-inline-original-line')!.getBoundingClientRect();
		return Math.abs(box.height - lineHeight) < 0.5 && Math.abs(box.top - row.top) < 0.5
			&& getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)';
	}), lineHeight)).toBe(true);
}

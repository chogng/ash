import { expect, type Locator } from '@playwright/test';
import { suite, test, teardown } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

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

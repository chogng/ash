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

suite('diff overlay measurements', () => {
	const browserTests = useBrowserTests();
	teardown(async () => { await browserTests.page.evaluate(() => window.ashDiffIntegration?.dispose()); });

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light']) {
			test(`hidden-region overlays scroll and reveal without measuring their content (${locale}, ${theme})`, async () => {
				const { page } = browserTests;
				await page.goto(`/diff.html?locale=${locale}`);
				await page.waitForFunction(() => !!window.ashDiffIntegration);
				await page.evaluate(theme => window.ashDiffIntegration.setTheme(theme), theme);
				await page.evaluate(() => {
					const lines = Array.from({ length: 600 }, (_, index) => `line ${index}`);
					window.ashDiffIntegration.setComparisonText(lines.join('\n'), lines.map((line, index) => index % 20 === 10 ? `CHANGED ${index}` : line).join('\n'));
				});
				await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
				await page.evaluate(() => window.ashDiffIntegration.setHiddenRegions(true));
				const overlays = page.locator('#single .ash-diff-hidden-region');
				await expect.poll(() => overlays.count()).toBeGreaterThan(30);
				await expect(page.locator('#single .modified .ash-diff-hidden-region-disclosure button:visible').first()).toBeVisible();
				const controlsBefore = await overlays.locator('button').count();
				expect(controlsBefore).toBeLessThan((await overlays.count()) * 3);
				const orderBefore = await overlays.evaluateAll(nodes => nodes.map(node => node.getAttribute('widgetId')));
				const reads = await page.evaluate(async () => {
					const read = HTMLElement.prototype.getBoundingClientRect;
					let measurements = 0;
					HTMLElement.prototype.getBoundingClientRect = function () {
						if (this.classList.contains('ash-diff-hidden-region')) measurements++;
						return read.call(this);
					};
					try {
						for (const top of [400, 1000, 1600, 800, 0]) {
							window.ashDiffIntegration.scrollModified(top);
							await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
						}
						return measurements;
					} finally {
						HTMLElement.prototype.getBoundingClientRect = read;
					}
				});
				expect(reads).toBe(0);
				expect(await overlays.locator('button').count()).toBeGreaterThan(controlsBefore);
				expect(await overlays.evaluateAll(nodes => nodes.map(node => node.getAttribute('widgetId')))).toEqual(orderBefore);
				const before = await overlays.count();
				const reveal = page.locator('#single .modified .ash-diff-hidden-region-disclosure button:visible').first();
				await expect(reveal).toBeVisible();
				await reveal.focus();
				await expect(reveal).toHaveCSS('outline-style', 'solid');
				await reveal.press('Enter');
				await expect(overlays).toHaveCount(before - 2);
				await page.evaluate(async () => {
					window.ashDiffIntegration.scrollModified(1000);
					await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				});
				const widgetId = await page.locator('#single .modified .ash-diff-hidden-region:visible').first().getAttribute('widgetId');
				// Revealing lines can move this region out of view; keep observing the captured handle.
				const region = page.locator(`#single .modified [widgetId="${widgetId}"]`);
				const hiddenCount = async () => Number((await region.locator('.ash-diff-hidden-region-count').textContent())!.match(/\d+/)![0]);
				const countBeforeDrag = await hiddenCount();
				const handle = region.locator('.ash-diff-hidden-region-below');
				const bounds = await handle.boundingBox();
				expect(bounds).not.toBeNull();
				await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
				await page.mouse.down();
				await expect(handle).toHaveClass(/dragging/);
				await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2 - 40, { steps: 4 });
				await page.mouse.up();
				await expect.poll(hiddenCount).toBeLessThan(countBeforeDrag);
				await expect(page.locator('#single .modified .stanza-editor-input')).toBeFocused();

			});
		}
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
		test(`follows Flat and Modern geometry without replacing focused file headers (${locale})`, async () => {
			const { page } = browserTests;
			await page.goto(`/diff.html?locale=${locale}`);
			await page.waitForFunction(() => !!window.ashDiffIntegration);
			await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('paths'));
			const host = page.locator('#title-comparison');
			const toggles = host.locator('.stanza-multi-diff-editor-header-toggle');
			for (let index = 0; index < 2; index++) {
				await toggles.nth(index).focus();
				await page.keyboard.press('Enter');
				await expect(toggles.nth(index)).toHaveAttribute('aria-expanded', 'false');
			}
			await toggles.first().focus();
			await expect.poll(() => host.locator('.stanza-multi-diff-editor-section.collapsed .stanza-multi-diff-editor-body').evaluateAll(nodes =>
				nodes.every(node => getComputedStyle(node).display === 'none'))).toBe(true);
			await toggles.first().evaluate(node => { node.dataset.retainedHeader = 'true'; });
			for (const style of ['flat', 'modern'] as const) {
				await page.evaluate(style => window.ashDiffIntegration.updateTitleEditorConfiguration('workbench.layoutStyle', style), style);
				for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light'] as const) {
					await page.evaluate(theme => window.ashDiffIntegration.setTitleTheme(theme), theme);
					await expect.poll(() => host.evaluate(node => {
						const editor = node.querySelector('.stanza-multi-diff-editor')!;
						const sections = [...editor.querySelectorAll('.stanza-multi-diff-editor-section')];
						const first = sections[0]!.getBoundingClientRect();
						const second = sections[1]!.getBoundingClientRect();
						return {
							gap: second.top - first.bottom,
							inset: first.left - editor.getBoundingClientRect().left,
							radius: getComputedStyle(sections[0]!).borderTopLeftRadius,
							height: first.height,
						};
					})).toEqual({ gap: style === 'flat' ? 0 : 8, inset: style === 'flat' ? 0 : 8, radius: style === 'flat' ? '0px' : '6px', height: 34 });
					await expect(toggles.first()).toHaveAttribute('data-retained-header', 'true');
					await expect(toggles.first()).toBeFocused();
					await expect(toggles.first()).toHaveAttribute('aria-expanded', 'false');
				}
				await page.evaluate(() => window.ashDiffIntegration.setTitleTheme('vs'));
				await host.screenshot({ path: browserTests.info.outputPath(`multi-diff-${style}-${locale}.png`) });
			}
			await page.keyboard.press('Space');
			await expect(toggles.first()).toHaveAttribute('aria-expanded', 'true');
		});

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

suite('MultiDiff reused editor lifecycle', () => {
	const browserTests = useBrowserTests();
	teardown(async () => { await browserTests.page.evaluate(() => window.ashDiffIntegration?.dispose()); });

	test('compressed MultiDiff keeps native, wheel and restored positions in logical coordinates', async () => {
		const { page } = browserTests;
		await page.goto('/diff.html');
		await page.waitForFunction(() => !!window.ashDiffIntegration);
		await page.evaluate(async () => {
			await window.ashDiffIntegration.setMultiHiddenRegions(false);
			await window.ashDiffIntegration.showCompressedComparisons(4200);
		});
		const host = page.locator('#many .stanza-multi-diff-editor');
		expect(await host.evaluate(node => node.firstElementChild!.getBoundingClientRect().height)).toBe(8_000_000);
		await host.evaluate(node => { node.scrollTop = node.scrollHeight; });
		await expect(host.locator('.stanza-multi-diff-editor-title').last()).toHaveText('large-4199.ts');
		await expect(host.locator('.modified .stanza-editor-line-text').last()).toHaveText('line 99');
		await host.evaluate(node => { node.scrollTop = node.scrollHeight / 2; });
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeGreaterThan(4_000_000);
		const before = await page.evaluate(() => {
			window.ashDiffIntegration.saveCompressedPosition();
			return window.ashDiffIntegration.compressedLogicalScrollTop;
		});
		await host.dispatchEvent('wheel', { deltaY: 100 });
		await expect.poll(async () => (await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)) - before).toBeCloseTo(100, 0);
		await host.evaluate(node => { node.scrollTop = 0; });
		await expect(host.locator('.stanza-multi-diff-editor-title').first()).toHaveText('large-0.ts');
		await page.evaluate(() => window.ashDiffIntegration.restoreCompressedPosition());
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeCloseTo(before, 0);
		expect(await host.locator('.stanza-diff-editor').count()).toBeLessThanOrEqual(2);
	});

	for (const locale of ['en', 'zh-CN']) {
		for (const style of ['flat', 'modern'] as const) {
			test(`cross-file reuse preserves editing, scrolling and retired actions (${locale}, ${style})`, async () => {
				const { page } = browserTests;
				await page.goto(`/diff.html?locale=${locale}`);
				await page.waitForFunction(() => !!window.ashDiffIntegration);
				await page.evaluate(async style => {
					await window.ashDiffIntegration.showReusableComparisons(style);
					await window.ashDiffIntegration.revealReusableComparison(0);
					await window.ashDiffIntegration.editReusableComparison();
				}, style);
				const first = await page.evaluate(() => window.ashDiffIntegration.readReusableComparison());
				expect(first.left).toBe(100);
				expect(first.position).toEqual({ lineNumber: 20, column: 12 });
				expect(first.text).toMatch(/^unsaved after file 0/);
				const host = page.locator('#many');
				const action = host.locator('.ash-diff-gutter button').first();
				await expect(action).toBeVisible();
				const retired = await action.elementHandle();
				await page.evaluate(() => window.ashDiffIntegration.revealReusableComparison(1));
				const readonly = await page.evaluate(() => window.ashDiffIntegration.readReusableComparison());
				expect(readonly.readOnly).toBe(true);
				expect(readonly.label).toBe('After 1');
				await page.evaluate(() => window.ashDiffIntegration.focusReusableComparison());
				await page.keyboard.insertText('blocked');
				expect(await page.evaluate(() => window.ashDiffIntegration.readReusableComparison().text)).toBe(readonly.text);
				await page.evaluate(() => window.ashDiffIntegration.revealReusableComparison(2));
				const beforeRetiredAction = await page.evaluate(() => window.ashDiffIntegration.readReusableComparison().text);
				await retired!.evaluate(node => (node as HTMLButtonElement).click());
				expect(await page.evaluate(() => window.ashDiffIntegration.readReusableComparison().text)).toBe(beforeRetiredAction);
				await retired!.dispose();
				for (let index = 3; index < 16; index++) {
					await page.evaluate(index => window.ashDiffIntegration.revealReusableComparison(index), index);
					const current = await page.evaluate(() => window.ashDiffIntegration.readReusableComparison());
					expect(current.label).toBe(`After ${index}`);
					expect(current.readOnly).toBe(index % 2 === 1);
					expect(current.text).toMatch(new RegExp(`^after file ${index} `));
					expect(current.controlCount).toBeLessThanOrEqual(2);
				}
				await page.evaluate(() => window.ashDiffIntegration.revealReusableComparison(0));
				await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readReusableComparison().left), { timeout: 2000 }).toBe(100);
				const restored = await page.evaluate(() => window.ashDiffIntegration.readReusableComparison());
				expect(restored.controlCount).toBeLessThanOrEqual(2);
				expect(restored.position).toEqual(first.position);
				expect(restored.left).toBe(100);
				expect(restored.text).toBe(first.text);
				// Recycle again before a paint can finish the newly attached View's width.
				await page.evaluate(async () => {
					for (const index of [1, 0, 2, 0]) await window.ashDiffIntegration.revealReusableComparison(index);
				});
				await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readReusableComparison().left)).toBe(100);
				await expect(host.locator('.modified .stanza-editor-input')).toBeEnabled();
				await host.screenshot({ path: browserTests.info.outputPath(`reuse-${locale}-${style}.png`) });
				await page.evaluate(() => window.ashDiffIntegration.focusReusableComparison());
				await page.evaluate(() => window.ashDiffIntegration.collapseReusableComparisons());
				await expect(host.locator('.stanza-diff-editor')).toHaveCount(0);
				await expect(host.locator('.stanza-multi-diff-editor')).toBeFocused();
				const idle = await page.evaluate(() => window.ashDiffIntegration.readReusableComparison());
				expect(idle.attached).toBe(0);
				expect(idle.registered).toBeLessThanOrEqual(2);
				await page.evaluate(() => window.ashDiffIntegration.closeReusableComparisons());
				const closed = await page.evaluate(() => window.ashDiffIntegration.readReusableComparison());
				expect(closed.registered).toBe(0);
				expect(closed.attached).toBe(0);
			});
		}
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

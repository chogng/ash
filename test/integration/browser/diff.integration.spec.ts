import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

type DiffTestLocale = 'en' | 'zh-CN';

function localized(locale: DiffTestLocale, english: string, chinese: string): string {
	return locale === 'zh-CN' ? chinese : english;
}

async function openDiffPage(page: Page, locale: DiffTestLocale = 'en'): Promise<void> {
	await page.goto(`/diff.html?locale=${locale}`);
	await page.waitForFunction(() => !!window.ashDiffIntegration);
}

test('diff scrolling preserves overview markers and does not emit editor layout changes', async ({ page }) => {
	await openDiffPage(page);
	const original = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
	const modified = Array.from({ length: 200 }, (_, index) => `changed line ${index + 1}`).join('\n');
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(page.locator('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker').first()).toBeAttached();
	const result = await page.evaluate(async () => {
		const marker = document.querySelector('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker')!;
		const before = window.ashDiffIntegration.layoutEventCount;
		window.ashDiffIntegration.scrollModified(100);
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return {
			scrollTop: window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop,
			layoutEvents: window.ashDiffIntegration.layoutEventCount - before,
			markerRetained: marker === document.querySelector('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker'),
		};
	});
	expect(result).toEqual({ scrollTop: 100, layoutEvents: 0, markerRetained: true });
	const beforeResize = await page.evaluate(() => window.ashDiffIntegration.layoutEventCount);
	await page.locator('#single').evaluate(node => { node.style.width = '760px'; });
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.layoutEventCount)).toBeGreaterThan(beforeResize);
});

for (const theme of ['vs', 'hc-black']) {
	test(`diff scrolling retains unchanged overlay children and refreshes changed content in ${theme}`, async ({ page }) => {
		await openDiffPage(page, 'zh-CN');
		const original = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
		const modified = Array.from({ length: 200 }, (_, index) => `changed line ${index + 1}`).join('\n');
		await page.evaluate(([left, right, themeId]) => {
			window.ashDiffIntegration.setTheme(themeId);
			window.ashDiffIntegration.setViewMode(false, false, 900);
			window.ashDiffIntegration.setComparisonText(left, right);
		}, [original, modified, theme]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await expect(page.locator('#single .modified .view-overlays .cdr').first()).toBeAttached();
		const result = await page.evaluate(async () => {
			const host = document.querySelector('#single .modified')!;
			const decoration = host.querySelector('.view-overlays .view-overlay-line[data-line-index="2"] .cdr')!;
			const number = host.querySelector('.margin-view-overlays .view-overlay-line[data-line-index="2"] .line-numbers')!;
			window.ashDiffIntegration.scrollModified(1);
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			return {
				hasDecoration: !!decoration,
				hasNumber: !!number,
				decorationRetained: decoration === host.querySelector('.view-overlays .view-overlay-line[data-line-index="2"] .cdr'),
				numberRetained: number === host.querySelector('.margin-view-overlays .view-overlay-line[data-line-index="2"] .line-numbers'),
			};
		});
		expect(result).toEqual({ hasDecoration: true, hasNumber: true, decorationRetained: true, numberRetained: true });
		await page.evaluate(text => window.ashDiffIntegration.setComparisonText(text, text), original);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await expect(page.locator('#single .modified .view-overlays .stanza-diff-line-added')).toHaveCount(0);
	});
}

test('diff scrolling keeps retained decorations stable during wheel input', async ({ page }, testInfo) => {
	await openDiffPage(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('#single').evaluate(node => { node.style.height = '720px'; });
	const original = Array.from({ length: 1200 }, (_, index) => `export const entry${index} = ${index};`);
	const modified = original.map((line, index) => index % 5 === 0 ? `${line} // changed` : line);
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setViewMode(false, false, 900);
		window.ashDiffIntegration.setComparisonText(left, right);
	}, [original.join('\n'), modified.join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const samples = await page.evaluate(async () => {
		const editor = document.querySelector<HTMLElement>('#single .modified .stanza-editor')!;
		const diff = document.querySelector('#single .stanza-diff-editor')!;
		const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
		// Warm the text and decorations before measuring an identical scroll range.
		for (let frame = 0; frame < 20; frame++) {
			editor.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
			await nextFrame();
		}
		const output = [];
		for (let sample = 0; sample < 3; sample++) {
			window.ashDiffIntegration.scrollModified(400);
			await nextFrame();
			await nextFrame();
			let retainedOverlayReplacements = 0;
			let overviewUpdates = 0;
			const observer = new MutationObserver(records => {
				for (const record of records) {
					if (!(record.target instanceof Element)) continue;
					if (record.target.matches('.view-overlay-line') && record.removedNodes.length > 0 && record.addedNodes.length > 0) retainedOverlayReplacements++;
					if (record.target.matches('.stanza-diff-overview-lane')) overviewUpdates++;
				}
			});
			const layoutEvents = window.ashDiffIntegration.layoutEventCount;
			observer.observe(diff, { childList: true, subtree: true });
			const intervals = [];
			const wheelDurations = [];
			let previous = await nextFrame();
			try {
				for (let frame = 0; frame < 90; frame++) {
					const start = performance.now();
					editor.dispatchEvent(new WheelEvent('wheel', { deltaY: frame < 45 ? 40 : -40, bubbles: true, cancelable: true }));
					wheelDurations.push(performance.now() - start);
					const now = await nextFrame();
					intervals.push(now - previous);
					previous = now;
				}
				await nextFrame();
				output.push({
					intervals,
					wheelDurations,
					retainedOverlayReplacements,
					overviewUpdates,
					layoutEvents: window.ashDiffIntegration.layoutEventCount - layoutEvents,
					finalTop: window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop,
				});
			} finally {
				observer.disconnect();
			}
		}
		return output;
	});
	const samplePath = testInfo.outputPath('diff-scroll-samples.json');
	await writeFile(samplePath, JSON.stringify(samples, null, 2));
	await testInfo.attach('diff-scroll-samples', { path: samplePath, contentType: 'application/json' });
	for (const sample of samples) {
		expect(sample.finalTop).toBe(400);
		expect(sample.layoutEvents).toBe(0);
		expect(sample.overviewUpdates).toBe(0);
		expect(sample.retainedOverlayReplacements).toBe(0);
	}
});

test('diff scrolling in a tall inline viewport preserves visible rows and keyboard focus', async ({ page }, testInfo) => {
	await openDiffPage(page, 'zh-CN');
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('#single').evaluate(node => { node.style.height = '720px'; });
	const original = Array.from({ length: 1200 }, (_, index) => `export const entry${index} = ${index};`);
	const modified = original.map((line, index) => index % 5 === 0 ? `${line} // changed` : line);
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setTheme('vs');
		window.ashDiffIntegration.setViewMode(false, false, 900);
		window.ashDiffIntegration.setComparisonText(left, right);
	}, [original.join('\n'), modified.join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#single .modified .stanza-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	const before = await page.evaluate(() => window.ashDiffIntegration.layoutEventCount);
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('Performance.enable');
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.start');
		await editor.hover();
		for (let iteration = 0; iteration < 30; iteration++) {
			await page.mouse.wheel(0, 80);
		}
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop)).toBe(2400);
		await expect(input).toBeFocused();
		expect(await page.evaluate(() => window.ashDiffIntegration.layoutEventCount)).toBe(before);
		const geometry = await editor.evaluate(node => {
			const bounds = node.getBoundingClientRect();
			const lines = [...node.querySelectorAll('.view-lines .view-line')].map(line => line.getBoundingClientRect());
			return { height: bounds.height, visibleRows: lines.filter(line => line.bottom > bounds.top && line.top < bounds.bottom).length };
		});
		expect(geometry.height).toBeGreaterThan(700);
		expect(geometry.visibleRows).toBeGreaterThan(25);
		await testInfo.attach('tall-inline-diff', { body: await page.locator('#single').screenshot(), contentType: 'image/png' });
		const { profile } = await cdp.send('Profiler.stop');
		const metrics = await cdp.send('Performance.getMetrics');
		const profilePath = testInfo.outputPath('tall-inline-diff.cpuprofile');
		await writeFile(profilePath, JSON.stringify(profile));
		await testInfo.attach('tall-inline-diff-cpu', { path: profilePath, contentType: 'application/json' });
		await testInfo.attach('tall-inline-diff-metrics', { body: JSON.stringify(metrics), contentType: 'application/json' });
	} finally {
		await cdp.detach();
	}
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.ashDiffIntegration?.dispose());
});

for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light'] as const) {
	test(`multi diff aligns header corners and borders without hover elevation (${theme})`, async ({ page }, testInfo) => {
		await openDiffPage(page);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('history'));
		await page.evaluate(themeId => window.ashDiffIntegration.setTitleTheme(themeId), theme);
		const section = page.locator('#title-comparison .stanza-multi-diff-editor-section').first();
		const header = section.locator('.stanza-multi-diff-editor-header');
		const toggle = header.locator('.stanza-multi-diff-editor-header-toggle');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await page.mouse.move(0, 0);
		const readHeader = async () => section.evaluate(node => {
			const headerNode = node.querySelector<HTMLElement>('.stanza-multi-diff-editor-header')!;
			const toggleNode = node.querySelector<HTMLElement>('.stanza-multi-diff-editor-header-toggle')!;
			const outer = node.getBoundingClientRect();
			const inner = headerNode.getBoundingClientRect();
			const outerStyle = getComputedStyle(node);
			const innerStyle = getComputedStyle(headerNode);
			return {
				background: innerStyle.backgroundColor,
				bounds: [outer.x, outer.y, outer.width, outer.height, inner.x, inner.y, inner.width, inner.height],
				insets: [inner.top - outer.top, outer.bottom - inner.bottom, inner.left - outer.left, outer.right - inner.right],
				borders: [outerStyle.borderTopWidth, outerStyle.borderBottomWidth, outerStyle.borderLeftWidth, outerStyle.borderRightWidth].map(Number.parseFloat),
				radii: [outerStyle.borderTopLeftRadius, innerStyle.borderTopLeftRadius, innerStyle.borderBottomLeftRadius].map(Number.parseFloat),
				edges: [outerStyle.borderColor, innerStyle.borderColor, innerStyle.borderRadius],
				shadows: [outerStyle.boxShadow, innerStyle.boxShadow, getComputedStyle(toggleNode).boxShadow],
				appearance: getComputedStyle(toggleNode).appearance,
			};
		});
		const resting = await readHeader();
		for (let index = 0; index < resting.insets.length; index++) {
			expect(resting.insets[index]).toBeCloseTo(resting.borders[index]!, 4);
		}
		expect(resting.radii[1]! + resting.borders[2]!).toBe(resting.radii[0]);
		expect(resting.radii[2]).toBe(resting.radii[1]);
		expect(resting.appearance).toBe('none');
		await toggle.hover();
		const hovered = await readHeader();
		expect(hovered.background).not.toBe(resting.background);
		expect(hovered.bounds).toEqual(resting.bounds);
		expect(hovered.edges).toEqual(resting.edges);
		expect(hovered.shadows).toEqual(['none', 'none', 'none']);
		await testInfo.attach(`multi-diff-hover-${theme}`, { body: await section.screenshot(), contentType: 'image/png' });
		await page.mouse.move(0, 0);
		await toggle.press('Tab');
		await page.keyboard.press('Shift+Tab');
		await expect(toggle).toBeFocused();
		await expect(toggle).toHaveCSS('outline-style', 'solid');
		await toggle.press('Enter');
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect(header).toHaveCSS('border-bottom-left-radius', '0px');
		const expanded = await section.evaluate(node => {
			const body = node.querySelector('.stanza-multi-diff-editor-body')!.getBoundingClientRect();
			return node.getBoundingClientRect().bottom - body.bottom;
		});
		expect(expanded).toBeCloseTo(resting.borders[1]!, 4);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`diff center gutter aligns deleted blocks and retains other hunks during selection (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => {
			const shared = 'shared\n'.repeat(20);
			window.ashDiffIntegration.setComparisonText(`first\ndeleted\n${shared}before\nlast`, `first\n${shared}after\nlast`);
		});
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const items = page.locator('#single .ash-diff-gutter-item');
		await expect(items).toHaveCount(2);
		const positions = await page.evaluate(() => window.ashDiffIntegration.linePositions(2, 2));
		const top = await items.first().evaluate(node => Number.parseFloat((node as HTMLElement).style.top));
		expect(top).toBe(positions.originalTop);
		expect(top).toBeLessThan(positions.modifiedTop);
		await page.evaluate(() => window.ashDiffIntegration.selectModified([22, 1, 22, 6]));
		await expect(items).toHaveCount(2);
		await expect(page.locator('#single .ash-diff-gutter').getByRole('button', { name: localized(locale, 'Revert selected changes', '还原选中的更改'), exact: true, includeHidden: true })).toHaveCount(1);
	});

	test(`multi diff updates configuration and uses scoped file menus (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git'));
		const host = page.locator('#title-comparison');
		const sections = host.locator('.stanza-multi-diff-editor-section');
		await expect(sections).toHaveCount(2);
		await sections.nth(1).locator('.stanza-multi-diff-editor-header-toggle').focus();
		const files = host.getByRole('button', { name: localized(locale, 'Files', '文件'), exact: true });
		await files.focus();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().activeCodeEditor)).toBe(true);
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().active)).toBe('src/second.ts');
		const inspect = sections.first().getByRole('button', { name: 'Inspect File', exact: true });
		await expect(inspect).toBeVisible();
		await expect(sections.nth(1).getByRole('button', { name: 'Inspect File', exact: true })).toHaveCount(0);
		await inspect.focus();
		await inspect.press('Enter');
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().inspected)).toEqual(['file:///workspace/src/first.ts']);
		await page.evaluate(async () => {
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.fontSize', 18);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.lineHeight', 30);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.fontFamily', 'Courier New');
			await window.ashDiffIntegration.updateTitleEditorConfiguration('editor.fontLigatures', true);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.showLineNumbers', false);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.showInlineChanges', false);
			await window.ashDiffIntegration.updateTitleEditorConfiguration('diffEditor.loopChanges', false);
		});
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().fonts)).toEqual([18, 18]);
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().lines)).toEqual([30, 30]);
		await expect(host.locator('.stanza-multi-diff-editor')).toHaveClass(/hide-line-numbers/);
		await expect(host.locator('.stanza-diff-inline-added, .stanza-diff-inline-removed')).toHaveCount(0);
		await expect(sections.first().locator('.stanza-editor').first()).toHaveCSS('font-family', /Courier New/);
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/first.ts', 'src/second.ts', 'src/third.ts'], 2));
		await expect(sections).toHaveCount(3);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().lines)).toEqual([30, 30, 30]);
	});

	test(`multi diff refreshes live Git without changing tabs or losing file state (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git'));
		const host = page.locator('#title-comparison');
		const sections = host.locator('.stanza-multi-diff-editor-section');
		await expect(sections).toHaveCount(2);
		await sections.first().locator('.stanza-multi-diff-editor-header-toggle').click();
		await sections.nth(1).locator('.stanza-multi-diff-editor-header-toggle').focus();
		const tabs = host.getByRole('tab');
		const originalTab = await tabs.first().textContent();
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/first.ts', 'src/second.ts', 'src/stale.ts'], 2, 150));
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/first.ts', 'src/second.ts', 'src/latest.ts'], 3));
		await expect(sections).toHaveCount(3);
		await expect(host.locator('.stanza-multi-diff-editor-title')).toHaveText(['src/first.ts', 'src/second.ts', 'src/latest.ts']);
		await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
		expect(await page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().active)).toBe('src/second.ts');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().contents)).toEqual(['src/second.ts revision 3\nshared', 'src/latest.ts revision 3\nshared']);
		await expect(tabs).toHaveCount(1);
		await expect(tabs.first()).toHaveText(originalTab!);
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit([], 4));
		await expect(sections).toHaveCount(0);
		await expect(host.locator('.stanza-multi-diff-editor-empty')).toHaveText(localized(locale, 'No changes in this selection.', '此选择中没有更改。'));
		await page.evaluate(() => window.ashDiffIntegration.updateTitleGit(['src/returned.ts'], 5));
		await expect(host.locator('.stanza-multi-diff-editor-title')).toHaveText(['src/returned.ts']);
		await expect(host.locator('.stanza-multi-diff-editor-empty')).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readMultiDiffFoundation().contents)).toEqual(['src/returned.ts revision 5\nshared']);
	});

	test(`history multi-diff uses the editor title toolbar and preserves keyboard actions (${locale})`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1200, height: 700 });
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('history'));
		const host = page.locator('#title-comparison');
		await expect(host.locator('.ash-editor-breadcrumbs')).toBeHidden();
		await expect(host.getByRole('tab')).toContainText('98246c6 · Simplify diff editor update method and improve accessibility');
		await expect(host.locator('.stanza-multi-diff-editor-toolbar')).toHaveCount(0);
		const collapse = host.getByRole('button', { name: localized(locale, 'Collapse All Diffs', '折叠所有差异'), exact: true });
		const expand = host.getByRole('button', { name: localized(locale, 'Expand All Diffs', '展开所有差异'), exact: true });
		const section = host.locator('.stanza-multi-diff-editor-header-toggle');
		await expect(section).toHaveAttribute('aria-expanded', 'true');
		const file = host.locator('.stanza-multi-diff-editor-section');
		expect(await collapse.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await file.evaluate(element => element.getBoundingClientRect().top));
		await collapse.focus();
		await collapse.press('Enter');
		await expect(section).toHaveAttribute('aria-expanded', 'false');
		await expand.focus();
		await expand.press('Enter');
		await expect(section).toHaveAttribute('aria-expanded', 'true');
		await expect(expand).toBeFocused();
		for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light'] as const) {
			await page.evaluate(themeId => window.ashDiffIntegration.setTitleTheme(themeId), theme);
			await expect(collapse).toBeVisible();
			await expect(collapse).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
			await testInfo.attach(`history-toolbar-${locale}-${theme}`, { body: await host.screenshot(), contentType: 'image/png' });
		}
		await page.evaluate(() => window.ashDiffIntegration.resizeTitleComparison(320));
		await expect(collapse).toBeVisible();
		await expect(expand).toBeVisible();
		await expect(host.locator('.stanza-multi-diff-editor-toolbar')).toHaveCount(0);
		await testInfo.attach(`history-toolbar-${locale}-narrow`, { body: await host.screenshot(), contentType: 'image/png' });
	});

	test(`multi diff opens files expanded and reveals unchanged code on demand (${locale})`, async ({ page }, testInfo) => {
		await openDiffPage(page, locale);
		const shared = Array.from({ length: 36 }, (_, index) => `shared ${index + 1}`);
		await page.evaluate(([original, modified]) => window.ashDiffIntegration.setComparisonText(original, modified), [shared.join('\n'), [...shared.slice(0, -1), 'changed'].join('\n')]);
		const section = page.locator('#multi .stanza-multi-diff-editor-section').first();
		await expect(section.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
		const regions = section.locator('.ash-diff-hidden-region');
		await expect(regions).toHaveCount(2);
		await expect(section.locator('.stanza-diff-inline-added')).toHaveText('changed');
		await section.locator('.stanza-diff-editor-side.modified .ash-diff-hidden-region').first().getByRole('button', { name: localized(locale, 'Show all unchanged lines', '显示全部未修改的行'), exact: true }).click();
		await expect(regions).toHaveCount(0);
		await expect.poll(() => section.locator('.stanza-diff-editor-side.modified .stanza-editor').evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
		await testInfo.attach(`multi-diff-revealed-${locale}`, { body: await section.screenshot(), contentType: 'image/png' });
	});

	test(`diff title More Actions runs layout, whitespace and swap commands by keyboard (${locale})`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1400, height: 700 });
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison());
		const more = page.locator('#title-comparison [data-action-id="ash.toolbar.moreActions"] button');
		await more.focus();
		await more.press('Enter');
		const view = page.getByRole('menuitem', { name: localized(locale, 'Diff View', '差异视图'), exact: true });
		await page.keyboard.press('ArrowDown');
		await expect(view).toBeFocused();
		await view.press('ArrowRight');
		const inline = page.getByRole('menuitemcheckbox', { name: localized(locale, 'Inline', '行内'), exact: true });
		const sideBySide = page.getByRole('menuitemcheckbox', { name: localized(locale, 'Side by Side', '并排'), exact: true });
		const automatic = page.getByRole('menuitemcheckbox', { name: localized(locale, 'Automatic', '自动'), exact: true });
		await expect(inline).toHaveAttribute('aria-checked', 'false');
		await expect(sideBySide).toHaveAttribute('aria-checked', 'false');
		await expect(automatic).toHaveAttribute('aria-checked', 'true');
		await testInfo.attach(`diff-title-menu-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		await inline.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().mode)).toBe('inline');
		await more.press('Enter');
		await view.press('ArrowRight');
		await expect(inline).toHaveAttribute('aria-checked', 'true');
		await sideBySide.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().mode)).toBe('sideBySide');
		await more.press('Enter');
		const whitespace = page.getByRole('menuitemcheckbox', { name: localized(locale, 'Show Whitespace Differences', '显示空白差异'), exact: true });
		await expect(whitespace).toHaveAttribute('aria-checked', 'false');
		await whitespace.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().ignoreWhitespace)).toBe(false);
		await more.press('Enter');
		await expect(whitespace).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('menuitem', { name: localized(locale, 'Swap Sides', '交换两侧'), exact: true }).press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitleComparison().original)).toBe('after\nshared');
		await more.press('Enter');
		await page.keyboard.press('Escape');
		await expect(more).toBeFocused();
	});

	test(`diff pairs edited code after inserted setup and highlights whole identifiers (${locale})`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1500, height: 600 });
		await openDiffPage(page, locale);
		const original = 'head\nconst source = new ExplorerDataSource(files, config);\ntail';
		const modified = 'head\nusing workspace = new WorkspaceContextService(project);\nconst getValue = config.getValue.bind(config);\nconfig.getValue = section => getValue(section);\nusing source = new WorkspaceDataSource(config);\ntail';
		await page.evaluate(([left, right]) => {
			document.getElementById('single')!.style.width = '1400px';
			window.ashDiffIntegration.setTheme('vs');
			window.ashDiffIntegration.setComparisonText(left, right);
			window.ashDiffIntegration.setViewMode(true, false, 1400);
		}, [original, modified]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'added', 'added', 'added', 'modified', 'unchanged']);
		await expect.poll(() => page.evaluate(() => {
			const lines = window.ashDiffIntegration.linePositions(2, 5);
			return Math.abs(lines.originalTop - lines.modifiedTop);
		})).toBeLessThan(1);
		const removed = page.locator('#single .stanza-diff-editor-side.original .stanza-diff-inline-removed');
		const added = page.locator('#single .stanza-diff-editor-side.modified .stanza-diff-inline-added');
		await expect.poll(async () => (await removed.allTextContents()).join('')).toBe('constExplorerDataSourcefiles, ');
		await expect.poll(async () => (await added.allTextContents()).join('')).toBe('usingWorkspaceDataSource');
		await expect(removed.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(added.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await testInfo.attach('paired-code-diff', { body: await page.locator('#single').screenshot(), contentType: 'image/png' });

		await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 1400));
		const inlineOriginal = page.locator('#single .stanza-diff-inline-original-line');
		await expect(inlineOriginal).toHaveText(original.split('\n')[1]!);
		await expect.poll(async () => (await inlineOriginal.locator('.stanza-diff-inline-removed').allTextContents()).join('')).toBe('constExplorerDataSourcefiles, ');

		await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 1400));
		const revert = page.locator('#single .ash-diff-revert').getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true });
		await revert.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe(original);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'unchanged', 'unchanged']);
		await page.evaluate(() => window.ashDiffIntegration.undo());
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe(modified);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'added', 'added', 'added', 'modified', 'unchanged']);
	});

	test(`diff keeps a rewritten loop continuous while selection revert preserves the added line (${locale})`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 2400, height: 600 });
		await openDiffPage(page, locale);
		const originalLine = '    for (let offset = 0; offset < Math.min(originalCount, modifiedCount); offset++) {';
		const modifiedLine = '    const pairs = yield* pairChangedLines(original.slice(originalIndex, originalMatch), modified.slice(modifiedIndex, modifiedMatch));';
		const addedLine = '    for (const [left, right] of pairs) {';
		await page.evaluate(([original, modified]) => {
			document.getElementById('single')!.style.width = '2300px';
			window.ashDiffIntegration.setTheme('vs');
			window.ashDiffIntegration.setComparisonText(original, modified);
			window.ashDiffIntegration.setViewMode(true, false, 2300);
		}, [`${originalLine}\nbody();`, `${modifiedLine}\n${addedLine}\nbody();`]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['modified', 'added', 'unchanged']);
		const removed = page.locator('#single .stanza-diff-editor-side.original .stanza-diff-inline-removed');
		const added = page.locator('#single .stanza-diff-editor-side.modified .stanza-diff-inline-added');
		await expect.poll(async () => (await removed.allTextContents()).join('')).toBe(originalLine.trimStart());
		await expect.poll(async () => (await added.allTextContents()).join('')).toBe(modifiedLine.trimStart());
		await expect(removed.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(added.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await testInfo.attach('contiguous-loop-rewrite', { body: await page.locator('#single').screenshot(), contentType: 'image/png' });

		await page.evaluate(endColumn => window.ashDiffIntegration.selectModified([1, 5, 1, endColumn]), modifiedLine.length + 1);
		const revert = page.locator('#single').getByRole('button', { name: localized(locale, 'Revert selected changes', '还原选中的更改'), exact: true });
		await revert.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe(`${originalLine}\n${addedLine}\nbody();`);
		await page.evaluate(() => window.ashDiffIntegration.undo());
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe(`${modifiedLine}\n${addedLine}\nbody();`);
	});
}

for (const bracketPairs of [false, true]) {
	test(`diff line backgrounds stay behind ${bracketPairs ? 'bracket' : 'indent'} guides in every theme`, async ({ page }, testInfo) => {
		await openDiffPage(page);
		await page.evaluate(bracketPairs => {
			window.ashDiffIntegration.setComparisonText('{\n    before\n    unchanged\n}', '{\n    after\n    unchanged\n}');
			window.ashDiffIntegration.setGuides({ guides: { indentation: !bracketPairs, bracketPairs, bracketPairsHorizontal: false } });
		}, bracketPairs);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const guideClass = bracketPairs ? '.stanza-editor-bracket-guide' : '.stanza-editor-indent-guide';
		for (const themeId of ['vs', 'vs-dark', 'hc-light', 'hc-black']) {
			await page.evaluate(themeId => window.ashDiffIntegration.setTheme(themeId), themeId);
			for (const [side, backgroundClass] of [['original', '.stanza-diff-line-removed'], ['modified', '.stanza-diff-line-added']] as const) {
				const row = page.locator(`#single .${side} .view-overlay-line[data-line-index="1"]`);
				const guide = row.locator(guideClass).first();
				await expect(guide).toBeVisible();
				await expect(guide).toHaveCSS('pointer-events', 'none');
				await expect(guide).toHaveCSS('border-left-width', '1px');
				await expect(row.locator(backgroundClass)).toBeVisible();
				await expect.poll(() => guide.evaluate((element, backgroundClass) => {
					const background = element.parentElement!.querySelector<HTMLElement>(backgroundClass)!;
					const guide = element as HTMLElement;
					const rect = guide.getBoundingClientRect();
					const guidePointerEvents = guide.style.pointerEvents;
					const backgroundPointerEvents = background.style.pointerEvents;
					// Include decorative nodes in the browser's paint-order hit test, then restore their input behavior.
					guide.style.pointerEvents = 'auto';
					background.style.pointerEvents = 'auto';
					try {
						const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
						const guideIndex = stack.indexOf(guide);
						return {
							guideAboveBackground: guideIndex >= 0 && stack.indexOf(background) > guideIndex,
							hasStroke: getComputedStyle(guide).borderLeftColor !== 'rgba(0, 0, 0, 0)',
							hiddenFromAccessibility: guide.closest('[aria-hidden="true"]') !== null,
						};
					} finally {
						guide.style.pointerEvents = guidePointerEvents;
						background.style.pointerEvents = backgroundPointerEvents;
					}
				}, backgroundClass)).toEqual({ guideAboveBackground: true, hasStroke: true, hiddenFromAccessibility: true });
			}
			await testInfo.attach(`diff-guides-${themeId}`, { body: await page.locator('#single').screenshot(), contentType: 'image/png' });
		}
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`multi diff displays binary-only files without code editors (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('binary'));
		const pane = page.locator('#title-comparison .stanza-multi-diff-editor-pane');
		const binary = pane.locator('.stanza-multi-diff-editor-item-editor.binary');
		await expect(binary).toHaveText(localized(locale, 'Binary file changed. Text comparison is unavailable.', '二进制文件已更改，无法进行文本比较。'));
		await expect(pane.locator('.stanza-editor-input')).toHaveCount(0);
		await expect(pane.getByRole('button', { name: localized(locale, 'Open File', '打开文件'), exact: true })).toBeVisible();
		await binary.focus();
		await expect(binary).toBeFocused();
		await expect(binary).toHaveCSS('outline-style', 'solid');
		const header = pane.getByRole('button', { name: /image.bin/ }).first();
		await header.click();
		await expect(header).toHaveAttribute('aria-expanded', 'false');
		await header.click();
		await expect(binary).toBeVisible();
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).toMatchObject({ dirty: false, copies: 0, writes: [], tabs: 1 });
	});

	test(`multi diff saves collapsed writable files from an inactive tab and retains failed edits (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('writable'));
		const pane = page.locator('#title-comparison .stanza-multi-diff-editor-pane');
		for (const name of ['first', 'second']) {
			const section = pane.locator('.stanza-multi-diff-editor-section').filter({ has: page.getByRole('button', { name: new RegExp(`${name}\\.ts`) }) });
			const input = section.locator('.stanza-diff-editor-side.modified .stanza-editor-input');
			await input.focus();
			await page.keyboard.press('ControlOrMeta+End');
			await page.keyboard.type(` ${name} edit`);
			await section.getByRole('button', { name: new RegExp(`${name}\\.ts`) }).click();
		}
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(true);
		expect(await page.evaluate(() => window.ashDiffIntegration.closeWritableTitle())).toBe(false);
		expect(await page.evaluate(() => window.ashDiffIntegration.saveTitleFiles(true))).toBe('Save rejected');
		expect((await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).dirty).toBe(true);
		await page.evaluate(() => window.ashDiffIntegration.openOtherTitleFile());
		const active = (await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).active;
		expect(await page.evaluate(() => window.ashDiffIntegration.saveTitleFiles())).toBeUndefined();
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).toMatchObject({
			dirty: false, tabs: 2, active, writes: [{ resource: '/workspace/first.ts', text: 'after first edit' }, { resource: '/workspace/second.ts', text: 'after second edit' }],
		});
		expect(await page.evaluate(() => window.ashDiffIntegration.closeWritableTitle())).toBe(true);
		expect((await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence())).copies).toBe(0);
	});
}

test('session Changes retains collapse and scroll through hiding, refresh and deferred restoration', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.openSessionChanges());
	const message = page.locator('#session-changes .ash-sessions-editor-message');
	await expect(message).toBeHidden();
	const editor = page.locator('#session-changes .stanza-multi-diff-editor');
	const firstHeader = editor.getByRole('button', { name: /file-0.ts/ });
	await firstHeader.click();
	await expect(firstHeader).toHaveAttribute('aria-expanded', 'false');
	await editor.evaluate(element => { element.scrollTop = 100; });
	await expect.poll(() => page.evaluate(() => (window.ashDiffIntegration.readSessionViewState() as { scrollTop?: number; } | null)?.scrollTop)).toBe(100);
	await page.evaluate(() => window.ashDiffIntegration.setSessionChangesVisible(false));
	await expect(editor).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.setSessionChangesVisible(true));
	await expect(editor).toBeVisible();
	await expect(message).toBeHidden();
	await expect(firstHeader).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(100);
	await page.evaluate(() => window.ashDiffIntegration.refreshSessionChanges());
	await expect(firstHeader).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(100);
	await page.evaluate(() => window.ashDiffIntegration.reopenSessionChanges());
	await expect(firstHeader).toHaveAttribute('aria-expanded', 'false');
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(100);
	await page.evaluate(() => window.ashDiffIntegration.switchSessionChanges());
	await expect(firstHeader).toHaveAttribute('aria-expanded', 'true');
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(0);
});

test('multi-diff exposes the active file control and retains it while focus leaves the editor', async ({ page }) => {
	await openDiffPage(page);
	const files = page.locator('#multi .stanza-multi-diff-editor-section');
	await expect(files).toHaveCount(2);
	await files.nth(0).locator('.stanza-editor-input').last().focus();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.activeMultiControl())).toBe('same\nbefore 🤖 after\nlast');
	await files.nth(1).locator('.stanza-editor-input').last().focus();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.activeMultiControl())).toBe('one');
	await page.locator('#modified').focus();
	expect(await page.evaluate(() => window.ashDiffIntegration.activeMultiControl())).toBe('one');
	await page.evaluate(() => window.ashDiffIntegration.focusMulti());
	await expect(files.nth(1).locator('.stanza-editor-input').last()).toBeFocused();
	await files.nth(1).getByRole('button', { name: /second.ts/ }).click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.activeMultiControl())).toBeUndefined();
});

test('diff feature revert buttons support keyboard, undo, read-only and live options', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const button = page.locator('#single .ash-diff-revert').getByRole('button', { name: 'Revert change', exact: true });
	await expect(button).toBeVisible();
	await button.focus();
	await page.keyboard.press('Space');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 😀 after\nlast');
	await page.evaluate(() => window.ashDiffIntegration.undo());
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(button).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: true }));
	await expect(button).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: false, renderMarginRevertIcon: false, renderOverviewRuler: false }));
	await expect(button).toHaveCount(0);
	await expect(page.locator('#single .stanza-diff-overview')).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderMarginRevertIcon: true, renderOverviewRuler: true }));
	await expect(button).toBeVisible();
	await button.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(0);
	await expect(button).toHaveCount(0);
});

test('diff feature selection reverts only the selected character change', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first OLD middle OLD last', 'first NEW middle NEW last'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.evaluate(() => window.ashDiffIntegration.selectModified([1, 7, 1, 10]));
	const button = page.locator('#single').getByRole('button', { name: 'Revert selected changes', exact: true });
	await expect(button).toBeVisible();
	await button.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('first OLD middle NEW last');
});

test('Git diff center gutter preserves BOM encoding while staging and reverting', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git', 'unstaged', 'utf8bom'));
	const gutter = page.locator('#title-comparison .stanza-multi-diff-editor-section').first().locator('.ash-diff-gutter');
	await gutter.getByRole('button', { name: 'Stage change', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([{
		path: 'src/first.ts', comparison: 'unstaged', repositoryId: 'repo',
		reviewed: { original: '\uFEFFbefore\nshared', modified: '\uFEFFsrc/first.ts revision 1\nshared', hunks: [] },
		selection: { kind: 'lines', start: 1, end: 1 },
	}]);
	await gutter.getByRole('button', { name: 'Revert change', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Revert changes', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls.length)).toBe(2);
	expect(await page.evaluate(() => (window.ashDiffIntegration.gitGutterCalls[1] as { save: { text: string; encoding: string; }; }).save)).toMatchObject({ text: 'before\nshared', encoding: 'utf8bom' });
});

test('diff feature gutter menus receive hunk and selection edits and follow scroll', async ({ page }) => {
	await openDiffPage(page);
	const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
	await page.evaluate(([original, modified]) => {
		window.ashDiffIntegration.setComparisonText(original!, modified!);
		window.ashDiffIntegration.registerHunkAction();
		window.ashDiffIntegration.registerHunkAction(true);
	}, [lines.join('\n'), [...lines.slice(0, 2), 'changed', 'extra', ...lines.slice(3)].join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const action = page.locator('#single .ash-diff-gutter').getByRole('button', { name: 'Apply change', exact: true });
	await expect(action).toBeVisible();
	await action.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lastHunkAction?.text)).toBe([...lines.slice(0, 2), 'changed', 'extra', ...lines.slice(3)].join('\n'));
	await page.evaluate(() => window.ashDiffIntegration.scrollModified(400));
	await expect(action).toBeHidden();
	await page.evaluate(() => {
		window.ashDiffIntegration.scrollModified(0);
		window.ashDiffIntegration.selectModified([3, 1, 3, 8]);
	});
	const selection = page.locator('#single .ash-diff-gutter').getByRole('button', { name: 'Apply selected change', exact: true });
	await expect(selection).toBeVisible();
	await selection.click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lastHunkAction?.text)).toBe([...lines.slice(0, 2), 'changed', ...lines.slice(3)].join('\n'));
	await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderGutterMenu: false }));
	await expect(page.locator('#single .ash-diff-gutter')).toBeHidden();
	await expect(page.locator('#single .ash-diff-revert')).toHaveCount(1);
});

test('diff gutter spans deletion zones before the first line and at EOF', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => {
		window.ashDiffIntegration.setComparisonText('removed head\nsame\nremoved tail', 'same');
		window.ashDiffIntegration.setViewMode(true, false, 900);
	});
	const items = page.locator('#single .ash-diff-gutter-item');
	await expect(items).toHaveCount(2);
	const positions = await page.evaluate(() => [window.ashDiffIntegration.linePositions(1, 1), window.ashDiffIntegration.linePositions(3, 1)]);
	for (const [index, position] of positions.entries()) {
		await expect.poll(() => items.nth(index).evaluate(node => ({ top: parseFloat((node as HTMLElement).style.top), height: parseFloat((node as HTMLElement).style.height) }))).toEqual({ top: position.originalTop, height: position.originalBottom - position.originalTop });
	}
	await items.nth(1).getByRole('button', { name: 'Revert change', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nremoved tail');
});

for (const [originalLength, modifiedLength] of [[6, 2], [2, 6]]) {
	test(`diff gutter covers the taller side of a replacement (${originalLength}, ${modifiedLength})`, async ({ page }) => {
		await openDiffPage(page);
		await page.evaluate(([left, right]) => {
			window.ashDiffIntegration.setViewMode(true, false, 900);
			window.ashDiffIntegration.setComparisonText(
				['first', ...Array.from({ length: left }, (_, index) => `original ${index}`), 'last'].join('\n'),
				['first', ...Array.from({ length: right }, (_, index) => `changed ${index}`), 'last'].join('\n'),
			);
		}, [originalLength!, modifiedLength!]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const start = await page.evaluate(() => window.ashDiffIntegration.linePositions(2, 2));
		const end = await page.evaluate(([left, right]) => window.ashDiffIntegration.linePositions(left + 1, right + 1), [originalLength!, modifiedLength!]);
		const item = page.locator('#single .ash-diff-gutter-item');
		await expect(item).toHaveCount(1);
		await expect.poll(() => item.evaluate(node => Number.parseFloat((node as HTMLElement).style.height))).toBe(Math.max(end.originalBottom, end.modifiedBottom) - start.modifiedTop);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	for (const theme of ['vs', 'hc-black']) {
		test(`diff gutter centers controls in the visible hunk and reveals on intent (${locale}, ${theme})`, async ({ page }, testInfo) => {
			await openDiffPage(page, locale);
			await page.evaluate(themeId => {
				window.ashDiffIntegration.setTheme(themeId);
				window.ashDiffIntegration.setViewMode(true, false, 900);
				window.ashDiffIntegration.setComparisonText(
					['first', ...Array.from({ length: 50 }, (_, index) => `original ${index}`), 'last'].join('\n'),
					['first', ...Array.from({ length: 50 }, (_, index) => `changed ${index}`), 'last'].join('\n'),
				);
				window.ashDiffIntegration.registerHunkAction();
			}, theme);
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
			const gutter = page.locator('#single .ash-diff-gutter');
			const item = gutter.locator('.ash-diff-gutter-item');
			const toolbar = item.getByRole('toolbar');
			await page.mouse.move(0, 0);
			await expect(item).toHaveCSS('opacity', '0');
			await gutter.hover();
			await expect(item).toHaveCSS('opacity', '1');
			for (const scrollTop of [0, 500]) {
				await page.evaluate(top => window.ashDiffIntegration.scrollModified(top), scrollTop);
				await expect.poll(async () => {
					const [block, controls, viewport] = await Promise.all([item.boundingBox(), toolbar.boundingBox(), gutter.boundingBox()]);
					if (!block || !controls || !viewport) return Infinity;
					const visibleTop = Math.max(block.y, viewport.y);
					const visibleBottom = Math.min(block.y + block.height, viewport.y + viewport.height);
					return Math.abs(controls.y + controls.height / 2 - (visibleTop + visibleBottom) / 2);
				}).toBeLessThanOrEqual(1);
			}
			await testInfo.attach('diff-gutter-scrolled', { body: await page.locator('#single').screenshot(), contentType: 'image/png' });
			await page.mouse.move(0, 0);
			await expect(item).toHaveCSS('opacity', '0');
			const revert = gutter.getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true });
			await revert.focus();
			await expect(item).toHaveCSS('opacity', '1');
			await expect(revert).toBeFocused();
			expect(await item.evaluate(node => {
				window.ashDiffIntegration.selectModified([25, 1, 25, 1]);
				return node === document.querySelector('#single .ash-diff-gutter-item');
			})).toBe(true);
			await expect(item).toHaveClass(/active/);
		});
	}

	test(`diff center gutter retains revert alongside contributed actions (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.registerHunkAction());
		const gutter = page.locator('#single .ash-diff-gutter');
		const revert = gutter.getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true });
		await expect(revert).toBeVisible();
		await expect(gutter.getByRole('button', { name: 'Apply change', exact: true })).toBeVisible();
		await revert.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 😀 after\nlast');
		await page.evaluate(() => window.ashDiffIntegration.undo());
		await expect(revert).toBeVisible();
		await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderGutterMenu: false }));
		await expect(gutter).toBeHidden();
		await expect(page.locator('#single .ash-diff-revert').getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true })).toBeVisible();
	});

	test(`Git diff center gutter stages its block and rejects an expired comparison (${locale})`, async ({ page }, testInfo) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git'));
		const first = page.locator('#title-comparison .stanza-multi-diff-editor-section').first();
		const gutter = first.locator('.ash-diff-gutter');
		const stage = gutter.getByRole('button', { name: localized(locale, 'Stage change', '暂存更改'), exact: true });
		const revert = gutter.getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true });
		await expect(stage).toBeVisible();
		await expect(revert).toBeVisible();
		const bounds = await first.evaluate(node => {
			const original = node.querySelector('.stanza-diff-editor-side.original')!.getBoundingClientRect();
			const modified = node.querySelector('.stanza-diff-editor-side.modified')!.getBoundingClientRect();
			const gutter = node.querySelector('.ash-diff-gutter')!.getBoundingClientRect();
			const controls = [...node.querySelectorAll('.ash-diff-gutter button')].map(button => button.getBoundingClientRect());
			return { leftGap: gutter.left - original.right, rightGap: modified.left - gutter.right, width: gutter.width, controlsFit: controls.every(button => button.top >= gutter.top && button.bottom <= gutter.bottom) };
		});
		expect(bounds).toEqual({ leftGap: 0, rightGap: 0, width: 36, controlsFit: true });
		await stage.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([{
			path: 'src/first.ts', comparison: 'unstaged', repositoryId: 'repo',
			reviewed: { original: 'before\nshared', modified: 'src/first.ts revision 1\nshared', hunks: [] },
			selection: { kind: 'lines', start: 1, end: 1 },
		}]);
		await testInfo.attach('git-center-gutter', { body: await first.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.ashDiffIntegration.expireGitGutterSnapshot());
		await stage.click();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls.length)).toBe(2);
		expect(await page.evaluate(() => window.ashDiffIntegration.gitGutterCalls[1])).toEqual({
			error: localized(locale,
				'Git operation failed: Open the current comparison from Source Control before selecting lines.',
				'Git 操作失败：请从源代码管理打开当前比较，再选中行。')
		});
	});

	test(`Git diff center gutter reverts only the reviewed block after confirmation (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git'));
		const revert = page.locator('#title-comparison .stanza-multi-diff-editor-section').first().locator('.ash-diff-gutter').getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true });
		await revert.click();
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('button', { name: localized(locale, 'Cancel', '取消'), exact: true }).click();
		expect(await page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([]);
		await revert.click();
		await dialog.getByRole('button', { name: localized(locale, 'Revert changes', '还原更改'), exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls.length)).toBe(1);
		expect(await page.evaluate(() => {
			const call = window.ashDiffIntegration.gitGutterCalls[0] as { save: { text: string; encoding: string; expectedRevision: string; resource: { path: string; }; }; };
			return { text: call.save.text, encoding: call.save.encoding, expectedRevision: call.save.expectedRevision, path: call.save.resource.path };
		})).toEqual({ text: 'before\nshared', encoding: 'utf8', expectedRevision: 'file-revision', path: '/workspace/src/first.ts' });
	});

	test(`Git diff center gutter unstages selected lines with per-editor menus (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('git', 'staged'));
		const gutter = page.locator('#title-comparison .stanza-multi-diff-editor-section').first().locator('.ash-diff-gutter');
		await expect(gutter.getByRole('button', { name: localized(locale, 'Unstage change', '取消暂存更改'), exact: true })).toBeVisible();
		await expect(gutter.getByRole('button', { name: localized(locale, 'Stage change', '暂存更改'), exact: true })).toHaveCount(0);
		await expect(gutter.getByRole('button', { name: localized(locale, 'Revert change', '还原更改'), exact: true })).toHaveCount(0);
		await expect(page.locator('#single .ash-diff-gutter').getByRole('button', { name: localized(locale, 'Unstage change', '取消暂存更改'), exact: true })).toHaveCount(0);
		await page.evaluate(() => window.ashDiffIntegration.selectTitleModified([1, 1, 1, 27]));
		const unstage = gutter.getByRole('button', { name: localized(locale, 'Unstage selected lines', '取消暂存选中行'), exact: true });
		await expect(unstage).toBeVisible();
		await unstage.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.gitGutterCalls)).toEqual([{
			path: 'src/first.ts', comparison: 'staged', repositoryId: 'repo',
			reviewed: { original: 'before\nshared', modified: 'src/first.ts revision 1\nshared', hunks: [] },
			selection: { kind: 'lines', start: 1, end: 1 },
		}]);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`diff feature moved links follow editor geometry, options, locale and disposal (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(async () => {
			window.ashDiffIntegration.setComparisonText('head\nmove A\nmove B\nkeep A\nkeep B\nkeep C\ntail', 'head\nkeep A\nkeep B\nkeep C\nmove A\nmove B\ntail');
			await window.ashDiffIntegration.setMoves(true);
		});
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
		const links = page.locator('#single .ash-diff-moved-links');
		await expect(links).toBeVisible();
		await expect(links.locator(':scope > svg > path')).toHaveCount(1);
		const button = links.getByRole('button');
		await expect(button).toHaveAccessibleName(localized(locale, 'Moved original lines 2–3 to modified lines 5–6', '原始第 2–3 行已移动到修改后的第 5–6 行'));
		await expect.poll(() => page.evaluate(prefix => window.ashDiffIntegration.read().accessibleContent.includes(prefix), localized(locale, 'Moved original lines 2–3', '原始第 2–3 行'))).toBe(true);
		const geometry = await links.locator(':scope > svg > path').getAttribute('d');
		await page.evaluate(() => window.ashDiffIntegration.setHiddenRegions(true));
		await expect(links.locator(':scope > svg > path')).toHaveAttribute('d', geometry!);
		await page.evaluate(() => {
			document.documentElement.style.setProperty('--ash-description-foreground', 'rgb(90, 110, 130)');
			document.documentElement.style.setProperty('--ash-strokeThickness', '1px');
		});
		await expect(button).toHaveAccessibleName(localized(locale, 'Moved original lines 2–3 to modified lines 5–6', '原始第 2–3 行已移动到修改后的第 5–6 行'));
		await expect(links.locator(':scope > svg')).toHaveCSS('stroke', 'rgb(90, 110, 130)');
		await button.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('#single .modified .stanza-editor-accessibility-status')).toContainText(localized(locale, 'Moved original lines 2–3', '原始第 2–3 行'));
		await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
		await expect(links).toBeHidden();
		await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
		await expect(links).toBeVisible();
		await page.evaluate(async () => { await window.ashDiffIntegration.setMoves(false); });
		await expect(links).toBeHidden();
		await page.evaluate(() => window.ashDiffIntegration.dispose());
		await expect(page.locator('.stanza-diff-editor')).toHaveCount(0);
	});
}

test('Worker comparison isolates edited moved code from a neighboring insertion', async ({ page }) => {
	await openDiffPage(page);
	await page.locator('#single').evaluate(element => { element.style.height = '600px'; });
	await page.evaluate(async () => {
		const block = ['function collectRecords(input) {', '  const pendingRecords = prepareRecords(input);', '  auditRecords(pendingRecords);', '  return pendingRecords;', '}'];
		const edited = [...block];
		edited[1] = '  const pendingRecords = prepareRecords(updatedInput);';
		const stay = Array.from({ length: 12 }, (_, index) => `stable record ${index}`);
		window.ashDiffIntegration.setComparisonText(['head', ...block, ...stay, 'tail'].join('\n'), ['head', ...stay, 'function other() {', '  return unrelated();', '}', ...edited, 'tail'].join('\n'));
		await window.ashDiffIntegration.setMoves(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
	const editor = page.locator('#single .stanza-diff-editor');
	await editor.locator('.ash-diff-moved-links').getByRole('button').click();
	await expect(editor.getByRole('toolbar', { name: 'Moved code comparison' })).toContainText('Comparing original lines 2–6 with modified lines 17–21');
	await expect(editor.locator('.modified .stanza-diff-line-added')).toHaveCount(1);
	await expect(editor.locator('.original .stanza-diff-line-removed')).toHaveCount(1);
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(6, 21);
		return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
	})).toBe(0);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).not.toContain('unrelated');
	await page.keyboard.press('Escape');
	await expect(editor.getByRole('toolbar', { name: 'Moved code comparison' })).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).toContain('unrelated');
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`edited moved code compares only block changes and stays aligned through edits and undo (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(async () => {
			const block = ['function load(input) {', '  const value = parse(input);', '  return value;', '}'];
			const edited = ['function load(input) {', '  const value = parse(updated);', '  log(value);', '  return value;', '}'];
			const stay = Array.from({ length: 6 }, (_, index) => `stay ${index}`);
			window.ashDiffIntegration.setComparisonText(['head', ...block, ...stay, 'tail'].join('\n'), ['head', ...stay, ...edited, 'tail'].join('\n'));
			await window.ashDiffIntegration.setMoves(true);
		});
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
		const editor = page.locator('#single .stanza-diff-editor');
		await editor.locator('.ash-diff-moved-links').getByRole('button').click();
		const toolbar = editor.getByRole('toolbar', { name: localized(locale, 'Moved code comparison', '移动代码比较') });
		await expect(toolbar).toContainText(localized(locale, 'Comparing original lines 2–5 with modified lines 8–12', '正在比较原始第 2–5 行与修改后第 8–12 行'));
		await expect(editor.locator('.ash-diff-revert')).toHaveCount(0);
		await expect(editor.locator('.modified .stanza-diff-line-added')).toHaveCount(2);
		await expect(editor.locator('.original .stanza-diff-line-removed')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => {
			const position = window.ashDiffIntegration.linePositions(2, 8);
			return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
		})).toBe(0);
		await expect.poll(() => page.evaluate(() => {
			const position = window.ashDiffIntegration.linePositions(5, 12);
			return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
		})).toBe(0);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).toContain(localized(locale, 'Original line 3:', '原始文件第 3 行：'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).not.toContain(localized(locale, 'Original line 2:', '原始文件第 2 行：'));
		await page.evaluate(() => window.ashDiffIntegration.editModified([1, 1, 1, 1], 'prefix\n'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await expect(toolbar).toContainText(localized(locale, 'modified lines 9–13', '修改后第 9–13 行'));
		await page.evaluate(() => window.ashDiffIntegration.editModified([10, 23, 10, 30], 'changed'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toContain('parse(changed)');
		await expect(toolbar).toContainText(localized(locale, 'modified lines 9–13', '修改后第 9–13 行'));
		await page.evaluate(() => window.ashDiffIntegration.undo());
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toContain('parse(updated)');
		await expect(toolbar).toBeVisible();
		await expect(editor.getByRole('toolbar', { name: localized(locale, 'Moved code comparison', '移动代码比较') })).toContainText(localized(locale, 'Comparing original lines 2–5 with modified lines 9–13', '正在比较原始第 2–5 行与修改后第 9–13 行'));
		const stop = editor.getByRole('button', { name: localized(locale, 'Stop comparing moved code', '停止比较移动代码'), exact: true });
		await stop.focus();
		await stop.press('Space');
		await expect(toolbar).toBeHidden();
		await expect(editor.locator('.modified .stanza-editor-input')).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().accessibleContent)).toContain(localized(locale, 'Original line 2', '原始文件第 2 行'));
	});
}

test('moved comparison supports keyboard exit, read-only views, wrapping and disappearing moves', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(async () => {
		const longLine = '  return compute(input, configuration); '.repeat(12);
		const block = ['function load(input) {', longLine, '}'];
		const stay = Array.from({ length: 12 }, (_, index) => `stay ${index}`);
		window.ashDiffIntegration.setComparisonText(['head', ...block, ...stay, 'tail'].join('\n'), ['head', ...stay, ...block, 'tail'].join('\n'));
		await window.ashDiffIntegration.setMoves(true);
		window.ashDiffIntegration.setEditorFeatures({ readOnly: true });
		window.ashDiffIntegration.toggleWordWrap();
	});
	const editor = page.locator('#single .stanza-diff-editor');
	const move = editor.locator('.ash-diff-moved-links').getByRole('button');
	const revealMove = async () => {
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
		await page.evaluate(() => window.ashDiffIntegration.scrollModified(window.ashDiffIntegration.linePositions(2, 14).modifiedTop));
		await expect(move).toBeVisible();
	};
	await revealMove();
	await expect(move).toBeVisible();
	await move.focus();
	await move.press('Enter');
	const toolbar = editor.getByRole('toolbar', { name: 'Moved code comparison' });
	await expect(toolbar).toBeVisible();
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(3, 15);
		return position.originalBottom - position.originalTop - position.modifiedBottom + position.modifiedTop;
	})).toBe(0);
	await editor.getByRole('separator').press('ArrowLeft');
	await editor.getByRole('separator').press('ArrowLeft');
	await expect.poll(() => page.evaluate(() => {
		const position = window.ashDiffIntegration.linePositions(4, 16);
		return position.originalTop - position.originalScrollTop - position.modifiedTop + position.modifiedScrollTop;
	})).toBe(0);
	await page.locator('#single .modified .stanza-editor-input').press('Escape');
	await expect(toolbar).toBeHidden();
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await expect(toolbar).toBeHidden();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await editor.getByRole('button', { name: 'Stop comparing moved code', exact: true }).focus();
	await page.evaluate(() => window.ashDiffIntegration.setMoves(false));
	await expect(toolbar).toBeHidden();
	await expect(editor.locator('.modified .stanza-editor-input')).toBeFocused();
	await page.evaluate(() => window.ashDiffIntegration.setMoves(true));
	await revealMove();
	await move.click();
	await expect(toolbar).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\nnew\ntail', 'head\nnew\ntail'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(toolbar).toBeHidden();
	await expect(move).toHaveCount(0);
});

test('diff feature overview delegates pointer and wheel input to editor scrolling', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => {
		const lines = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n');
		window.ashDiffIntegration.setComparisonText(lines, `${lines}\nadded`);
	});
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const ruler = page.locator('#single .stanza-diff-overview');
	await ruler.click({ position: { x: 10, y: 150 } });
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop)).toBeGreaterThan(0);
	await page.evaluate(() => window.ashDiffIntegration.scrollModified(0));
	await ruler.hover();
	await page.mouse.wheel(0, 200);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1).modifiedScrollTop)).toBeGreaterThan(0);
});

test('diff feature geometry follows wrapping and collapse, and selecting hidden lines reveals both sides', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(async () => {
		const header = Array.from({ length: 25 }, (_, index) => `header ${index}`);
		const keep = Array.from({ length: 35 }, (_, index) => `keep ${index}`);
		const moved = ['move A '.repeat(80), 'move B '.repeat(80)];
		window.ashDiffIntegration.setComparisonText([...header, ...moved, ...keep, 'tail'].join('\n'), [...header, ...keep, ...moved, 'tail'].join('\n'));
		await window.ashDiffIntegration.setMoves(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().moves)).toBe(1);
	const path = page.locator('#single .ash-diff-moved-links > svg > path');
	await page.evaluate(() => window.ashDiffIntegration.toggleWordWrap());
	const firstLine = await page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1));
	const originalRowHeight = firstLine.originalBottom - firstLine.originalTop;
	const modifiedRowHeight = firstLine.modifiedBottom - firstLine.modifiedTop;
	await expect.poll(async () => {
		const positions = await page.evaluate(() => window.ashDiffIntegration.linePositions(26, 61));
		const originalCenter = positions.originalTop - positions.originalScrollTop + originalRowHeight / 2;
		const modifiedCenter = positions.modifiedTop - positions.modifiedScrollTop + modifiedRowHeight / 2;
		return await path.getAttribute('d') === `M 0 ${originalCenter} C 12 ${originalCenter} 12 ${modifiedCenter} 24 ${modifiedCenter}`;
	}).toBe(true);
	const before = await path.getAttribute('d');
	await expect.poll(() => page.evaluate(() => {
		const first = window.ashDiffIntegration.linePositions(26, 61);
		const last = window.ashDiffIntegration.linePositions(27, 62);
		const originalMarker = document.querySelector<HTMLElement>('#single .stanza-diff-overview-lane.original .stanza-diff-overview-marker')!;
		const modifiedMarker = document.querySelector<HTMLElement>('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker')!;
		return Math.abs(parseFloat(originalMarker.style.height) - (last.originalBottom - first.originalTop) / last.originalContentHeight * 100) < 0.001
			&& Math.abs(parseFloat(modifiedMarker.style.height) - (last.modifiedBottom - first.modifiedTop) / last.modifiedContentHeight * 100) < 0.001;
	})).toBe(true);
	await page.evaluate(() => window.ashDiffIntegration.setHiddenRegions(true));
	await expect.poll(() => path.getAttribute('d')).not.toBe(before);
	const contains = (ranges: number[][]) => ranges.some(([start, end]) => start! <= 5 && end! >= 5);
	expect(contains((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).original)).toBe(false);
	await page.evaluate(() => window.ashDiffIntegration.selectModified([5, 1, 6, 2]));
	await expect.poll(async () => {
		const ranges = await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges());
		return contains(ranges.original) && contains(ranges.modified);
	}).toBe(true);
	await page.evaluate(() => {
		document.documentElement.dataset.colorScheme = 'hcDark';
		document.documentElement.style.setProperty('--ash-contrastBorder', 'rgb(10, 20, 30)');
		document.documentElement.style.setProperty('--ash-strokeThickness', '1px');
		window.ashDiffIntegration.scrollModified(window.ashDiffIntegration.linePositions(26, 61).originalTop);
	});
	await expect(page.locator('#single .ash-diff-moved-block').first()).toHaveCSS('outline-color', 'rgb(10, 20, 30)');
});

test('diff editors preserve source indentation on both sides', async ({ page }) => {
	await openDiffPage(page);
	const lines = ['xxxxxxxxxx', '    xxxxxx', '\txxxxxx', '\t\txx'];
	await page.evaluate(value => window.ashDiffIntegration.setComparisonText(value, `${value}\nchanged`), lines.join('\n'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	for (const side of ['original', 'modified']) {
		const renderedLines = page.locator(`#single .stanza-diff-editor-side.${side} .view-line .stanza-editor-line-text`);
		await expect.poll(async () => (await renderedLines.allTextContents()).slice(0, 4)).toEqual(lines);
		const widths = await renderedLines.evaluateAll(elements => elements.slice(0, 4).map(element => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return range.getBoundingClientRect().width;
		}));
		expect(widths[0]).toBeGreaterThan(0);
		for (const width of widths) {
			expect(Math.abs(width - widths[0]!)).toBeLessThan(1);
		}
	}
});

test('both diff scroll viewports start after their fixed line-number gutter', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('long line '.repeat(100), `${'long line '.repeat(100)}changed`));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	for (const side of ['original', 'modified']) {
		const editor = page.locator(`#single .stanza-diff-editor-side.${side} .stanza-editor`);
		await expect.poll(() => editor.evaluate(root => {
			const margin = root.querySelector('.margin')!.getBoundingClientRect();
			const viewport = root.querySelector('.ash-smooth-scrollable')!.getBoundingClientRect();
			const track = root.querySelector('.ash-scrollbar-track-horizontal')!.getBoundingClientRect();
			return { gutterWidth: margin.width > 0, viewportDelta: viewport.left - margin.right, trackDelta: track.left - viewport.left };
		})).toEqual({ gutterWidth: true, viewportDelta: 0, trackDelta: 0 });
	}
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`editable diff renders Unicode changes and shares models with Multi Diff (${locale})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await openDiffPage(page, locale);
		await expect(page.locator('#single .stanza-diff-inline-removed')).toHaveText('😀');
		await expect(page.locator('#single .stanza-diff-inline-added')).toHaveText('🤖');
		await expect(page.locator('#single .stanza-editor')).toHaveCount(2);
		await expect(page.locator('#multi .stanza-multi-diff-editor-section')).toHaveCount(2);
		await expect(page.locator('#multi .stanza-diff-editor')).toHaveCount(2);
		await expect(page.locator('#multi .stanza-editor')).toHaveCount(4);
		await expect(page.locator('#multi .stanza-diff-inline-removed')).toHaveText('😀');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.activeMultiControl())).toBe('same\nbefore 🤖 after\nlast');
		await page.locator('#single .stanza-diff-editor').focus();
		await page.keyboard.press('F7');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().activeRow)).toBe(1);
		await expect(page.locator('#single .stanza-diff-editor-accessibility-status')).toContainText('2');
		await page.locator('#multi .stanza-multi-diff-editor').focus();
		await page.keyboard.press('F7');
		await expect(page.locator('#multi .stanza-multi-diff-editor-accessibility-status')).toContainText(localized(locale, 'Change 2 of 2, second.ts', '第 2 处差异，共 2 处，second.ts'));
		await page.keyboard.press('F7');
		await expect(page.locator('#multi .stanza-multi-diff-editor-accessibility-status')).toContainText(localized(locale, 'Change 1 of 2, first.ts', '第 1 处差异，共 2 处，first.ts'));
		await expect(page.locator('#multi .stanza-multi-diff-editor')).toHaveAttribute('aria-label', localized(locale, 'Multi-file diff editor with 2 files', '多文件差异编辑器，共 2 个文件'));
		expect(errors).toEqual([]);
	});
}

test('diff navigation keeps line decorations free of focus rings in every theme', async ({ page }, testInfo) => {
	await openDiffPage(page);
	const editor = page.locator('#single .stanza-diff-editor');
	for (const themeId of ['vs', 'vs-dark', 'hc-light', 'hc-black']) {
		await page.evaluate(themeId => {
			window.ashDiffIntegration.setTheme(themeId);
			if (themeId.startsWith('hc-')) {
				document.getElementById('single')!.style.setProperty('--ash-contrastBorder', 'rgb(10, 20, 30)');
			}
			window.ashDiffIntegration.setComparisonText(`head\nbefore\nmiddle\nold\n${themeId}`, `head\nafter\nmiddle\nnew\n${themeId}`);
		}, themeId);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await editor.focus();
		await page.keyboard.press('F7');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().activeRow)).toBe(1);
		await page.keyboard.press('F7');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().activeRow)).toBe(3);
		await page.keyboard.press('Shift+F7');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().activeRow)).toBe(1);
		await page.keyboard.press('Escape');
		await expect(editor).toBeFocused();
		await expect(editor).toHaveCSS('outline-style', 'solid');
		await expect(editor.locator('.stanza-diff-editor-accessibility-status')).toContainText('Change 1 of 2');
		await page.locator('#modified').click();
		for (const side of ['original', 'modified']) {
			const lines = editor.locator(`.${side} .stanza-diff-line-removed, .${side} .stanza-diff-line-added`);
			await expect(lines).toHaveCount(2);
			for (const line of await lines.all()) {
				await expect(line).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				if (themeId.startsWith('hc-')) {
					await expect(line).toHaveCSS('outline-style', 'solid');
					await expect(line).toHaveCSS('outline-color', 'rgb(10, 20, 30)');
				} else {
					await expect(line).toHaveCSS('outline-style', 'none');
				}
			}
		}
		await testInfo.attach(`diff-navigation-${themeId}`, { body: await page.locator('#single').screenshot(), contentType: 'image/png' });
	}
});

test('diff decorations render themed lines, gutter signs, and overview markers', async ({ page }) => {
	await openDiffPage(page);
	const editor = page.locator('#single .stanza-diff-editor');
	const removedLine = editor.locator('.stanza-diff-line-removed').first();
	const insertedLine = editor.locator('.stanza-diff-line-added').first();
	const removedGutter = editor.locator('.stanza-diff-gutter-removed').first();
	const insertedGutter = editor.locator('.stanza-diff-gutter-added').first();
	const removedSign = editor.locator('.stanza-diff-remove-sign .ash-icon').first();
	const insertedSign = editor.locator('.stanza-diff-insert-sign .ash-icon').first();
	const removedMarker = editor.locator('.stanza-diff-overview-marker.removed').first();
	const insertedMarker = editor.locator('.stanza-diff-overview-marker.inserted').first();
	await page.evaluate(() => document.documentElement.style.setProperty('--ash-lxiconFontSize-compact', '12px'));
	await expect(removedSign).toHaveAttribute('aria-hidden', 'true');
	await expect(insertedSign).toHaveAttribute('aria-hidden', 'true');
	await expect(removedSign).toHaveCSS('width', '12px');
	await expect(insertedSign).toHaveCSS('width', '12px');
	await page.evaluate(() => {
		const root = document.documentElement;
		root.style.setProperty('--ash-diffEditor-removedLineBackground', 'rgb(250, 220, 220)');
		root.style.setProperty('--ash-diffEditor-insertedLineBackground', 'rgb(220, 250, 220)');
		root.style.setProperty('--ash-diffEditorGutter-removedLineBackground', 'rgb(240, 180, 180)');
		root.style.setProperty('--ash-diffEditorGutter-insertedLineBackground', 'rgb(180, 240, 180)');
		root.style.setProperty('--ash-diffEditorOverview-removedForeground', 'rgb(200, 40, 40)');
		root.style.setProperty('--ash-diffEditorOverview-insertedForeground', 'rgb(40, 160, 40)');
	});
	await expect(removedLine).toHaveCSS('background-color', 'rgb(250, 220, 220)');
	await expect(insertedLine).toHaveCSS('background-color', 'rgb(220, 250, 220)');
	await expect(removedGutter).toHaveCSS('background-color', 'rgb(240, 180, 180)');
	await expect(insertedGutter).toHaveCSS('background-color', 'rgb(180, 240, 180)');
	await expect(removedMarker).toHaveCSS('background-color', 'rgb(200, 40, 40)');
	await expect(insertedMarker).toHaveCSS('background-color', 'rgb(40, 160, 40)');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('same', 'same'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(editor.locator('.stanza-diff-line-removed, .stanza-diff-line-added, .stanza-diff-remove-sign, .stanza-diff-insert-sign')).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`diff separator resizes both columns by pointer and keyboard, resets, and leaves focus in inline view (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		const editor = page.locator('#single .stanza-diff-editor');
		const sash = editor.getByRole('separator', { name: localized(locale, 'Resize diff editor columns', '调整差异编辑器的分栏宽度') });
		const original = editor.locator('.stanza-diff-editor-side.original');
		const modified = editor.locator('.stanza-diff-editor-side.modified');
		const widths = async () => ({
			original: await original.evaluate(element => element.getBoundingClientRect().width),
			modified: await modified.evaluate(element => element.getBoundingClientRect().width),
		});
		await expect(sash).toHaveAttribute('aria-valuenow', '50');
		await expect(sash).toHaveAttribute('aria-controls', /ash-diff-editor-\d+-original ash-diff-editor-\d+-modified/);
		const initial = await widths();
		await sash.focus();
		await page.keyboard.press('ArrowRight');
		await expect.poll(async () => (await widths()).original).toBe(initial.original + 10);
		await page.keyboard.press('Alt+ArrowLeft');
		await expect.poll(async () => (await widths()).original).toBe(initial.original + 9);
		const bounds = await sash.boundingBox();
		if (!bounds) throw new Error('Diff separator has no bounds');
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2);
		await page.mouse.up();
		await expect.poll(async () => (await widths()).original).toBe(initial.original + 89);
		await expect.poll(async () => (await widths()).modified).toBe(initial.modified - 89);
		await sash.dblclick();
		await expect.poll(async () => (await widths()).original).toBe(initial.original);
		await sash.focus();
		await page.locator('#single').evaluate(element => { element.style.width = '200px'; });
		await expect(sash).toBeHidden();
		await expect.poll(() => modified.evaluate(element => element.contains(document.activeElement))).toBe(true);
		await page.locator('#single').evaluate(element => { element.style.width = '800px'; });
		await expect(sash).toBeVisible();
		await sash.focus();
		await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
		await expect(sash).toBeHidden();
		await expect.poll(() => modified.evaluate(element => element.contains(document.activeElement))).toBe(true);
		await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
		await expect.poll(async () => (await widths()).original).toBe(initial.original);
		const localizedSash = editor.getByRole('separator', { name: localized(locale, 'Resize diff editor columns', '调整差异编辑器的分栏宽度') });
		await expect(localizedSash).toHaveAttribute('aria-valuetext', localized(locale, 'Original 50%, modified 50%', '原始文件 50%，修改后文件 50%'));
		await expect(localizedSash).toHaveAttribute('aria-description', locale === 'zh-CN' ? /左右方向键/ : /Left and Right Arrow keys/);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`accessible diff viewer reads changed lines, follows navigation, and restores editor focus (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nold\nlast\nold end', 'first\nnew\nlast\nnew end'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const editor = page.locator('#single .stanza-diff-editor');
		const viewer = editor.locator('.stanza-accessible-diff-viewer');
		await editor.focus();
		await page.keyboard.press('F7');
		await expect(viewer).toBeVisible();
		await expect(viewer).toHaveAttribute('aria-label', localized(locale, 'Accessible Diff Viewer', '无障碍差异查看器'));
		await expect(viewer.locator('textarea')).toBeFocused();
		await expect(viewer.locator('[role="status"]')).toHaveText(localized(locale, 'Difference 1 of 2', '第 1 处差异，共 2 处'));
		await expect(viewer.locator('textarea')).toHaveValue(localized(locale, 'Original line 2: old\nModified line 2: new', '原始文件第 2 行：old\n修改后文件第 2 行：new'));
		await expect(editor.locator('.stanza-diff-editor-side.original')).toHaveAttribute('aria-hidden', 'true');
		await expect(editor.locator('.stanza-diff-editor-side.original')).toHaveAttribute('inert', '');
		await page.keyboard.press('F7');
		await expect(viewer.locator('[role="status"]')).toHaveText(localized(locale, 'Difference 2 of 2', '第 2 处差异，共 2 处'));
		await expect(viewer.locator('textarea')).toHaveValue(localized(locale, 'Original line 4: old end\nModified line 4: new end', '原始文件第 4 行：old end\n修改后文件第 4 行：new end'));
		await page.keyboard.press('Shift+F7');
		await expect(viewer.locator('[role="status"]')).toHaveText(localized(locale, 'Difference 1 of 2', '第 1 处差异，共 2 处'));
		await viewer.getByRole('button', { name: localized(locale, 'Next difference', '下一处差异') }).click();
		await expect(viewer.locator('[role="status"]')).toHaveText(localized(locale, 'Difference 2 of 2', '第 2 处差异，共 2 处'));
		await page.evaluate(() => {
			document.documentElement.dataset.colorScheme = 'hcDark';
			document.documentElement.style.setProperty('--ash-contrastBorder', 'rgb(10, 20, 30)');
			document.documentElement.style.setProperty('--ash-strokeThickness', '1px');
		});
		await expect(viewer).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
		await expect(viewer.getByRole('button', { name: localized(locale, 'Next difference', '下一处差异') })).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
		await expect(editor.getByRole('region', { name: localized(locale, 'Accessible Diff Viewer', '无障碍差异查看器') }).locator('[role="status"]')).toHaveText(localized(locale, 'Difference 2 of 2', '第 2 处差异，共 2 处'));
		await expect(viewer.locator('textarea')).toHaveValue(localized(locale, 'Original line 4: old end\nModified line 4: new end', '原始文件第 4 行：old end\n修改后文件第 4 行：new end'));
		await page.keyboard.press('Escape');
		await expect(viewer).toBeHidden();
		await expect(editor).toBeFocused();
		await expect(editor.locator('.stanza-diff-editor-side.original')).toHaveAttribute('aria-hidden', 'false');
		await expect(editor.locator('.stanza-diff-editor-side.original')).not.toHaveAttribute('inert');
		await page.evaluate(() => window.ashDiffIntegration.setComparisonText('same', 'same'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await page.keyboard.press('F7');
		await expect(viewer).toBeHidden();
		await expect(editor.locator('.stanza-diff-editor-accessibility-status')).toHaveText(localized(locale, 'No differences', '没有差异'));
		await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\nremoved\ntail', 'head\ntail'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await page.keyboard.press('F7');
		await expect(viewer.locator('textarea')).toHaveValue(localized(locale, 'Original line 2: removed', '原始文件第 2 行：removed'));
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\ntail', 'head\nadded\ntail'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await page.keyboard.press('F7');
		await expect(viewer.locator('textarea')).toHaveValue(localized(locale, 'Modified line 2: added', '修改后文件第 2 行：added'));
		await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\ntail', 'head\nnew addition\ntail'));
		await expect(viewer).toBeHidden();
		await expect(editor.locator('.stanza-diff-editor-side.modified')).not.toHaveAttribute('inert');
	});
}

test('inline changes mark the empty side of pure insertions and deletions', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('before after', 'before new after'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-strokeThickness', '1px');
		document.documentElement.style.setProperty('--ash-diffEditor-removedLineMarker', 'rgb(200, 40, 40)');
		document.documentElement.style.setProperty('--ash-diffEditor-removedTextBackground', 'rgb(250, 220, 220)');
	});
	const originalAnchor = page.locator('#single .stanza-diff-editor-side.original .stanza-diff-inline-removed-empty');
	await expect(originalAnchor).toBeVisible();
	await expect(originalAnchor).toHaveCSS('border-left-style', 'solid');
	await expect(originalAnchor).toHaveCSS('background-color', 'rgb(250, 220, 220)');
	await expect(page.locator('#single .stanza-diff-editor-side.modified .stanza-diff-inline-added')).toContainText('new ');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('before new after', 'before after'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(page.locator('#single .stanza-diff-editor-side.modified .stanza-diff-inline-added-empty')).toBeVisible();
	await expect(page.locator('#single .stanza-diff-editor-side.original .stanza-diff-inline-removed')).toContainText('new ');
});

test('inline diff keeps removed text readable and restores both sides', async ({ page }) => {
	await openDiffPage(page);
	const editor = page.locator('#single .stanza-diff-editor');
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await expect(editor).toHaveClass(/inline-view/);
	await expect(editor.locator('.stanza-diff-editor-side.original')).toBeHidden();
	await expect(editor.locator('.stanza-diff-editor-side.modified')).toBeVisible();
	await expect(editor.locator('.stanza-diff-inline-original-line')).toContainText('before 😀 after');
	await expect(editor.locator('.stanza-diff-inline-original-line').first()).toHaveAttribute('aria-label', /Removed line/);
	await editor.locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await expect(editor).not.toHaveClass(/inline-view/);
	await expect(editor.locator('.stanza-diff-editor-side.original')).toBeVisible();
	await expect(editor.locator('.stanza-diff-inline-original-line')).toHaveCount(0);
	await expect.poll(() => editor.locator('.stanza-diff-editor-side.modified').evaluate(element => element.contains(document.activeElement))).toBe(true);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, true, 900));
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect(editor).toHaveClass(/inline-view/);
	await page.locator('#single').evaluate(element => { element.style.width = '800px'; });
	await expect(editor).toHaveClass(/inline-view/);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, true, 700));
	await expect(editor).not.toHaveClass(/inline-view/);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, true, 900));
	await expect(editor).toHaveClass(/inline-view/);
	await page.locator('#single').evaluate(element => { element.style.width = '1000px'; });
	await expect(editor).not.toHaveClass(/inline-view/);
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`inline deletion indicators share the editor margin and respect live configuration (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		const setting = await page.evaluate(() => window.ashDiffIntegration.readIndicatorSetting());
		expect(setting).toEqual({
			title: localized(locale, 'Diff indicators', '差异标记'),
			description: localized(locale, 'Show plus and minus signs beside added and removed lines.', '在新增行和删除行旁显示加号和减号。'),
		});
		await page.evaluate(() => {
			const prefix = Array.from({ length: 5 }, (_, index) => `prefix ${index}`);
			const suffix = Array.from({ length: 30 }, (_, index) => `suffix ${index}`);
			window.ashDiffIntegration.setComparisonText([...prefix, '\tremoved', '', ...suffix].join('\n'), [...prefix, '\tadded', ...suffix].join('\n'));
			window.ashDiffIntegration.setViewMode(false, false, 900);
		});
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const editor = page.locator('#single .stanza-diff-editor');
		const removedLines = editor.locator('.stanza-diff-inline-original-line');
		const margins = editor.locator('.ash-diff-inline-original-margin');
		const removedSigns = margins.locator('.stanza-diff-remove-sign');
		const addedSign = editor.locator('.stanza-diff-editor-side.modified .stanza-diff-insert-sign').first();
		await expect(removedLines).toHaveCount(2);
		await expect(removedSigns).toHaveCount(2);
		await expect(removedSigns.first()).toBeVisible();
		await expect(margins.first()).toHaveAttribute('aria-hidden', 'true');
		await expect(removedSigns.first().locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'diff-remove');
		await expect(removedSigns.first().locator('.ash-icon')).toHaveAttribute('aria-hidden', 'true');
		await expect(removedLines.first()).toHaveAttribute('aria-label', localized(locale, 'Removed line 6: \tremoved', '已删除的第 6 行：\tremoved'));
		await expect(removedLines.first()).toHaveCSS('border-left-width', '0px');
		const markerPosition = async () => {
			const removed = await removedSigns.first().evaluate(element => {
				const { x, y, width, height } = element.getBoundingClientRect();
				return { x, y, width, height };
			});
			const added = await addedSign.evaluate(element => {
				const { x, width } = element.getBoundingClientRect();
				return { x, width };
			});
			const text = await removedLines.first().evaluate(element => {
				const { y, height } = element.getBoundingClientRect();
				return { y, height };
			});
			return { x: removed.x - added.x, width: removed.width - added.width, y: removed.y - text.y, height: removed.height - text.height };
		};
		await expect.poll(markerPosition).toEqual({ x: 0, width: 0, y: 0, height: 0 });
		const topBeforeScroll = (await removedSigns.first().boundingBox())!.y;
		await page.evaluate(() => window.ashDiffIntegration.scrollModified(40));
		await expect.poll(async () => (await removedSigns.first().boundingBox())!.y).toBe(topBeforeScroll - 40);
		await expect.poll(markerPosition).toEqual({ x: 0, width: 0, y: 0, height: 0 });
		await page.locator('#single').evaluate(element => { element.style.width = '450px'; });
		await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ readOnly: true }));
		await expect.poll(markerPosition).toEqual({ x: 0, width: 0, y: 0, height: 0 });
		for (const themeId of ['vs', 'vs-dark', 'hc-light', 'hc-black']) {
			const colors = await page.evaluate(themeId => window.ashDiffIntegration.setTheme(themeId), themeId);
			await expect(removedSigns.first()).toHaveCSS('color', colors.marker);
			await expect(margins.first()).toHaveCSS('background-color', colors.background);
		}
		await page.evaluate(() => window.ashDiffIntegration.setDiffIndicators(false));
		await expect(editor.locator('.stanza-diff-remove-sign, .stanza-diff-insert-sign')).toHaveCount(0);
		await expect(removedLines).toHaveCount(2);
		await expect(editor.locator('.stanza-diff-line-added').first()).toBeVisible();
		await page.evaluate(() => window.ashDiffIntegration.setDiffIndicators(true));
		await expect(removedSigns).toHaveCount(2);
		await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderIndicators: false }));
		await page.evaluate(() => window.ashDiffIntegration.setDiffIndicators(false));
		await page.evaluate(() => window.ashDiffIntegration.setDiffIndicators(true));
		await expect(editor.locator('.stanza-diff-remove-sign, .stanza-diff-insert-sign')).toHaveCount(0);
		await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderIndicators: true }));
		await expect(removedSigns).toHaveCount(2);
		await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
		await expect(margins).toHaveCount(0);
		await expect(editor.locator('.stanza-diff-editor-side.original .stanza-diff-remove-sign').first()).toBeVisible();
		await page.evaluate(() => window.ashDiffIntegration.setEditorFeatures({ renderIndicators: false }));
		await expect(editor.locator('.stanza-diff-remove-sign, .stanza-diff-insert-sign')).toHaveCount(0);
		await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
		await page.evaluate(() => window.ashDiffIntegration.setComparisonText('same', 'same'));
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		await expect(margins).toHaveCount(0);
		await page.evaluate(() => window.ashDiffIntegration.dispose());
		await expect(editor).toHaveCount(0);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`inline deletion copies source tabs, blank lines and CRLF in either selection direction (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => {
			window.ashDiffIntegration.setComparisonText('head\r\n\tdeleted😀\r\n\r\nsecond deleted\r\nend', 'head\r\nend');
			window.ashDiffIntegration.setViewMode(false, false, 900);
		});
		await expect(page.locator('#single .stanza-diff-inline-original-line')).toHaveCount(3);
		for (const reverse of [false, true]) {
			const copied = await page.evaluate(reverse => {
				const lines = document.querySelectorAll('#single .stanza-diff-inline-original-line');
				const first = document.createTreeWalker(lines[0]!, NodeFilter.SHOW_TEXT).nextNode()!;
				const last = document.createTreeWalker(lines[2]!, NodeFilter.SHOW_TEXT).nextNode()!;
				document.getSelection()!.setBaseAndExtent(reverse ? last : first, reverse ? 5 : 0, reverse ? first : last, reverse ? 0 : 5);
				const clipboardData = new DataTransfer();
				const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
				document.dispatchEvent(event);
				return { text: clipboardData.getData('text/plain'), handled: event.defaultPrevented };
			}, reverse);
			expect(copied).toEqual({ text: '\tdeleted😀\r\n\r\nsecon', handled: true });
		}
	});
}

test('diff view zones replace removed lines after a comparison changes', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nremoved line\nlast', 'first\nlast'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const removedLines = page.locator('#single .stanza-diff-inline-original-line');
	await expect(removedLines).toHaveCount(1);
	await expect(removedLines).toHaveText('removed line');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nnew removed line\nlast', 'first\nlast'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(removedLines).toHaveCount(1);
	await expect(removedLines).toHaveText('new removed line');
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('first\nlast', 'first\nlast'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect(removedLines).toHaveCount(0);
});

for (const theme of ['vs', 'vs-dark', 'hc-black']) {
	test(`unchanged region bars cover the gutter and stay fixed during horizontal scrolling (${theme})`, async ({ page }, testInfo) => {
		await openDiffPage(page);
		const original = Array.from({ length: 36 }, (_, index) => `shared line ${index + 1} ${'context '.repeat(30)}`);
		const modified = [...original];
		modified[11] = 'first changed line';
		modified[25] = 'second changed line';
		await page.evaluate(([left, right, themeId]) => {
			window.ashDiffIntegration.setTheme(themeId);
			window.ashDiffIntegration.setComparisonText(left, right);
			window.ashDiffIntegration.setHiddenRegions(true);
		}, [original.join('\n'), modified.join('\n'), theme]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const side = page.locator('#single .stanza-diff-editor-side.modified');
		const bars = side.locator('.ash-diff-hidden-region');
		await expect(bars).toHaveCount(3);
		await expect(bars.locator('.ash-diff-hidden-region-count')).toHaveText(['10 hidden lines', '11 hidden lines', '9 hidden lines']);
		const geometry = () => side.evaluate(node => {
			const editor = node.querySelector('.stanza-editor')!.getBoundingClientRect();
			return [...node.querySelectorAll('.ash-diff-hidden-region')].map(bar => {
				const rect = bar.getBoundingClientRect();
				return { left: rect.left - editor.left, right: editor.right - rect.right, top: rect.top - editor.top, height: rect.height };
			});
		});
		const before = await geometry();
		expect(before[0].top).toBe(0);
		for (const bar of before) {
			expect(bar.left).toBe(0);
			expect(bar.right).toBeGreaterThanOrEqual(0);
			expect(bar.right).toBeLessThanOrEqual(20);
			expect(bar.height).toBe(24);
		}
		await expect(bars.first()).toHaveCSS('font-size', '13px');
		await expect(bars.first()).toHaveCSS('font-family', 'sans-serif');
		await page.locator('#single').screenshot({ path: testInfo.outputPath('unchanged-regions.png') });
		await side.hover();
		await page.mouse.wheel(240, 0);
		await expect.poll(() => side.locator('.view-lines').evaluate(node => node.getBoundingClientRect().left)).toBeLessThan((await side.boundingBox())!.x);
		expect(await geometry()).toEqual(before);
		await page.evaluate(() => window.ashDiffIntegration.setFontOptions({ fontSize: 20, lineHeight: 32 }));
		await expect(bars.first()).toHaveCSS('height', '24px');
		await expect(bars.first()).toHaveCSS('font-size', '13px');
		await expect.poll(() => geometry().then(rows => rows[1].top)).toBeGreaterThan(before[1].top);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`multi diff restores its folded height after expanding an unchanged region (${locale})`, async ({ page }, testInfo) => {
		await openDiffPage(page, locale);
		const original = Array.from({ length: 60 }, (_, index) => `shared line ${index + 1}`);
		const modified = [...original];
		modified[29] = 'changed middle line';
		await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original.join('\n'), modified.join('\n')]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const section = page.locator('#multi .stanza-multi-diff-editor-section').filter({ hasText: 'first.ts' });
		const side = section.locator('.stanza-diff-editor-side.modified');
		const regions = section.locator('.ash-diff-hidden-region');
		const leading = side.locator('.ash-diff-hidden-region').first();
		await expect(regions).toHaveCount(4);
		const hiddenCount = await leading.locator('.ash-diff-hidden-region-count').textContent();
		const height = () => section.evaluate(node => node.getBoundingClientRect().height);
		const foldedHeight = await height();
		await leading.getByRole('button', { name: localized(locale, 'Show all unchanged lines', '显示全部未修改的行') }).click();
		await expect(regions).toHaveCount(2);
		await expect.poll(height).toBeGreaterThan(foldedHeight);
		const collapse = side.getByRole('button', { name: localized(locale, 'Collapse unchanged region', '折叠未修改区域') });
		await expect(collapse).toBeInViewport();
		await page.locator('#multi').screenshot({ path: testInfo.outputPath('multi-expanded-unchanged-region.png') });
		await collapse.click();
		await expect(regions).toHaveCount(4);
		await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(hiddenCount!);
		await expect.poll(height).toBe(foldedHeight);
		await page.locator('#multi').screenshot({ path: testInfo.outputPath('multi-refolded-unchanged-region.png') });
	});

	for (const inline of [false, true]) {
		test(`expanded unchanged regions can be folded again in a read-only diff (${locale}, ${inline ? 'inline' : 'side by side'})`, async ({ page }, testInfo) => {
			await openDiffPage(page, locale);
			const original = Array.from({ length: 36 }, (_, index) => `shared line ${index + 1}`);
			const modified = [...original];
			modified[17] = 'changed middle line';
			await page.evaluate(([left, right, inline]) => {
				window.ashDiffIntegration.setTheme('vs');
				window.ashDiffIntegration.setComparisonText(left, right);
				window.ashDiffIntegration.setHiddenRegions(true);
				window.ashDiffIntegration.setEditorFeatures({ readOnly: true });
				window.ashDiffIntegration.setViewMode(!inline, false, 900);
			}, [original.join('\n'), modified.join('\n'), inline] as const);
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
			const regions = page.locator('#single .ash-diff-hidden-region');
			const modifiedSide = page.locator('#single .stanza-diff-editor-side.modified');
			const leading = modifiedSide.locator('.ash-diff-hidden-region').first();
			const collapse = modifiedSide.getByRole('button', { name: localized(locale, 'Collapse unchanged region', '折叠未修改区域') });
			await expect(regions).toHaveCount(4);
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '16 hidden lines', '隐藏 16 行'));
			await leading.locator('.ash-diff-hidden-region-count').dblclick();
			await expect(regions).toHaveCount(2);
			await expect(collapse).toBeVisible();
			await page.locator('#single').screenshot({ path: testInfo.outputPath('expanded-fold-button.png') });
			await collapse.focus();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Shift+Tab');
			await expect(collapse).toBeFocused();
			await expect(collapse).toHaveCSS('outline-style', 'solid');
			await page.keyboard.press('Space');
			await expect(regions).toHaveCount(4);
			await expect(collapse).toHaveCount(0);
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '16 hidden lines', '隐藏 16 行'));
			const visible = await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges());
			for (const ranges of [visible.original, visible.modified]) {
				expect(ranges.some(([start, end]) => start <= 5 && 5 <= end)).toBe(false);
			}
			await leading.locator('.ash-diff-hidden-region-above').click();
			await leading.locator('.ash-diff-hidden-region-below').click();
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '12 hidden lines', '隐藏 12 行'));
			for (let step = 0; step < 6; step++) {
				await leading.locator('.ash-diff-hidden-region-above').click();
			}
			await expect(collapse).toBeVisible();
			if (inline) {
				await collapse.click();
			} else {
				await page.locator('#single .stanza-diff-editor-side.original').getByRole('button', { name: localized(locale, 'Collapse unchanged region', '折叠未修改区域') }).click();
			}
			await expect(regions).toHaveCount(4);
			await expect(leading.locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '16 hidden lines', '隐藏 16 行'));
			await page.evaluate(() => window.ashDiffIntegration.setHiddenRegions(false));
			await expect(regions).toHaveCount(0);
			await expect(page.locator('#single .ash-diff-fold-unchanged')).toHaveCount(0);
		});
	}

	test(`unchanged regions collapse on both sides and symbol navigation reveals the target (${locale})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await openDiffPage(page, locale);
		const original = Array.from({ length: 36 }, (_, index) => `shared line ${index + 1}`);
		const modified = [...original];
		modified[35] = 'changed final line';
		await page.evaluate(([left, right]) => {
			window.ashDiffIntegration.setComparisonText(left, right);
			window.ashDiffIntegration.setHiddenRegions(true);
		}, [original.join('\n'), modified.join('\n')]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const regions = page.locator('#single .ash-diff-hidden-region');
		await expect(regions).toHaveCount(2);
		await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '34 hidden lines', '隐藏 34 行'));
		await expect(regions.first()).toBeVisible();
		await expect(regions.first().locator('.ash-diff-hidden-region-content')).toHaveCSS('display', 'flex');
		await expect(regions.first()).toHaveCSS('height', '24px');
		const lineIsVisible = (ranges: number[][]) => ranges.some(([start, end]) => start <= 5 && 5 <= end);
		expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).original)).toBe(false);
		expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).modified)).toBe(false);
		await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveText('Shared section');
		await page.evaluate(() => {
			document.documentElement.dataset.colorScheme = 'hcDark';
			document.documentElement.style.setProperty('--ash-contrastBorder', 'rgb(10, 20, 30)');
			document.documentElement.style.setProperty('--ash-strokeThickness', '1px');
			document.documentElement.style.setProperty('--ash-focusBorder', 'rgb(100, 150, 200)');
		});
		await expect(regions.first().locator('.ash-diff-hidden-region-content')).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
		const showMore = regions.first().getByRole('button', { name: localized(locale, 'Show 2 more lines above', '向上显示更多 2 行') });
		await showMore.focus();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Shift+Tab');
		await expect(showMore).toBeFocused();
		await expect(showMore).toHaveCSS('outline-style', 'solid');
		await page.keyboard.press('Enter');
		await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '32 hidden lines', '隐藏 32 行'));
		await regions.last().locator('.ash-diff-hidden-region-symbol').click();
		await expect(regions).toHaveCount(0);
		expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).modified)).toBe(true);
		await page.evaluate(() => {
			window.ashDiffIntegration.setHiddenRegions(false);
			window.ashDiffIntegration.setHiddenRegions(true);
		});
		await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText(localized(locale, '34 hidden lines', '隐藏 34 行'));
		await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveText('Shared section');
		await page.evaluate(() => window.ashDiffIntegration.removeSymbolProvider());
		await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveCount(0);
		await expect(regions.first().getByRole('button', { name: localized(locale, 'Show all unchanged lines', '显示全部未修改的行') })).toBeVisible();
		await regions.first().getByRole('button', { name: localized(locale, 'Show all unchanged lines', '显示全部未修改的行') }).click();
		await expect(regions).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

test('word wrap updates both editable columns and keeps diff navigation available', async ({ page }) => {
	await openDiffPage(page);
	const original = `same\n${'before '.repeat(70)}😀 tail\nold end`;
	const modified = `same\n${'before '.repeat(70)}🤖 tail\nnew end`;
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#single .stanza-diff-editor');
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).toHaveClass(/word-wrapped/);
	await expect(editor.locator('.stanza-diff-editor-side.original .stanza-editor')).toBeVisible();
	await expect(editor.locator('.stanza-diff-editor-side.modified .stanza-editor')).toBeVisible();
	await page.keyboard.press('F7');
	await expect(editor.locator('.stanza-diff-inline-removed')).toContainText(['😀']);
	await expect(editor.locator('.stanza-diff-inline-added')).toContainText(['🤖']);
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => editor.locator('.stanza-diff-editor-side.original').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(200);
	await page.keyboard.press('F7');
	await expect(page.locator('#single .stanza-diff-editor-accessibility-status')).toContainText('Change 2 of 2');
	const marker = page.locator('#single .stanza-diff-overview-lane.modified .stanza-diff-overview-marker.inserted').first();
	await expect(marker).toBeVisible();
	await page.keyboard.press('Alt+Z');
	await expect(editor).not.toHaveClass(/word-wrapped/);
});

test('modified side accepts text input and original side remains read-only', async ({ page }) => {
	await openDiffPage(page);
	const original = page.locator('#single .stanza-diff-editor-side.original .stanza-editor');
	const modified = page.locator('#single .stanza-diff-editor-side.modified .stanza-editor');
	await original.focus();
	await page.keyboard.type('blocked');
	expect((await page.evaluate(() => window.ashDiffIntegration.read())).originalText).toBe('same\nbefore 😀 after\nlast');
	await modified.focus();
	await page.evaluate(() => window.ashDiffIntegration.selectModifiedAll());
	await page.keyboard.type('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'unchanged', 'unchanged']);
});

test('multi diff edits the shared modified model while its original column stays read-only', async ({ page }) => {
	await openDiffPage(page);
	const first = page.locator('#multi .stanza-multi-diff-editor-section').first();
	await first.locator('.stanza-diff-editor-side.original .stanza-editor').focus();
	await page.keyboard.type('blocked');
	expect((await page.evaluate(() => window.ashDiffIntegration.read())).originalText).toBe('same\nbefore 😀 after\nlast');
	await first.locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' added');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText)).toBe('same\nbefore 🤖 after\nlast added');
	await expect(page.locator('#single .stanza-diff-inline-added').last()).toContainText('added');
});

test('diff font changes update alignment and the removed lines in inline view', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('head\nremoved\nshared', 'head\nshared'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.evaluate(() => window.ashDiffIntegration.setFontOptions({ fontFamily: 'Arial', fontSize: 18, lineHeight: 30 }));
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 2);
		return Math.abs(lines.originalTop - lines.modifiedTop);
	})).toBeLessThan(1);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false, 900));
	const removed = page.locator('#single .stanza-diff-inline-original-line');
	await expect(removed).toHaveText('removed');
	await expect(removed).toHaveCSS('font-size', '18px');
	await expect(removed).toHaveCSS('line-height', '30px');
	await expect(removed).toHaveCSS('height', '30px');
	await page.evaluate(() => window.ashDiffIntegration.setFontOptions({ fontSize: 22, lineHeight: 36 }));
	await expect(removed).toHaveCSS('font-size', '22px');
	await expect(removed).toHaveCSS('height', '36px');
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 2);
		return Math.abs(lines.originalTop - lines.modifiedTop);
	})).toBeLessThan(1);
});

test('diff change navigation and scrolling keep corresponding lines aligned on both sides', async ({ page }) => {
	await openDiffPage(page);
	const original = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
	const modified = [...original];
	modified[59] = 'changed line 60';
	modified[99] = 'changed line 100';
	modified.splice(79, 3);
	modified.splice(20, 0, 'inserted first', 'inserted second');
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setViewMode(true, false, 900);
		window.ashDiffIntegration.setComparisonText(left, right);
	}, [original.join('\n'), modified.join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const alignment = () => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(110, 109);
		return {
			scrollGap: lines.originalScrollTop - lines.modifiedScrollTop,
			lineGap: lines.originalTop - lines.originalScrollTop - (lines.modifiedTop - lines.modifiedScrollTop),
		};
	});
	await page.locator('#single .stanza-diff-editor').focus();
	for (let change = 0; change < 7; change++) {
		await page.keyboard.press('F7');
		await expect.poll(alignment).toEqual({ scrollGap: 0, lineGap: 0 });
	}
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(110, 109).modifiedScrollTop)).toBeGreaterThan(0);
	await page.keyboard.press('Escape');
	for (const enabled of [true, false]) {
		await page.evaluate(enabled => window.ashDiffIntegration.setHiddenRegions(enabled), enabled);
		await expect.poll(alignment).toEqual({ scrollGap: 0, lineGap: 0 });
	}
	await page.evaluate(() => window.ashDiffIntegration.scrollModified(1200));
	await expect.poll(alignment).toEqual({ scrollGap: 0, lineGap: 0 });
	for (const side of ['original', 'modified']) {
		const previousTop = await page.evaluate(() => window.ashDiffIntegration.linePositions(110, 109).modifiedScrollTop);
		await page.locator(`#single .stanza-diff-editor-side.${side}`).hover();
		await page.mouse.wheel(0, -320);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(110, 109).modifiedScrollTop)).toBeLessThan(previousTop);
		await expect.poll(alignment).toEqual({ scrollGap: 0, lineGap: 0 });
	}
});

test('diff restores synchronized vertical scrolling when switching from inline to side by side', async ({ page }) => {
	await openDiffPage(page);
	const original = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n');
	const modified = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join('\n');
	await page.evaluate(([left, right]) => {
		window.ashDiffIntegration.setViewMode(false, false, 900);
		window.ashDiffIntegration.setComparisonText(left, right);
	}, [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.evaluate(() => window.ashDiffIntegration.scrollModified(1800));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.linePositions(8, 8).modifiedScrollTop)).toBe(1800);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false, 900));
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(8, 8);
		return { original: lines.originalScrollTop, modified: lines.modifiedScrollTop };
	})).toEqual({ original: 1800, modified: 1800 });
});

test('wrapped and inserted lines stay aligned while the two editors scroll', async ({ page }) => {
	await openDiffPage(page);
	const tail = Array.from({ length: 100 }, (_, index) => `tail ${index}`).join('\n');
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [
		`head\n${'long '.repeat(100)}\nshared\n${tail}`,
		`head\nshort\ninserted\nshared\n${tail}`,
	]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await page.locator('#single .stanza-diff-editor').focus();
	await page.keyboard.press('Alt+Z');
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 4);
		return Math.abs(lines.originalTop - lines.modifiedTop);
	})).toBeLessThan(1);
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 4);
		return Math.abs(lines.originalTop - lines.modifiedTop);
	})).toBeLessThan(1);
	await page.locator('#single .stanza-diff-editor-side.original').hover();
	await page.mouse.wheel(0, 320);
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 4);
		return { moved: lines.originalScrollTop > 0, gap: Math.abs(lines.originalScrollTop - lines.modifiedScrollTop) };
	})).toEqual({ moved: true, gap: 0 });
});

test('unchanged wrapped lines stay aligned across unequal split widths and repeated layout', async ({ page }) => {
	await openDiffPage(page);
	const shared = 'unchanged long text '.repeat(40);
	const tail = Array.from({ length: 60 }, (_, index) => `tail ${index}`);
	await page.evaluate(([original, modified]) => {
		window.ashDiffIntegration.setComparisonText(original, modified);
		window.ashDiffIntegration.setViewMode(true, false, 900);
		window.ashDiffIntegration.toggleWordWrap();
	}, [`head\n${shared}\nbefore\n${tail.join('\n')}`, `head\n${shared}\nafter\n${tail.join('\n')}`]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const separator = page.locator('#single').getByRole('separator');
	await separator.focus();
	for (let step = 0; step < 8; step++) {
		await separator.press('ArrowLeft');
	}
	await expect(separator).not.toHaveAttribute('aria-valuenow', '50');
	const gap = () => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(3, 3);
		return Math.abs(lines.originalTop - lines.modifiedTop);
	});
	await expect.poll(gap).toBeLessThan(1);
	for (const width of [600, 900, 800]) {
		await page.locator('#single').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
		await expect.poll(gap).toBeLessThan(1);
	}
	for (let step = 0; step < 16; step++) {
		await separator.press('ArrowRight');
	}
	await expect.poll(gap).toBeLessThan(1);
	await page.evaluate(() => window.ashDiffIntegration.scrollModified(360));
	await expect.poll(() => page.evaluate(() => {
		const lines = window.ashDiffIntegration.linePositions(4, 4);
		return { gap: Math.abs(lines.originalTop - lines.modifiedTop), scrollGap: Math.abs(lines.originalScrollTop - lines.modifiedScrollTop) };
	})).toEqual({ gap: 0, scrollGap: 0 });
});

test('inline navigation reveals deleted text after earlier insertions', async ({ page }) => {
	await openDiffPage(page);
	const shared = Array.from({ length: 60 }, (_, index) => `shared ${index}`);
	const inserted = Array.from({ length: 30 }, (_, index) => `inserted ${index}`);
	const tail = Array.from({ length: 20 }, (_, index) => `tail ${index}`);
	await page.evaluate(([original, modified]) => {
		window.ashDiffIntegration.setComparisonText(original, modified);
		window.ashDiffIntegration.setViewMode(false, false, 900);
	}, [['head', ...shared, 'removed target', ...tail].join('\n'), ['head', ...inserted, ...shared, ...tail].join('\n')]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#single .stanza-diff-editor');
	await editor.focus();
	await page.keyboard.press('Shift+F7');
	const removed = editor.locator('.stanza-diff-inline-original-line').filter({ hasText: 'removed target' });
	await expect(removed).toBeInViewport();
});

test('multi diff wraps editable columns and repositions sections through resize and collapse', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.activeMultiControl())).toBe('same\nbefore 🤖 after\nlast');
	const original = `same\n${'before '.repeat(70)}😀 tail\nsame end`;
	const modified = `same\n${'before '.repeat(70)}🤖 tail\nsame end`;
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).toHaveClass(/word-wrapped/);
	const sections = editor.locator('.stanza-multi-diff-editor-section');
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveClass(/word-wrapped/);
	const firstHeight = await sections.first().evaluate(element => element.getBoundingClientRect().height);
	expect(firstHeight).toBeGreaterThan(34 + 3 * 20);
	const firstScrollHeight = await editor.evaluate(element => element.scrollHeight);
	expect(firstScrollHeight).toBeGreaterThan(firstHeight);
	await page.locator('#multi').evaluate(element => { element.style.width = '400px'; });
	await expect.poll(() => sections.first().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(firstHeight);
	expect(await editor.evaluate(element => element.scrollHeight)).toBeGreaterThan(firstScrollHeight);
	await sections.first().locator('.stanza-multi-diff-editor-header-toggle').click();
	await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
	const collapsedGap = await sections.evaluateAll(elements => elements[1]!.getBoundingClientRect().top - elements[0]!.getBoundingClientRect().bottom);
	expect(collapsedGap).toBe(8);
	await editor.focus();
	await page.keyboard.press('F7');
	await expect(sections.first().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
	await page.keyboard.press('F7');
	await expect(editor.locator('.stanza-multi-diff-editor-accessibility-status')).toContainText('Change 2 of 2');
	await expect(sections.nth(1).locator('.stanza-diff-line-removed')).toBeVisible();
	await expect(sections.nth(1)).toHaveClass(/\bactive\b/);
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).not.toHaveClass(/word-wrapped/);
	await expect(sections.first().locator('.stanza-diff-editor')).not.toHaveClass(/word-wrapped/);
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`multi diff uses one shared vertical scrollbar without clipping file editors (${locale})`, async ({ page }, testInfo) => {
		await openDiffPage(page, locale);
		const original = Array.from({ length: 180 }, (_, index) => `original line ${index}`).join('\n');
		const modified = Array.from({ length: 180 }, (_, index) => `modified line ${index}`).join('\n');
		await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [original, modified]);
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
		const host = page.locator('#multi');
		const editor = host.locator('.stanza-multi-diff-editor');
		const track = host.locator('.stanza-multi-diff-editor-scrollbar > .ash-scrollbar-track-vertical');
		await editor.hover();
		await expect(track).toBeVisible();
		await expect(host.locator('.ash-scrollbar-track-vertical:visible')).toHaveCount(1);
		await expect(editor.locator('.stanza-diff-overview')).toBeHidden();
		expect(await editor.evaluate(node => node.getBoundingClientRect().width - node.clientWidth)).toBe(0);
		for (const width of [800, 400, 700]) {
			await host.evaluate((node, width) => { node.style.width = `${width}px`; }, width);
			await expect.poll(() => editor.locator('.stanza-diff-editor').first().evaluate(node => {
				const slot = node.parentElement!.getBoundingClientRect();
				return Math.abs(node.getBoundingClientRect().right - slot.right);
			})).toBeLessThan(1);
			expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
		}
		for (const side of ['original', 'modified']) {
			await editor.locator(`.stanza-diff-editor-side.${side}`).first().hover();
			const before = await editor.evaluate(node => node.scrollTop);
			await page.mouse.wheel(0, 120);
			await expect.poll(() => editor.evaluate(node => node.scrollTop)).toBe(before + 120);
		}
		await editor.focus();
		const beforePage = await editor.evaluate(node => node.scrollTop);
		await page.keyboard.press('PageDown');
		await expect.poll(() => editor.evaluate(node => node.scrollTop)).toBeGreaterThan(beforePage);
		await track.focus();
		await track.press('Home');
		await expect.poll(() => editor.evaluate(node => node.scrollTop)).toBe(0);
		const thumb = track.locator('.ash-scrollbar-thumb');
		const bounds = (await thumb.boundingBox())!;
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 60);
		await page.mouse.up();
		await expect.poll(() => editor.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
		await testInfo.attach(`multi-diff-scrollbar-${locale}`, { body: await host.screenshot(), contentType: 'image/png' });
	});
}

test('multi diff keeps one outer scroll and remounts only visible file editors', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.toggleMultiUnchangedRegions());
	const lines = Array.from({ length: 180 }, (_, index) => `line ${index}`);
	const changed = [...lines];
	changed[90] = 'changed line 90';
	await page.evaluate(([left, right]) => window.ashDiffIntegration.setComparisonText(left, right), [lines.join('\n'), changed.join('\n')]);
	await page.evaluate(text => window.ashDiffIntegration.setSecondComparisonText(text, text), lines.join('\n'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	const sections = editor.locator('.stanza-multi-diff-editor-section');
	await expect(sections).toHaveCount(1);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('first.ts');
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveCount(1);
	await sections.first().locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.press('ArrowDown');
	await editor.evaluate(element => { element.scrollTop = 600; });
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBe(600);
	const stickyGap = await sections.first().evaluate(section => {
		const header = section.querySelector('.stanza-multi-diff-editor-header')!;
		const body = section.querySelector('.stanza-multi-diff-editor-item-editor')!;
		return Math.abs(body.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
	});
	expect(stickyGap).toBeLessThan(2);
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections).toHaveCount(1);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('second.ts');
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveCount(1);
	await editor.evaluate(element => { element.scrollTop = 0; });
	await expect(sections.first().locator('.stanza-diff-editor')).toHaveCount(1);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('first.ts');
	await sections.first().locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.keyboard.type('X');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().modifiedText.split('\n')[1])).toBe('Xline 1');
});

test('multi diff keeps the visible file in place when an earlier comparison changes height', async ({ page }) => {
	await openDiffPage(page);
	const lineCount = 180;
	const longText = Array.from({ length: lineCount }, (_, index) => `line ${index}`).join('\n');
	await page.evaluate(text => {
		window.ashDiffIntegration.setComparisonText(text, text);
		window.ashDiffIntegration.setSecondComparisonText(text, text);
	}, longText);
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	const firstLine = await page.evaluate(() => window.ashDiffIntegration.linePositions(1, 1));
	const bodyHeight = 2 * lineCount * (firstLine.modifiedBottom - firstLine.modifiedTop);
	await expect.poll(() => editor.evaluate(element => element.scrollHeight)).toBeGreaterThan(bodyHeight);
	const first = editor.locator('.stanza-multi-diff-editor-section').first();
	const secondTop = await first.evaluate(element => parseFloat(element.style.top) + parseFloat(element.style.height) + 8);
	await editor.evaluate((element, top) => { element.scrollTop = top + 500; }, secondTop);
	const second = editor.locator('.stanza-multi-diff-editor-section').filter({ hasText: 'second.ts' });
	await expect(second).toBeVisible();
	const positionBefore = await second.evaluate(element => element.getBoundingClientRect().top);
	await page.evaluate(() => window.ashDiffIntegration.setComparisonText('old', 'new'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().state)).toBe('ready');
	await expect.poll(() => second.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(positionBefore, 0);
	await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeLessThan(secondTop - 1000);
});

test('multi diff mounts only nearby file headers and restores collapsed state after scrolling away', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-strokeThickness', '1px');
		document.documentElement.style.setProperty('--ash-multiDiffEditor-background', 'rgb(18, 27, 36)');
		document.documentElement.style.setProperty('--ash-multiDiffEditor-headerBackground', 'rgb(37, 46, 55)');
		document.documentElement.style.setProperty('--ash-multiDiffEditor-border', 'rgb(56, 65, 74)');
	});
	await page.evaluate(() => window.ashDiffIntegration.showManyComparisons(120));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const sections = editor.locator('.stanza-multi-diff-editor-section');
	await expect(editor).toHaveCSS('background-color', 'rgb(18, 27, 36)');
	await expect(sections.first()).toHaveCSS('border-top-color', 'rgb(56, 65, 74)');
	await expect(sections.first().locator('.stanza-multi-diff-editor-header')).toHaveCSS('background-color', 'rgb(37, 46, 55)');
	await expect.poll(() => sections.count()).toBeLessThan(5);
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('file-0.ts');
	await sections.first().locator('.stanza-multi-diff-editor-header-toggle').focus();
	await page.keyboard.press('ArrowDown');
	await expect(sections.locator('.stanza-multi-diff-editor-header-toggle:focus')).toHaveAttribute('aria-label', 'Collapse file-1.ts');
	await page.keyboard.press('End');
	await expect(sections.locator('.stanza-multi-diff-editor-header-toggle:focus')).toHaveAttribute('aria-label', 'Collapse file-119.ts');
	await page.keyboard.press('Home');
	await expect(sections.locator('.stanza-multi-diff-editor-header-toggle:focus')).toHaveAttribute('aria-label', 'Collapse file-0.ts');
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections.last().locator('.stanza-multi-diff-editor-title')).toHaveText('file-119.ts');
	expect(await sections.count()).toBeLessThan(5);
	expect(await page.evaluate(() => window.ashDiffIntegration.activeManyActions)).toBe(await sections.count());
	await editor.evaluate(element => { element.scrollTop -= 150; });
	const visibleIds = await sections.locator('.stanza-multi-diff-editor-title').allTextContents();
	expect(visibleIds.map(label => Number(label.match(/\d+/)?.[0]))).toEqual([...visibleIds.map(label => Number(label.match(/\d+/)?.[0]))].sort((a, b) => a - b));
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await sections.last().locator('.stanza-multi-diff-editor-header-toggle').click();
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections.last().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
	await editor.evaluate(element => { element.scrollTop = 0; });
	await expect(sections.first().locator('.stanza-multi-diff-editor-title')).toHaveText('file-0.ts');
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(sections.last().locator('.stanza-multi-diff-editor-title')).toHaveText('file-119.ts');
	await expect(sections.last().locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('multi diff resolves only comparisons near the viewport', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showLazyComparisons(100));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lazyLoads.length)).toBeGreaterThan(0);
	const initialLoads = await page.evaluate(() => window.ashDiffIntegration.lazyLoads);
	expect(initialLoads.length).toBeLessThan(10);
	expect(initialLoads.every(index => index < 10)).toBe(true);
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('lazy-99.ts');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.lazyLoads.includes(99))).toBe(true);
	expect((await page.evaluate(() => window.ashDiffIntegration.lazyLoads)).length).toBeLessThan(20);
});

test('reverse navigation resolves the last comparison without loading intermediate files', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showLazyComparisons(100));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	await editor.focus();
	await page.keyboard.press('Shift+F7');
	await expect(editor.locator('.stanza-multi-diff-editor-accessibility-status')).toHaveText('Change in lazy-99.ts');
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('lazy-99.ts');
	const loads = await page.evaluate(() => window.ashDiffIntegration.lazyLoads);
	expect(loads).toContain(99);
	expect(loads.length).toBeLessThan(10);
});

test('multi diff reaches the last file when logical content exceeds the browser scroll height', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showCompressedComparisons(5000));
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const physicalHeight = await editor.evaluate(element => element.scrollHeight);
	expect(physicalHeight).toBeGreaterThanOrEqual(8_000_000);
	expect(physicalHeight).toBeLessThan(8_000_010);
	await editor.evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('large-4999.ts');
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(1);
	await expect(editor.locator('.stanza-multi-diff-editor-section').last().getByText('line 99', { exact: true }).first()).toBeVisible();
	expect(await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeGreaterThan(physicalHeight);
	const logicalBeforeWheel = await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	await editor.hover();
	await page.mouse.wheel(0, -120);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeLessThan(logicalBeforeWheel);
	const logicalWheelDistance = logicalBeforeWheel - await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	expect(logicalWheelDistance).toBeGreaterThan(110);
	expect(logicalWheelDistance).toBeLessThan(130);
	const logicalBeforePage = await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	const viewportHeight = await editor.evaluate(element => element.clientHeight);
	await editor.focus();
	await page.keyboard.press('PageUp');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop)).toBeLessThan(logicalBeforePage);
	const logicalPageDistance = logicalBeforePage - await page.evaluate(() => window.ashDiffIntegration.compressedLogicalScrollTop);
	expect(logicalPageDistance).toBeGreaterThan(viewportHeight - 10);
	expect(logicalPageDistance).toBeLessThan(viewportHeight + 10);
	await page.evaluate(() => window.ashDiffIntegration.saveCompressedPosition());
	await editor.evaluate(element => { element.scrollTop = 0; });
	await expect(editor.locator('.stanza-multi-diff-editor-title').first()).toHaveText('large-0.ts');
	await page.evaluate(() => window.ashDiffIntegration.restoreCompressedPosition());
	await expect(editor.locator('.stanza-multi-diff-editor-title').last()).toHaveText('large-4999.ts');
});

test('multi diff updates its file list and keeps the retained file collapsed', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showDynamicComparisons());
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const second = editor.locator('.stanza-multi-diff-editor-section').filter({ hasText: 'dynamic-second.ts' });
	await second.locator('.stanza-multi-diff-editor-header-toggle').click();
	await expect(second.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
	await page.evaluate(() => window.ashDiffIntegration.updateDynamicComparisons());
	await expect(editor.locator('.stanza-multi-diff-editor-title')).toHaveText(['dynamic-second.ts', 'dynamic-third.ts']);
	await expect(editor.locator('.stanza-multi-diff-editor-header-toggle').first()).toHaveAttribute('aria-expanded', 'false');
	await expect(editor.locator('.stanza-multi-diff-editor-header-toggle').last()).toHaveAttribute('aria-expanded', 'true');
	await expect(editor).toHaveAttribute('aria-label', 'Multi-file diff editor with 2 files');
});

test('multi diff announces a deferred comparison and mounts it when ready', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showDeferredComparison());
	const editor = page.locator('#many .stanza-multi-diff-editor');
	const status = editor.locator('.stanza-multi-diff-editor-incomplete-status');
	await expect(status).toHaveAttribute('role', 'status');
	await expect(status).toHaveText('Loading comparison');
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.completeDeferredComparison());
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(1);
	await expect(status).toHaveText('');
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`multi diff reports a comparison load failure without an unhandled error (${locale})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.showFailedComparison());
		const editor = page.locator('#many .stanza-multi-diff-editor');
		await expect(editor.locator('.stanza-multi-diff-editor-incomplete-status')).toHaveText(localized(locale, 'Could not load failed.ts', '无法加载 failed.ts'));
		await expect(editor.locator('.stanza-diff-editor')).toHaveCount(0);
		await expect(editor.locator('.stanza-multi-diff-editor-incomplete-status')).toHaveText(localized(locale, 'Could not load failed.ts', '无法加载 failed.ts'));
		expect(errors).toEqual([]);
	});
}

test('unsaved input updates Diff and Quick Diff locally using the existing baseline', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffReady)).toBe(true);
	const before = await page.evaluate(() => window.ashDiffIntegration.read());
	await page.getByRole('textbox', { name: 'Modified text' }).fill('obsolete');
	await page.getByRole('textbox', { name: 'Modified text' }).fill('same\nbefore 😀 after\nlast');
	await expect.poll(() => page.evaluate(() => {
		const state = window.ashDiffIntegration.read();
		return state.state === 'ready' && state.quickDiffReady && state.resultVersion === state.version;
	})).toBe(true);
	const after = await page.evaluate(() => window.ashDiffIntegration.read());
	expect(after.kinds).toEqual(['unchanged', 'unchanged', 'unchanged']);
	expect(after.quickDiffChanges).toBe(0);
	expect(after.baselineRequests).toBe(before.baselineRequests);
	await expect(page.locator('#single .stanza-diff-inline-added')).toHaveCount(0);
	await expect(page.locator('#multi .stanza-diff-inline-added')).toHaveCount(0);
});

test('embedded diff follows parent fonts, retains overrides and releases its editor pair', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showEmbeddedComparison());
	const editor = page.locator('#many .stanza-diff-editor');
	await expect(editor).toBeVisible();
	await page.evaluate(() => window.ashDiffIntegration.setFontOptions({ fontSize: 21, lineHeight: 32 }));
	await expect(editor.locator('.modified .view-line').first()).toHaveCSS('font-size', '21px');
	await expect(editor.locator('.original .view-line').first()).toHaveCSS('line-height', '32px');
	await expect(editor.locator('.modified textarea')).toHaveAttribute('readonly', '');
	await page.evaluate(() => {
		window.ashDiffIntegration.updateEmbeddedComparison({ fontSize: 17 });
		window.ashDiffIntegration.setFontOptions({ fontSize: 24, lineHeight: 36 });
	});
	await expect(editor.locator('.modified .view-line').first()).toHaveCSS('font-size', '17px');
	await expect(editor.locator('.original .view-line').first()).toHaveCSS('line-height', '36px');
	await page.evaluate(() => {
		window.ashDiffIntegration.closeEmbeddedComparison();
		window.ashDiffIntegration.setFontOptions({ fontSize: 18 });
	});
	await expect(editor).toHaveCount(0);
});

test('Quick Diff inherits whitespace settings without reading the baseline again', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffReady)).toBe(true);
	const baselineRequests = await page.evaluate(() => window.ashDiffIntegration.read().baselineRequests);
	await page.getByRole('textbox', { name: 'Modified text' }).fill('same\nbefore 😀 after\nlast ');
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	await page.evaluate(() => window.ashDiffIntegration.setQuickDiffWhitespace('inherit'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(0);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespaceForLanguage('typescript', false));
	await page.evaluate(() => window.ashDiffIntegration.setModifiedLanguage('typescript'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespaceForLanguage('typescript', true));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(0);
	await page.evaluate(() => window.ashDiffIntegration.setDiffWhitespace(false));
	await page.evaluate(() => window.ashDiffIntegration.setModifiedLanguage('javascript'));
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().quickDiffChanges)).toBe(1);
	expect(await page.evaluate(() => window.ashDiffIntegration.read().baselineRequests)).toBe(baselineRequests);
});

test('cancels expensive Worker computation and completes the next comparison', async ({ page }) => {
	await openDiffPage(page);
	await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.read().kinds)).toEqual(['unchanged', 'modified', 'unchanged']);
	expect(await page.evaluate(() => window.ashDiffIntegration.cancelLargeComparison())).toEqual({ outcome: 'CancellationError', kinds: ['modified'] });
});

test('the browser Worker compares text lines across CRLF and LF models', async ({ page }) => {
	await openDiffPage(page);
	expect(await page.evaluate(() => window.ashDiffIntegration.compareLineEndings())).toEqual({
		identical: false,
		changedLines: [[2, 2]],
		inlineColumns: [[1, 4]],
	});
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`a timed Worker result is marked incomplete in Diff and Multi Diff (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => {
			document.documentElement.style.setProperty('--ash-warning-foreground', 'rgb(150, 80, 0)');
			document.documentElement.style.setProperty('--ash-editor-background', 'rgb(255, 255, 255)');
		});
		expect(await page.evaluate(() => window.ashDiffIntegration.showTimedComparison())).toBe(true);
		const warning = page.locator('#timed-single .stanza-diff-editor-incomplete-status');
		const multiWarning = page.locator('#timed-multi .stanza-multi-diff-editor-incomplete-status');
		await expect(warning).toBeVisible();
		await expect(warning).toContainText(localized(locale, 'Results may be incomplete', '结果可能不完整'));
		await expect(warning).toHaveAttribute('role', 'status');
		await expect(multiWarning).toBeVisible();
		await expect(multiWarning).toHaveText(localized(locale, 'Diff may be incomplete', '差异结果可能不完整'));
		await expect(warning).toHaveCSS('color', 'rgb(150, 80, 0)');
		await page.locator('#timed-single .stanza-diff-editor').evaluate(element => { element.scrollTop = 400; element.dispatchEvent(new Event('scroll')); });
		const positions = await page.evaluate(() => ({
			editorTop: document.querySelector('#timed-single .stanza-diff-editor')!.getBoundingClientRect().top,
			warningTop: document.querySelector('#timed-single .stanza-diff-editor-incomplete-status')!.getBoundingClientRect().top,
		}));
		expect(Math.abs(positions.warningTop - positions.editorTop)).toBeLessThan(2);
		await page.evaluate(() => {
			document.documentElement.style.setProperty('--ash-warning-foreground', 'rgb(255, 255, 255)');
			document.documentElement.style.setProperty('--ash-editor-background', 'rgb(0, 0, 0)');
		});
		await expect(warning).toHaveCSS('color', 'rgb(255, 255, 255)');
		await expect(warning).toHaveCSS('background-color', 'rgb(0, 0, 0)');
		await expect(warning).toHaveText(localized(locale, 'Diff computation stopped after the time limit. Results may be incomplete.', '差异计算已达到时间上限，结果可能不完整。'));
		await expect(multiWarning).toHaveText(localized(locale, 'Diff may be incomplete', '差异结果可能不完整'));
		await expect(page.locator('#timed-multi .stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-label', localized(locale, 'Collapse timed.ts', '折叠 timed.ts'));
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`editor status bar follows diff focus and runs keyboard actions (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('diff'));
		const status = page.locator('#title-comparison .ash-workbench-statusbar');
		const cursor = status.locator('[data-statusbar-item-id="ash.status.editor.cursor"]');
		const eol = status.locator('[data-statusbar-item-id="ash.status.editor.eol"]');
		const indentation = status.locator('[data-statusbar-item-id="ash.status.editor.indentation"]');
		const editorInputs = page.locator('#title-comparison .stanza-editor-input');
		await expect(cursor).toHaveText(localized(locale, 'Ln 1, Col 1', '行 1，列 1'));
		const order = await status.locator('[data-statusbar-item-id^="ash.status.editor."]').evaluateAll(elements => elements
			.map(element => ({ id: element.getAttribute('data-statusbar-item-id'), left: element.getBoundingClientRect().left }))
			.sort((a, b) => a.left - b.left).map(item => item.id));
		expect(order).toEqual(['cursor', 'indentation', 'encoding', 'eol', 'language'].map(id => `ash.status.editor.${id}`));
		await editorInputs.last().focus();
		await page.keyboard.press('ArrowRight');
		await expect(cursor).toHaveText(localized(locale, 'Ln 1, Col 2', '行 1，列 2'));
		await editorInputs.first().focus();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(cursor).toHaveText(localized(locale, 'Ln 1, Col 3', '行 1，列 3'));
		await expect(eol.getByRole('button')).toHaveAttribute('aria-disabled', 'true');
		await cursor.getByRole('button').focus();
		await page.keyboard.press('Enter');
		const gotoInput = page.locator('#title-comparison .stanza-editor-goto-line-widget.visible input');
		await expect(gotoInput).toBeFocused();
		await gotoInput.fill('2:2');
		await page.keyboard.press('Enter');
		await expect(cursor).toHaveText(localized(locale, 'Ln 2, Col 2', '行 2，列 2'));
		await expect(editorInputs.first()).toBeFocused();
		await editorInputs.last().focus();
		await expect(cursor).toHaveText(localized(locale, 'Ln 1, Col 2', '行 1，列 2'));
		await eol.getByRole('button').focus();
		await page.keyboard.press('Enter');
		const picker = page.locator('.ash-quick-input-host input');
		await expect(picker).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(eol).toHaveText('CRLF');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(eol).toHaveText('LF');
		await indentation.getByRole('button').focus();
		await page.keyboard.press('Enter');
		await expect(picker).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select Tab Size', '选择制表符大小'));
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(indentation).toHaveText(localized(locale, 'Spaces: 2', '空格: 2'));
		const language = status.locator('[data-statusbar-item-id="ash.status.editor.language"] [role="button"]');
		await language.focus();
		await page.keyboard.press('Enter');
		await expect(picker).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(editorInputs.last()).toBeFocused();
		await cursor.getByRole('button').focus();
		await page.keyboard.press('Enter');
		await expect(gotoInput).toBeFocused();
		await gotoInput.fill('2:3');
		await page.keyboard.press('Enter');
		await expect(cursor).toHaveText(localized(locale, 'Ln 2, Col 3', '行 2，列 3'));
		await expect(editorInputs.last()).toBeFocused();
		await language.focus();
		await page.keyboard.press('Enter');
		await picker.fill('Status Language');
		await page.keyboard.press('Enter');
		await expect(language).toHaveText('Status Language');
		await expect(editorInputs.last()).toBeFocused();
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`encoding status action saves, reopens and cancels without changing another editor (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('encoding'));
		const encoding = page.locator('#title-comparison [data-statusbar-item-id="ash.status.editor.encoding"]');
		const input = page.locator('#title-comparison .stanza-editor-input').last();
		const picker = page.locator('.ash-quick-input-host input');
		await input.focus();
		await encoding.getByRole('button').focus();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select an Encoding Action', '选择编码操作'));
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select File Encoding', '选择文件编码'));
		await picker.fill('GBK');
		await page.keyboard.press('Enter');
		await expect(encoding).toHaveText('GBK');
		await expect(input).toBeFocused();
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toEqual([{ resource: '/title/after.ts', text: 'after\nshared', encoding: 'gbk' }]);
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(false);
		await encoding.getByRole('button').click();
		await expect(picker).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select File Encoding', '选择文件编码'));
		await expect(page.getByText(localized(locale, 'Guessed from Content', '根据内容猜测'), { exact: true })).toBeVisible();
		await expect(page.locator('.ash-quick-pick-list').getByRole('option')).toHaveCount(48);
		await picker.fill('cp1125');
		await expect(page.locator('.ash-quick-pick-list').getByRole('option')).toHaveText(/CP 1125/);
		await picker.fill('UTF-16 LE');
		await page.keyboard.press('Enter');
		await expect(encoding).toHaveText('UTF-16 LE');
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toHaveLength(1);
		await encoding.getByRole('button').click();
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await expect(encoding).toHaveText('UTF-16 LE');
		await encoding.getByRole('button').click();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveAttribute('placeholder', localized(locale, 'Select File Encoding', '选择文件编码'));
		await page.evaluate(() => window.ashDiffIntegration.openOtherTitleFile());
		await picker.fill('UTF-8');
		await page.keyboard.press('Enter');
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toHaveLength(1);
	});
}

for (const locale of ['en', 'zh-CN'] as const) {
	test(`encoding reopening confirms dirty discard and readonly sides offer only reopen (${locale})`, async ({ page }) => {
		await openDiffPage(page, locale);
		await page.evaluate(() => window.ashDiffIntegration.openTitleComparison('encoding'));
		const encoding = page.locator('#title-comparison [data-statusbar-item-id="ash.status.editor.encoding"]');
		const inputs = page.locator('#title-comparison .stanza-editor-input');
		const picker = page.locator('.ash-quick-input-host input');
		await inputs.first().focus();
		await encoding.getByRole('button').click();
		await expect(picker).toBeFocused();
		await expect(page.getByText(localized(locale, 'Reopen with Encoding', '通过编码重新打开'), { exact: true })).toBeVisible();
		await expect(page.getByText(localized(locale, 'Save with Encoding', '通过编码保存'), { exact: true })).not.toBeVisible();
		await page.keyboard.press('Escape');
		await inputs.last().focus();
		await page.keyboard.press('End');
		await page.keyboard.type('!');
		await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(true);
		for (const confirm of [false, true]) {
			await encoding.getByRole('button').click();
			await expect(picker).toBeFocused();
			await page.keyboard.press('Enter');
			await picker.fill('UTF-16 LE');
			await page.keyboard.press('Enter');
			await expect(page.getByText(localized(locale, 'Your unsaved changes will be discarded.', '未保存的更改将被丢弃。'), { exact: true })).toBeVisible();
			await page.getByRole('button', { name: confirm ? localized(locale, 'Reopen', '重新打开') : localized(locale, 'Cancel', '取消'), exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().dirty)).toBe(!confirm);
			await expect(encoding).toHaveText(confirm ? 'UTF-16 LE' : 'UTF-8');
		}
		expect(await page.evaluate(() => window.ashDiffIntegration.readTitlePersistence().writes)).toHaveLength(0);
	});
}

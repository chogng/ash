import { expect, test, type Page } from '@playwright/test';

async function openDiffPage(page: Page): Promise<void> {
	await page.goto('/diff.html');
	await page.waitForFunction(() => !!window.ashDiffIntegration);
}

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.ashDiffIntegration?.dispose());
});

test('editable diff renders Unicode changes and shares models with Multi Diff', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page);
	await expect(page.locator('#single .stanza-diff-inline-removed')).toHaveText('😀');
	await expect(page.locator('#single .stanza-diff-inline-added')).toHaveText('🤖');
	await expect(page.locator('#single .stanza-editor')).toHaveCount(2);
	await expect(page.locator('#multi .stanza-multi-diff-editor-section')).toHaveCount(2);
	await expect(page.locator('#multi .stanza-diff-editor')).toHaveCount(2);
	await expect(page.locator('#multi .stanza-editor')).toHaveCount(4);
	await expect(page.locator('#multi .stanza-diff-inline-removed')).toHaveText('😀');
	await page.locator('#single .stanza-diff-editor').focus();
	await page.keyboard.press('F7');
	await expect(page.locator('#single .stanza-diff-line-active')).toHaveCount(2);
	await expect(page.locator('#single .stanza-diff-editor-accessibility-status')).toContainText('2');
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await page.locator('#multi .stanza-multi-diff-editor').focus();
	await page.keyboard.press('F7');
	await expect(page.locator('#multi .stanza-multi-diff-editor-accessibility-status')).toContainText('第 1 处差异，共 2 处，first.ts');
	await expect(page.locator('#multi .stanza-multi-diff-editor')).toHaveAttribute('aria-label', '多文件差异编辑器，共 2 个文件');
	expect(errors).toEqual([]);
});

test('inline diff keeps removed text readable and restores both sides', async ({ page }) => {
	await openDiffPage(page);
	const editor = page.locator('#single .stanza-diff-editor');
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(false, false));
	await expect(editor).toHaveClass(/inline-view/);
	await expect(editor.locator('.stanza-diff-editor-side.original')).toBeHidden();
	await expect(editor.locator('.stanza-diff-editor-side.modified')).toBeVisible();
	await expect(editor.locator('.stanza-diff-inline-original-line')).toContainText('before 😀 after');
	await expect(editor.locator('.stanza-diff-inline-original-line').first()).toHaveAttribute('aria-label', /Removed line/);
	await editor.locator('.stanza-diff-editor-side.modified .stanza-editor').focus();
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, false));
	await expect(editor).not.toHaveClass(/inline-view/);
	await expect(editor.locator('.stanza-diff-editor-side.original')).toBeVisible();
	await expect(editor.locator('.stanza-diff-inline-original-line')).toHaveCount(0);
	await expect.poll(() => editor.locator('.stanza-diff-editor-side.modified').evaluate(element => element.contains(document.activeElement))).toBe(true);
	await page.evaluate(() => window.ashDiffIntegration.setViewMode(true, true));
	await page.locator('#single').evaluate(element => { element.style.width = '400px'; });
	await expect(editor).toHaveClass(/inline-view/);
	await page.locator('#single').evaluate(element => { element.style.width = '800px'; });
	await expect(editor).not.toHaveClass(/inline-view/);
});

test('unchanged regions collapse on both sides and symbol navigation reveals the target', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page);
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
	await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText('33 hidden lines');
	await expect(regions.first()).toBeVisible();
	await expect(regions.first().locator('.ash-diff-hidden-region-content')).toHaveCSS('display', 'flex');
	await expect(regions.first()).toHaveCSS('height', '32px');
	const lineIsVisible = (ranges: number[][]) => ranges.some(([start, end]) => start <= 5 && 5 <= end);
	expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).original)).toBe(false);
	expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).modified)).toBe(false);
	await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveText('Shared section');
	await page.evaluate(() => {
		document.documentElement.dataset.colorScheme = 'high-contrast-dark';
		document.documentElement.style.setProperty('--ash-contrast-border', 'rgb(10, 20, 30)');
		document.documentElement.style.setProperty('--ash-stroke-thickness', '1px');
		document.documentElement.style.setProperty('--ash-focus-border', 'rgb(100, 150, 200)');
	});
	await expect(regions.first().locator('.ash-diff-hidden-region-content')).toHaveCSS('border-top-color', 'rgb(10, 20, 30)');
	const showMore = regions.first().getByRole('button', { name: 'Show 2 more lines above' });
	await showMore.focus();
	await page.keyboard.press('Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(showMore).toBeFocused();
	await expect(showMore).toHaveCSS('outline-style', 'solid');
	await page.keyboard.press('Enter');
	await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText('31 hidden lines');
	await regions.last().locator('.ash-diff-hidden-region-symbol').click();
	await expect(regions).toHaveCount(0);
	expect(lineIsVisible((await page.evaluate(() => window.ashDiffIntegration.visibleDiffRanges())).modified)).toBe(true);
	await page.evaluate(() => {
		window.ashDiffIntegration.setChineseLocale();
		window.ashDiffIntegration.setHiddenRegions(false);
		window.ashDiffIntegration.setHiddenRegions(true);
	});
	await expect(regions.first().locator('.ash-diff-hidden-region-count')).toHaveText('隐藏 33 行');
	await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveText('Shared section');
	await page.evaluate(() => window.ashDiffIntegration.removeSymbolProvider());
	await expect(regions.last().locator('.ash-diff-hidden-region-symbol')).toHaveCount(0);
	await expect(regions.first().getByRole('button', { name: '显示全部未修改的行' })).toBeVisible();
	await regions.first().getByRole('button', { name: '显示全部未修改的行' }).click();
	await expect(regions).toHaveCount(0);
	expect(errors).toEqual([]);
});

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
	await expect(editor.locator('.stanza-diff-inline-removed')).toContainText('😀');
	await expect(editor.locator('.stanza-diff-inline-added')).toContainText('🤖');
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

test('multi diff wraps editable columns and repositions sections through resize and collapse', async ({ page }) => {
	await openDiffPage(page);
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
	await expect(sections.nth(1).locator('.stanza-diff-line-active')).toHaveCount(1);
	await editor.focus();
	await page.keyboard.press('Alt+Z');
	await expect(editor).not.toHaveClass(/word-wrapped/);
	await expect(sections.first().locator('.stanza-diff-editor')).not.toHaveClass(/word-wrapped/);
});

test('multi diff keeps one outer scroll and remounts only visible file editors', async ({ page }) => {
	await openDiffPage(page);
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
	const longText = Array.from({ length: 180 }, (_, index) => `line ${index}`).join('\n');
	await page.evaluate(text => {
		window.ashDiffIntegration.setComparisonText(text, text);
		window.ashDiffIntegration.setSecondComparisonText(text, text);
	}, longText);
	const editor = page.locator('#multi .stanza-multi-diff-editor');
	await expect.poll(() => editor.evaluate(element => element.scrollHeight)).toBeGreaterThan(7000);
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
		document.documentElement.style.setProperty('--ash-multi-diff-editor-background', 'rgb(18, 27, 36)');
		document.documentElement.style.setProperty('--ash-multi-diff-editor-header-background', 'rgb(37, 46, 55)');
		document.documentElement.style.setProperty('--ash-multi-diff-editor-border', 'rgb(56, 65, 74)');
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

test('multi diff reports a comparison load failure without an unhandled error', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await openDiffPage(page);
	await page.evaluate(() => window.ashDiffIntegration.showFailedComparison());
	const editor = page.locator('#many .stanza-multi-diff-editor');
	await expect(editor.locator('.stanza-multi-diff-editor-incomplete-status')).toHaveText('Could not load failed.ts');
	await expect(editor.locator('.stanza-diff-editor')).toHaveCount(0);
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await expect(editor.locator('.stanza-multi-diff-editor-incomplete-status')).toHaveText('无法加载 failed.ts');
	expect(errors).toEqual([]);
});

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

test('a timed Worker result is marked incomplete in Diff and Multi Diff', async ({ page }) => {
	await openDiffPage(page);
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-warning-foreground', 'rgb(150, 80, 0)');
		document.documentElement.style.setProperty('--ash-editor-background', 'rgb(255, 255, 255)');
	});
	expect(await page.evaluate(() => window.ashDiffIntegration.showTimedComparison())).toBe(true);
	const warning = page.locator('#timed-single .stanza-diff-editor-incomplete-status');
	const multiWarning = page.locator('#timed-multi .stanza-multi-diff-editor-incomplete-status');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('Results may be incomplete');
	await expect(warning).toHaveAttribute('role', 'status');
	await expect(multiWarning).toBeVisible();
	await expect(multiWarning).toHaveText('Diff may be incomplete');
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
	await page.evaluate(() => window.ashDiffIntegration.setChineseLocale());
	await expect(warning).toHaveText('差异计算已达到时间上限，结果可能不完整。');
	await expect(multiWarning).toHaveText('差异结果可能不完整');
	await expect(page.locator('#timed-multi .stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-label', '折叠 timed.ts');
});

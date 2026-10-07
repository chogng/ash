import { expect, test } from '@playwright/test';

test('Dismiss updates retained results and focus while refresh restores the searched files', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await expect(page.getByRole('status')).toHaveText('3 results');
	await tree.locator('.ash-search-match').first().click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('2 results');
	await expect(tree).toBeFocused();
	await expect(tree.locator('.ash-search-match')).toHaveCount(2);
	const activeId = await tree.getAttribute('aria-activedescendant');
	await expect(page.locator(`[id="${activeId}"]`)).toHaveAccessibleName('Line 1, column 13: 中文😀 needle needle');
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot()?.matchCount)).toBe(2);
	await tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'workspace • src/main.ts' }) }).click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.locator('.ash-search-file-path')).toHaveText(['other • src/main.ts']);
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('3 results');
});

test('Dismiss leaves a running search active and incorporates later result batches', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('slow');
	await query.press('Enter');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await expect(tree).toHaveAttribute('aria-busy', 'true');
	await tree.locator('.ash-search-match').click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('0 results…');
	await expect(tree).toHaveAttribute('aria-busy', 'true');
	expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(0);
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(tree).toHaveAttribute('aria-busy', 'false');
	await expect(page.locator('.ash-search-file-path')).toHaveText(['workspace • late.ts']);
	await expect(page.getByRole('status')).toHaveText('1 results');
});

test('Dismiss handles a file and its selected child together through multiple selection', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const file = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'workspace • src/main.ts' }) });
	await file.click();
	await tree.locator('.ash-search-match').first().click({ modifiers: ['ControlOrMeta'] });
	await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('1 results');
	await expect(page.locator('.ash-search-file-path')).toHaveText(['other • src/main.ts']);
	await expect(tree).toBeFocused();
});

test('Dismiss and its accessibility guidance use the Chinese language catalog', async ({ page }) => {
	await page.goto('/search.html?locale=zh-CN');
	const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 个结果');
	await page.locator('.ash-search-match').click();
	expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('不会删除文件');
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('未找到结果。');
});

test('registered Search keeps query controls and labeled filters usable at the minimum sidebar width', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	const matchCase = page.getByRole('button', { name: 'Match Case', exact: true });
	const regex = page.getByRole('button', { name: 'Use Regular Expression', exact: true });
	const details = page.getByRole('button', { name: 'Toggle Search Details', exact: true });
	const include = page.getByRole('textbox', { name: 'Files to include', exact: true });
	const exclude = page.getByRole('textbox', { name: 'Files to exclude', exact: true });
	await expect(include).toBeHidden();
	await query.focus();
	await query.press('Tab');
	await expect(matchCase).toBeFocused();
	await matchCase.press('Space');
	await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
	await expect(matchCase).toBeFocused();
	await matchCase.press('ArrowRight');
	await expect(page.getByRole('button', { name: 'Match Whole Word', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Match Whole Word', exact: true }).press('ArrowRight');
	await expect(regex).toBeFocused();
	await regex.press('Space');
	await expect(regex).toHaveAttribute('aria-pressed', 'true');
	await expect(regex).toBeFocused();
	await regex.press('Tab');
	await expect(details).toBeFocused();
	await details.press('Enter');
	await expect(details).toHaveAttribute('aria-expanded', 'true');
	await details.press('Tab');
	await expect(include).toBeFocused();
	await include.fill('src/**, docs/**');
	await include.press('Tab');
	await expect(exclude).toBeFocused();
	await exclude.fill('**/*.test.ts');
	await details.click();
	await expect(include).toBeHidden();
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	expect(await page.evaluate(() => window.ashSearchIntegration.queries)).toEqual([{
		text: 'needle', wholeWord: false, patternKind: 'regex', caseSensitivity: 'sensitive',
		includePatterns: ['src/**', 'docs/**'], excludePatterns: ['**/*.test.ts'], maxResults: 2000,
	}]);
	await expect(page.locator('.ash-search-preview mark')).toHaveText('needle');
	await details.click();
	await expect(include).toHaveValue('src/**, docs/**');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashSearchIntegration.setTheme(theme), theme);
		for (const width of [280, 180]) {
			await page.evaluate(width => window.ashSearchIntegration.setWidth(width), width);
			await query.focus();
			const geometry = await page.locator('.ash-search-query-field').evaluate(field => {
				const bounds = field.getBoundingClientRect();
				const input = field.querySelector('textarea')!.getBoundingClientRect();
				const controls = field.querySelector('[role="toolbar"]')!.getBoundingClientRect();
				return { height: bounds.height, inputWidth: input.width, inside: controls.left >= input.right && controls.right <= bounds.right && controls.top >= bounds.top && controls.bottom <= bounds.bottom };
			});
			expect(geometry.height).toBe(26);
			expect(geometry.inputWidth).toBeGreaterThan(40);
			expect(geometry.inside).toBe(true);
			await expect(include).toHaveCSS('min-height', '22px');
		}
	}
});

test('registered Search exposes Chinese labels and localized result counts', async ({ page }) => {
	await page.goto('/search.html?locale=zh-CN');
	const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
	await expect(query).toHaveAttribute('placeholder', '搜索');
	await expect(page.getByRole('button', { name: '区分大小写', exact: true })).toHaveText('Aa');
	await expect(page.getByRole('button', { name: '使用正则表达式', exact: true })).toHaveText('.*');
	await page.getByRole('button', { name: '切换搜索详细信息', exact: true }).click();
	await expect(page.getByRole('textbox', { name: '包含的文件', exact: true })).toHaveAttribute('placeholder', '例如 *.ts、src/**/include');
	await expect(page.getByRole('textbox', { name: '排除的文件', exact: true })).toBeVisible();
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 个结果');
});

test('Search opens each occurrence at UTF-16 columns and keeps same-path roots separate', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('3 results');
	await expect(page.locator('.ash-search-file-path')).toHaveText(['workspace • src/main.ts', 'other • src/main.ts']);
	await expect(page.locator('.ash-search-file-count')).toHaveText(['2', '1']);
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const rows = tree.getByRole('treeitem');
	const workspaceFile = rows.filter({ has: page.locator('.ash-search-file-path', { hasText: 'workspace • src/main.ts' }) });
	await workspaceFile.locator('.ash-tree-twistie').click();
	await expect(workspaceFile).toHaveAttribute('aria-expanded', 'false');
	await expect(tree.locator('.ash-search-match')).toHaveCount(1);
	await workspaceFile.locator('.ash-tree-twistie').click();
	await expect(workspaceFile).toHaveAttribute('aria-expanded', 'true');
	await tree.locator('.ash-search-match').filter({ hasText: '中文😀 needle needle' }).last().click();
	await expect(rows.filter({ has: page.locator('.ash-search-match', { hasText: '中文😀 needle needle' }) }).last()).toHaveAccessibleName('Line 1, column 13: 中文😀 needle needle');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1))).toMatchObject({
		resource: 'file:///workspace/src/main.ts', target: 'activeGroup',
		options: { pinned: false, preserveFocus: true, selection: { startLineNumber: 1, startColumn: 13, endLineNumber: 1, endColumn: 19 } },
	});
	await tree.press('ControlOrMeta+Enter');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1))).toMatchObject({ target: 'sideGroup', options: { pinned: true } });
	await tree.press('F4');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1))).toMatchObject({ resource: 'ssh://host/other/src/main.ts', options: { selection: { startLineNumber: 8, startColumn: 7, endColumn: 13 } } });
	await expect(tree).toBeFocused();
	await page.getByRole('button', { name: 'Collapse all results', exact: true }).click();
	await expect(tree.locator('.ash-search-match')).toHaveCount(0);
	await query.press('Shift+F4');
	await expect(tree.locator('.ash-search-match')).toHaveCount(2);
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1))).toMatchObject({ resource: 'file:///workspace/src/main.ts', options: { selection: { startColumn: 13 } } });
});

test('Search stop retains delivered matches and rejects late batches after refresh and clear', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const stop = page.getByRole('button', { name: 'Stop search', exact: true });
	await query.fill('slow');
	await query.press('Enter');
	await expect(stop).toBeEnabled();
	await expect(tree).toHaveAttribute('aria-busy', 'true');
	await query.press('Escape');
	await expect(page.getByRole('status')).toHaveText('Search stopped. 1 results retained.');
	await expect(stop).toBeDisabled();
	await expect(tree.locator('.ash-search-match')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(1);
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(page.locator('.ash-search-file-path')).toHaveText(['workspace • src/main.ts']);
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	expect(await page.evaluate(() => window.ashSearchIntegration.queries.map(query => query.text))).toEqual(['slow', 'needle', 'needle']);
	await page.getByRole('button', { name: 'Clear search results', exact: true }).click();
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(tree).toHaveAttribute('aria-busy', 'false');
	await expect(query).toHaveValue('needle');
	await expect(query).toBeFocused();
});

test('Search virtualizes a thousand matches and navigates to an offscreen result', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('large');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1000 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const rows = tree.getByRole('treeitem');
	expect(await rows.count()).toBeLessThan(100);
	await tree.focus();
	await tree.press('End');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.opened.at(-1))).toMatchObject({
		resource: 'file:///workspace/src/main.ts', options: { preserveFocus: true, selection: { startLineNumber: 1000, endLineNumber: 1000 } },
	});
	await expect(tree.locator('.ash-search-line-number').last()).toHaveText('1000');
	expect(await rows.count()).toBeLessThan(100);
});

test('Changing workspace cancels search and discards results from the previous roots', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await query.fill('slow');
	await query.press('Enter');
	await expect(tree.getByRole('treeitem')).toHaveCount(2);
	await page.evaluate(() => window.ashSearchIntegration.closeWorkspace());
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(tree).toHaveAttribute('aria-busy', 'false');
	expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(1);
});

test('Search preserves multiline queries and restores history after recreating the page', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('first');
	await query.press('Shift+Enter');
	await page.keyboard.insertText('second');
	await expect(query).toHaveValue('first\nsecond');
	expect(await page.evaluate(() => window.ashSearchIntegration.queries.length)).toBe(0);
	await query.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.queries[0]?.text)).toBe('first\nsecond');
	await query.fill('needle');
	await query.press('Enter');
	await query.fill('draft');
	await query.press('ArrowUp');
	await expect(query).toHaveValue('needle');
	await query.press('ArrowUp');
	await expect(query).toHaveValue('first\nsecond');
	await query.press('Alt+ArrowDown');
	await expect(query).toHaveValue('needle');
	await query.press('ArrowDown');
	await expect(query).toHaveValue('draft');
	await page.reload();
	await query.focus();
	await query.press('ArrowUp');
	await expect(query).toHaveValue('needle');
	await query.press('ArrowUp');
	await expect(query).toHaveValue('first\nsecond');
});

test('search context snapshot preserves query, file locations and matches and excludes in-progress results', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toBeUndefined();
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'false');
	const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
	expect(snapshot).toMatchObject({ query: 'needle', matchCount: 1 });
	expect(snapshot!.content).toContain('# File: file:///workspace/src/main.ts');
	expect(snapshot!.content).toContain('1:7-1:13: needle');
	await query.fill('slow');
	await query.press('Enter');
	await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'true');
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toBeUndefined();
	await page.evaluate(() => window.ashSearchIntegration.closeWorkspace());
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toBeUndefined();
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
});

test('Copy All includes collapsed retained results and excludes dismissed occurrences', async ({ page }) => {
	await page.goto('/search.html');
	await page.evaluate(() => window.ashSearchIntegration.copyAll());
	expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['']);
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('3 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await tree.locator('.ash-tree-twistie').first().click();
	const before = await page.evaluate(() => window.ashSearchIntegration.snapshot());
	await page.evaluate(() => window.ashSearchIntegration.copyAll());
	expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['', '/workspace/src/main.ts\n  1,6: 中文😀 needle needle\n  1,13: 中文😀 needle needle\n\n/other/src/main.ts\n  8,7: const needle = true;']);
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(before);
	await tree.locator('.ash-tree-twistie').first().click();
	await tree.locator('.ash-search-match').first().click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await page.evaluate(() => window.ashSearchIntegration.copyAll());
	expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).at(-1)).toBe('/workspace/src/main.ts\n  1,13: 中文😀 needle needle\n\n/other/src/main.ts\n  8,7: const needle = true;');
	await page.evaluate(() => window.ashSearchIntegration.setClipboardFailure(true));
	await expect(page.evaluate(() => window.ashSearchIntegration.copyAll())).rejects.toThrow('Clipboard permission denied');
	await expect(page.getByRole('status')).toHaveText('2 results');
	expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).length).toBe(3);
});

test('Copy All reads the latest incremental results and its help is translated', async ({ page }) => {
	await page.goto('/search.html?locale=zh-CN');
	const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.fill('slow');
	await query.press('Enter');
	const tree = page.getByRole('tree', { name: '搜索结果', exact: true });
	await expect(tree).toHaveAttribute('aria-busy', 'true');
	await page.evaluate(() => window.ashSearchIntegration.copyAll());
	expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).at(-1)).toBe('/workspace/src/main.ts\n  1,7: const needle = true;');
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(tree).toHaveAttribute('aria-busy', 'false');
	await page.evaluate(() => window.ashSearchIntegration.copyAll());
	expect((await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).at(-1)).toBe('/workspace/src/main.ts\n  1,7: const needle = true;\n\n/workspace/late.ts\n  1,7: const needle = true;');
	expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(0);
	expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('已移除的结果不会复制');
});

test.describe('Windows Copy All formatting', () => {
	test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36' });
	test('Copy All uses Windows labels and block separators while preserving multi-line previews', async ({ page }) => {
		await page.goto('/search.html?windows=1');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('windows');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('2 results');
		await page.evaluate(() => window.ashSearchIntegration.copyAll());
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['C:\\workspace\\src\\main.ts\r\n  9,1: needle\n  10:  next\r\n\r\nC:\\workspace\\root.ts\r\n  2,1: needle']);
	});
});

import { expect, test } from '@playwright/test';

test('Search registration merges one title and moves the same toolbar through view switching and multiple views', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const title = page.locator('.ash-sidebar-title-label');
	const paneHeader = page.locator('.ash-search').locator('..').locator('.ash-pane-view-header');
	await expect(title).toHaveText('Search');
	await expect(paneHeader).toBeHidden();
	await expect(page.locator('.ash-pane-composite-title-view-actions').getByRole('toolbar', { name: 'Search result actions', exact: true })).toHaveCount(1);
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	const before = await page.evaluate(() => window.ashSearchIntegration.snapshot());
	const original = await toolbar.elementHandle();
	expect(original).not.toBeNull();
	const refresh = toolbar.getByRole('button', { name: 'Refresh search', exact: true });
	await refresh.focus();
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.focusedView())).toBe('ash.searchView');
	await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
	await expect(paneHeader).toBeVisible();
	await expect(paneHeader.getByRole('toolbar', { name: 'Search result actions', exact: true })).toHaveCount(1);
	await expect(refresh).toBeFocused();
	expect(await original!.evaluate(node => node === document.querySelector('[aria-label="Search result actions"]'))).toBe(true);
	await page.evaluate(() => window.ashSearchIntegration.setSecondView(false));
	await expect(paneHeader).toBeHidden();
	await expect(refresh).toBeFocused();
	await page.evaluate(() => window.ashSearchIntegration.switchSidebar('explorer'));
	await expect(title).toHaveText('Explorer');
	await expect(toolbar).toBeHidden();
	await page.evaluate(() => window.ashSearchIntegration.switchSidebar('search'));
	await expect(title).toHaveText('Search');
	await expect(toolbar).toBeVisible();
	await expect(query).toHaveValue('needle');
	expect(await original!.evaluate(node => node === document.querySelector('.ash-pane-composite-title-view-actions [aria-label="Search result actions"]'))).toBe(true);
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(before);
	await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
	await paneHeader.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(query).toBeHidden();
	await page.evaluate(() => window.ashSearchIntegration.setSecondView(false));
	await expect(query).toBeVisible();
	await page.evaluate(() => window.ashSearchIntegration.setSecondView(true));
	await expect(query).toBeHidden();
	await paneHeader.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(query).toBeVisible();
	await original!.dispose();
});

test('Search inputs wrap within shared height limits, preserve caret and use managed scrolling', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	const replace = page.getByRole('textbox', { name: 'Replace', exact: true });
	await expect(replace).toBeVisible();
	await query.fill('one');
	const single = await query.boundingBox();
	expect(single!.height).toBe(24);
	const long = '中文😀 long search text '.repeat(40);
	await query.fill(long);
	await expect.poll(async () => (await query.boundingBox())!.height).toBe(134);
	await query.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
	expect(await query.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(0);
	await query.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
	await expect.poll(() => query.evaluate((input: HTMLTextAreaElement) => input.scrollTop)).toBeGreaterThan(0);
	const scrolling = await query.evaluate((input: HTMLTextAreaElement) => ({
		value: input.value, caret: input.selectionEnd, scroll: input.scrollTop, overflowing: input.scrollHeight > input.clientHeight,
		browserBar: getComputedStyle(input).scrollbarWidth, managed: input.parentElement!.querySelectorAll('.ash-scrollbar-track-vertical').length,
	}));
	expect(scrolling).toMatchObject({ value: long, caret: long.length, overflowing: true, browserBar: 'none', managed: 1 });
	expect(scrolling.scroll).toBeGreaterThan(0);
	await query.fill('first\nsecond');
	await query.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
	expect(await query.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(0);
	await query.press('ArrowDown');
	await expect(query).toHaveValue('first\nsecond');
	expect(await query.evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBeGreaterThan(5);
	await replace.fill('replacement\nsecond');
	await replace.focus();
	const toggle = page.getByRole('button', { name: 'Toggle Replace', exact: true });
	await toggle.evaluate((button: HTMLButtonElement) => button.click());
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(query).toBeFocused();
	await toggle.click();
	await expect(replace).toHaveValue('replacement\nsecond');
	await query.fill('one');
	await expect.poll(async () => (await query.boundingBox())!.height).toBe(24);
});

test('Expand All replaces the collapsed toolbar slot, preserves keyboard focus and expands both roots', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	const collapse = page.getByRole('button', { name: 'Collapse all results', exact: true });
	const expand = page.getByRole('button', { name: 'Expand All', exact: true });
	await expect(collapse).toBeDisabled();
	await expect(expand).toHaveCount(0);
	await query.fill('中文');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('3 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await page.getByRole('toolbar', { name: 'Search result actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
	const before = await page.evaluate(() => window.ashSearchIntegration.snapshot());
	await collapse.focus();
	await collapse.press('Enter');
	await expect(expand).toBeFocused();
	await expect(collapse).toHaveCount(0);
	await expect(tree.locator('.ash-search-match')).toHaveCount(0);
	await expand.press('Enter');
	await expect(collapse).toBeFocused();
	await expect(tree.locator('.ash-search-match')).toHaveCount(3);
	await expect(tree.locator('[aria-expanded="false"]')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(before);
	expect(await page.evaluate(() => ({ queries: window.ashSearchIntegration.queries.length, opened: window.ashSearchIntegration.opened.length }))).toEqual({ queries: 1, opened: 0 });
	await tree.getByRole('treeitem', { name: 'other', exact: true }).locator('.ash-tree-twistie').click();
	await expect(tree).toBeFocused();
	await expect(collapse).toBeVisible();
	await expect(expand).toHaveCount(0);
	await query.focus();
	await collapse.evaluate((button: HTMLButtonElement) => button.click());
	await expect(query).toBeFocused();
	await expand.evaluate((button: HTMLButtonElement) => button.click());
	await expect(query).toBeFocused();
	await expect(tree.locator('.ash-search-match')).toHaveCount(3);
});

test('Expand All updates after a late batch and its Chinese action and help stay discoverable', async ({ page }) => {
	await page.goto('/search.html?locale=zh-CN');
	const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.fill('slow');
	await query.press('Enter');
	const tree = page.getByRole('tree');
	await expect(tree).toHaveAttribute('aria-busy', 'true');
	await page.getByRole('button', { name: '收起所有结果', exact: true }).click();
	await expect(page.getByRole('button', { name: '全部展开', exact: true })).toBeVisible();
	const oldExpand = await page.getByRole('button', { name: '全部展开', exact: true }).elementHandle();
	expect(oldExpand).not.toBeNull();
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(tree).toHaveAttribute('aria-busy', 'false');
	await expect(page.getByRole('button', { name: '收起所有结果', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '全部展开', exact: true })).toHaveCount(0);
	await oldExpand!.evaluate((button: HTMLButtonElement) => button.click());
	await expect(tree.locator('.ash-search-match')).toHaveCount(1);
	await oldExpand!.dispose();
	await page.getByRole('button', { name: '收起所有结果', exact: true }).click();
	await page.getByRole('button', { name: '全部展开', exact: true }).click();
	await expect(tree.locator('.ash-search-match')).toHaveCount(2);
	expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('全部展开');
	expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(0);
	await page.evaluate(() => window.ashSearchIntegration.closeWorkspace());
	await expect(page.getByRole('button', { name: '收起所有结果', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: '全部展开', exact: true })).toHaveCount(0);
});

test('Copy Path shortcut copies the first selected file and ignores input focus, matches and extra modifiers', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('3 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const first = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }) });
	const other = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'other • src' }) }) });
	await first.click();
	await other.click({ modifiers: ['ControlOrMeta'] });
	await tree.press('ControlOrMeta+Alt+c');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts']);
	await tree.press('ControlOrMeta+Shift+Alt+c');
	await query.focus();
	await query.press('ControlOrMeta+Alt+c');
	await tree.getByRole('treeitem', { name: 'Line 1, column 6: 中文😀 needle needle', exact: true }).click();
	await tree.press('ControlOrMeta+Alt+c');
	expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts']);
	await expect(page.getByRole('status')).toHaveText('3 results');
});

test('Copy Path menus copy explicit file and folder URIs and release callbacks on refresh and hiding', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('3 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const first = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }) });
	const other = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'other • src' }) }) });
	await first.click();
	await other.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/other/src/main.ts']);
	await page.getByRole('toolbar', { name: 'Search result actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
	const folder = tree.getByRole('treeitem', { name: 'other', exact: true });
	await folder.click();
	await tree.press('ControlOrMeta+Alt+c');
	expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/other/src/main.ts']);
	await tree.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/other/src/main.ts', '/other']);
	const removedContent = await folder.locator('.ash-search-result').elementHandle();
	expect(removedContent).not.toBeNull();
	await tree.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible();
	await query.focus();
	await page.getByRole('button', { name: 'Refresh search', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(query).toBeFocused();
	await removedContent!.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
	await expect(page.getByRole('menu')).toHaveCount(0);
	await removedContent!.dispose();
	await folder.click();
	await tree.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(false));
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(tree).toBeHidden();
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot()?.matchCount)).toBe(3);
});

test('Copy Path menu excludes matching lines and translates its path-only help', async ({ page }) => {
	await page.goto('/search.html?locale=zh-CN');
	const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 个结果');
	await page.locator('.ash-search-match').click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: '复制路径', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await page.locator('.ash-search-file-path').click({ button: 'right' });
	await page.getByRole('menuitem', { name: '复制路径', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts']);
	expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('仅在选择首项是文件时复制其路径');
});

test('Copy shortcut uses the first selection and a context menu copies its explicit row', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('3 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const first = tree.getByRole('treeitem', { name: 'Line 1, column 6: 中文😀 needle needle', exact: true });
	const other = tree.getByRole('treeitem', { name: 'Line 8, column 7: const needle = true;', exact: true });
	await first.click();
	await other.click({ modifiers: ['ControlOrMeta'] });
	await tree.press('ControlOrMeta+c');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,6: 中文😀 needle needle']);
	await other.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,6: 中文😀 needle needle', '8,7: const needle = true;']);
	await expect(page.getByRole('status')).toHaveText('3 results');
});

test('Copy does not intercept query text copying and keyboard menus close on refresh', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true }).click();
	await query.focus();
	await query.press('ControlOrMeta+a');
	await query.press('ControlOrMeta+c');
	expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([]);
	await tree.focus();
	await tree.press('ControlOrMeta+c');
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,7: const needle = true;']);
	await tree.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(tree).toBeFocused();
	await tree.press('Shift+F10');
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(page.getByRole('status')).toHaveText('1 results');
});

test('Copy result menu and accessibility guidance use the Chinese catalog', async ({ page }) => {
	await page.goto('/search.html?locale=zh-CN');
	const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 个结果');
	await page.locator('.ash-search-match').click({ button: 'right' });
	await page.getByRole('menuitem', { name: '复制', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['1,7: const needle = true;']);
	expect(await page.evaluate(() => window.ashSearchIntegration.help())).toContain('不会合并多选');
});

test('Copy menu closing preserves focus already moved to another input', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true }).click();
	await tree.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
	await query.focus();
	await page.evaluate(() => window.ashSearchIntegration.closeResultMenu());
	await expect(query).toBeFocused();
});

test('Copy menu replacement does not overwrite the next menu focus origin', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	await tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true }).click();
	await tree.press('Shift+F10');
	await query.focus();
	await page.evaluate(() => window.ashSearchIntegration.replaceResultMenu());
	await expect(page.getByRole('menuitem', { name: 'Other menu action', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(query).toBeFocused();
});

test('Copy menu release on hiding Search preserves editor focus and refresh focuses the query', async ({ page }) => {
	await page.goto('/search.html');
	await page.evaluate(() => {
		const editor = document.createElement('div');
		editor.contentEditable = 'true';
		editor.setAttribute('role', 'textbox');
		editor.setAttribute('aria-label', 'Outside editor');
		document.body.append(editor);
	});
	const editor = page.getByRole('textbox', { name: 'Outside editor', exact: true });
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const result = tree.getByRole('treeitem', { name: 'Line 1, column 7: const needle = true;', exact: true });
	await result.click();
	await tree.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
	await editor.focus();
	await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(false));
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(tree).toBeHidden();
	await expect(editor).toBeFocused();
	await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(true));
	await result.click();
	await tree.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
	await editor.focus();
	await page.getByRole('button', { name: 'Refresh search', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(page.getByRole('status')).toHaveText('1 results');
	await expect(query).toBeFocused();
});

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
	await tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }) }).click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts']);
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('3 results');
});

test('Dismiss expands the next nested result branch and the last same-kind branch on fallback', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('focus');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('5 results');
	await page.getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const folder = (name: string) => tree.getByRole('treeitem', { name, exact: true });
	const file = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').getByText('b.ts', { exact: true }) });
	await folder('b/nested').locator('.ash-tree-twistie').click();
	await folder('c').locator('.ash-tree-twistie').click();
	await tree.getByRole('treeitem', { name: 'Line 2, column 7: const needle = true;', exact: true }).click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('4 results');
	await expect(folder('b/nested')).toHaveAttribute('aria-expanded', 'true');
	await expect(file).toHaveAttribute('aria-expanded', 'true');
	await expect(folder('c')).toHaveAttribute('aria-expanded', 'false');
	const next = tree.getByRole('treeitem', { name: 'Line 8, column 7: const needle = true;', exact: true });
	await expect(next).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toHaveAttribute('aria-activedescendant', await next.getAttribute('id') as string);
	await expect(tree).toBeFocused();

	await folder('b/nested').locator('.ash-tree-twistie').click();
	await folder('c').locator('.ash-tree-twistie').click();
	await tree.getByRole('treeitem', { name: 'Line 10, column 7: const needle = true;', exact: true }).click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('3 results');
	await expect(folder('b/nested')).toHaveAttribute('aria-expanded', 'true');
	await expect(file).toHaveAttribute('aria-expanded', 'true');
	const last = tree.getByRole('treeitem', { name: 'Line 9, column 7: const needle = true;', exact: true });
	await expect(last).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toHaveAttribute('aria-activedescendant', await last.getAttribute('id') as string);
	await expect(tree).toBeFocused();
});

test('Dismiss restores file focus inside a collapsed folder without expanding the target file', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('focus');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('5 results');
	await page.getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const folder = (name: string) => tree.getByRole('treeitem', { name, exact: true });
	const file = (name: string) => tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').getByText(name, { exact: true }) });
	await file('b.ts').locator('.ash-tree-twistie').click();
	await folder('b/nested').locator('.ash-tree-twistie').click();
	await folder('c').locator('.ash-tree-twistie').click();
	await file('a.ts').click();
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('3 results');
	await expect(folder('b/nested')).toHaveAttribute('aria-expanded', 'true');
	await expect(file('b.ts')).toHaveAttribute('aria-expanded', 'false');
	await expect(file('b.ts')).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toHaveAttribute('aria-activedescendant', await file('b.ts').getAttribute('id') as string);
	await expect(folder('c')).toHaveAttribute('aria-expanded', 'false');
	await expect(tree).toBeFocused();
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
	await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['late.ts']);
	await expect(page.getByRole('status')).toHaveText('1 results');
});

test('Dismiss handles a file and its selected child together through multiple selection', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const file = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }) });
	await file.click();
	await tree.locator('.ash-search-match').first().click({ modifiers: ['ControlOrMeta'] });
	await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(2);
	await page.evaluate(() => window.ashSearchIntegration.dismiss());
	await expect(page.getByRole('status')).toHaveText('1 results');
	await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts']);
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
	await expect(page.getByRole('textbox', { name: 'Replace', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('button', { name: 'Preserve Case', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
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
		for (const width of [180, 220, 280, 400, 600]) {
			await page.evaluate(width => window.ashSearchIntegration.setWidth(width), width);
			await query.focus();
			await expect.poll(() => page.locator('.ash-search-widget').evaluate(widget => widget.classList.contains('ash-search-widget-narrow'))).toBe(width < 284);
			const geometry = await page.locator('.ash-search-widget').evaluate(widget => {
				const field = widget.querySelector('.ash-search-query-field')!;
				const bounds = field.getBoundingClientRect();
				const input = field.querySelector('textarea')!.getBoundingClientRect();
				const replacement = widget.querySelector('.ash-search-replace-field textarea')!.getBoundingClientRect();
				const controls = field.querySelector('[role="toolbar"]')!.getBoundingClientRect();
				const narrow = widget.classList.contains('ash-search-widget-narrow');
				const widgetBounds = widget.getBoundingClientRect();
				return {
					inputWidth: input.width, aligned: Math.abs(input.left - replacement.left) < 0.01 && Math.abs(input.right - replacement.right) < 0.01,
					inside: controls.left >= bounds.left && controls.right <= bounds.right + 0.01 && controls.top >= bounds.top && controls.bottom <= bounds.bottom + 0.01,
					narrowOptions: !narrow || controls.top >= input.bottom, fits: widget.scrollWidth <= widget.clientWidth,
					width: widget.clientWidth, scrollWidth: widget.scrollWidth,
					overflowing: Array.from(widget.querySelectorAll('*')).filter(element => element.getBoundingClientRect().right > widgetBounds.right + 0.01).map(element => ({ className: element.className, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width })),
				};
			});
			expect(geometry.inputWidth).toBeGreaterThanOrEqual(100);
			expect(geometry.aligned).toBe(true);
			expect(geometry.inside).toBe(true);
			expect(geometry.narrowOptions).toBe(true);
			expect(geometry.fits, JSON.stringify({ theme, requestedWidth: width, ...geometry })).toBe(true);
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
	const details = page.getByRole('button', { name: '切换搜索详细信息', exact: true });
	await expect(details).toHaveText('搜索条件');
	await details.click();
	await expect(page.getByRole('textbox', { name: '包含的文件', exact: true })).toHaveAttribute('placeholder', '例如 *.ts、src/**/include');
	await expect(page.getByRole('textbox', { name: '排除的文件', exact: true })).toBeVisible();
	await expect(page.locator('.ash-search-filter-help')).toHaveText('用逗号分隔 glob 模式。“包含”限定搜索范围；“排除”跳过匹配的文件。');
	await page.getByRole('textbox', { name: '包含的文件', exact: true }).fill('src/**');
	await details.click();
	await expect(details).toHaveText('搜索条件 · 筛选已启用');
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 个结果');
});

for (const mode of ['flat', 'tree'] as const) {
	test(`Search ${mode} results preserve source paths, preview coordinates and geometry across Sidebar widths`, async ({ page }) => {
		await page.goto('/search.html');
		const sidebar = page.locator('[data-part="sidebar"]');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
		await query.fill('layout');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('3 results');
		const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
		if (mode === 'tree') {
			await page.getByRole('button', { name: 'More Actions', exact: true }).click();
			await page.evaluate(() => window.ashSearchIntegration.selectTreeView());
			await expect(tree.getByRole('treeitem', { name: 'src/ash', exact: true })).toHaveCount(1);
			await expect(tree.getByRole('treeitem', { name: 'base/browser/ui/inputbox', exact: true })).toHaveCount(1);
			await expect(tree.getByRole('treeitem', { name: 'workbench/contrib/search/browser', exact: true })).toHaveCount(1);
			await expect(tree.getByRole('treeitem', { name: 'src/ash/workbench/contrib/search/browser', exact: true })).toHaveCount(1);
		} else {
			await expect(tree.locator('.ash-search-folder-path')).toHaveCount(0);
			await expect(tree.locator('.ash-icon-label-description')).toContainText([
				'workspace • src/ash/base/browser/ui/inputbox',
				'workspace • src/ash/workbench/contrib/search/browser',
				'other • src/ash/workbench/contrib/search/browser',
			]);
		}
		await expect(tree.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(mode === 'tree' ? ['searchView.ts', 'inputbox.ts', 'searchView.ts'] : ['inputbox.ts', 'searchView.ts', 'searchView.ts']);
		await expect(tree.locator('.ash-search-preview mark')).toHaveText(['layout', 'layout', 'layout']);
		expect((await tree.locator('.ash-search-line-number').allTextContents()).sort()).toEqual(['1000', '3456', '43']);
		const late = tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-line-number').getByText('3456', { exact: true }) });
		expect((await late.locator('.ash-search-preview').innerText()).length).toBeLessThanOrEqual(250);
		await expect(late.locator('.ash-search-preview mark')).toHaveText('layout');
		await late.dblclick();
		expect((await page.evaluate(() => window.ashSearchIntegration.opened)).at(-1)).toMatchObject({
			resource: 'file:///workspace/src/ash/workbench/contrib/search/browser/searchView.ts',
			options: { selection: { startLineNumber: 3456, startColumn: '中文😀 long context '.repeat(36).length + 1, endLineNumber: 3456, endColumn: '中文😀 long context '.repeat(36).length + 7 } },
		});
		for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(value => window.ashSearchIntegration.setTheme(value), theme);
			for (const width of [180, 220, 280, 400, 600]) {
				await page.evaluate(value => window.ashSearchIntegration.setWidth(value), width);
				await query.focus();
				await expect.poll(() => page.locator('.ash-search-widget').evaluate(widget => widget.classList.contains('ash-search-widget-narrow'))).toBe(width < 284);
				const geometry = await sidebar.evaluate(element => {
					const bounds = element.getBoundingClientRect();
					const title = element.querySelector('.ash-sidebar-title-label')!.getBoundingClientRect();
					const toolbar = element.querySelector('[aria-label="Search result actions"]')!.getBoundingClientRect();
					const input = element.querySelector('.ash-search-query-field textarea')!.getBoundingClientRect();
					const replacement = element.querySelector('.ash-search-replace-field textarea')!.getBoundingClientRect();
					const previews = Array.from(element.querySelectorAll('.ash-search-match')).map(row => {
						const content = row.getBoundingClientRect();
						const line = row.querySelector('.ash-search-line-number')!.getBoundingClientRect();
						const preview = row.querySelector('.ash-search-preview')!.getBoundingClientRect();
						return { lineWidth: line.width, origin: preview.left - content.left, width: preview.width, fits: preview.right <= bounds.right + 0.01 };
					});
					const files = Array.from(element.querySelectorAll('.ash-search-file-heading')).filter(row => row.querySelector('.ash-search-file-count')).map(row => {
						const label = row.querySelector('.ash-icon-label-text')!.getBoundingClientRect();
						const count = row.querySelector('.ash-search-file-count')!.getBoundingClientRect();
						return { width: label.width, separated: label.right <= count.left + 0.01, fits: count.right <= bounds.right + 0.01 };
					});
					return { width: bounds.width, titleFits: title.right <= toolbar.left, toolbarAtTop: toolbar.bottom <= input.top, alignedInputs: input.left === replacement.left && input.right === replacement.right, previews, files };
				});
				expect(geometry.titleFits).toBe(true);
				expect(geometry.toolbarAtTop).toBe(true);
				expect(geometry.alignedInputs).toBe(true);
				expect(geometry.previews).toHaveLength(3);
				expect(geometry.files).toHaveLength(3);
				for (const preview of geometry.previews) {
					expect(preview.lineWidth).toBeCloseTo(geometry.previews[0]!.lineWidth, 2);
					expect(preview.origin).toBeCloseTo(geometry.previews[0]!.origin, 2);
					expect(preview.width).toBeGreaterThan(0);
					expect(preview.fits).toBe(true);
				}
				for (const file of geometry.files) { expect(file.width).toBeGreaterThan(0); expect(file.separated).toBe(true); expect(file.fits).toBe(true); }
				await expect(page.locator('.ash-pane-composite-title-view-actions').getByRole('toolbar', { name: 'Search result actions', exact: true })).toHaveCount(1);
				await test.info().attach(`search-${mode}-${theme}-${width}px-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
				await test.info().attach(`search-${mode}-${theme}-${width}px`, { body: await sidebar.screenshot(), contentType: 'image/png' });
			}
		}
		await expect(toolbar).toBeVisible();
		expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(snapshot);
	});
}

test('Search opens each occurrence at UTF-16 columns and keeps same-path roots separate', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('中文');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('3 results');
	await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts', 'main.ts']);
	await expect(page.locator('.ash-search-file-count')).toHaveText(['2', '1']);
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const rows = tree.getByRole('treeitem');
	const workspaceFile = rows.filter({ has: page.locator('.ash-search-file-path').filter({ has: page.locator('.ash-icon-label-description', { hasText: 'workspace • src' }) }) });
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

test('Search lifecycle refreshes running tasks, cancels retained results, clears twice and searches again', async ({ page }) => {
	await page.clock.install();
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	const tree = page.getByRole('tree', { name: 'Search results', exact: true });
	const refresh = page.getByRole('button', { name: 'Refresh search', exact: true });
	const cancel = page.getByRole('button', { name: 'Cancel Search', exact: true });
	const clear = page.getByRole('button', { name: 'Clear search results', exact: true });
	await expect(clear).toBeDisabled();
	await query.fill('slow');
	await query.press('Enter');
	await expect(refresh).toBeEnabled();
	await expect(cancel).toHaveCount(0);
	await expect(tree).toHaveAttribute('aria-busy', 'true');
	await refresh.focus();
	await page.clock.fastForward(2_000);
	await expect(cancel).toBeFocused();
	await expect(refresh).toHaveCount(0);
	await cancel.press('Enter');
	await expect(query).toBeFocused();
	await expect(page.getByRole('status')).toHaveText('Search stopped. 1 results retained.');
	await expect(refresh).toBeEnabled();
	await expect(tree.locator('.ash-search-match')).toHaveCount(1);
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(tree.locator('.ash-search-match')).toHaveCount(1);
	await query.fill('slow');
	await query.press('Enter');
	await expect(tree).toHaveAttribute('aria-busy', 'true');
	await query.fill('needle');
	await refresh.click();
	await expect(query).toBeFocused();
	await expect(page.getByRole('status')).toHaveText('1 results');
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(page.locator('.ash-search-file-path .ash-icon-label-text')).toHaveText(['main.ts']);
	expect(await page.evaluate(() => window.ashSearchIntegration.cancelled())).toBe(2);
	await expect(page.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
	await page.getByRole('textbox', { name: 'Replace', exact: true }).fill('replacement');
	await page.getByRole('button', { name: 'Toggle Search Details', exact: true }).click();
	const includes = page.getByRole('textbox', { name: 'Files to include', exact: true });
	const excludes = page.getByRole('textbox', { name: 'Files to exclude', exact: true });
	await includes.fill('src/**');
	await excludes.fill('**/*.test.ts');
	await clear.click();
	await expect(query).toHaveValue('');
	await expect(query).toBeFocused();
	await expect(page.getByRole('textbox', { name: 'Replace', exact: true })).toHaveValue('');
	await expect(includes).toHaveValue('src/**');
	await expect(excludes).toHaveValue('**/*.test.ts');
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(page.getByRole('status')).toBeHidden();
	await clear.click();
	await expect(includes).toHaveValue('');
	await expect(excludes).toHaveValue('');
	await expect(clear).toBeDisabled();
	await query.press('ArrowUp');
	await expect(query).toHaveValue('needle');
	await query.press('ArrowDown');
	await expect(query).toHaveValue('');
	await query.fill('slow');
	await query.press('Enter');
	await includes.focus();
	await includes.press('Escape');
	await expect(includes).toBeFocused();
	await expect(page.getByRole('status')).toHaveText('Search stopped. 1 results retained.');
	await query.press('Enter');
	await tree.focus();
	await tree.press('Escape');
	await expect(query).toBeFocused();
	await clear.click();
	await page.evaluate(() => window.ashSearchIntegration.finishLateSearch());
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
});

test('Search lifecycle Chinese controls and help explain cancellation and repeated clearing', async ({ page }) => {
	await page.clock.install();
	await page.goto('/search.html?locale=zh-CN');
	const query = page.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.fill('slow');
	await query.press('Enter');
	await page.clock.fastForward(2_000);
	await page.getByRole('button', { name: '取消搜索', exact: true }).click();
	await expect(query).toBeFocused();
	await expect(page.getByRole('status')).toHaveText('搜索已停止，保留 1 个结果。');
	await page.getByRole('button', { name: '清空搜索结果', exact: true }).click();
	await expect(query).toHaveValue('');
	const help = await page.evaluate(() => window.ashSearchIntegration.help());
	expect(help).toContain('搜索: 刷新');
	expect(help).toContain('两项输入已为空时再次清空');
	expect(help).toContain('搜索选项和输入历史保留');
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

test('Copy All does not write while Search is inactive and resumes from its retained model', async ({ page }) => {
	await page.goto('/search.html');
	const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
	await query.fill('needle');
	await query.press('Enter');
	await expect(page.getByRole('status')).toHaveText('1 results');
	const snapshot = await page.evaluate(() => window.ashSearchIntegration.snapshot());
	await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(false));
	await expect(query).toBeHidden();
	await page.evaluate(() => window.ashSearchIntegration.copyAll());
	expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([]);
	expect(await page.evaluate(() => window.ashSearchIntegration.snapshot())).toEqual(snapshot);
	await expect(query).toBeHidden();
	await page.evaluate(() => window.ashSearchIntegration.setSearchVisible(true));
	await expect(query).toBeVisible();
	await page.evaluate(() => window.ashSearchIntegration.copyAll());
	expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['/workspace/src/main.ts\n  1,7: const needle = true;']);
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

test.describe('Windows search clipboard formatting', () => {
	test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36' });
	test('Copy Path uses the Windows shortcut and does not claim Control+Alt+C', async ({ page }) => {
		await page.goto('/search.html?windows=1');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('windows');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('2 results');
		await page.locator('.ash-search-file-path').filter({ hasText: 'main.ts' }).click();
		const tree = page.getByRole('tree', { name: 'Search results', exact: true });
		await tree.press('Control+Alt+c');
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual([]);
		await tree.press('Shift+Alt+c');
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['C:\\workspace\\src\\main.ts']);
		await tree.press('Control+Shift+Alt+c');
		await query.focus();
		await query.press('Shift+Alt+c');
		expect(await page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['C:\\workspace\\src\\main.ts']);
	});
	test('Copy formats a single multi-line match and its file with Windows labels and separators', async ({ page }) => {
		await page.goto('/search.html?windows=1');
		const query = page.getByRole('textbox', { name: 'Search workspace', exact: true });
		await query.fill('windows');
		await query.press('Enter');
		await expect(page.getByRole('status')).toHaveText('2 results');
		await page.locator('.ash-search-match').filter({ hasText: 'next' }).click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
		await page.locator('.ash-search-file-path').filter({ hasText: 'main.ts' }).click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashSearchIntegration.clipboardWrites())).toEqual(['9,1: needle\n10:  next', 'C:\\workspace\\src\\main.ts\r\n  9,1: needle\n  10:  next']);
	});
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

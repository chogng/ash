import { expect, test } from '../../../automation/test.js';
import { basename, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ElectronApplication } from '@playwright/test';

test('Search Dismiss removes retained matches, files and folders without changing disk contents', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual workspace content searches.');
	const contents = [
		['main.ts', 'ash_dismiss_token first\nash_dismiss_token second\n'],
		['src/source.ts', 'ash_dismiss_token source\n'],
		['docs/notes.md', 'ash_dismiss_token docs\n'],
	] as const;
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	await mkdir(join(testWorkspace.directory, 'docs'), { recursive: true });
	for (const [path, content] of contents) { await writeFile(join(testWorkspace.directory, path), content); }
	await workbench.search.open();
	await workbench.search.search('ash_dismiss_token');
	const page = workbench.page;
	const search = workbench.search.element;
	const tree = search.getByRole('tree');
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const openMoreActions = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	const dismissKey = process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete';
	await expect(workbench.search.status).toHaveText('4 results');
	await workbench.search.query.press(dismissKey);
	await expect(workbench.search.status).toHaveText('4 results');
	await workbench.search.query.fill('ash_dismiss_token');
	await search.locator('.ash-search-match', { hasText: 'ash_dismiss_token first' }).click();
	await tree.press(dismissKey);
	await expect(workbench.search.status).toHaveText('3 results');
	await expect(tree).toBeFocused();
	const next = tree.getByRole('treeitem', { name: 'Line 2, column 1: ash_dismiss_token second', exact: true });
	await expect(next).toHaveAttribute('aria-selected', 'true');
	await expect(tree).toHaveAttribute('aria-activedescendant', (await next.getAttribute('id'))!);
	await workbench.menus.select(application, openMoreActions, ['View as tree']);
	await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
	await workbench.menus.select(application, openMoreActions, ['Dismiss']);
	await expect(workbench.search.status).toHaveText('2 results');
	await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toHaveCount(0);
	await tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'main.ts' }) }).click();
	await workbench.menus.select(application, openMoreActions, ['Dismiss']);
	await expect(workbench.search.files).toHaveText(['notes.md']);
	await expect(workbench.search.status).toHaveText('1 results');
	await workbench.menus.select(application, openMoreActions, ['Open results in Search Editor']);
	const resultEditor = page.locator('.ash-search-editor');
	await expect(resultEditor).toBeVisible();
	await expect(resultEditor).toContainText('notes.md');
	await expect(resultEditor).not.toContainText('source.ts');
	await expect(resultEditor).not.toContainText('main.ts');
	await search.locator('.ash-search-match', { hasText: 'ash_dismiss_token docs' }).click();
	await tree.press(dismissKey);
	await expect(workbench.search.status).toHaveText('No results found.');
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(tree).toBeFocused();
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(workbench.search.status).toHaveText('4 results');
	for (const [path, content] of contents) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
});

test('Search submits case, regex and file filters to workspace search', async ({ target, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the real workspace search service.');
	await workbench.search.open();
	const search = workbench.search.element;
	const mainFileLabel = `${basename(testWorkspace.directory)} • main.ts`;
	await search.getByRole('button', { name: 'Toggle Search Details', exact: true }).click();
	await search.getByRole('textbox', { name: 'Files to include', exact: true }).fill('**/*.ts');
	await search.getByRole('button', { name: 'Match Case', exact: true }).click();
	await workbench.search.search('value');
	await expect(workbench.search.files).toHaveText([mainFileLabel]);
	await expect(search.locator('.ash-search-preview mark')).toHaveText('value');
	await workbench.search.search('VALUE');
	await expect(workbench.search.status).toHaveText('No results found.');
	await search.getByRole('button', { name: 'Use Regular Expression', exact: true }).click();
	await workbench.search.search('[v]alue');
	await expect(workbench.search.files).toHaveText([mainFileLabel]);
	await search.getByRole('textbox', { name: 'Files to exclude', exact: true }).fill('main.ts');
	await search.getByRole('textbox', { name: 'Files to exclude', exact: true }).press('Enter');
	await expect(workbench.search.status).toHaveText('No results found.');
});

test('Search selects exact matches, opens beside the editor and supports result controls', async ({ target, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the real workspace search service and editors.');
	await writeFile(join(testWorkspace.directory, 'main.ts'), 'const text = "中文😀 needle needle";\n');
	await workbench.search.open();
	await workbench.search.search('needle');
	const page = workbench.page;
	const search = workbench.search.element;
	const tree = search.getByRole('tree');
	await expect(workbench.search.status).toHaveText('2 results');
	await expect(search.locator('.ash-search-match')).toHaveCount(2);
	await search.locator('.ash-search-match').last().dblclick();
	await expect(workbench.editors.groupAt(0).editor.element).toBeVisible();
	const cursor = page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]');
	await expect(cursor).toContainText('Ln 1, Col 33');
	await expect(workbench.editors.groupAt(0).editor.element.locator('.stanza-editor-selection').first()).toBeVisible();
	await tree.focus();
	await tree.press('ControlOrMeta+Enter');
	await expect(workbench.editors.groups).toHaveCount(2);
	await expect(workbench.editors.groupAt(1).editor.element).toBeVisible();
	await expect(cursor).toContainText('Ln 1, Col 33');
	await workbench.search.query.press('Shift+F4');
	await expect(tree).toBeFocused();
	await expect(cursor).toContainText('Ln 1, Col 26');
	await page.getByRole('button', { name: 'Collapse all results', exact: true }).click();
	await expect(search.locator('.ash-search-match')).toHaveCount(0);
	await tree.focus();
	await tree.press('ArrowRight');
	await expect(search.locator('.ash-search-match')).toHaveCount(2);
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(workbench.search.status).toHaveText('2 results');
	await page.getByRole('button', { name: 'Clear search results', exact: true }).click();
	await expect(tree.getByRole('treeitem')).toHaveCount(0);
	await expect(workbench.search.query).toHaveValue('needle');
	await expect(workbench.search.query).toBeFocused();
});

test('Search offers tree view, sorting and accessible help through actual workbench controls', async ({ target, application, workbench, testWorkspace }) => {
	await workbench.search.open();
	const query = workbench.search.query;
	await query.focus();
	await query.press('Alt+F1');
	const help = workbench.page.getByRole('dialog');
	await expect(help).toBeVisible();
	await expect(help.getByRole('textbox')).toHaveValue(/Search across files[\s\S]*Shift\+F4/);
	await workbench.page.keyboard.press('Escape');
	await expect(query).toBeFocused();
	if (target.appServerMode !== 'required') { return; }
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	await writeFile(join(testWorkspace.directory, 'a.ts'), 'value\n');
	await writeFile(join(testWorkspace.directory, 'src', 'z.ts'), 'value value value\n');
	await workbench.search.search('value');
	const toolbar = workbench.page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const files = workbench.search.element.locator('.ash-search-file-path');
	const workspaceName = basename(testWorkspace.directory);
	await expect(files).toHaveText([`${workspaceName} • a.ts`, `${workspaceName} • main.ts`, `${workspaceName} • src/z.ts`]);
	const openMoreActions = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	await workbench.menus.select(application, openMoreActions, ['Sort by match count']);
	await expect(files).toHaveText([`${workspaceName} • src/z.ts`, `${workspaceName} • a.ts`, `${workspaceName} • main.ts`]);
	await workbench.menus.select(application, openMoreActions, ['View as tree']);
	await expect(files).toHaveText(['z.ts', 'a.ts', 'main.ts']);
	const folder = workbench.search.element.getByRole('treeitem', { name: 'src', exact: true });
	await folder.locator('.ash-tree-twistie').click();
	await expect(files).toHaveText(['a.ts', 'main.ts']);
	await folder.locator('.ash-tree-twistie').click();
	await expect(files).toHaveText(['z.ts', 'a.ts', 'main.ts']);
	await expect(workbench.search.element.locator('.ash-search-match')).toHaveCount(5);
});

test('Search keeps options inside the query and preserves collapsed file filters', async ({ workbench }) => {
	await workbench.search.open();
	const page = workbench.page;
	const search = workbench.search.element;
	const query = workbench.search.query;
	const matchCase = search.getByRole('button', { name: 'Match Case', exact: true });
	const regex = search.getByRole('button', { name: 'Use Regular Expression', exact: true });
	const details = search.getByRole('button', { name: 'Toggle Search Details', exact: true });
	const include = search.getByRole('textbox', { name: 'Files to include', exact: true });
	const exclude = search.getByRole('textbox', { name: 'Files to exclude', exact: true });
	await expect(search.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
	await expect(search.getByRole('checkbox')).toHaveCount(0);
	await expect(details).toHaveAttribute('aria-expanded', 'false');
	await expect(include).toBeHidden();
	await expect(exclude).toBeHidden();

	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const themeQuery = page.locator('.ash-quick-pick').getByRole('combobox');
		await themeQuery.fill(theme);
		await themeQuery.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await query.focus();
		await expect(query).toBeFocused();
		const geometry = await search.evaluate(element => {
			const field = element.querySelector('.ash-search-query-field')!;
			const bounds = field.getBoundingClientRect();
			const input = element.querySelector('.ash-search-query')!.getBoundingClientRect();
			const options = element.querySelector('.ash-search-query-options')!.getBoundingClientRect();
			const style = getComputedStyle(field);
			const probe = document.createElement('span');
			probe.style.color = 'var(--ash-focusBorder)';
			element.append(probe);
			const focusBorder = getComputedStyle(probe).color;
			probe.remove();
			return {
				height: bounds.height,
				inputWidth: input.width,
				// Chromium rects use floats; adjacent edges can differ by a few millionths at 125% scale.
				optionsInside: options.left >= input.right - 0.01 && options.right <= bounds.right && options.top >= bounds.top && options.bottom <= bounds.bottom,
				border: style.borderColor,
				focusBorder,
				fits: element.scrollWidth <= element.clientWidth,
			};
		});
		expect(geometry.height).toBe(26);
		expect(geometry.inputWidth).toBeGreaterThan(80);
		expect(geometry.optionsInside).toBe(true);
		expect(geometry.fits).toBe(true);
		expect(geometry.border).toBe(geometry.focusBorder);
	}

	await query.press('Tab');
	await expect(matchCase).toBeFocused();
	await matchCase.press('Space');
	await expect(matchCase).toBeFocused();
	await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
	await matchCase.press('ArrowRight');
	await expect(search.getByRole('button', { name: 'Match Whole Word', exact: true })).toBeFocused();
	await search.getByRole('button', { name: 'Match Whole Word', exact: true }).press('ArrowRight');
	await expect(regex).toBeFocused();
	await regex.press('Space');
	await expect(regex).toBeFocused();
	await expect(regex).toHaveAttribute('aria-pressed', 'true');
	await regex.press('Tab');
	await expect(details).toBeFocused();
	await details.press('Enter');
	await expect(details).toHaveAttribute('aria-expanded', 'true');
	await details.press('Tab');
	await expect(include).toBeFocused();
	await include.fill('src/**');
	await include.press('Tab');
	await expect(exclude).toBeFocused();
	await exclude.fill('**/*.test.ts');
	await details.click();
	await expect(include).toBeHidden();
	await details.click();
	await expect(include).toHaveValue('src/**');
	await expect(exclude).toHaveValue('**/*.test.ts');
	await expect(include).toHaveAccessibleName('Files to include');
});

test('Search Editor opens from its command and provides keyboard help', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('search.action.openNewEditor');
	const pane = workbench.page.locator('.ash-search-editor');
	const query = pane.getByRole('textbox', { name: 'Search editor query', exact: true });
	await expect(query).toBeVisible();
	await expect(pane.locator('.stanza-editor')).toBeVisible();
	await query.fill('first\nsecond');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('first\\nsecond'));
	await query.press('Alt+F1');
	const help = workbench.page.getByRole('dialog');
	await expect(help.getByRole('textbox')).toHaveValue(/search editor[\s\S]*\.code-search/);
	await workbench.page.keyboard.press('Escape');
	await expect(query).toBeFocused();
});

test('Search replaces across lines on disk and undo restores the searched contents', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses real workspace files and search engines.');
	const path = join(testWorkspace.directory, 'main.ts');
	await writeFile(path, '中文😀 first\r\nsecond end\r\n');
	if (target.kind === 'electron') {
		await (application as ElectronApplication).evaluate(({ dialog }) => {
			dialog.showMessageBox = async (...args: unknown[]) => {
				(globalThis as typeof globalThis & { searchConfirmation?: unknown; }).searchConfirmation = args.at(-1);
				return { response: 0, checkboxChecked: false };
			};
		});
	}
	await workbench.search.open();
	await workbench.search.search('first\nsecond');
	await expect(workbench.search.status).toHaveText('1 results');
	await workbench.search.element.locator('.ash-search-match').dblclick();
	await expect(workbench.page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]')).toContainText('Ln 2, Col 7');
	await workbench.search.element.getByRole('button', { name: 'Toggle Replace', exact: true }).click();
	await workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true }).fill('updated');
	await workbench.search.element.getByRole('button', { name: 'Replace All', exact: true }).click();
	if (target.kind === 'electron') {
		await expect.poll(() => (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { searchConfirmation?: unknown; }).searchConfirmation)).toMatchObject({ message: 'Replace 1 matches in 1 files?' });
	} else {
		const dialog = workbench.page.getByRole('dialog');
		await expect(dialog).toContainText('Replace 1 matches in 1 files?');
		await dialog.getByRole('button', { name: 'Replace All', exact: true }).click();
	}
	await expect(workbench.search.status).toHaveText('No results found.');
	expect((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).toBe('中文😀 updated end\n');
	const toolbar = workbench.page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	await workbench.menus.select(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click(), ['Undo replacement']);
	await expect(workbench.search.status).toHaveText('1 results');
	expect((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).toBe('中文😀 first\nsecond end\n');
	await workbench.search.element.getByRole('button', { name: 'Use Regular Expression', exact: true }).click();
	await workbench.search.search('(first)\n(second)');
	await expect(workbench.search.status).toHaveText('1 results');
	await workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true }).fill('$2 $1');
	await workbench.search.element.getByRole('button', { name: 'Replace All', exact: true }).click();
	if (target.kind !== 'electron') {
		await workbench.page.getByRole('dialog').getByRole('button', { name: 'Replace All', exact: true }).click();
	}
	await expect(workbench.search.status).toHaveText('No results found.');
	expect((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).toBe('中文😀 second first end\n');
});

test.describe('Search with a granted browser folder', () => {
	test.use({ openWorkspace: false });
	test('preview, undo, Search Editor source navigation and saved searches use the real browser filesystem', async ({ target, workbench }) => {
		test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled');
		const page = workbench.page;
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const folder = await root.getDirectoryHandle(`search-${crypto.randomUUID()}`, { create: true });
			const writer = await (await folder.getFileHandle('main.txt', { create: true })).createWritable();
			await writer.write('中文😀 first\r\nsecond end\r\nneedle needle\r\n');
			await writer.close();
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
		await workbench.quickaccess.runCommand('workbench.action.files.openFolderViaWorkspace');
		// Opening the folder rebuilds Workbench; wait for its new Explorer before navigation.
		await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.txt', exact: true })).toBeVisible();
		await workbench.search.open();
		await workbench.search.search('needle');
		await expect(workbench.search.status).toHaveText('2 results');
		await workbench.search.element.getByRole('button', { name: 'Toggle Replace', exact: true }).click();
		await workbench.search.element.getByRole('textbox', { name: 'Replace', exact: true }).fill('value');
		const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
		await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Preview replacement', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Apply selected', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Apply selected', exact: true }).click();
		await expect(workbench.search.status).toHaveText('No results found.');
		await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Undo replacement', exact: true }).click();
		await expect(workbench.search.status).toHaveText('2 results');
		await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Open results in Search Editor', exact: true }).click();
		const pane = page.locator('.ash-search-editor:visible');
		const query = pane.getByRole('textbox', { name: 'Search editor query', exact: true });
		await expect(query).toHaveValue('needle');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorContents(text => text.includes('3:8-3:14: needle'));
		await editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('ControlOrMeta+Enter');
		await expect(page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]')).toContainText('Ln 3, Col 14');
		await workbench.editors.groupAt(0).tabs.filter({ hasText: 'Search Editor' }).click();
		await query.fill('first\nsecond');
		await query.press('ControlOrMeta+Enter');
		await expect(pane.getByRole('status')).toHaveText('1 results');
		await editor.waitForEditorContents(text => text.includes('1:6-2:7: first ↵ second'));
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		const save = page.getByRole('dialog');
		await save.getByRole('textbox').fill('results.code-search');
		await save.getByRole('button').filter({ hasText: /^OK$|^Save$/ }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(query).toHaveValue('first\nsecond');
		await page.getByRole('button', { name: 'Close results.code-search', exact: true }).click();
		await expect(pane).toHaveCount(0);
		await page.getByRole('tab', { name: 'Explorer', exact: true }).click();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'results.code-search', exact: true }).dblclick();
		await expect(query).toHaveValue('first\nsecond');
		await editor.waitForEditorContents(text => text.includes('first ↵ second'));

		// Hold the filesystem boundary to switch documents while the old search is still running.
		await page.evaluate(() => {
			const original = FileSystemFileHandle.prototype.getFile;
			let release!: () => void;
			const pending = new Promise<void>(resolve => { release = resolve; });
			FileSystemFileHandle.prototype.getFile = async function () { await pending; return original.call(this); };
			(globalThis as typeof globalThis & { resumeSearchRead?: () => void; }).resumeSearchRead = () => {
				FileSystemFileHandle.prototype.getFile = original;
				release();
			};
		});
		try {
			await query.press('ControlOrMeta+Enter');
			await expect(pane.getByRole('button', { name: 'Search again', exact: true })).toBeDisabled();
			await workbench.quickaccess.runCommand('search.action.openNewEditor');
			await expect(query).toHaveValue('');
			await expect(pane.getByRole('button', { name: 'Search again', exact: true })).toBeEnabled();
		} finally {
			await page.evaluate(() => {
				const boundary = globalThis as typeof globalThis & { resumeSearchRead?: () => void; };
				boundary.resumeSearchRead!();
				delete boundary.resumeSearchRead;
			});
		}
	});
});

test('Search translates query options and file filters into Chinese', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.appServerMode === 'required', 'Locale restart is covered by the UI projects.');
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('general');
	await workbench.page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
	await workbench.page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	await workbench.page.locator('[data-part="activitybar"]').getByRole('tab', { name: '搜索', exact: true }).click();
	const search = workbench.page.locator('.ash-search');
	await expect(search.getByRole('textbox', { name: '搜索工作区', exact: true })).toHaveAttribute('placeholder', '搜索');
	await expect(search.getByRole('button', { name: '区分大小写', exact: true })).toHaveText('Aa');
	await expect(search.getByRole('button', { name: '使用正则表达式', exact: true })).toHaveText('.*');
	await expect(search.getByRole('button', { name: '全字匹配', exact: true })).toHaveText('ab');
	await search.getByRole('button', { name: '切换替换', exact: true }).click();
	await expect(search.getByRole('textbox', { name: '替换', exact: true })).toBeVisible();
	await expect(search.getByRole('button', { name: '保留大小写', exact: true })).toHaveText('AB');
	await search.getByRole('button', { name: '切换搜索详细信息', exact: true }).click();
	await expect(search.getByRole('textbox', { name: '包含的文件', exact: true })).toHaveAttribute('placeholder', '例如 *.ts、src/**/include');
	await expect(search.getByRole('textbox', { name: '排除的文件', exact: true })).toBeVisible();
	const query = search.getByRole('textbox', { name: '搜索工作区', exact: true });
	await query.focus();
	await query.press('Alt+F1');
	await expect(workbench.page.getByRole('dialog').getByRole('textbox')).toHaveValue(/跨文件搜索[\s\S]*移除结果[\s\S]*不会删除文件/);
	await workbench.page.keyboard.press('Escape');
	await expect(query).toBeFocused();
	await workbench.page.getByRole('toolbar', { name: '搜索结果操作', exact: true }).getByRole('button', { name: '更多操作', exact: true }).click();
	await expect(workbench.page.getByRole('menuitem', { name: '移除结果', exact: true })).toBeVisible();
	await expect(workbench.page.getByRole('menuitem', { name: '复制全部结果', exact: true })).toBeVisible();
	await workbench.page.keyboard.press('Escape');
	await workbench.quickaccess.runCommand('search.action.openNewEditor');
	const editorQuery = workbench.page.getByRole('textbox', { name: '搜索编辑器查询', exact: true });
	await expect(editorQuery).toBeVisible();
	await expect(workbench.page.locator('.ash-search-editor').getByRole('button', { name: '重新搜索', exact: true })).toBeVisible();
	await editorQuery.press('Alt+F1');
	await expect(workbench.page.getByRole('dialog').getByRole('textbox')).toHaveValue(/搜索编辑器[\s\S]*\.code-search/);
	await workbench.page.keyboard.press('Escape');
	await expect(editorQuery).toBeFocused();
});

test('Search Copy All copies current retained results through the host clipboard', async ({ target, workbench, testWorkspace, application }) => {
	test.skip(target.appServerMode !== 'required', 'Uses actual workspace searches and the host clipboard.');
	const contents = [
		['src/file10.ts', 'ash_copy_token ten\n'],
		['src/file2.ts', 'ash_copy_token first\nash_copy_token second\n'],
		['root.ts', 'ash_copy_token root\n'],
	] as const;
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	for (const [path, content] of contents) { await writeFile(join(testWorkspace.directory, path), content); }
	const page = workbench.page;
	// Seed known test content before any clipboard read; never inspect the user's previous clipboard.
	if (target.kind === 'browser') {
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.evaluate(() => navigator.clipboard.writeText('ash-search-copy-fixture'));
	} else {
		await (application as ElectronApplication).evaluate(async ({ clipboard }) => { await clipboard.writeText('ash-search-copy-fixture'); });
	}
	const readCopied = () => target.kind === 'browser'
		? page.evaluate(() => navigator.clipboard.readText())
		: (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText());
	await workbench.search.open();
	const toolbar = page.getByRole('toolbar', { name: 'Search result actions', exact: true });
	const openMoreActions = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	expect(await workbench.menus.inspect(application, openMoreActions)).toContainEqual(expect.objectContaining({ label: 'Copy All', enabled: false }));
	await workbench.search.search('ash_copy_token');
	await expect(workbench.search.status).toHaveText('4 results');
	const copyAll = () => workbench.menus.select(application, openMoreActions, ['Copy All']);
	const delimiter = process.platform === 'win32' ? '\r\n' : '\n';
	const pathLabel = (path: string) => join(testWorkspace.directory, path).replace(/^([a-z]):/i, (_prefix, drive: string) => drive.toUpperCase() + ':');
	const blocks = [
		[pathLabel('src/file2.ts'), '  1,1: ash_copy_token first', '  2,1: ash_copy_token second'].join(delimiter),
		[pathLabel('src/file10.ts'), '  1,1: ash_copy_token ten'].join(delimiter),
		[pathLabel('root.ts'), '  1,1: ash_copy_token root'].join(delimiter),
	];
	await page.getByRole('button', { name: 'Collapse all results', exact: true }).click();
	await copyAll();
	await expect.poll(readCopied).toBe(blocks.join(delimiter + delimiter));
	const tree = workbench.search.element.getByRole('tree');
	await tree.getByRole('treeitem').filter({ has: page.locator('.ash-search-file-path', { hasText: 'src/file10.ts' }) }).click();
	await workbench.menus.select(application, openMoreActions, ['Dismiss']);
	await expect(workbench.search.status).toHaveText('3 results');
	await copyAll();
	await expect.poll(readCopied).toBe([blocks[0], blocks[2]].join(delimiter + delimiter));
	await writeFile(join(testWorkspace.directory, 'root.ts'), 'ash_copy_token root\nash_copy_token latest\n');
	await page.getByRole('button', { name: 'Refresh search', exact: true }).click();
	await expect(workbench.search.status).toHaveText('5 results');
	await copyAll();
	await expect.poll(readCopied).toBe([blocks[0], blocks[1], blocks[2] + delimiter + '  2,1: ash_copy_token latest'].join(delimiter + delimiter));
	for (const [path, content] of contents.slice(0, 2)) { expect(await readFile(join(testWorkspace.directory, path), 'utf8')).toBe(content); }
	expect(await readFile(join(testWorkspace.directory, 'root.ts'), 'utf8')).toBe('ash_copy_token root\nash_copy_token latest\n');
});

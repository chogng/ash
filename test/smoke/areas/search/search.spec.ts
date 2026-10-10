import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires workspace content search.');
	await mkdir(join(testWorkspace.directory, 'src'));
	await writeFile(join(testWorkspace.directory, 'src', 'alpha.ts'), 'ash_search_token\nASH_SEARCH_TOKEN\nash_search_token:42\n');
	await writeFile(join(testWorkspace.directory, 'src', 'beta.js'), 'ash_search_token\n');
	await writeFile(join(testWorkspace.directory, 'notes.md'), 'ash_search_token\n');
});

test('workspace search applies include and exclude filters and clears previous results', async ({ workbench }) => {
	const search = workbench.search;
	await search.open();
	await search.search('ash_search_token');
	await expect(search.status).toHaveText('5 results');
	await expect(search.files).toHaveCount(3);
	await search.element.getByRole('button', { name: 'Toggle Search Details', exact: true }).click();
	await search.element.getByRole('textbox', { name: 'Files to include', exact: true }).fill('**/*.ts');
	await search.search('ash_search_token');
	await expect(search.status).toHaveText('3 results');
	await expect(search.files).toHaveText(['alpha.ts']);
	await search.element.getByRole('textbox', { name: 'Files to include', exact: true }).fill('');
	await search.element.getByRole('textbox', { name: 'Files to exclude', exact: true }).fill('**/alpha.ts');
	await search.search('ash_search_token');
	await expect(search.status).toHaveText('2 results');
	await expect.poll(async () => (await search.files.allTextContents()).sort()).toEqual(['beta.js', 'notes.md']);
	await search.search('no_such_workspace_token');
	await expect(search.status).toHaveText('No results found.');
	await expect(search.files).toHaveCount(0);
});

test('workspace search applies case and regular expression options to real files', async ({ workbench }) => {
	const search = workbench.search;
	await search.open();
	await search.element.getByRole('button', { name: 'Match Case', exact: true }).click();
	await search.search('ash_search_token');
	await expect(search.status).toHaveText('4 results');
	await search.element.getByRole('button', { name: 'Use Regular Expression', exact: true }).click();
	await search.search('ash_search_token:[0-9]+');
	await expect(search.status).toHaveText('1 results');
	await expect(search.files).toHaveText(['alpha.ts']);
	await expect(search.element.locator('.ash-search-match')).toContainText('ash_search_token:42');
});

test('workspace file picker ranks fuzzy names before truncation and preserves explicit globs', async ({ workbench, testWorkspace }) => {
	await mkdir(join(testWorkspace.directory, 'fixtures'));
	await Promise.all(Array.from({ length: 1050 }, (_, index) => writeFile(join(testWorkspace.directory, 'fixtures', `f_i_l_e_p_i_c_k_e_r_${index}.txt`), 'spread subsequence')));
	await mkdir(join(testWorkspace.directory, 'fixtures', 'zz'));
	await writeFile(join(testWorkspace.directory, 'fixtures', 'zz', 'FILEPICKER.txt'), 'best contiguous name');
	await workbench.quickaccess.open('filepicker');
	const labels = workbench.quickaccess.items.locator('.ash-quick-pick-row-label');
	await expect(labels.first()).toHaveText('FILEPICKER.txt');
	await expect(labels).toHaveCount(100);
	await workbench.quickaccess.input.press('Enter');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForEditorContents(text => text === 'best contiguous name');
	await workbench.quickaccess.open('src/*.js');
	await expect(labels).toHaveText(['beta.js']);
	await workbench.quickaccess.close();
	await workbench.quickaccess.open('no_such_filepicker_name');
	await expect(labels).toHaveCount(0);
	await workbench.quickaccess.close();
});

test('workspace search uses unsaved editor text and removes stale disk hits without saving the file', async ({ workbench, testWorkspace }) => {
	const path = join(testWorkspace.directory, 'src', 'alpha.ts');
	const disk = await readFile(path, 'utf8');
	await workbench.quickaccess.open('alpha.ts');
	await workbench.quickaccess.select('alpha.ts');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await workbench.page.keyboard.press('ControlOrMeta+A');
	await workbench.page.keyboard.insertText('中文😀 unsaved_search_token unsaved_search_token');
	await editor.waitForEditorContents(text => text === '中文😀 unsaved_search_token unsaved_search_token');
	await workbench.search.open();
	await workbench.search.search('unsaved_search_token');
	await expect(workbench.search.status).toHaveText('2 results');
	await expect(workbench.search.files).toHaveText(['alpha.ts']);
	await workbench.search.search('ash_search_token');
	await expect(workbench.search.status).toHaveText('2 results');
	await expect.poll(async () => (await workbench.search.files.allTextContents()).sort()).toEqual(['beta.js', 'notes.md']);
	expect(await readFile(path, 'utf8')).toBe(disk);
});


test('Quick Open ranks fuzzy paths beyond the first page and supports multiple query words', async ({ workbench, testWorkspace }) => {
	for (let index = 0; index < 110; index++) {
		await writeFile(join(testWorkspace.directory, `a_s_e_a_r_c_h_s_e_r_v_i_c_e_${index}.ts`), 'candidate');
	}
	await writeFile(join(testWorkspace.directory, 'searchService.ts'), 'best_fuzzy_candidate');
	await workbench.quickaccess.open('searchservice');
	await expect(workbench.quickaccess.items.first().locator('.ash-quick-pick-row-label')).toHaveText('searchService.ts');
	await expect(workbench.quickaccess.items).toHaveCount(100);
	await workbench.quickaccess.search('search service');
	await expect(workbench.quickaccess.items).toHaveCount(100);
	await workbench.quickaccess.select('searchService.ts');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'best_fuzzy_candidate');
});

test('workspace search opens untitled matches without saving the draft', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await workbench.page.keyboard.insertText('中文😀 untitled_search_token untitled_search_token');
	await editor.waitForEditorContents(text => text === '中文😀 untitled_search_token untitled_search_token');
	await workbench.search.open();
	await workbench.search.search('untitled_search_token');
	await expect(workbench.search.status).toHaveText('2 results');
	await expect(workbench.search.files).toHaveText(['Untitled-1']);
	await workbench.search.element.locator('.ash-search-match').first().dblclick();
	await editor.waitForEditorContents(text => text === '中文😀 untitled_search_token untitled_search_token');
	await expect(workbench.page.getByRole('dialog')).toHaveCount(0);
});

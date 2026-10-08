import { mkdir, writeFile } from 'node:fs/promises';
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

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const execute = promisify(execFile);

test.describe('Git-backed ordinary Output', () => {
	test.use({ gitRepository: true });

	test('Git Output filters real repository status and preserves raw editor text through clearing', async ({ target, testWorkspace, workbench }, testInfo) => {
		test.skip(target.appServerMode !== 'required', 'Requires the real Git backend and its isolated test profile.');
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const changes = page.locator('[data-view-id="ash.gitView"]');
		await expect(changes).toBeVisible();
		const refreshAndShow = async (): Promise<void> => {
			await workbench.quickaccess.runCommand('git.refresh');
			await workbench.quickaccess.runCommand('git.showOutput');
		};
		const output = page.locator('[data-view-id="ash.output"]');
		const filter = output.getByRole('searchbox', { name: 'Filter Output', exact: true });
		const visibleLines = async (): Promise<string[]> => (await output.locator('.view-line').allTextContents()).map(line => line.replaceAll('\u00a0', ' ')).filter(Boolean);

		// Real workspace changes reach the existing Git status owner and channel;
		// this producer emits complete lines, while chunk boundaries are tested in components.
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await expect(changes.locator('.ash-scm-change')).toHaveCount(1);
		await refreshAndShow();
		await expect(output).toBeVisible();
		await expect(page.locator('.ash-output-title-actions')).toContainText('Git');
		await expect.poll(visibleLines).toContain('1 changed file');
		await writeFile(join(testWorkspace.directory, 'output-added.ts'), 'export const added = 1;\n');
		await expect(changes.locator('.ash-scm-change')).toHaveCount(2);
		await refreshAndShow();
		await expect.poll(visibleLines).toContain('2 changed files');
		const retainedLines = await visibleLines();
		await filter.fill('1 changed file,2 changed files');
		await expect.poll(visibleLines).toEqual(['1 changed file', '2 changed files']);
		await filter.fill('changed,!2 changed files');
		await expect.poll(visibleLines).toEqual(['1 changed file']);
		await filter.fill('1 changed file !2 changed files');
		await expect(output.locator('.view-lines')).toHaveCount(0);
		await filter.fill('"1 changed file"');
		await expect(output.locator('.view-lines')).toHaveCount(0);
		await filter.fill('1 changed file,!2 changed files');
		await expect.poll(visibleLines).toEqual(['1 changed file']);
		expect(await filter.getAttribute('title')).toBeNull();
		expect(await filter.getAttribute('aria-description')).toBeNull();
		await workbench.quickaccess.runCommand('workbench.action.output.openInEditor');
		const editor = workbench.editors.groupAt(0).content;
		const rawLines = async (): Promise<string[]> => (await editor.locator('.view-line').allTextContents()).map(line => line.replaceAll('\u00a0', ' ')).filter(Boolean);
		await expect.poll(rawLines).toEqual(retainedLines);
		await filter.fill('absent');
		await expect(output.locator('.view-lines')).toHaveCount(0);
		await expect.poll(rawLines).toEqual(retainedLines);
		await workbench.quickaccess.runCommand('workbench.action.output.clear');
		await expect.poll(visibleLines).toEqual([]);
		await expect.poll(rawLines).toEqual([]);
		await writeFile(join(testWorkspace.directory, 'output-after-clear.ts'), 'export const afterClear = 1;\n');
		await expect(changes.locator('.ash-scm-change')).toHaveCount(3);
		await refreshAndShow();
		await filter.fill('3 changed files');
		await expect.poll(visibleLines).toEqual(['3 changed files']);
		await expect.poll(rawLines).toEqual(['3 changed files']);
		const status = await execute('git', ['status', '--porcelain=v2', '--untracked-files=all'], { cwd: testWorkspace.directory });
		expect(status.stdout.trim().split('\n')).toHaveLength(3);
		expect(status.stdout).toContain('main.ts');
		expect(status.stdout).toContain('? output-added.ts');
		expect(status.stdout).toContain('? output-after-clear.ts');
		await testInfo.attach('git-output-status', { body: JSON.stringify({ producer: 'Git', kind: 'output', retainedLines, afterClear: await rawLines(), repositoryStatus: status.stdout, arbitraryChunks: 'component tests only' }), contentType: 'application/json' });
	});
});

for (const locale of ['en', 'zh-CN']) {
	test(`Output saved query restoration exits on explicit input and protects newer stored versions across reloads (${locale})`, async ({ target, workbench, reloadWorkbench, restartWorkbench }, testInfo) => {
		test.skip(target.kind !== 'browser' || target.appServerMode !== 'required', 'Covers the connected Web client workspace storage.');
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ workbench } = await restartWorkbench());
		}
		const page = workbench.page;
		const labels = locale === 'zh-CN' ? {
			filter: '筛选输出', placeholder: '筛选输出（文本1,文本2,!排除文本）',
			restored: '已恢复保存的筛选条件。编辑或清空后使用逗号分隔的筛选语法。',
			unsupported: '已保留由较新版本保存的筛选条件。本窗口中的修改不会保存。',
			controls: '使用逗号分隔任选匹配的文本，以 ! 开头可排除文本。空格和 - 按字面匹配。',
		} : {
			filter: 'Filter Output', placeholder: 'Filter Output (text1,text2,!exclude)',
			restored: 'Saved filter restored. Edit or clear to use comma-separated filters.',
			unsupported: 'A newer saved filter is preserved. Changes in this window are not saved.',
			controls: 'Separate alternative text filters with commas and prefix exclusions with !. Spaces and - are literal.',
		};
		const selectChannel = async (): Promise<void> => {
			await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
			await workbench.quickaccess.select('App Server');
		};
		const output = page.locator('[data-view-id="ash.output"]');
		const filter = output.getByRole('searchbox', { name: labels.filter, exact: true });
		await page.addInitScript(() => {
			const seed = sessionStorage.getItem('ash.test.output.seed');
			if (seed === null) { return; }
			sessionStorage.removeItem('ash.test.output.seed');
			const documents = Object.keys(localStorage).filter(key => key.startsWith('ash.storage.workspace.')).map(key => ({
				key, document: JSON.parse(localStorage.getItem(key)!) as { entries: Record<string, { value: string; target: string; }>; },
			})).filter(item => item.document.entries['output.filterState']);
			if (documents.length !== 1) { throw new Error('Expected one isolated Output filter workspace document'); }
			const { key, document } = documents[0]!;
			document.entries['output.filterState']!.value = seed;
			localStorage.setItem(key, JSON.stringify(document));
		});
		const persistedFilter = async (value?: string): Promise<string> => page.evaluate(value => {
			// Seed after the current window's shutdown saves, before the next window
			// loads storage. Only isolated saved data changes; Output is never injected.
			const documents = Object.keys(localStorage).filter(key => key.startsWith('ash.storage.workspace.')).map(key => ({
				key, document: JSON.parse(localStorage.getItem(key)!) as { entries: Record<string, { value: string; target: string; }>; },
			})).filter(item => item.document.entries['output.filterState']);
			if (documents.length !== 1) { throw new Error('Expected one isolated Output filter workspace document'); }
			const { document } = documents[0]!;
			const entry = document.entries['output.filterState']!;
			if (value !== undefined) {
				sessionStorage.setItem('ash.test.output.seed', value);
			}
			return entry.value;
		}, value);
		await selectChannel();
		await expect(filter).toHaveAttribute('placeholder', labels.placeholder);
		await filter.fill('connection');
		await expect(output.locator('.view-lines')).toContainText('connection');
		const restored = JSON.stringify({ text: 'connection !crashed', hiddenSeverities: [], hiddenCategories: [] });
		await persistedFilter(restored);
		await reloadWorkbench();
		await selectChannel();
		await expect(filter).toHaveValue('connection !crashed');
		await expect(filter).toHaveAttribute('title', labels.restored);
		await expect(filter).toHaveAttribute('aria-description', labels.restored);
		await expect(output.locator('.view-lines')).toContainText('connection');
		expect(await persistedFilter()).toBe(restored);
		await output.locator('.stanza-editor-input').focus();
		await page.keyboard.press('Alt+F1');
		const help = page.locator('.ash-accessible-view-content');
		await expect.poll(() => help.inputValue()).toContain(labels.controls);
		await expect.poll(() => help.inputValue()).toContain(labels.restored);
		await page.keyboard.press('Escape');
		await expect(output.locator('.stanza-editor-input')).toBeFocused();
		await filter.fill('connection !crashed');
		await expect(output.locator('.view-lines')).toHaveCount(0);
		expect(await filter.getAttribute('title')).toBeNull();
		expect(JSON.parse(await persistedFilter())).toEqual({ syntaxVersion: 2, text: 'connection !crashed', hiddenSeverities: [], hiddenCategories: [] });
		await reloadWorkbench();
		await selectChannel();
		await expect(filter).toHaveValue('connection !crashed');
		await expect(output.locator('.view-lines')).toHaveCount(0);
		expect(await filter.getAttribute('aria-description')).toBeNull();
		await filter.press('Escape');
		await expect(filter).toHaveValue('');
		await expect(output.locator('.view-lines')).toContainText('connection');
		const future = JSON.stringify({ syntaxVersion: 3, text: 'future query', future: { untouched: true } });
		await persistedFilter(future);
		await reloadWorkbench();
		await selectChannel();
		await expect(filter).toHaveValue('');
		await expect(filter).toHaveAttribute('title', labels.unsupported);
		await filter.fill('connection');
		await expect(output.locator('.view-lines')).toContainText('connection');
		expect(await persistedFilter()).toBe(future);
		await output.locator('.stanza-editor-input').focus();
		await page.keyboard.press('Alt+F1');
		await expect.poll(() => help.inputValue()).toContain(labels.unsupported);
		await page.keyboard.press('Escape');
		await testInfo.attach('saved-query-compatibility', { body: JSON.stringify({ locale, restored, current: { syntaxVersion: 2, text: 'connection !crashed' }, preservedFuture: await persistedFilter() }), contentType: 'application/json' });
	});
}

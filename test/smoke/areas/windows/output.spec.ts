import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import type { ElectronApplication } from '@playwright/test';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';

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

test.describe('Git-backed Output smart scrolling', () => {
	test.use({ gitRepository: true });

	for (const locale of ['en', 'zh-CN']) {
		test(`Output smart scrolling preserves reading position and live configuration (${locale})`, async ({ target, application, testWorkspace, workbench, restartWorkbench }, testInfo) => {
			test.skip(target.appServerMode !== 'required', 'Requires the real Git backend and its isolated test profile.');
			test.setTimeout(90_000);
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
				await language.fill('简体中文');
				await language.press('Enter');
				({ workbench, application } = await restartWorkbench());
			}
			const page = workbench.page;
			const labels = locale === 'zh-CN' ? {
				scroll: '自动滚动', title: '输出智能滚动',
				description: '主光标移到较早的行时暂停自动滚动，移到最后一行时恢复。设置变更从下一次光标移动起生效。',
				help: '启用 output.smartScroll.enabled 时，主光标移到较早的行会暂停自动滚动，移到最后一行会恢复。设置变更从下一次光标移动起生效。',
			} : {
				scroll: 'Auto Scroll', title: 'Output smart scrolling',
				description: 'Pause Auto Scroll when the primary cursor moves to an earlier line, and resume at the last line. Changes apply to the next cursor movement.',
				help: 'With output.smartScroll.enabled, moving the primary cursor to an earlier line pauses Auto Scroll; moving it to the last line resumes it. Changing the setting affects the next cursor movement.',
			};
			const output = page.locator('[data-view-id="ash.output"]');
			const input = output.locator('.stanza-editor-input');
			const scroll = output.locator('.stanza-editor > .ash-smooth-scrollable');
			const autoScroll = page.locator('.ash-output-title-actions').getByRole('button', { name: labels.scroll, exact: true });
			if (target.kind === 'browser') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
			const readClipboard = (): Promise<string> => target.kind === 'electron'
				? (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
				: page.evaluate(() => navigator.clipboard.readText());
			const previousClipboard = await readClipboard();
			const rawText = async (expected: string): Promise<string> => {
				// Copy through the separate resource editor so observing raw text does not move the Output caret.
				await workbench.quickaccess.runCommand('workbench.action.output.openInEditor');
				const editor = workbench.editors.groupAt(0).editor;
				await editor.waitForEditorFocus();
				await editor.input.press('ControlOrMeta+a');
				await editor.input.press('ControlOrMeta+c');
				await expect.poll(readClipboard).toContain(expected);
				return readClipboard();
			};
			const appendStatus = async (count: number): Promise<void> => {
				await writeFile(join(testWorkspace.directory, `output-scroll-${count}.ts`), `export const value = ${count};\n`);
				await workbench.quickaccess.runCommand('git.refresh');
				await expect(page.locator('[data-view-id="ash.gitView"] .ash-scm-change')).toHaveCount(count);
			};
			const changeSmartScrolling = async (enabled: boolean): Promise<void> => {
				await workbench.settingsEditor.openUserSettingsUI();
				const settings = workbench.settingsEditor.element;
				await settings.getByRole('searchbox').fill('@id:output.smartScroll.enabled');
				const row = settings.locator('[data-settings-item-id="output.smartScroll.enabled"]');
				await expect(row).toContainText(labels.description);
				const control = row.getByRole('switch', { name: labels.title, exact: true });
				await expect(control).toBeChecked({ checked: !enabled });
				// The switch input is visually clipped; use its normal keyboard interaction.
				await control.press('Space');
				await expect(control).toBeEnabled();
				await expect(control).toBeChecked({ checked: enabled });
				await settings.locator('.ash-modal-editor-close').click();
				await workbench.quickaccess.runCommand('git.showOutput');
			};
			try {
				await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
				await workbench.quickaccess.select('App Server');
				const otherBefore = await rawText('App Server connection');
				await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
				await workbench.quickaccess.runCommand('git.showOutput');
				await workbench.quickaccess.runCommand('workbench.action.output.clear');
				for (let count = 1; count <= 3; count++) await appendStatus(count);
				await expect(output.locator('.view-lines')).toContainText('3 changed files');
				const beforeRaw = await rawText('3 changed files');
				await workbench.quickaccess.runCommand('git.showOutput');
				await input.press('ControlOrMeta+End');
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
				const beforeScroll = await scroll.evaluate(element => element.scrollTop);
				await input.press('ArrowUp');
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
				expect(await scroll.evaluate(element => element.scrollTop)).toBe(beforeScroll);
				await input.press('ControlOrMeta+c');
				await expect.poll(readClipboard).toBe('3 changed files\n');
				await appendStatus(4);
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
				expect(await scroll.evaluate(element => element.scrollTop)).toBe(beforeScroll);
				const afterRaw = await rawText('4 changed files');
				expect(afterRaw).toBe(`${beforeRaw}4 changed files\n`);
				await workbench.quickaccess.runCommand('git.showOutput');
				await input.press('ControlOrMeta+End');
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
				await input.press('Alt+F1');
				await expect.poll(() => page.locator('.ash-accessible-view-content').inputValue()).toContain(labels.help);
				await page.keyboard.press('Escape');
				for (let count = 5; count <= 20; count++) await appendStatus(count);
				await expect(output.locator('.view-lines')).toContainText('20 changed files');
				await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
				const readViewport = () => scroll.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight, focused: element.querySelector('.stanza-editor-input') === element.ownerDocument.activeElement }));
				const quickInputBefore = await readViewport();
				await expect(input).toBeFocused();
				await workbench.quickaccess.open();
				await workbench.quickaccess.close();
				await expect(input).toBeFocused();
				const quickInputEscape = await readViewport();
				expect(quickInputEscape).toEqual(quickInputBefore);
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
				// Showing the already visible Output pane focuses it without appending or revealing a line.
				await workbench.quickaccess.runCommand('workbench.action.output.show');
				await expect(input).toBeFocused();
				const quickInputAccept = await readViewport();
				expect(quickInputAccept).toEqual(quickInputBefore);
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
				await changeSmartScrolling(false);
				await input.press('ControlOrMeta+End');
				await input.press('ArrowUp');
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
				await output.locator('.stanza-editor').hover();
				await page.mouse.wheel(0, -160);
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
				const readingScroll = await scroll.evaluate(element => element.scrollTop);
				await appendStatus(21);
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
				expect(await scroll.evaluate(element => element.scrollTop)).toBe(readingScroll);
				const finalRaw = await rawText('21 changed files');
				expect(finalRaw.startsWith(afterRaw)).toBe(true);
				await workbench.quickaccess.runCommand('git.showOutput');
				await output.locator('.stanza-editor').hover();
				await page.mouse.wheel(0, 10_000);
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
				await changeSmartScrolling(true);
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
				await input.press('ControlOrMeta+End');
				await input.press('ArrowUp');
				await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
				await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
				await workbench.quickaccess.select('App Server');
				const otherAfter = await rawText('App Server connection');
				expect(otherAfter).toBe(otherBefore);
				const status = await execute('git', ['status', '--porcelain=v2', '--untracked-files=all'], { cwd: testWorkspace.directory });
				expect(status.stdout.trim().split('\n')).toHaveLength(21);
				await testInfo.attach('output-smart-scroll', { body: JSON.stringify({ locale, beforeScroll, readingScroll, beforeRaw, afterRaw, finalRaw, otherBefore, otherAfter, quickInput: { before: quickInputBefore, escape: quickInputEscape, accept: quickInputAccept }, repositoryStatus: status.stdout }), contentType: 'application/json' });
			} finally {
				if (target.kind === 'electron') {
					await (application as ElectronApplication).evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
				} else {
					await page.evaluate(text => navigator.clipboard.writeText(text), previousClipboard);
				}
			}
		});
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`Output category choices isolate real Window and Extension Host logs and migrate legacy choices (${locale})`, async ({ target, application, workbench, reloadWorkbench, restartWorkbench }, testInfo) => {
		test.skip(target.appServerMode !== 'required', 'Requires the real Extension Host fleet response and its isolated product profile.');
		// Locale restart and three persisted-state reloads each use the real backend.
		test.setTimeout(90_000);
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ workbench, application } = await restartWorkbench());
		}
		let page = workbench.page;
		const labels = locale === 'zh-CN' ? { filter: '筛选输出', reset: '重置筛选', unsupported: '已保留由较新版本保存的筛选条件。本窗口中的修改不会保存。', categoryHelp: '类别选项作用于所选通道。旧版保存的类别选项仍作用于所有通道，直到逐项更改；每次只将该类别迁移到所选通道。重置筛选会清除所有通道的类别选项。' } : { filter: 'Filter Output', reset: 'Reset Filters', unsupported: 'A newer saved filter is preserved. Changes in this window are not saved.', categoryHelp: 'Category choices apply to the selected channel. Older saved category choices apply to all channels until you change each category; only that category moves to the selected channel. Reset Filters clears category choices for all channels.' };
		const output = () => page.locator('[data-view-id="ash.output"]');
		const lines = async (): Promise<string[]> => (await output().locator('.view-line').allTextContents()).map(line => line.replaceAll('\u00a0', ' ')).filter(Boolean);
		const select = async (channel: string): Promise<void> => {
			await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
			await workbench.quickaccess.select(channel);
			await expect(page.locator('.ash-output-title-actions')).toContainText(channel);
		};
		const readWindowStart = async (): Promise<void> => {
			// Only a channel with visible content owns an editor input. Read its
			// startup logs above the virtualized tail once lifecycle is visible.
			await output().locator('.stanza-editor-input').focus();
			await page.keyboard.press('ControlOrMeta+Home');
		};
		const openFilters = (): Promise<void> => page.locator('.ash-output-title-actions').getByRole('button', { name: labels.filter, exact: true }).click();
		const category = async (name: string, checked: boolean, change: boolean): Promise<void> => {
			// The existing menu driver observes and dispatches through Browser or Main
			// according to the product's menu setting; Output and IPC remain real.
			const items = await workbench.menus.inspect(application, openFilters);
			expect(items.find(item => item.label === name)).toMatchObject({ label: name, enabled: true, checked });
			if (change) { await workbench.menus.select(application, openFilters, [name]); }
		};
		const reset = (): Promise<void> => workbench.menus.select(application, openFilters, [labels.reset]);
		const reloadSeededOwner = async (): Promise<void> => {
			// The Electron saved-data fixture belongs to Main's next storage read;
			// reload the renderer owner without replacing Main before it consumes it.
			if (target.kind === 'electron') {
				await workbench.reloadWindow();
				await workbench.waitForReady();
			} else {
				({ workbench, application } = await reloadWorkbench());
			}
			page = workbench.page;
		};
		const workspaceId = target.kind === 'browser' ? await page.evaluate(() => {
			const host = (globalThis as unknown as { ashWebWorkbenchHost: { workspace: { id: string; }; }; }).ashWebWorkbenchHost;
			return host.workspace.id;
		}) : await page.evaluate(async () => {
			const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ id: string; }>; }; }; }).ash;
			return (await bridge.ipcRenderer.invoke('ash:workspace:context:read')).id;
		});
		const identity = { scope: StorageScope.WORKSPACE, id: workspaceId };
		const savedFilter = async (): Promise<string | undefined> => (await readStorageEntries(application, page, identity))['output.filterState']?.value;
		await select('Extension Host');
		// Ready is published only after the existing fleet reconcile/list response
		// reaches the production owner. No producer or transport is replaced.
		await expect.poll(lines).toContain('Extension Host fleet is ready.');
		const hostBaseline = await lines();
		const input = output().locator('.stanza-editor-input');
		await input.focus();
		await page.keyboard.press('Alt+F1');
		await expect.poll(() => page.locator('.ash-accessible-view-content').inputValue()).toContain(labels.categoryHelp);
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await select('Window');
		await readWindowStart();
		await expect.poll(lines).toContain('Workbench restored');
		await workbench.quickaccess.runCommand('workbench.action.output.openInEditor');
		const rawEditor = workbench.editors.groupAt(0).content;
		const rawLines = async (): Promise<string[]> => (await rawEditor.locator('.view-line').allTextContents()).map(line => line.replaceAll('\u00a0', ' ')).filter(Boolean);
		const rawWindow = await rawLines();
		expect(rawWindow).toContain('Workbench restored');
		await category('lifecycle', true, true);
		await expect.poll(lines).not.toContain('Workbench restored');
		// Window keeps appending focus traces; filtering must retain the original prefix.
		await expect.poll(async () => (await rawLines()).slice(0, rawWindow.length)).toEqual(rawWindow);
		await select('Extension Host');
		await expect.poll(lines).toEqual(hostBaseline);
		await category('lifecycle', true, true);
		await expect.poll(lines).not.toContain('Extension Host fleet is ready.');
		await select('Window');
		await category('lifecycle', false, false);
		await expect.poll(lines).not.toContain('Workbench restored');
		await reset();
		await readWindowStart();
		await expect.poll(lines).toContain('Workbench restored');
		const legacy = JSON.stringify({ syntaxVersion: 2, text: '', hiddenSeverities: [], hiddenCategories: ['lifecycle', 'connection'] });
		// Existing storage fixtures seed only saved data before the next owner loads.
		await seedStorageOnNextLoad(application, page, identity, { 'output.filterState': { value: legacy, target: StorageTarget.MACHINE } });
		await reloadSeededOwner();
		await select('Window');
		await expect.poll(lines).not.toContain('Workbench restored');
		await category('lifecycle', false, false);
		await select('Extension Host');
		await expect.poll(lines).not.toContain('Extension Host fleet is ready.');
		await select('App Server');
		await expect(output().locator('.view-lines')).toHaveCount(0);
		expect(await savedFilter()).toBe(legacy);
		await select('Window');
		await category('lifecycle', false, true);
		await readWindowStart();
		await expect.poll(lines).toContain('Workbench restored');
		await select('Extension Host');
		await expect.poll(lines).toContain('Extension Host fleet is ready.');
		await category('lifecycle', true, false);
		await select('App Server');
		await expect(output().locator('.view-lines')).toHaveCount(0);
		await category('connection', false, false);
		await expect.poll(async () => {
			const raw = await savedFilter();
			return raw === undefined ? undefined : JSON.parse(raw).hiddenCategories;
		}).toEqual(['connection']);
		const migrated = await savedFilter();
		({ workbench, application } = await reloadWorkbench());
		page = workbench.page;
		await select('Extension Host');
		await expect.poll(lines).toContain('Extension Host fleet is ready.');
		await select('App Server');
		await expect(output().locator('.view-lines')).toHaveCount(0);
		await reset();
		await expect(output().locator('.view-lines')).toContainText('connection');
		const future = JSON.stringify({ syntaxVersion: 3, text: 'future', hiddenCategories: ['lifecycle'], future: { retained: true } });
		await seedStorageOnNextLoad(application, page, identity, { 'output.filterState': { value: future, target: StorageTarget.MACHINE } });
		await reloadSeededOwner();
		await select('Window');
		await expect(output().getByRole('searchbox', { name: labels.filter, exact: true })).toHaveAttribute('title', labels.unsupported);
		await category('lifecycle', true, true);
		await expect.poll(lines).not.toContain('Workbench restored');
		await select('Extension Host');
		await expect.poll(lines).toContain('Extension Host fleet is ready.');
		expect(await savedFilter()).toBe(future);
		await reset();
		await expect.poll(lines).toContain('Extension Host fleet is ready.');
		expect(await savedFilter()).toBe(future);
		await testInfo.attach(`output-channel-categories-${locale}`, { body: JSON.stringify({ backend: 'real extensionHost/reconcile or list', hostBaseline, rawWindow, legacy, migrated, untouchedFuture: await savedFilter(), identity: 'channel and category JSON tuple', finalHost: await lines() }), contentType: 'application/json' });
	});
}

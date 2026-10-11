import { expect, test } from '../../../automation/test.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

test.use({ openWorkspace: false });

test('display language startup recovers from missing and damaged Ash packs and restores the saved base language', async ({ target, application, workbench, restartWorkbench, restartMessage }) => {
	const catalog = JSON.parse(await readFile(resolve('localization/examples/fr/localization/package.json'), 'utf8'));
	for (const state of ['missing', 'damaged', 'restored'] as const) {
		// Request a real host restart, then inject the selected resource's persistence failure.
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
		await picker.getByRole('combobox').fill('简体中文');
		await picker.getByRole('combobox').press('Enter');
		await expect.poll(restartMessage).toBe('Restart Ash to use 简体中文?');
		if (target.kind === 'electron' && 'windows' in application) {
			const profile = await application.evaluate(() => process.env.ASH_HOME!);
			if (state !== 'missing') {
				await mkdir(join(profile, 'languagepacks'), { recursive: true });
				await writeFile(join(profile, 'languagepacks/fr.json'), state === 'damaged' ? '{invalid JSON' : JSON.stringify(catalog));
			}
			await workbench.page.evaluate(async () => {
				const snapshot = await globalThis.ashTestMainProcess.call('configuration', 'read') as { revision: number; document: { version: 1; source: string; }; };
				const settings = { ...JSON.parse(snapshot.document.source), 'workbench.locale': 'fr-CA' };
				await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
			});
		} else {
			await workbench.page.evaluate(async ({ catalog, state }) => {
				const configuration = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('ash-configuration');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						const transaction = configuration.transaction('resources', 'readwrite');
						const store = transaction.objectStore('resources');
						const request = store.get('settings.json');
						request.onsuccess = () => {
							const current = request.result;
							const settings = { ...JSON.parse(current.document.source), 'workbench.locale': 'fr-CA' };
							store.put({ ...current, revision: current.revision + 1, document: { version: 1, source: JSON.stringify(settings) } });
						};
						transaction.oncomplete = () => resolve();
						transaction.onerror = () => reject(transaction.error);
					});
				} finally { configuration.close(); }
				if (state === 'missing') { return; }
				const resources = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('ash-language-packs', 1);
					request.onupgradeneeded = () => request.result.createObjectStore('catalogs', { keyPath: 'locale' });
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						const transaction = resources.transaction('catalogs', 'readwrite');
						transaction.objectStore('catalogs').put(state === 'damaged' ? { ...catalog, catalogVersion: 'incompatible' } : catalog);
						transaction.oncomplete = () => resolve();
						transaction.onerror = () => reject(transaction.error);
					});
				} finally { resources.close(); }
			}, { catalog, state });
		}
		({ application, workbench } = await restartWorkbench());
		const searchLabel = state === 'restored' ? 'Rechercher des commandes' : 'Search commands';
		await expect(workbench.page.getByRole('button', { name: searchLabel, exact: true })).toBeVisible();
		await expect(workbench.page.getByRole('button', { name: 'Manage', exact: true })).toBeVisible();
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = workbench.settingsEditor.element;
		await settings.locator('[data-settings-category-id="general"]').click();
		const languageLabel = state === 'restored' ? 'Langue de l’interface' : 'Interface language';
		await expect(settings.getByRole('combobox', { name: languageLabel, exact: true })).toHaveText('fr-CA');
		await settings.locator('.ash-modal-editor-close').click();
	}
});

test('display language stays unchanged until restart and initializes Chinese command titles', async ({ target, workbench, restartWorkbench, deferRestart, restartMessage }) => {
	let page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	let settings = page.locator('.ash-settings-editor');
	await settings.locator('[data-settings-category-id="general"]').click();
	const language = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox', { name: 'Interface language', exact: true });
	await language.focus();
	await language.press('Enter');
	await expect(page.getByRole('option')).toHaveText(['English', '简体中文']);
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect.poll(restartMessage).toBe('Restart Ash to use 简体中文?');
	await expect(settings.getByRole('heading', { name: 'Display Language', exact: true })).toBeVisible();
	await expect(language).toHaveText('简体中文');
	await deferRestart();
	await expect(language).toBeFocused();
	await expect(language).toBeEnabled();
	await expect(settings).toContainText('Choose the language used by the Ash interface.');
	await page.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	await expect(page.getByRole('button', { name: '搜索命令', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: '管理', exact: true })).toBeVisible();
	await page.getByRole('tab', { name: /^源代码管理(?:,|$)/u }).click();
	const scmWelcome = page.locator('[data-view-id="ash.gitView"]').getByRole('region', { name: '欢迎', exact: true });
	// A connected Web session opens the backend workspace; desktop and UI-only hosts can start empty.
	if (target.kind === 'browser' && target.appServerMode === 'required') {
		await expect(scmWelcome).toContainText('打开的文件夹中没有 Git 仓库。初始化仓库以开始跟踪更改。');
		await expect(scmWelcome.getByRole('button', { name: '初始化仓库', exact: true })).toBeVisible();
	} else {
		await expect(scmWelcome).toContainText('打开包含 Git 仓库的文件夹');
		await expect(scmWelcome.getByRole('button', { name: '打开文件夹', exact: true })).toBeVisible();
	}
	if (target.kind === 'electron') await expect(scmWelcome.getByRole('button', { name: '克隆仓库', exact: true })).toBeVisible();
	if (target.appServerMode === 'required') {
		await workbench.quickaccess.runCommand('ash.call.open');
		const call = page.locator('.ash-call').getByRole('combobox', { name: 'Call', exact: true });
		await call.focus();
		await call.press('Alt+F1');
		const help = page.getByRole('dialog', { name: '无障碍帮助', exact: true });
		await expect(help.getByRole('textbox')).toHaveValue(/麦克风/u);
		await page.keyboard.press('Escape');
		await expect(call).toBeFocused();
	}
	await page.keyboard.press('F1');
	const commands = page.locator('.ash-quick-pick');
	await workbench.quickaccess.search('>创建分支');
	await expect(commands.getByRole('option').filter({ hasText: 'git.branch' }).locator('.ash-quick-pick-row-label')).toHaveText('创建分支…');
	await workbench.quickaccess.search('>Preferences: Change Keyboard Layout');
	await expect(commands.locator('.ash-quick-pick-row-label', { hasText: '首选项：更改键盘布局' })).toBeVisible();
	await commands.getByRole('combobox').press('Enter');
	const layouts = page.getByRole('dialog', { name: '选择键盘布局' });
	await expect(layouts).toBeVisible();
	await expect(layouts.locator('.ash-quick-pick-row-label', { hasText: '自动检测' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+,');
	settings = page.getByRole('dialog', { name: 'Ash 设置' });
	await settings.locator('[data-settings-category-id="general"]').click();
	const chinese = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox', { name: '界面语言', exact: true });
	await expect(chinese).toHaveText('简体中文');
	const search = settings.getByRole('searchbox');
	for (const query of ['language', 'locale', '语言']) {
		await search.fill(query);
		await expect(chinese).toBeVisible();
	}
	await page.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.clearLocalePreference');
	await expect.poll(restartMessage).toBe('重启 Ash 以使用English？');
	({ workbench } = await restartWorkbench());
	await workbench.page.keyboard.press('ControlOrMeta+,');
	await expect(workbench.page.getByRole('dialog', { name: 'Ash Settings' })).toBeVisible();
});

test('command palette saves and clears a pending display language without changing current commands', async ({ workbench, deferRestart }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	await deferRestart();
	await workbench.quickaccess.runCommand('workbench.action.clearLocalePreference');
	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.locator('[data-settings-category-id="general"]').click();
	await expect(settings.getByRole('combobox', { name: 'Interface language', exact: true })).toHaveText('English');
});

test('display language picker opens Extensions with language packs selected', async ({ workbench }) => {
	const page = workbench.page;
	await expect(page.getByRole('button', { name: 'Search commands', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Manage', exact: true })).toBeVisible();
	await page.keyboard.press('F1');
	let picker = page.locator('.ash-quick-pick');
	await workbench.quickaccess.search('>Configure Display Language');
	await picker.getByRole('combobox').press('Enter');

	picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('Install more languages from Extensions');
	await picker.getByRole('combobox').press('Enter');
	await expect(picker).toHaveCount(0);
	await expect(page.locator('.ash-extensions').getByRole('button', { name: 'Language packs', exact: true })).toBeVisible();
});


test('Chinese sidebar context menu localizes registered layout commands', async ({ workbench, application, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench, application } = await restartWorkbench());
	const page = workbench.page;
	await page.getByRole('tab', { name: /^源代码管理(?:,|$)/u }).click();
	const sidebar = page.locator('[data-part="sidebar"]');
	const openSidebarMenu = () => sidebar.locator('.ash-workbench-part-title').click({ button: 'right' });
	const sidebarMenu = await workbench.menus.inspect(application, openSidebarMenu);
	expect(sidebarMenu).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: '更改', checked: true, enabled: false }),
		expect.objectContaining({ label: '将主侧栏移到右侧', enabled: true }),
		expect.objectContaining({ label: '活动栏位置', enabled: true }),
		expect.objectContaining({ label: '活动栏大小', enabled: true }),
	]));
	await workbench.menus.select(application, openSidebarMenu, ['活动栏位置', '顶部']);
	await expect(sidebar.locator('.ash-sidebar-composite-bar-top .ash-composite-bar')).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.default');
	await expect(page.locator('[data-part="activitybar"]')).toBeVisible();

});

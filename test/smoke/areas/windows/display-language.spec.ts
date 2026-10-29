import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';

test.use({ openWorkspace: false });

test(
	'browser reload resolves saved Chinese translations according to the development mode',
	{ tag: ['@browser-ui'] },
	async ({ workbench, reloadWorkbench }) => {
		const catalog = JSON.parse(
			await readFile(
				resolve('.build/desktop/localization/extensions/ash.language-pack-zh-cn/localization/package.json'),
				'utf8',
			),
		);
		catalog.bundles['ash.settings']['categories.editor-fonts.label'] = '旧字体标题';
		const current = await readUserSettings(workbench.page);
		await writeUserSettings(
			workbench.page,
			JSON.stringify({ ...JSON.parse(current.content), 'workbench.locale': 'zh-CN' }),
			current.revision,
		);
		await workbench.page.evaluate(async catalog => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('ash-language-packs', 1);
				request.onupgradeneeded = () => request.result.createObjectStore('catalogs', { keyPath: 'locale' });
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = database.transaction('catalogs', 'readwrite');
					transaction.objectStore('catalogs').put(catalog);
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				});
			} finally {
				database.close();
			}
		}, catalog);
		({ workbench } = await reloadWorkbench());
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectEditorCategory('editor-fonts');
		const expected = process.env.ASH_PLAYWRIGHT_SERVER === 'development' ? '字体' : '旧字体标题';
		await expect(workbench.settingsEditor.element.locator('.ash-settings-page h3')).toHaveText(expected);
		await expect(workbench.settingsEditor.element.locator('[data-settings-category-id="editor-fonts"]')).toHaveText(
			expected,
		);
	},
);

test.describe('signed language pack installation', () => {
	test.use({
		backendFixture: async ({ testWorkspace }, use, testInfo) => {
			const registry = await SignedExtensionRegistry.createLanguagePack(
				resolve(testWorkspace.directory, 'language-pack-registry'),
			);
			try {
				await use(registry);
			} finally {
				try {
					await testInfo.attach('https-extension-source-requests', {
						body: JSON.stringify(registry.requests, undefined, 2),
						contentType: 'application/json',
					});
				} finally {
					await registry.close();
				}
			}
		},
	});

	test(
		'Chinese language pack downloads over HTTPS, really installs, independently updates and restores the preinstalled version on uninstall',
		{ tag: ['@electron-app-server'] },
		async ({ target, backendFixture, application, workbench, restartWorkbench, reloadWorkbench }) => {
			test.setTimeout(90_000);
			const registry = backendFixture as SignedExtensionRegistry;
			if ('windows' in application) {
				expect(await application.evaluate(() => process.env.ASH_PRODUCT_SERVICES_PATH)).toBe(
					registry.productServicesPath,
				);
			}
			const [installedRelease, updatedRelease] = registry.releases;
			const bundled = JSON.parse(
				await readFile(
					resolve('.build/desktop/localization/extensions/ash.language-pack-zh-cn/localization/package.json'),
					'utf8',
				),
			);
			const packagedManifest = await readFile(
				resolve('.build/desktop/localization/extensions/ash.language-pack-zh-cn/manifest.json'),
				'utf8',
			);
			expect(JSON.parse(packagedManifest).version).not.toBe(installedRelease.version);
			expect(JSON.parse(packagedManifest).version).not.toBe(updatedRelease.version);
			await expect.poll(() => registry.installations()).toEqual([]);
			await expect(registry.installedCatalog(installedRelease.version)).rejects.toThrow(/ENOENT/u);
			await workbench.quickaccess.runCommand('ash.extensions.open');
			let view = workbench.page.locator('.ash-extensions');
			await view.getByRole('searchbox').fill('language-pack-zh-cn');
			await view.getByRole('searchbox').press('Enter');
			const row = view.locator(`[data-package-id="${registry.packageId}"]`);
			await expect(row).toContainText(installedRelease.version);
			expect(registry.requests).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: '/metadata/timestamp.json', release: 1, status: 200 }),
					expect.objectContaining({ path: '/metadata/publishers%2Fash.json', release: 1, status: 200 }),
				]),
			);
			expect(registry.requests.filter(request => request.path.endsWith('.zip'))).toEqual([]);
			const installReview = await workbench.dialogs.confirm(application, 'Install', 'Install', () =>
				row.getByRole('button', { name: 'Install', exact: true }).click(),
			);
			expect(installReview.message).toContain(installedRelease.version);
			expect(installReview.detail).toContain('localization: zh-CN');
			await expect
				.poll(() => registry.installations())
				.toMatchObject([
					{
						package: {
							id: registry.packageId,
							version: installedRelease.version,
							digest: installedRelease.digest,
						},
						state: 'installed',
					},
				]);
			expect(registry.requests).toContainEqual({
				path: `/targets/packages/ash/language-pack-zh-cn/${installedRelease.version}.zip`,
				release: 1,
				status: 200,
				bytes: installedRelease.archive.length,
			});
			const firstInstallation = (await registry.installations())[0].installationId;
			expect(
				(await registry.installations())[0].capabilities.map(capability => capability.descriptor.kind),
			).toEqual(['localization']);
			const firstCatalog = (await registry.installedCatalog(installedRelease.version)) as typeof bundled;
			expect(firstCatalog.bundles['ash.regions'].searchCommands).toBe('安装版搜索命令');
			await expect
				.poll(() => startupProvider(workbench))
				.toMatchObject({
					extensionId: registry.packageId,
					version: installedRelease.version,
					digest: installedRelease.digest,
				});
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page
				.getByRole('dialog', { name: 'Select Display Language', exact: true })
				.getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
			await expect(workbench.page.getByRole('button', { name: '安装版搜索命令', exact: true })).toBeVisible();
			await expect(workbench.page.getByRole('region', { name: 'Primary sidebar', exact: true })).toBeAttached();
			await expectBranchTitle(workbench, '安装版创建分支…');

			await registry.publishUpdate();
			// Restart refreshes the registry's signed catalog, while the installed version stays intact.
			({ application, workbench } = await reloadWorkbench());
			await expect(workbench.page.getByRole('button', { name: '安装版搜索命令', exact: true })).toBeVisible();
			await workbench.quickaccess.runCommand('ash.extensions.installed');
			view = workbench.page.locator('.ash-extensions');
			await view.locator(`[data-installation-id="${firstInstallation}"]`).click();
			let editor = workbench.page.locator('.ash-extension-editor');
			const updateReview = await workbench.dialogs.confirm(application, '更新', '更新', () =>
				editor.getByRole('button', { name: '更新', exact: true }).click(),
			);
			expect(updateReview.message).toContain(updatedRelease.version);
			await expect
				.poll(() => registry.installations())
				.toMatchObject([
					{
						package: {
							id: registry.packageId,
							version: updatedRelease.version,
							digest: updatedRelease.digest,
						},
						state: 'installed',
					},
				]);
			expect(registry.requests).toContainEqual({
				path: `/targets/packages/ash/language-pack-zh-cn/${updatedRelease.version}.zip`,
				release: 2,
				status: 200,
				bytes: updatedRelease.archive.length,
			});
			expect(registry.requests).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: '/metadata/timestamp.json', release: 2, status: 200 }),
				]),
			);
			const secondInstallation = (await registry.installations())[0].installationId;
			expect(secondInstallation).not.toBe(firstInstallation);
			const updatedCatalog = (await registry.installedCatalog(updatedRelease.version)) as typeof bundled;
			expect(updatedCatalog.bundles['ash.regions'].searchCommands).toBe('更新版搜索命令');
			await expect
				.poll(() => startupProvider(workbench))
				.toMatchObject({
					extensionId: registry.packageId,
					version: updatedRelease.version,
					digest: updatedRelease.digest,
				});
			await expect(workbench.page.getByRole('button', { name: '安装版搜索命令', exact: true })).toBeVisible();
			({ application, workbench } = await reloadWorkbench());
			await expect(workbench.page.getByRole('button', { name: '更新版搜索命令', exact: true })).toBeVisible();
			await expectBranchTitle(workbench, '更新版创建分支…');

			await workbench.quickaccess.runCommand('ash.extensions.installed');
			view = workbench.page.locator('.ash-extensions');
			await expect(view.locator(`[data-installation-id="${firstInstallation}"]`)).toHaveCount(0);
			await expect(view.locator(`[data-installation-id="${secondInstallation}"]`)).toContainText(
				updatedRelease.version,
			);
			await view.locator(`[data-installation-id="${secondInstallation}"]`).click();
			editor = workbench.page.locator('.ash-extension-editor');
			const uninstallReview = await workbench.dialogs.confirm(application, '卸载扩展', '卸载', () =>
				editor.getByRole('button', { name: '卸载', exact: true }).click(),
			);
			expect(uninstallReview.message).toContain(updatedRelease.version);
			await expect.poll(() => registry.installations()).toEqual([]);
			await expect.poll(() => startupProvider(workbench)).toBeUndefined();
			await expect(workbench.page.getByRole('button', { name: '更新版搜索命令', exact: true })).toBeVisible();
			({ workbench } = await reloadWorkbench());
			await expect(
				workbench.page.getByRole('button', {
					name: bundled.bundles['ash.regions'].searchCommands,
					exact: true,
				}),
			).toBeVisible();
			await expectBranchTitle(
				workbench,
				bundled.extensionTranslations['ash.git'].package['git.menu.createBranch'],
			);
			await expect(workbench.page.getByRole('region', { name: '主侧栏', exact: true })).toBeAttached();
			await workbench.quickaccess.runCommand('ash.extensions.installed');
			await expect(
				workbench.page.locator('.ash-extensions').locator(`[data-package-id="${registry.packageId}"]`),
			).toHaveCount(0);
			expect(
				await readFile(
					resolve('.build/desktop/localization/extensions/ash.language-pack-zh-cn/manifest.json'),
					'utf8',
				),
			).toBe(packagedManifest);
			expect(
				[
					...new Set(
						registry.requests
							.filter(request => request.path.endsWith('.zip') && request.status === 200)
							.map(request => request.path),
					),
				].sort(),
			).toEqual([
				`/targets/packages/ash/language-pack-zh-cn/${installedRelease.version}.zip`,
				`/targets/packages/ash/language-pack-zh-cn/${updatedRelease.version}.zip`,
			]);
			expect(registry.requests.filter(request => request.status === 500)).toEqual([]);
			await expect.poll(() => registry.installations()).toEqual([]);
		},
	);
});

async function startupProvider(
	workbench: import('../../../automation/workbench.js').Workbench,
): Promise<{ extensionId: string; version: string; digest: string } | undefined> {
	return workbench.page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('ash-language-packs', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise((resolve, reject) => {
				const request = database.transaction('catalogs').objectStore('catalogs').get('zh-CN');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			database.close();
		}
	});
}

async function expectBranchTitle(
	workbench: import('../../../automation/workbench.js').Workbench,
	title: string,
): Promise<void> {
	await workbench.quickaccess.open('>git.branch');
	await expect(
		workbench.page
			.locator('.ash-quick-pick')
			.getByRole('option')
			.filter({ hasText: 'git.branch' })
			.locator('.ash-quick-pick-row-label'),
	).toHaveText(`Git: ${title}`);
	await workbench.quickaccess.close();
}

test('display language startup recovers from missing and damaged Ash packs and restores the saved base language', async ({
	target,
	application,
	workbench,
	restartWorkbench,
	restartMessage,
}) => {
	const catalog = JSON.parse(await readFile(resolve('localization/examples/fr/localization/package.json'), 'utf8'));
	for (const state of ['missing', 'damaged', 'restored'] as const) {
		// Request a real host restart, then inject the selected resource's persistence failure.
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
		await picker.getByRole('combobox').fill('简体中文');
		await picker.getByRole('combobox').press('Enter');
		await expect.poll(restartMessage).toBe('Restart Ash to use 简体中文?');
		const currentSettings = await readUserSettings(workbench.page);
		const unsupportedLocaleSettings = { ...JSON.parse(currentSettings.content), 'workbench.locale': 'fr-CA' };
		await writeUserSettings(workbench.page, JSON.stringify(unsupportedLocaleSettings), currentSettings.revision);
		await workbench.page.evaluate(
			async ({ catalog, state }) => {
				const resources = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('ash-language-packs', 1);
					request.onupgradeneeded = () => request.result.createObjectStore('catalogs', { keyPath: 'locale' });
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						const transaction = resources.transaction('catalogs', 'readwrite');
						const store = transaction.objectStore('catalogs');
						if (state === 'missing') {
							store.delete('fr');
						} else {
							store.put({
								locale: 'fr',
								extensionId: 'example.language-fr',
								version: '1.0.0',
								digest: 'sha256:' + 'a'.repeat(64),
								catalog: state === 'damaged' ? { ...catalog, catalogVersion: 'incompatible' } : catalog,
							});
						}
						transaction.oncomplete = () => resolve();
						transaction.onerror = () => reject(transaction.error);
					});
				} finally {
					resources.close();
				}
			},
			{ catalog, state },
		);
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

test('display language stays unchanged until restart and initializes Chinese command titles', async ({
	target,
	workbench,
	restartWorkbench,
	deferRestart,
	restartMessage,
}) => {
	let page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	let settings = page.locator('.ash-settings-editor');
	await settings.locator('[data-settings-category-id="general"]').click();
	const language = settings
		.locator('[data-settings-item-id="workbench.locale"]')
		.getByRole('combobox', { name: 'Interface language', exact: true });
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
	if (target.kind === 'electron')
		await expect(scmWelcome.getByRole('button', { name: '克隆仓库', exact: true })).toBeVisible();
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
	await expect(
		commands.getByRole('option').filter({ hasText: 'git.branch' }).locator('.ash-quick-pick-row-label'),
	).toHaveText('Git: 创建分支…');
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
	const chinese = settings
		.locator('[data-settings-item-id="workbench.locale"]')
		.getByRole('combobox', { name: '界面语言', exact: true });
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

test(
	'cached updated language pack translates startup and retired providers restore bundled Chinese',
	{ tag: ['@browser-app-server', '@electron-app-server'] },
	async ({ target, workbench, restartWorkbench, reloadWorkbench }) => {
		const catalog = JSON.parse(
			await readFile(
				resolve('.build/desktop/localization/extensions/ash.language-pack-zh-cn/localization/package.json'),
				'utf8',
			),
		);
		catalog.bundles['ash.regions'].searchCommands = '新版搜索命令';
		catalog.extensionTranslations['ash.git'].package['git.menu.createBranch'] = '新版创建分支…';
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
		await picker.getByRole('combobox').fill('简体中文');
		await picker.getByRole('combobox').press('Enter');
		await workbench.page.evaluate(async catalog => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('ash-language-packs', 1);
				request.onupgradeneeded = () => request.result.createObjectStore('catalogs', { keyPath: 'locale' });
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = database.transaction('catalogs', 'readwrite');
					transaction
						.objectStore('catalogs')
						.put({
							locale: 'zh-CN',
							extensionId: 'ash.language-pack-zh-cn@official',
							version: '2.0.0',
							digest: 'sha256:' + 'a'.repeat(64),
							catalog,
						});
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
				});
			} finally {
				database.close();
			}
		}, catalog);
		({ workbench } = await restartWorkbench());
		await expect(workbench.page.getByRole('button', { name: '新版搜索命令', exact: true })).toBeVisible();
		await workbench.page.keyboard.press('F1');
		await workbench.quickaccess.search('>新版创建分支');
		await expect(
			workbench.page
				.locator('.ash-quick-pick')
				.getByRole('option')
				.filter({ hasText: 'git.branch' })
				.locator('.ash-quick-pick-row-label'),
		).toHaveText('Git: 新版创建分支…');
		await workbench.page.keyboard.press('Escape');
		// No installation owns this cached update. Reconciliation must retire it for the next startup.
		await expect
			.poll(() =>
				workbench.page.evaluate(async () => {
					const database = await new Promise<IDBDatabase>((resolve, reject) => {
						const request = indexedDB.open('ash-language-packs', 1);
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
					try {
						return await new Promise<boolean>((resolve, reject) => {
							const request = database.transaction('catalogs').objectStore('catalogs').get('zh-CN');
							request.onsuccess = () => resolve(request.result === undefined);
							request.onerror = () => reject(request.error);
						});
					} finally {
						database.close();
					}
				}),
			)
			.toBe(true);
		({ workbench } = await reloadWorkbench());
		await expect(workbench.page.getByRole('button', { name: '搜索命令', exact: true })).toBeVisible();
	},
);

test('command palette saves and clears a pending display language without changing current commands', async ({
	workbench,
	deferRestart,
}) => {
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
	await expect(
		page.locator('.ash-extensions').getByRole('button', { name: 'Language packs', exact: true }),
	).toBeVisible();
});

test('Chinese sidebar context menu localizes registered layout commands', async ({
	workbench,
	application,
	restartWorkbench,
}) => {
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
	expect(sidebarMenu).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ label: '更改', checked: true, enabled: false }),
			expect.objectContaining({ label: '将主侧栏移到右侧', enabled: true }),
			expect.objectContaining({ label: '活动栏位置', enabled: true }),
			expect.objectContaining({ label: '活动栏大小', enabled: true }),
		]),
	);
	await workbench.menus.select(application, openSidebarMenu, ['活动栏位置', '顶部']);
	await expect(sidebar.locator('.ash-sidebar-composite-bar-top .ash-composite-bar')).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.default');
	await expect(page.locator('[data-part="activitybar"]')).toBeVisible();
});

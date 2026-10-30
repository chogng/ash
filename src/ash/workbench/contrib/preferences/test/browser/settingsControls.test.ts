import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('table browser component', () => {
	const browserTests = useBrowserTests();

	for (const [locale, presentation] of [['en', 'editor'], ['zh-CN', 'editor'], ['en', 'general'], ['zh-CN', 'general']] as const) {
		test(`policy controls keep keyboard focus and explain equal-value management across themes (${locale}, ${presentation})`, async function () {
			const { page } = browserTests;
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/table.html?locale=${locale}`);
			await page.evaluate(presentation => window.ashTableIntegration.showPolicySettings(presentation), presentation);
			const root = page.locator('#policy-settings');
			const text = root.getByRole('textbox', { name: 'Text', exact: true });
			const textRow = root.getByRole('group', { name: 'Text', exact: true });
			const actions = textRow.getByRole('button', { name: locale === 'zh-CN' ? 'Text 的更多操作' : 'More actions for Text' });
			const original = await page.evaluate(() => window.ashTableIntegration.readPolicySettings());
			for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) {
				await page.evaluate(name => window.ashTableIntegration.theme(name), theme);
				await text.focus();
				await page.evaluate(() => window.ashTableIntegration.setSettingsPolicy(true));
				await expect(text).toBeDisabled();
				await expect(actions).toBeFocused();
				await expect(root.getByRole('switch', { name: 'Flag', exact: true })).toBeDisabled();
				await expect(root.getByRole('spinbutton', { name: 'Count', exact: true })).toBeDisabled();
				await expect(root.getByRole('combobox', { name: 'Channel', exact: true })).toBeDisabled();
				const descriptions = root.locator('.ash-settings-policy');
				await expect(descriptions).toHaveText(Array(4).fill(locale === 'zh-CN' ? '由管理员策略管理，无法在此更改。' : 'Managed by administrator policy. This value cannot be changed here.'));
				await expect(textRow).toHaveAccessibleDescription(new RegExp(locale === 'zh-CN' ? '由管理员策略管理' : 'Managed by administrator policy'));
				for (const width of [340, 720]) {
					await root.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
					await expect.poll(() => root.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
					await expect(descriptions.first()).toBeVisible();
				}
				await actions.press('Enter');
				await expect(page.getByRole('menuitem', { name: locale === 'zh-CN' ? '重置设置' : 'Reset Setting', exact: true })).toBeDisabled();
				await page.keyboard.press('Escape');
				await page.evaluate(() => window.ashTableIntegration.setSettingsPolicy(false));
				await expect(text).toBeEnabled();
				await expect(descriptions.first()).toBeHidden();
				expect(await page.evaluate(() => window.ashTableIntegration.readPolicySettings())).toBe(original);
			}
			await text.fill('new user value');
			await text.press('Tab');
			await expect.poll(() => page.evaluate(() => window.ashTableIntegration.readPolicySettings())).toContain('new user value');
			expect(errors).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`credential storage failure preserves saved-key state and keyboard retry recovers (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/table.html?locale=${locale}`);
			await page.evaluate(() => window.ashTableIntegration.showCredentialSettings());
			const root = page.locator('#credential-settings');
			const key = root.locator('input[type="password"]');
			await expect(key).toHaveValue('••••••••');
			for (const theme of ['light', 'hcDark', 'hcLight']) {
				await page.evaluate(name => window.ashTableIntegration.theme(name), theme);
				await page.evaluate(() => window.ashTableIntegration.setCredentialStorage('accessDenied'));
				const retry = root.getByRole('button', { name: locale === 'zh-CN' ? '重试凭据存储' : 'Retry credential storage' });
				await expect(retry).toBeVisible();
				await expect(root.getByRole('status').filter({ hasText: locale === 'zh-CN' ? '访问被拒绝' : 'access was denied' })).toBeVisible();
				await expect(key).toBeDisabled();
				await expect(key).toHaveValue('••••••••');
				await retry.focus();
				await page.keyboard.press('Enter');
				await expect(retry).toBeEnabled();
				await expect(retry).toBeFocused();
				await page.evaluate(() => window.ashTableIntegration.setCredentialStorage('available'));
				await expect(retry).toHaveCount(0);
				await expect(key).toBeEnabled();
				await expect(key).toHaveValue('••••••••');
				await expect(key).toBeFocused();
			}
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`memory credential fallback stays usable and keyboard authorization restores persistence (${locale})`, async function () {
			const { page } = browserTests;
			await page.goto(`/table.html?locale=${locale}`);
			await page.evaluate(() => {
				window.ashTableIntegration.setCredentialStorageMode('encrypted');
				window.ashTableIntegration.setCredentialStorageType('in-memory');
				window.ashTableIntegration.setCredentialStorage('accessDenied');
				window.ashTableIntegration.showCredentialSettings();
			});
			const root = page.locator('#credential-settings');
			await expect(root.getByRole('status').filter({ hasText: locale === 'zh-CN' ? '退出 Ash' : 'lost when Ash exits' })).toBeVisible();
			await expect(root.locator('input[type="password"]')).toBeEnabled();
			expect(await page.evaluate(() => [...window.ashTableIntegration.credentialOperations])).toEqual([]);
			const authorize = root.getByRole('button', { name: locale === 'zh-CN' ? '授权系统钥匙串' : 'Authorize system keyring' });
			await authorize.focus();
			await page.keyboard.press('Enter');
			await expect(root.getByRole('status').filter({ hasText: locale === 'zh-CN' ? '系统钥匙串中的密钥加密' : 'encrypted using a key' })).toBeVisible();
			await expect(authorize).toHaveCount(0);
			await expect(root.getByRole('button', { name: locale === 'zh-CN' ? '使用文件存储' : 'Use file storage' })).toBeFocused();
			expect(await page.evaluate(() => [...window.ashTableIntegration.credentialOperations])).toEqual(['authorize']);
		});
	}

	for (const scale of [1, 1.25, 1.5, 2]) {
		suite(`Table layout at ${scale * 100}% display scale`, () => {
			browserTests.use({ deviceScaleFactor: scale });
			test('table resizes without spurious overflow or resize observation errors', async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.goto('/table.html');
				await expect.poll(async () => ({ initialized: await page.evaluate(() => !!window.ashTableIntegration), errors })).toEqual({ initialized: true, errors: [] });
				expect(await page.evaluate(() => devicePixelRatio)).toBe(scale);
				const grid = page.getByRole('grid', { name: 'Local dictation models' });
				await expect(grid.getByRole('row')).toHaveCount(3);
				for (const theme of ['light', 'hcDark', 'hcLight']) {
					await page.evaluate(name => window.ashTableIntegration.theme(name), theme);
					for (const width of [760, 340, 760]) {
						await page.evaluate(width => { document.getElementById('models')!.style.width = `${width}px`; }, width);
						const headerWidth = Math.max(590, await grid.evaluate(element => element.clientWidth));
						await expect.poll(() => grid.evaluate(element => ({
							overflow: element.scrollWidth > element.clientWidth,
							headerWidth: Math.round([...element.querySelectorAll('[role="columnheader"]')].reduce((width, header) => width + header.getBoundingClientRect().width, 0)),
						}))).toEqual({ overflow: width === 340, headerWidth });
					}
				}
				await page.evaluate(() => window.ashTableIntegration.dispose());
				await expect(grid).toHaveCount(0);
				expect(errors).toEqual([]);
			});
		});
	}

	test('model table installs, preserves progress focus, cancels and selects installed models', async function () {
		const { page } = browserTests;

		await page.goto('/table.html');
		const grid = page.getByRole('grid', { name: 'Local dictation models' });
		await expect(grid.getByRole('columnheader')).toHaveText(['Model', 'Size', 'Status', 'Actions']);
		const missing = grid.getByRole('row').filter({ hasText: 'paraformer-large-online' });
		const installed = grid.getByRole('row').filter({ hasText: 'imported-model' });
		await expect(missing.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
		await expect(installed.getByRole('button', { name: 'Use model', exact: true })).toBeEnabled();
		await missing.getByRole('button', { name: 'Install', exact: true }).click();
		const cancel = missing.getByRole('button', { name: 'Cancel', exact: true });
		await cancel.focus();
		await page.evaluate(() => window.ashTableIntegration.progress());
		await expect(missing).toContainText('Downloading encoder.onnx: 1.0 MiB');
		await expect(cancel).toBeFocused();
		await cancel.click();
		await expect(missing.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
		await installed.getByRole('button', { name: 'Use model', exact: true }).click();
		await expect(installed.getByRole('button', { name: 'Current', exact: true })).toBeDisabled();
		await installed.getByRole('button', { name: 'Uninstall', exact: true }).click();
		await installed.getByRole('button', { name: 'Confirm uninstall', exact: true }).click();
		await expect(installed).toContainText('Not installed');
		expect(await page.evaluate(() => window.ashTableIntegration.operations)).toEqual([
			'install:paraformer-large-online-ec6a3c64', 'cancel:paraformer-large-online-ec6a3c64', 'uninstall:imported-model',
		]);
	});

	test('table columns align through resizing and remain keyboard accessible in every theme', async function () {
		const { page } = browserTests;

		await page.goto('/table.html');
		const grid = page.getByRole('grid');
		const rows = grid.getByRole('row');
		await rows.nth(1).focus();
		await page.keyboard.press('ArrowDown');
		await expect(rows.nth(2)).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(rows.nth(2).getByRole('gridcell').first()).toBeFocused();
		for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
			await page.evaluate(name => window.ashTableIntegration.theme(name), theme);
			expect(await rows.nth(2).getByRole('gridcell').first().evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
		}
		const separator = grid.getByRole('separator').first();
		await separator.focus();
		const before = await grid.getByRole('columnheader').first().boundingBox();
		await page.keyboard.press('ArrowRight');
		await expect.poll(async () => (await grid.getByRole('columnheader').first().boundingBox())!.width).not.toBe(before!.width);
		const widths = await grid.evaluate(element => {
			const headers = [...element.querySelectorAll('[role="columnheader"]')].map(node => node.getBoundingClientRect().width);
			const cells = [...element.querySelectorAll('.ash-table-row')][0]!.querySelectorAll('[role="gridcell"]');
			return [headers, [...cells].map(node => node.getBoundingClientRect().width)];
		});
		expect(widths[1]).toEqual(widths[0]);
		await page.evaluate(() => { document.getElementById('models')!.style.width = '340px'; });
		await expect.poll(() => grid.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
		await page.goto('/table.html?locale=zh-CN');
		await expect(page.getByRole('grid', { name: '本地听写模型' }).getByRole('columnheader')).toHaveText(['模型', '大小', '状态', '操作']);
		await page.evaluate(() => window.ashTableIntegration.dispose());
		await expect(page.getByRole('grid')).toHaveCount(0);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`credential storage authorizes only on request and confirms file migration (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/table.html?locale=${locale}`);
			await page.evaluate(() => {
				window.ashTableIntegration.setCredentialStorageMode('encrypted');
				window.ashTableIntegration.setCredentialStorage('accessDenied');
				window.ashTableIntegration.showCredentialSettings();
			});
			const root = page.locator('#credential-settings');
			const authorize = root.getByRole('button', { name: locale === 'zh-CN' ? '授权系统钥匙串' : 'Authorize system keyring' });
			const file = root.getByRole('button', { name: locale === 'zh-CN' ? '使用文件存储' : 'Use file storage' });
			const encrypted = root.getByRole('button', { name: locale === 'zh-CN' ? '使用加密存储' : 'Use encrypted storage' });
			await expect(authorize).toBeVisible();
			await expect.poll(() => page.evaluate(() => [...window.ashTableIntegration.credentialOperations])).toEqual([]);
			await authorize.focus();
			await page.keyboard.press('Enter');
			await expect(root.locator('input[type="password"]')).toBeEnabled();
			await expect(file).toBeFocused();
			await expect.poll(() => page.evaluate(() => [...window.ashTableIntegration.credentialOperations])).toEqual(['authorize']);
			await page.keyboard.press('Enter');
			const confirmation = page.getByRole('dialog');
			await expect(confirmation).toContainText(locale === 'zh-CN' ? '不加密保存凭据' : 'Store credentials without encryption');
			await confirmation.getByRole('button', { name: locale === 'zh-CN' ? '取消' : 'Cancel', exact: true }).click();
			await expect(file).toBeFocused();
			await expect.poll(() => page.evaluate(() => [...window.ashTableIntegration.credentialOperations])).toEqual(['authorize']);
			await file.click();
			await confirmation.getByRole('button', { name: locale === 'zh-CN' ? '使用文件存储' : 'Use file storage', exact: true }).click();
			await expect(encrypted).toBeVisible();
			await expect(encrypted).toBeFocused();
			await expect(root.getByRole('status').filter({ hasText: locale === 'zh-CN' ? '未加密形式' : 'without encryption' })).toBeVisible();
			await expect(root.locator('input[type="password"]')).toHaveValue('••••••••');
			await page.keyboard.press('Enter');
			await expect(file).toBeVisible();
			await expect.poll(() => page.evaluate(() => [...window.ashTableIntegration.credentialOperations])).toEqual(['authorize', 'file', 'encrypted']);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`search settings use the shared renderer and save backend revisions with the keyboard (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/table.html?locale=${locale}`);
			await page.evaluate(() => window.ashTableIntegration.showSearchSettings());
			const root = page.locator('#search-settings');
			const engine = root.getByRole('combobox', { name: locale === 'zh-CN' ? '索引搜索引擎' : 'Indexed search engine', exact: true });
			await expect(engine).toBeEnabled();
			await expect(engine).toHaveText(locale === 'zh-CN' ? 'tgrep（默认）' : 'tgrep (default)');
			await engine.focus();
			await page.keyboard.press('Enter');
			await page.getByRole('option', { name: 'ripgrep', exact: true }).press('End');
			await page.keyboard.press('Enter');
			await expect(engine).toHaveText('ripgrep');
			await expect(root.getByRole('status')).toHaveText(locale === 'zh-CN' ? '搜索引擎已保存。' : 'Search engine saved.');
			expect(await page.evaluate(() => window.ashTableIntegration.searchSaved)).toEqual(['ripgrep']);
			await root.getByRole('button', { name: locale === 'zh-CN' ? '刷新' : 'Refresh', exact: true }).click();
			await expect(engine).toHaveText('ripgrep');
		});
	}
});

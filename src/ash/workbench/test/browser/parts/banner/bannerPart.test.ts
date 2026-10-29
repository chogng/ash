import { expect } from '@playwright/test';
import { suite, test, setup } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('banner browser component', () => {
	const browserTests = useBrowserTests();
	setup(function () {
		const { page } = browserTests;
		page.on('pageerror', error => { throw error; });
	});

	for (const locale of ['en', 'zh']) {
		test(`Agent Host banner follows recovery, keeps editor focus and reconnects through the command (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/banner.html${locale === 'zh' ? '?zh' : ''}`);
			await page.waitForFunction(() => !!window.ashBannerIntegration);
			const banner = page.locator('[data-part="banner"]');
			const editor = page.getByRole('textbox', { name: 'Editor draft' });
			const editorTop = (await page.locator('[data-part="editor"]').boundingBox())!.y;
			await expect(banner).toBeHidden();
			await editor.fill('unsaved draft');
			await page.evaluate(() => window.ashBannerIntegration.setRecovery('recovering'));
			await expect(banner).toBeVisible();
			await expect(banner).toContainText(locale === 'zh' ? '正在重新连接到 Agent Host…' : 'Reconnecting to the Agent Host…');
			await expect(editor).toBeFocused();
			expect((await page.locator('[data-part="editor"]').boundingBox())!.y).toBe(editorTop + 32);
			await page.evaluate(() => window.ashBannerIntegration.setRecovery('failed'));
			const reconnect = banner.getByRole('button', { name: locale === 'zh' ? '重新连接' : 'Reconnect', exact: true });
			await expect(reconnect).toBeVisible();
			await page.evaluate(() => window.ashBannerIntegration.focus());
			await banner.press('ArrowLeft');
			await expect(banner.getByRole('button', { name: locale === 'zh' ? '关闭横幅' : 'Close Banner' })).toBeFocused();
			await banner.press('ArrowRight');
			await expect(reconnect).toBeFocused();
			await reconnect.press('Space');
			await expect.poll(() => page.evaluate(() => window.ashBannerIntegration.state().retries)).toBe(1);
			await expect(banner).toContainText(locale === 'zh' ? '正在重新连接' : 'Reconnecting');
			await expect(banner.getByRole('button')).toHaveCount(1);
			await page.evaluate(() => window.ashBannerIntegration.rebuild());
			await expect(banner).toBeVisible();
			expect((await page.locator('[data-part="editor"]').boundingBox())!.y).toBe(editorTop + 32);
			for (const index of [0, 1, 2, 3]) {
				await page.evaluate(index => window.ashBannerIntegration.setTheme(index), index);
				await page.screenshot({ path: testInfo.outputPath(`banner-${locale}-theme-${index}.png`) });
				const colors = await banner.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, foreground: getComputedStyle(node).color, border: getComputedStyle(node).borderBottomColor }));
				expect(colors.background).not.toBe(colors.foreground);
				if (index > 1) expect(colors.border).not.toBe(colors.background);
			}
			await banner.press('Escape');
			await expect(banner).toBeFocused();
			await page.evaluate(() => window.ashBannerIntegration.setRecovery('idle'));
			await expect(banner).toBeHidden();
			await expect(editor).toHaveValue('unsaved draft');
			expect((await page.locator('[data-part="editor"]').boundingBox())!.y).toBe(editorTop);
			await page.evaluate(() => window.ashBannerIntegration.setRecovery('unavailable'));
			await expect(banner).toContainText('Authorization expired');
			await expect(banner.getByRole('button')).toHaveCount(1);
			await page.setViewportSize({ width: 360, height: 600 });
			await expect(banner).toHaveCSS('width', '360px');
			const closeBounds = await banner.getByRole('button').boundingBox();
			expect(closeBounds!.x).toBeGreaterThanOrEqual(0);
			expect(closeBounds!.x + closeBounds!.width).toBeLessThanOrEqual(360);
			await expect(banner.locator('.ash-banner-message')).toHaveCSS('text-overflow', 'ellipsis');
			await page.evaluate(() => window.ashBannerIntegration.setRecovery('suspended'));
			await expect(banner).toBeHidden();
		});
	}

	test('banner preserves pending notices, updates content, exposes help and restores focus on close', async function () {
		const { page } = browserTests;

		await page.goto('/banner.html');
		await page.waitForFunction(() => !!window.ashBannerIntegration);
		const banner = page.locator('[data-part="banner"]');
		const origin = page.getByRole('textbox', { name: 'Sidebar filter' });
		await origin.focus();
		await page.evaluate(() => {
			window.ashBannerIntegration.show('low', 'Pending notice', -1);
			window.ashBannerIntegration.setRecovery('failed');
			window.ashBannerIntegration.show('low', 'Updated pending notice', -1);
		});
		await expect(banner).toContainText('Could not restore');
		await page.evaluate(() => window.ashBannerIntegration.setRecovery('idle'));
		await expect(banner).toContainText('Updated pending notice');
		await page.evaluate(() => window.ashBannerIntegration.focus());
		await banner.press('ArrowRight');
		const close = banner.getByRole('button', { name: 'Close Banner' });
		await expect(close).toBeFocused();
		await page.evaluate(() => window.ashBannerIntegration.show('low', 'Updated **formatted** message', -1, true));
		await expect(banner.locator('strong')).toHaveText('formatted');
		await expect(close).toBeFocused();
		await expect(banner.locator('.ash-banner-message')).toHaveCount(1);
		await page.evaluate(() => window.ashBannerIntegration.openHelp());
		const help = page.getByRole('textbox', { name: 'Accessibility Help' });
		await expect(help).toHaveValue(/Tab and Shift\+Tab/);
		await help.press('Escape');
		await expect(close).toBeFocused();
		await page.evaluate(() => window.ashBannerIntegration.openView());
		const view = page.getByRole('textbox', { name: 'Accessible View' });
		await expect(view).toHaveValue('Updated formatted message\nClose Banner');
		await page.evaluate(() => window.ashBannerIntegration.show('low', 'Latest message', -1));
		await expect(view).toHaveValue('Latest message\nClose Banner');
		await view.press('Escape');
		await expect(banner).toBeFocused();
		await banner.press('ArrowRight');
		await banner.getByRole('button', { name: 'Close Banner' }).press('Enter');
		await expect(origin).toBeFocused();
		await expect(banner).toBeHidden();
		expect(await page.evaluate(() => window.ashBannerIntegration.state().closed)).toBe(1);
		await page.evaluate(() => {
			window.ashBannerIntegration.show('first', 'First equal-priority notice');
			window.ashBannerIntegration.show('second', 'Latest equal-priority notice');
		});
		await expect(banner).toContainText('Latest equal-priority notice');
		await banner.getByRole('button', { name: 'Close Banner' }).click();
		await expect(banner).toContainText('First equal-priority notice');
		await page.evaluate(() => window.ashBannerIntegration.hide('first'));
		await expect(banner).toBeHidden();
		expect(await page.evaluate(() => window.ashBannerIntegration.state().closed)).toBe(2);
		await page.evaluate(() => window.ashBannerIntegration.dispose());
		await expect(page.locator('[data-part="banner"]')).toHaveCount(0);
	});

	test('Banner commands and user keybindings share one dispatch path', async function () {
		const { page } = browserTests;

		await page.goto('/banner.html');
		await page.waitForFunction(() => !!window.ashBannerIntegration);
		await page.evaluate(async () => {
			window.ashBannerIntegration.setRecovery('failed');
			await window.ashBannerIntegration.command('workbench.action.focusBanner');
		});
		const banner = page.locator('[data-part="banner"]');
		const reconnect = banner.getByRole('button', { name: 'Reconnect', exact: true });
		const close = banner.getByRole('button', { name: 'Close Banner' });
		await banner.press('ArrowDown');
		await expect(reconnect).toBeFocused();
		await reconnect.press('ArrowUp');
		await expect(close).toBeFocused();
		await close.press('Escape');
		await expect(banner).toBeFocused();
		await page.evaluate(() => window.ashBannerIntegration.setBindings([{ key: 'down', command: 'workbench.banner.focusPreviousAction', when: 'bannerFocused' }]));
		await banner.press('ArrowDown');
		await expect(close).toBeFocused();
		await page.evaluate(() => window.ashBannerIntegration.command('workbench.banner.focusNextAction'));
		await expect(reconnect).toBeFocused();
		await page.evaluate(() => window.ashBannerIntegration.setBindings([{ key: 'escape', command: '-workbench.banner.focusBanner' }]));
		await reconnect.press('Escape');
		await expect(reconnect).toBeFocused();
		await page.evaluate(() => window.ashBannerIntegration.command('workbench.banner.focusBanner'));
		await expect(banner).toBeFocused();
	});

	for (const locale of ['en', 'zh']) {
		test(`workspace permission Banner follows policy, dismissal and workspace scope (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/banner.html${locale === 'zh' ? '?zh' : ''}`);
			await page.waitForFunction(() => !!window.ashBannerIntegration);
			const banner = page.locator('[data-part="banner"]');
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
			await expect(banner).toContainText(locale === 'zh' ? '此工作区为只读' : 'This workspace is read-only');
			await page.evaluate(() => window.ashBannerIntegration.setRecovery('failed'));
			await expect(banner).toContainText(locale === 'zh' ? '无法恢复' : 'Could not restore');
			await page.evaluate(() => window.ashBannerIntegration.setRecovery('idle'));
			await expect(banner).toContainText(locale === 'zh' ? '此工作区为只读' : 'This workspace is read-only');
			await banner.getByRole('button', { name: locale === 'zh' ? '关闭横幅' : 'Close Banner' }).click();
			await expect(banner).toBeHidden();
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('restricted'));
			await expect(banner).toBeHidden();
			await page.evaluate(() => window.ashBannerIntegration.switchWorkspace('second'));
			await expect(banner).toContainText(locale === 'zh' ? '目录权限受限' : 'limited directory permissions');
			await page.evaluate(() => window.ashBannerIntegration.setBannerPolicy('never'));
			await expect(banner).toBeHidden();
			await page.evaluate(() => window.ashBannerIntegration.setBannerPolicy('always'));
			await expect(banner).toBeVisible();
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('trusted'));
			await expect(banner).toBeHidden();
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
			await expect(banner).toBeVisible();
			await page.evaluate(async () => {
				await window.ashBannerIntegration.switchWorkspace('test-components');
				await window.ashBannerIntegration.setBannerPolicy('untilDismissed');
			});
			await expect(banner).toBeHidden();
		});
	}

	for (const locale of ['en', 'zh']) {
		test(`Workspace Trust leads with effective status and direct trust actions (${locale})`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/banner.html${locale === 'zh' ? '?zh' : ''}`);
			await page.waitForFunction(() => !!window.ashBannerIntegration);
			const zh = locale === 'zh';
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
			const banner = page.locator('[data-part="banner"]');
			await banner.getByRole('button', { name: zh ? '管理权限' : 'Manage permissions', exact: true }).click();
			const editor = page.locator('.ash-workspace-trust-editor');
			const heading = editor.getByRole('heading', { level: 2 });
			const trust = editor.getByRole('button', { name: zh ? '信任工作区' : 'Trust workspace', exact: true });
			const readOnly = editor.getByRole('button', { name: zh ? '以只读方式打开' : 'Open read-only', exact: true });
			await expect(heading).toHaveText(zh ? '只读工作区' : 'Read-only workspace');
			await expect(editor.getByRole('switch')).toHaveCount(0);
			await expect(editor.getByRole('combobox')).toHaveCount(0);
			await expect(readOnly).toBeHidden();
			await expect(editor.getByRole('button')).toHaveCount(1);
			await expect(editor.locator('.workspace-trust-folder-path')).toBeHidden();
			await trust.focus();
			await trust.press('Enter');
			const dialog = page.getByRole('dialog');
			await expect(dialog).toContainText(zh ? '信任' : 'Trust');
			await expect(dialog).toContainText(zh ? '可能终止正在运行的终端命令和调试会话' : 'may terminate running terminal commands and debug sessions');
			await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
			await expect(heading).toHaveText(zh ? '只读工作区' : 'Read-only workspace');
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(0);
			await trust.click();
			await dialog.getByRole('button', { name: zh ? '信任工作区' : 'Trust workspace', exact: true }).click();
			await expect(heading).toHaveText(zh ? '已信任工作区' : 'Trusted workspace');
			await expect(banner).toBeHidden();
			await expect(editor).toBeFocused();
			await expect(trust).toBeHidden();
			await expect(readOnly).toBeEnabled();
			await expect(editor.getByRole('button')).toHaveCount(1);
			for (const index of [0, 1, 2, 3]) {
				await page.evaluate(index => window.ashBannerIntegration.setTheme(index), index);
				const colors = await editor.evaluate(node => ({ foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
				expect(colors.foreground).not.toBe(colors.background);
				await page.screenshot({ path: testInfo.outputPath(`trust-${locale}-theme-${index}.png`) });
			}
			await readOnly.click();
			await expect(dialog).toContainText(zh ? '可能终止正在运行的终端命令和调试会话' : 'may terminate running terminal commands and debug sessions');
			await expect(dialog).toContainText(zh ? '进程中未保存的状态可能丢失' : 'Unsaved process state may be lost');
			await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
			await expect(heading).toHaveText(zh ? '已信任工作区' : 'Trusted workspace');
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(1);
			await readOnly.click();
			await dialog.getByRole('button', { name: zh ? '以只读方式打开' : 'Open read-only', exact: true }).click();
			await expect(heading).toHaveText(zh ? '只读工作区' : 'Read-only workspace');
			await expect(banner).toBeVisible();
			await expect(editor).toBeFocused();
			const advanced = editor.locator('summary');
			await advanced.focus();
			await advanced.press('Enter');
			await expect(editor.getByRole('switch')).toHaveCount(15);
			await expect(editor.locator('.workspace-trust-folder-path')).toBeVisible();
			await advanced.press('Space');
			await expect(editor.getByRole('switch')).toHaveCount(0);
			await page.evaluate(() => window.ashBannerIntegration.layoutTrustEditor(360, 480));
			await expect(editor).toHaveCSS('width', '360px');
			const geometry = await editor.evaluate(node => {
				const content = node.querySelector<HTMLElement>('.workspace-trust-content')!;
				const viewport = content.parentElement!;
				return { width: content.clientWidth, scrollWidth: content.scrollWidth, scrollHeight: viewport.scrollHeight, height: viewport.clientHeight };
			});
			expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
			await advanced.focus();
			await advanced.press('Enter');
			await expect.poll(() => editor.locator('.workspace-trust-content').evaluate(content => content.parentElement!.scrollHeight > content.parentElement!.clientHeight)).toBe(true);
			const mutation = editor.getByRole('switch', { name: zh ? '修改仓库' : 'Modify repository', exact: true });
			await mutation.focus();
			await expect(mutation).toBeFocused();
			await expect(editor.locator('.ash-switch').filter({ has: page.getByRole('switch', { name: zh ? '修改仓库' : 'Modify repository', exact: true }) })).toBeInViewport();
			await page.screenshot({ path: testInfo.outputPath(`trust-${locale}-narrow-advanced.png`) });
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(2);
		});

		test(`Workspace Trust manages draft, confirmation and conflicts through the Banner (${locale})`, async function () {
			const { page } = browserTests;

			await page.goto(`/banner.html${locale === 'zh' ? '?zh' : ''}`);
			await page.waitForFunction(() => !!window.ashBannerIntegration);
			const zh = locale === 'zh';
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
			const banner = page.locator('[data-part="banner"]');
			await banner.getByRole('button', { name: zh ? '管理权限' : 'Manage permissions', exact: true }).click();
			const editor = page.locator('.ash-workspace-trust-editor');
			await editor.locator('summary').click();
			const write = editor.getByRole('switch', { name: zh ? '写入文件' : 'Write files', exact: true });
			const save = editor.getByRole('button', { name: zh ? '保存权限' : 'Save permissions', exact: true });
			await expect(write).not.toBeChecked();
			await expect(save).toBeDisabled();
			await editor.focus();
			await page.keyboard.press('Alt+F1');
			const help = page.getByRole('textbox', { name: 'Accessibility Help', exact: true });
			await expect(help).toHaveValue(zh ? /工作区信任/ : /Workspace Trust/);
			await expect(help).toHaveValue(zh ? /可能终止正在运行的终端命令和调试会话/ : /may terminate running terminal commands and debug sessions/);
			await help.press('Escape');
			await expect(editor).toBeFocused();
			const development = async () => {
				await editor.getByRole('combobox', { name: zh ? '权限预设' : 'Permission preset', exact: true }).click();
				await page.getByRole('option', { name: zh ? '开发' : 'Development', exact: true }).click();
			};
			await development();
			await expect(write).toBeChecked();
			await expect(banner).toBeVisible();
			await editor.getByRole('button', { name: zh ? '放弃更改' : 'Discard changes', exact: true }).click();
			await expect(write).not.toBeChecked();
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(0);
			await development();
			await save.click();
			const dialog = page.getByRole('dialog');
			await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(0);
			await save.click();
			await dialog.getByRole('button', { name: zh ? '保存权限' : 'Save permissions', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashBannerIntegration.managementState().grantWrites)).toBe(1);
			await expect(banner).toBeHidden();
			await expect(save).toBeDisabled();
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
			await expect(write).not.toBeChecked();
			await write.focus();
			await write.press('Space');
			await save.click();
			await expect(dialog).toContainText(zh ? '可能终止正在运行的终端命令和调试会话' : 'may terminate running terminal commands and debug sessions');
			await expect(dialog).toContainText(zh ? '进程中未保存的状态可能丢失' : 'Unsaved process state may be lost');
			await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(1);
			await save.click();
			await dialog.getByRole('button', { name: zh ? '保存权限' : 'Save permissions', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashBannerIntegration.managementState().grantWrites)).toBe(2);
			const saved = (await page.evaluate(() => window.ashBannerIntegration.managementState())).saved;
			expect(saved).toContain('writeFiles');
			expect(saved).not.toContain('executeCommands');
			await expect(banner).toContainText(zh ? '目录权限受限' : 'limited directory permissions');
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
			await expect(write).not.toBeChecked();
			await development();
			await page.evaluate(() => window.ashBannerIntegration.conflictGrant());
			await save.click();
			await dialog.getByRole('button', { name: zh ? '保存权限' : 'Save permissions', exact: true }).click();
			await expect(editor).toContainText(zh ? '无法应用权限' : 'Could not apply permissions');
			await expect(save).toBeDisabled();
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(2);
			await editor.getByRole('button', { name: zh ? '刷新' : 'Refresh', exact: true }).click();
			await expect(write).not.toBeChecked();
		});
	}

	test('Workspace Trust rejects stale confirmations and keeps unauthorized connections read-only', async function () {
		const { page } = browserTests;

		await page.goto('/banner.html');
		await page.waitForFunction(() => !!window.ashBannerIntegration);
		await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
		await page.locator('[data-part="banner"]').getByRole('button', { name: 'Manage permissions', exact: true }).click();
		const editor = page.locator('.ash-workspace-trust-editor');
		await editor.locator('summary').click();
		const write = editor.getByRole('switch', { name: 'Write files', exact: true });
		const save = editor.getByRole('button', { name: 'Save permissions', exact: true });
		for (const change of ['workspace', 'connection']) {
			await write.focus();
			await write.press('Space');
			await save.click();
			await expect(page.getByRole('dialog')).toBeVisible();
			if (change === 'workspace') await page.evaluate(() => window.ashBannerIntegration.switchWorkspace('second'));
			else await page.evaluate(() => window.ashBannerIntegration.bumpConnection());
			await page.getByRole('dialog').getByRole('button', { name: 'Save permissions', exact: true }).click();
			await expect(write).not.toBeChecked();
			await expect(save).toBeDisabled();
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(0);
		}
		await page.evaluate(async () => {
			window.ashBannerIntegration.setManagementAllowed(false);
			await window.ashBannerIntegration.command('workbench.trust.manage');
		});
		await expect(editor).toContainText('Directory permissions can only be changed by an authorized desktop host');
		await expect(write).toBeDisabled();
		await expect(save).toBeDisabled();
		await page.evaluate(async () => {
			window.ashBannerIntegration.setManagementAllowed(true);
			window.ashBannerIntegration.setPermissions('unknown');
			await window.ashBannerIntegration.command('workbench.trust.manage');
		});
		await expect(editor).toContainText('Effective directory permissions are unavailable');
		await expect(write).toBeEnabled();
		await expect(save).toBeDisabled();
		expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(0);
	});

	for (const locale of ['en', 'zh']) {
		test(`Workspace Trust requests coalesce, cancel with Escape and complete after recovery (${locale})`, async function () {
			const { page } = browserTests;
			const zh = locale === 'zh';
			await page.goto(`/banner.html${zh ? '?zh' : ''}`);
			await page.waitForFunction(() => !!window.ashBannerIntegration);
			await page.evaluate(() => window.ashBannerIntegration.setPermissions('readonly'));
			const origin = page.getByRole('textbox', { name: 'Editor draft' });
			await origin.focus();
			await page.evaluate(() => { window.ashBannerIntegration.requestTrust(); window.ashBannerIntegration.requestTrust(); });
			const dialog = page.getByRole('dialog', { name: zh ? '工作区信任' : 'Workspace Trust', exact: true });
			await expect(dialog).toHaveCount(1);
			await expect(dialog).toContainText(zh ? '你是否信任此工作区中文件的作者' : 'Do you trust the authors');
			await expect(dialog).toContainText(zh ? '未保存的状态可能丢失' : 'Unsaved process state may be lost');
			await dialog.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(origin).toBeFocused();
			await expect.poll(() => page.evaluate(() => window.ashBannerIntegration.managementState().trustResponses)).toEqual(['canceled', 'canceled']);
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(0);
			await page.evaluate(() => window.ashBannerIntegration.requestTrust());
			const trust = dialog.getByRole('button', { name: zh ? '信任工作区' : 'Trust workspace', exact: true });
			await trust.focus();
			await trust.press('Enter');
			await expect(dialog).toBeHidden();
			await expect.poll(() => page.evaluate(() => window.ashBannerIntegration.managementState().trustResponses)).toEqual(['canceled', 'canceled', 'trusted']);
			expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(1);
			expect((await page.evaluate(() => window.ashBannerIntegration.state())).retries).toBe(1);
			await expect(page.locator('[data-part="banner"]')).toBeHidden();
		});
	}

	test('an old Workspace Trust dialog cannot authorize the replacement workspace request', async function () {
		const { page } = browserTests;
		await page.goto('/banner.html');
		await page.waitForFunction(() => !!window.ashBannerIntegration);
		await page.evaluate(() => { window.ashBannerIntegration.setPermissions('readonly'); window.ashBannerIntegration.requestTrust(); });
		const dialog = page.getByRole('dialog', { name: 'Workspace Trust', exact: true });
		await expect(dialog).toBeVisible();
		await page.evaluate(() => window.ashBannerIntegration.switchWorkspace('replacement'));
		await expect(dialog).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashBannerIntegration.managementState().trustResponses)).toEqual(['canceled']);
		expect((await page.evaluate(() => window.ashBannerIntegration.managementState())).grantWrites).toBe(0);
		await page.evaluate(() => window.ashBannerIntegration.requestTrust());
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashBannerIntegration.managementState().trustResponses)).toEqual(['canceled', 'canceled']);
	});
});

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import type { BrowserPasswordState } from '../../../../src/ash/platform/browserView/common/browserPasswordService.js';

for (const locale of ['en', 'zh-CN'] as const) {
	test.describe(`Website passwords ${locale}`, () => {
		test.use({ openWorkspace: false, electronUserSettings: { 'workbench.locale': locale } });
		test('real form login saves, updates, fills and manages encrypted passwords across restart', { tag: ['@electron-ui'] }, async ({ application: initialApplication, workbench: initialWorkbench, reloadWorkbench }, testInfo) => {
			test.setTimeout(180_000);
			let application = initialApplication;
			let workbench = initialWorkbench;
			let currentPassword = 'synthetic-login-password';
			const accepted: string[] = [];
			const form = (failed = false) => `<title>${failed ? 'Login failed' : 'Login form'}</title><form method="post" action="/login"><label>Account<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Log in</button></form>`;
			const server = createServer(async (request, response) => {
				response.setHeader('Content-Type', 'text/html');
				if (request.method === 'POST') {
					const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.from(chunk)); }
					const data = new URLSearchParams(Buffer.concat(chunks).toString());
					if (data.get('password') !== currentPassword) { response.end(form(true)); return; }
					accepted.push(data.get('username')!); response.writeHead(303, { Location: '/account' }); response.end(); return;
				}
				response.end(request.url === '/account' ? '<title>Account page</title><p>Signed in</p>' : request.url === '/new-password' ? form().replace('current-password', 'new-password') : request.url === '/hidden-password' ? form().replace('type="password"', 'type="password" style="opacity:0"') : request.url === '/cross-form' ? form().replace('action="/login"', 'action="https://other.example/login"') : form());
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const endpoint = server.address(); if (!endpoint || typeof endpoint === 'string') { throw new Error('Missing login fixture'); }
			const url = `http://127.0.0.1:${endpoint.port}/login`;
			const origin = new URL(url).origin;
			const labels = locale === 'en' ? {
				address: 'Browser address', saveTitle: 'Save website password', save: 'Save password', updateTitle: 'Update website password', update: 'Update password',
				choose: 'Choose a saved account', title: 'Saved website passwords', search: 'Search saved accounts', edit: 'Edit saved website account',
				username: 'Username', password: 'New password', ok: 'OK', confirm: 'Confirm', clear: 'Delete all saved website passwords',
				saveSetting: 'Offer to save website passwords', fillSetting: 'Automatically fill website passwords', help: 'Accessibility Help', close: 'Close',
			} : {
				address: '浏览器地址', saveTitle: '保存网站密码', save: '保存密码', updateTitle: '更新网站密码', update: '更新密码',
				choose: '选择已保存的账号', title: '已保存的网站密码', search: '搜索已保存的账号', edit: '编辑已保存的网站账号',
				username: '用户名', password: '新密码', ok: '确定', confirm: '确认', clear: '删除所有已保存的网站密码',
				saveSetting: '询问是否保存网站密码', fillSetting: '自动填充网站密码', help: '无障碍帮助', close: '关闭',
			};
			const state = () => workbench.page.evaluate(() => globalThis.ashTestMainProcess.call<BrowserPasswordState>('browserPasswords', 'readState', []));
			const editor = () => workbench.page.locator('.ash-browser-editor');
			const navigate = async (next = url) => {
				const previousDocument = view && await view.evaluate(view => view.webContents.executeJavaScript('performance.timeOrigin'));
				const address = editor().getByRole('textbox', { name: labels.address, exact: true });
				await address.fill(next); await address.press('Enter');
				await expect(editor().getByRole('status')).toHaveText('Login form');
				if (view) { await expect.poll(() => view!.evaluate(view => view.webContents.executeJavaScript('performance.timeOrigin'))).not.toBe(previousDocument); }
			};
			const acquire = () => (application as ElectronApplication).evaluateHandle(({ BrowserWindow }, origin) => {
				const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().startsWith(origin));
				if (!view) { throw new Error('Missing login page'); } return view as Electron.WebContentsView;
			}, origin);
			let view: Awaited<ReturnType<typeof acquire>> | undefined;
			const click = async (selector: string) => view!.evaluate(async (view, selector) => {
				const point = await view.webContents.executeJavaScript(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
				view.webContents.focus();
				for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) { view.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 }); }
			}, selector);
			const enter = async (selector: string, text: string) => {
				await click(selector);
				await expect.poll(() => view!.evaluate((view, selector) => view.webContents.executeJavaScript(`document.activeElement.matches(${JSON.stringify(selector)})`), selector)).toBe(true);
				await view!.evaluate(view => {
					view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
					view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
				});
				await expect.poll(() => view!.evaluate(view => view.webContents.executeJavaScript('document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length'))).toBe(true);
				await view!.evaluate((view, text) => view.webContents.insertText(text), text);
				await expect.poll(() => view!.evaluate((view, selector) => view.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value`), selector)).toBe(text);
			};
			const values = () => view!.evaluate(view => view.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input'),input=>input.value)`));
			const settings = async () => {
				await workbench.settingsEditor.openUserSettingsUI(); await workbench.settingsEditor.selectGroup('workbench'); await workbench.settingsEditor.selectCategory('browser');
				const panel = workbench.page.locator('.ash-browser-passwords'); await expect(panel).toBeVisible(); return panel;
			};
			const closeSettings = () => workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
			const setSwitch = async (name: string, checked: boolean) => {
				const control = workbench.settingsEditor.element.getByRole('switch', { name, exact: true });
				await control.focus(); if (await control.isChecked() !== checked) { await control.press('Space'); }
				await expect(control).toBeChecked({ checked });
			};
			try {
				await installMainChannelTestClient(workbench.page);
				await workbench.page.evaluate(() => globalThis.ashTestMainProcess.call('browserView', 'getOrCreateBrowserView', ['browser_target_' + crypto.randomUUID(), { initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: 'global' } }]));
				await navigate(); view = await acquire();
				expect(await view.evaluate(view => view.webContents.executeJavaScript('[typeof process,typeof require,typeof browserViewAPI]'))).toEqual(['undefined', 'undefined', 'undefined']);
				await enter('input[name=username]', 'synthetic-account'); await enter('input[name=password]', 'rejected-password'); await click('button');
				await expect(editor().getByRole('status')).toHaveText('Login failed'); expect((await state()).entries).toHaveLength(0);
				await enter('input[name=username]', 'synthetic-account');
				await enter('input[name=password]', currentPassword);
				await workbench.dialogs.confirm(application, labels.saveTitle, labels.save, () => click('button'));
				await expect(editor().getByRole('status')).toHaveText('Account page'); await expect.poll(async () => (await state()).entries.length).toBe(1);
				const storagePath = await (application as ElectronApplication).evaluate(({ app }) => app.getPath('userData'));
				const disk = await readFile(join(storagePath, 'workbench-state.json'), 'utf8');
				expect(disk).toContain('ash-encrypted:1:'); expect(disk).not.toContain('synthetic-account'); expect(disk).not.toContain(currentPassword);
				await view.dispose(); view = undefined;
				({ application, workbench } = await reloadWorkbench()); await installMainChannelTestClient(workbench.page);
				await navigate(); view = await acquire(); await click('input[name=username]');
				await expect.poll(values).toEqual(['synthetic-account', currentPassword]);
				currentPassword = 'updated-login-password'; await enter('input[name=password]', currentPassword);
				await workbench.dialogs.confirm(application, labels.updateTitle, labels.update, () => click('button'));
				await navigate(); await click('input[name=username]'); await expect.poll(values).toEqual(['synthetic-account', currentPassword]);
				await enter('input[name=username]', 'second-account');
				await workbench.dialogs.confirm(application, labels.saveTitle, labels.save, () => click('button'));
				await expect.poll(async () => (await state()).entries.length).toBe(2);
				await navigate(); await workbench.dialogs.confirm(application, labels.choose, 'second-account', () => click('input[name=username]'));
				await expect.poll(values).toEqual(['second-account', currentPassword]);
				for (const excluded of ['/new-password', '/cross-form', '/hidden-password']) {
					await navigate(origin + excluded); await enter('input[name=username]', 'second-account'); await click('input[name=password]'); await expect.poll(values).toEqual(['second-account', '']);
				}

				let panel = await settings(); await expect(panel.getByRole('listitem')).toHaveCount(2);
				await panel.getByRole('textbox', { name: labels.search, exact: true }).fill('second-account'); await expect(panel.getByRole('listitem')).toHaveCount(1);
				const editName = locale === 'en' ? `Edit account second-account on ${origin}` : `编辑 ${origin} 上的账号 second-account`;
				await panel.getByRole('button', { name: editName, exact: true }).click();
				const edit = workbench.page.getByRole('dialog', { name: labels.edit, exact: true });
				await expect(edit.getByLabel(labels.password, { exact: true })).toHaveAttribute('type', 'password');
				await expect(edit.getByLabel(labels.password, { exact: true })).toHaveValue('');
				await edit.getByLabel(labels.password, { exact: true }).fill('managed-new-password'); await edit.getByRole('button', { name: labels.ok, exact: true }).click();
				await expect(edit).toBeHidden();
				await panel.getByRole('textbox', { name: labels.search, exact: true }).fill('');
				await testInfo.attach(`password-settings-${locale}`, { body: await workbench.page.screenshot(), contentType: 'image/png' });
				await setSwitch(labels.fillSetting, false); await closeSettings();
				await navigate(); await enter('input[name=username]', 'second-account'); await click('input[name=password]');
				await expect.poll(values).toEqual(['second-account', '']);
				panel = await settings(); await setSwitch(labels.fillSetting, true);
				await setSwitch(labels.saveSetting, false);
				const search = panel.getByRole('textbox', { name: labels.search, exact: true }); await search.focus(); await search.press('Alt+F1');
				const help = workbench.page.getByRole('dialog', { name: labels.help, exact: true }); await expect(help.getByRole('textbox')).toHaveValue(locale === 'en' ? /existing passwords are never shown/ : /已有密码不会显示/);
				await help.getByRole('button', { name: labels.close, exact: true }).click(); await expect(search).toBeFocused();
				await closeSettings(); await navigate(); await workbench.dialogs.confirm(application, labels.choose, 'second-account', () => click('input[name=username]'));
				await expect.poll(values).toEqual(['second-account', 'managed-new-password']);
				// Saving disabled: a successful new account must not create a record or a prompt.
				await enter('input[name=username]', 'not-saved'); await enter('input[name=password]', currentPassword); await click('button');
				await expect(editor().getByRole('status')).toHaveText('Account page'); expect((await state()).entries).toHaveLength(2);
				panel = await settings();
				const deleteName = locale === 'en' ? `Delete account second-account on ${origin}` : `删除 ${origin} 上的账号 second-account`;
				await workbench.dialogs.confirm(application, labels.confirm, labels.confirm, () => panel.getByRole('button', { name: deleteName, exact: true }).click());
				await expect(panel.getByRole('listitem')).toHaveCount(1);
				await workbench.dialogs.confirm(application, labels.confirm, labels.confirm, () => panel.getByRole('button', { name: labels.clear, exact: true }).click());
				await expect(panel.getByRole('listitem')).toHaveCount(0); await closeSettings();
				await navigate(); await enter('input[name=username]', 'second-account'); await click('input[name=password]'); await expect.poll(values).toEqual(['second-account', '']);
				expect(accepted).toEqual(['synthetic-account', 'synthetic-account', 'second-account', 'not-saved']);
				expect(await readFile(join(storagePath, 'workbench-state.json'), 'utf8')).not.toContain('browser.passwords.');
				await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
			} finally {
				await view?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
			}
		});
	});
}

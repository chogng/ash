import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, JSHandle } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import type { BrowserPasswordState } from '../../../../src/ash/platform/browserView/common/browserPasswordService.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

async function clickBrowserControl(view: JSHandle<Electron.WebContentsView>, selector: string): Promise<void> {
	await expect.poll(() => view.evaluate(view => view.webContents.isLoading())).toBe(false);
	const click = () =>
		view.evaluate(async (view, selector) => {
			const point = await view.webContents.executeJavaScript(
				`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
			);
			view.webContents.focus();
			for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) {
				view.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
			}
		}, selector);
	const input = await view.evaluate((view, selector) => view.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}) instanceof HTMLInputElement`), selector);
	if (input) {
		// Native focus can finish after navigation's title notification. Retry only
		// focusing an input; submit actions must still be dispatched exactly once.
		await expect
			.poll(async () => {
				await click();
				return view.evaluate((view, selector) => view.webContents.executeJavaScript(`document.activeElement.matches(${JSON.stringify(selector)})`), selector);
			})
			.toBe(true);
	} else {
		await click();
	}
}

test.describe('Ephemeral website credentials', () => {
	test.use({ openWorkspace: false });
	test(
		'ordinary Electron saves credentials in memory without a keychain or disk persistence',
		{ tag: ['@electron-ui', '@electron-app-server'] },
		async ({ application: initialApplication, workbench: initialWorkbench, reloadWorkbench, target, testWorkspace }) => {
			let application = initialApplication;
			let workbench = initialWorkbench;
			const server = createServer((request, response) => {
				response.setHeader('Content-Type', 'text/html');
				response.end(
					request.method === 'POST'
						? '<title>Account page</title><p>Signed in</p>'
						: '<title>Memory login</title><form method="post"><input name="username" autocomplete="username" value="memory-account"><input name="password" type="password" autocomplete="current-password" value="memory-password"><button>Log in</button></form>',
				);
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing login endpoint');
			const origin = `http://127.0.0.1:${address.port}`;
			let view: JSHandle<Electron.WebContentsView> | undefined;
			let backend: Awaited<ReturnType<typeof connectProfile>> | undefined;
			try {
				const paths = await (application as ElectronApplication).evaluate(({ app, safeStorage }) => {
					if (!process.argv.includes('--use-inmemory-secretstorage') || process.env.ASH_USE_INMEMORY_SECRETSTORAGE !== '1') throw new Error('Memory mode was not selected');
					// Any application-level access to native credentials fails this scenario.
					for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString'] as const) {
						safeStorage[method] = () => {
							throw new Error('Memory credentials accessed safeStorage');
						};
					}
					return {
						home: process.env.HOME!,
						profile: process.env.ASH_HOME!,
						storage: app.getPath('userData'),
					};
				});
				if (target.appServerMode === 'required') {
					backend = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
					const result = await backend.client.request(APP_SERVER_METHODS['provider/apiKey/set'], {
						connection: 'openai',
						apiKey: 'synthetic-memory-key',
					});
					expect(result.apiKeyConfigured).toBe(true);
					await expect(stat(join(paths.profile, 'secrets'))).rejects.toMatchObject({ code: 'ENOENT' });
					await backend.close();
					backend = undefined;
				}
				await installMainChannelTestClient(workbench.page);
				await workbench.page.evaluate(
					url =>
						globalThis.ashTestMainProcess.call('browserView', 'getOrCreateBrowserView', [
							'browser_target_' + crypto.randomUUID(),
							{ initialUrl: url, owner: { type: 'user' }, session: { scope: 'global' } },
						]),
					origin,
				);
				await expect(workbench.page.locator('.ash-browser-editor').getByRole('status')).toHaveText('Memory login');
				view = await (application as ElectronApplication).evaluateHandle(
					({ BrowserWindow }, origin) =>
						BrowserWindow.getAllWindows()
							.flatMap(window => window.contentView.children)
							.find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().startsWith(origin)) as Electron.WebContentsView,
					origin,
				);
				await workbench.dialogs.confirm(application, 'Save website password', 'Save password', () => clickBrowserControl(view!, 'button'));
				const state = () => workbench.page.evaluate(() => globalThis.ashTestMainProcess.call<BrowserPasswordState>('browserPasswords', 'readState', []));
				await expect.poll(async () => (await state()).entries.map(entry => entry.username)).toEqual(['memory-account']);
				const disk = await readFile(join(paths.storage, 'workbench-state.json'), 'utf8');
				for (const value of ['browser.passwords.', 'memory-account', 'memory-password']) expect(disk).not.toContain(value);
				if (process.platform === 'darwin')
					await expect(stat(join(paths.home, 'Library', 'Keychains'))).rejects.toMatchObject({
						code: 'ENOENT',
					});
				await view.dispose();
				view = undefined;
				({ application, workbench } = await reloadWorkbench());
				await installMainChannelTestClient(workbench.page);
				expect(await state()).toEqual({ available: true, entries: [], corrupted: 0 });
			} finally {
				await backend?.close();
				await view?.dispose();
				server.closeAllConnections();
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
		},
	);
});

for (const locale of ['en', 'zh-CN'] as const) {
	test.describe(`Website passwords ${locale}`, () => {
		// These journeys verify encrypted disk records and process restart; the launcher
		// still replaces Chromium's OS credential facility inside the isolated test profile.
		test.use({
			openWorkspace: false,
			useInMemorySecretStorage: false,
			electronUserSettings: { 'workbench.locale': locale },
		});
		test(
			'real form login saves, updates, fills and manages encrypted passwords across restart',
			{ tag: ['@electron-ui'] },
			async ({ application: initialApplication, workbench: initialWorkbench, reloadWorkbench }, testInfo) => {
				test.setTimeout(180_000);
				let application = initialApplication;
				let workbench = initialWorkbench;
				let currentPassword = 'synthetic-login-password';
				const accepted: string[] = [];
				const form = (failed = false) =>
					`<title>${failed ? 'Login failed' : 'Login form'}</title><form method="post" action="/login"><label>Account<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Log in</button><button id="show" type="button">Show password</button><button id="toggle" type="submit">Toggle visibility</button></form><script>for(const id of ['show','toggle'])document.getElementById(id).onclick=event=>{event.preventDefault();const input=document.querySelector('[name=password]');input.type=input.type==='password'?'text':'password';};</script>`;
				const server = createServer(async (request, response) => {
					response.setHeader('Content-Type', 'text/html');
					if (request.method === 'POST') {
						const chunks: Buffer[] = [];
						for await (const chunk of request) {
							chunks.push(Buffer.from(chunk));
						}
						const data = new URLSearchParams(Buffer.concat(chunks).toString());
						if (data.get('password') !== currentPassword) {
							response.end(form(true));
							return;
						}
						accepted.push(data.get('username')!);
						response.writeHead(303, { Location: '/account' });
						response.end();
						return;
					}
					response.end(
						request.url === '/account'
							? '<title>Account page</title><p>Signed in</p>'
							: request.url === '/new-password'
								? form().replace('current-password', 'new-password')
								: request.url === '/hidden-password'
									? form().replace('type="password"', 'type="password" style="opacity:0"')
									: request.url === '/cross-form'
										? form().replace('action="/login"', 'action="https://other.example/login"')
										: request.url === '/invalid-action'
											? form().replace('action="/login"', 'action="https://["')
											: request.url === '/cross-button'
												? form().replace('<button>', '<button formaction="https://other.example/login">')
												: form(),
					);
				});
				await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
				const endpoint = server.address();
				if (!endpoint || typeof endpoint === 'string') {
					throw new Error('Missing login fixture');
				}
				const url = `http://127.0.0.1:${endpoint.port}/login`;
				const origin = new URL(url).origin;
				const labels =
					locale === 'en'
						? {
								address: 'Browser address',
								saveTitle: 'Save website password',
								save: 'Save password',
								updateTitle: 'Update website password',
								update: 'Update password',
								choose: 'Choose a saved account',
								title: 'Saved website passwords',
								search: 'Search saved accounts',
								edit: 'Edit saved website account',
								username: 'Username',
								password: 'New password',
								ok: 'OK',
								confirm: 'Confirm',
								clear: 'Delete all saved website passwords',
								saveSetting: 'Offer to save website passwords',
								fillSetting: 'Automatically fill website passwords',
								help: 'Accessibility Help',
								close: 'Close',
							}
						: {
								address: '浏览器地址',
								saveTitle: '保存网站密码',
								save: '保存密码',
								updateTitle: '更新网站密码',
								update: '更新密码',
								choose: '选择已保存的账号',
								title: '已保存的网站密码',
								search: '搜索已保存的账号',
								edit: '编辑已保存的网站账号',
								username: '用户名',
								password: '新密码',
								ok: '确定',
								confirm: '确认',
								clear: '删除所有已保存的网站密码',
								saveSetting: '询问是否保存网站密码',
								fillSetting: '自动填充网站密码',
								help: '无障碍帮助',
								close: '关闭',
							};
				const state = () => workbench.page.evaluate(() => globalThis.ashTestMainProcess.call<BrowserPasswordState>('browserPasswords', 'readState', []));
				const editor = () => workbench.page.locator('.ash-browser-editor');
				const navigate = async (next = url) => {
					const previousDocument = view && (await view.evaluate(view => view.webContents.executeJavaScript('performance.timeOrigin')));
					const address = editor().getByRole('textbox', { name: labels.address, exact: true });
					await address.fill(next);
					await address.press('Enter');
					await expect(editor().getByRole('status')).toHaveText('Login form');
					if (view) {
						await expect.poll(() => view!.evaluate(view => view.webContents.executeJavaScript('performance.timeOrigin'))).not.toBe(previousDocument);
						await expect.poll(() => view!.evaluate(view => view.webContents.isLoading())).toBe(false);
					}
				};
				const acquire = () =>
					(application as ElectronApplication).evaluateHandle(({ BrowserWindow }, origin) => {
						const view = BrowserWindow.getAllWindows()
							.flatMap(window => window.contentView.children)
							.find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().startsWith(origin));
						if (!view) {
							throw new Error('Missing login page');
						}
						return view as Electron.WebContentsView;
					}, origin);
				let view: Awaited<ReturnType<typeof acquire>> | undefined;
				const click = (selector: string) => clickBrowserControl(view!, selector);
				const enter = async (selector: string, text: string) => {
					await click(selector);
					// Hidden macOS windows do not own application-menu accelerators.
					await view!.evaluate(view => view.webContents.selectAll());
					await expect
						.poll(() =>
							view!.evaluate(view =>
								view.webContents.executeJavaScript('document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length'),
							),
						)
						.toBe(true);
					await view!.evaluate((view, text) => view.webContents.insertText(text), text);
					await expect.poll(() => view!.evaluate((view, selector) => view.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value`), selector)).toBe(text);
				};
				const values = () => view!.evaluate(view => view.webContents.executeJavaScript(`Array.from(document.querySelectorAll('input'),input=>input.value)`));
				const settings = async () => {
					await workbench.settingsEditor.openUserSettingsUI();
					await workbench.settingsEditor.selectGroup('workbench');
					await workbench.settingsEditor.selectCategory('browser');
					const panel = workbench.page.locator('.ash-browser-passwords');
					await expect(panel).toBeVisible();
					return panel;
				};
				const closeSettings = () => workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
				const setSwitch = async (name: string, checked: boolean) => {
					const control = workbench.settingsEditor.element.getByRole('switch', { name, exact: true });
					await control.focus();
					if ((await control.isChecked()) !== checked) {
						await control.press('Space');
					}
					await expect(control).toBeChecked({ checked });
				};
				try {
					await installMainChannelTestClient(workbench.page);
					await workbench.page.evaluate(() =>
						globalThis.ashTestMainProcess.call('browserView', 'getOrCreateBrowserView', [
							'browser_target_' + crypto.randomUUID(),
							{ initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: 'global' } },
						]),
					);
					await navigate();
					view = await acquire();
					expect(await view.evaluate(view => view.webContents.executeJavaScript('[typeof process,typeof require,typeof browserViewAPI]'))).toEqual(['undefined', 'undefined', 'undefined']);
					// Observe the real preload IPC boundary without retaining any credentials.
					type Capture = { submissions: number; hasPasswordForm?: boolean; dispose(): void };
					await (application as ElectronApplication).evaluate(({ ipcMain }) => {
						const host = globalThis as typeof globalThis & { passwordToggleCapture?: Capture };
						const listener = (_event: Electron.IpcMainEvent, message: { type: string; data?: { hasPasswordForm?: boolean } }) => {
							if (message.type === 'passwordSubmitted') host.passwordToggleCapture!.submissions++;
							if (message.type === 'passwordPageState') host.passwordToggleCapture!.hasPasswordForm = message.data?.hasPasswordForm;
						};
						host.passwordToggleCapture = {
							submissions: 0,
							dispose() {
								ipcMain.removeListener('ash:browserView:preload', listener);
								delete host.passwordToggleCapture;
							},
						};
						ipcMain.on('ash:browserView:preload', listener);
					});
					await enter('input[name=username]', 'unverified-account');
					await enter('input[name=password]', 'unverified-password');
					let visible = false;
					for (const selector of ['#show', '#show', '#toggle', '#toggle']) {
						visible = !visible;
						await click(selector);
						await expect
							.poll(() =>
								(application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { passwordToggleCapture: Capture }).passwordToggleCapture.hasPasswordForm),
							)
							.toBe(!visible);
						expect(
							await (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { passwordToggleCapture: Capture }).passwordToggleCapture.submissions),
						).toBe(0);
						expect((await state()).entries).toHaveLength(0);
					}
					await enter('input[name=username]', 'synthetic-account');
					await enter('input[name=password]', 'rejected-password');
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('Login failed');
					expect((await state()).entries).toHaveLength(0);
					expect(await (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { passwordToggleCapture: Capture }).passwordToggleCapture.submissions)).toBe(1);
					await (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { passwordToggleCapture: Capture }).passwordToggleCapture.dispose());
					await enter('input[name=username]', 'synthetic-account');
					await enter('input[name=password]', currentPassword);
					await workbench.dialogs.confirm(application, labels.saveTitle, labels.save, () => click('button'));
					await expect(editor().getByRole('status')).toHaveText('Account page');
					await expect.poll(async () => (await state()).entries.length).toBe(1);
					const storagePath = await (application as ElectronApplication).evaluate(({ app }) => app.getPath('userData'));
					const disk = await readFile(join(storagePath, 'workbench-state.json'), 'utf8');
					expect(disk).toContain('ash-encrypted:1:');
					expect(disk).not.toContain('synthetic-account');
					expect(disk).not.toContain(currentPassword);
					if (process.platform === 'darwin')
						await expect(stat(join(storagePath, 'Library', 'Keychains'))).rejects.toMatchObject({
							code: 'ENOENT',
						});
					await view.dispose();
					view = undefined;
					({ application, workbench } = await reloadWorkbench());
					await installMainChannelTestClient(workbench.page);
					await navigate();
					view = await acquire();
					await click('input[name=username]');
					await expect.poll(values).toEqual(['synthetic-account', currentPassword]);
					currentPassword = 'updated-login-password';
					await enter('input[name=password]', currentPassword);
					await workbench.dialogs.confirm(application, labels.updateTitle, labels.update, () => click('button'));
					await navigate();
					await click('input[name=username]');
					await expect.poll(values).toEqual(['synthetic-account', currentPassword]);
					await enter('input[name=username]', 'second-account');
					await workbench.dialogs.confirm(application, labels.saveTitle, labels.save, () => click('button'));
					await expect.poll(async () => (await state()).entries.length).toBe(2);
					await navigate();
					await workbench.dialogs.confirm(application, labels.choose, 'second-account', () => click('input[name=username]'));
					await expect.poll(values).toEqual(['second-account', currentPassword]);
					for (const excluded of ['/new-password', '/cross-form', '/cross-button', '/invalid-action', '/hidden-password']) {
						await navigate(origin + excluded);
						await enter('input[name=username]', 'second-account');
						await click('input[name=password]');
						await expect.poll(values).toEqual(['second-account', '']);
					}

					let panel = await settings();
					await expect(panel.getByRole('listitem')).toHaveCount(2);
					await panel.getByRole('textbox', { name: labels.search, exact: true }).fill('second-account');
					await expect(panel.getByRole('listitem')).toHaveCount(1);
					const editName = locale === 'en' ? `Edit account second-account on ${origin}` : `编辑 ${origin} 上的账号 second-account`;
					await panel.getByRole('button', { name: editName, exact: true }).click();
					const edit = workbench.page.getByRole('dialog', { name: labels.edit, exact: true });
					await expect(edit.getByLabel(labels.password, { exact: true })).toHaveAttribute('type', 'password');
					await expect(edit.getByLabel(labels.password, { exact: true })).toHaveValue('');
					await edit.getByLabel(labels.password, { exact: true }).fill('managed-new-password');
					await edit.getByRole('button', { name: labels.ok, exact: true }).click();
					await expect(edit).toBeHidden();
					await panel.getByRole('textbox', { name: labels.search, exact: true }).fill('');
					await testInfo.attach(`password-settings-${locale}`, {
						body: await workbench.page.screenshot(),
						contentType: 'image/png',
					});
					await setSwitch(labels.fillSetting, false);
					await closeSettings();
					await navigate();
					await enter('input[name=username]', 'second-account');
					await click('input[name=password]');
					await expect.poll(values).toEqual(['second-account', '']);
					panel = await settings();
					await setSwitch(labels.fillSetting, true);
					await setSwitch(labels.saveSetting, false);
					const search = panel.getByRole('textbox', { name: labels.search, exact: true });
					await search.focus();
					await search.press('Alt+F1');
					const help = workbench.page.getByRole('dialog', { name: labels.help, exact: true });
					await expect(help.getByRole('textbox')).toHaveValue(locale === 'en' ? /existing passwords are never shown/ : /已有密码不会显示/);
					await expect(help.getByRole('textbox')).toHaveValue(locale === 'en' ? /Username-first login.*two minutes/ : /用户名优先.*两分钟/);
					await help.getByRole('button', { name: labels.close, exact: true }).click();
					await expect(search).toBeFocused();
					await closeSettings();
					await navigate();
					await workbench.dialogs.confirm(application, labels.choose, 'second-account', () => click('input[name=username]'));
					await expect.poll(values).toEqual(['second-account', 'managed-new-password']);
					// Saving disabled: a successful new account must not create a record or a prompt.
					await enter('input[name=username]', 'not-saved');
					await enter('input[name=password]', currentPassword);
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('Account page');
					expect((await state()).entries).toHaveLength(2);
					panel = await settings();
					const deleteName = locale === 'en' ? `Delete account second-account on ${origin}` : `删除 ${origin} 上的账号 second-account`;
					await workbench.dialogs.confirm(application, labels.confirm, labels.confirm, () => panel.getByRole('button', { name: deleteName, exact: true }).click());
					await expect(panel.getByRole('listitem')).toHaveCount(1);
					await workbench.dialogs.confirm(application, labels.confirm, labels.confirm, () => panel.getByRole('button', { name: labels.clear, exact: true }).click());
					await expect(panel.getByRole('listitem')).toHaveCount(0);
					await closeSettings();
					await navigate();
					await enter('input[name=username]', 'second-account');
					await click('input[name=password]');
					await expect.poll(values).toEqual(['second-account', '']);
					expect(accepted).toEqual(['synthetic-account', 'synthetic-account', 'second-account', 'not-saved']);
					expect(await readFile(join(storagePath, 'workbench-state.json'), 'utf8')).not.toContain('browser.passwords.');
					await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
				} finally {
					await (application as ElectronApplication)
						.evaluate(() => (globalThis as typeof globalThis & { passwordToggleCapture?: { dispose(): void } }).passwordToggleCapture?.dispose())
						.catch(() => {});
					await view?.dispose();
					server.closeAllConnections();
					await new Promise<void>(resolve => server.close(() => resolve()));
				}
			},
		);

		test(
			'username-first GET and SPA Fetch/XHR logins preserve account binding and isolation',
			{ tag: ['@electron-ui'] },
			async ({ application: initialApplication, workbench: initialWorkbench, reloadWorkbench }) => {
				test.setTimeout(180_000);
				let application = initialApplication;
				let workbench = initialWorkbench;
				let password = 'multi-step-password';
				const username = 'multi@example.test';
				let pendingLogin: Promise<void> | undefined;
				let releaseLogin: (() => void) | undefined;
				let signedInUser = '';
				const accepted: string[] = [];
				const usernameStep = '<title>Username step</title><form action="/steps/password"><input name="username" type="email" autocomplete="username"><button>Next</button></form>';
				const passwordStep =
					'<title>Password step</title><form method="post" action="/steps/login"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>';
				const spa = (kind: string) => {
					const fields =
						'<input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button type="' +
						(kind === 'form' ? 'submit' : 'button') +
						'">Sign in</button><p role="alert"></p>';
					const panel =
						kind === 'steps'
							? '<div id="login" role="form"><input name="username" autocomplete="username"><button type="button">Next</button></div>'
							: ['form', 'retarget'].includes(kind)
								? '<form id="login">' + fields + '</form>'
								: '<div id="login">' + fields + '</div>';
					return `<title>SPA login</title>${panel}<script>
				const panel=document.getElementById('login'); let account='';
				if(${JSON.stringify(kind)}==='retarget'){panel.querySelector('[name=username]').oninput=()=>{panel.action='https://other.example/login';};}
				function complete(){history.pushState({},'', '/spa/account'); panel.innerHTML='<h1>Welcome</h1>'; document.title='SPA account';}
				async function login(event){event.preventDefault(); const user=panel.querySelector('[name=username]'); if(user)account=user.value;
				const data=JSON.stringify({username:account,password:panel.querySelector('[name=password]').value}); let result;
				for(const input of panel.querySelectorAll('input'))input.disabled=true; const busy=document.createElement('p');busy.textContent='Signing in';panel.append(busy);document.title='Signing in';
				if(${JSON.stringify(kind)}==='xhr'){result=await new Promise(resolve=>{const request=new XMLHttpRequest();request.open('POST','/api/login');request.onload=()=>resolve(JSON.parse(request.responseText));request.send(data);});}
				else{result=await (await fetch('/api/login',{method:'POST',body:data})).json();}
				if(!result.ok){for(const input of panel.querySelectorAll('input'))input.disabled=false;document.title='SPA rejected';return;}
				if(${JSON.stringify(kind)}!=='steps'){complete();return;}
				panel.innerHTML='<input name="code" type="password" autocomplete="one-time-code"><button type="button">Verify</button>';document.title='Verification step';
				panel.querySelector('button').onclick=async()=>{const result=await (await fetch('/api/verify',{method:'POST',body:panel.querySelector('input').value})).json();if(result.ok)complete();};}
				if(${JSON.stringify(kind)}==='steps'){panel.querySelector('button').onclick=()=>{account=panel.querySelector('input').value; panel.innerHTML='<input name="password" type="password" autocomplete="current-password"><button type="button">Sign in</button>';history.pushState({},'', '/spa/password');document.title='SPA password';panel.querySelector('button').onclick=login;};}
				else if(${JSON.stringify(kind)}==='form'){panel.onsubmit=login;}else{panel.querySelector('button').onclick=login;}
				</script>`;
				};
				const server = createServer(async (request, response) => {
					const url = new URL(request.url!, 'http://fixture.test');
					if (request.method === 'POST') {
						const chunks: Buffer[] = [];
						for await (const chunk of request) {
							chunks.push(Buffer.from(chunk));
						}
						const body = Buffer.concat(chunks).toString();
						if (url.pathname === '/api/verify') {
							response.setHeader('Content-Type', 'application/json');
							response.end(JSON.stringify({ ok: body === '123456' }));
							return;
						}
						const data =
							url.pathname === '/steps/login'
								? { username: signedInUser, password: new URLSearchParams(body).get('password') }
								: (JSON.parse(body) as { username: string; password: string });
						const ok = data.username === username && data.password === password;
						if (ok) {
							accepted.push(url.pathname);
						}
						if (url.pathname.startsWith('/api/')) {
							await pendingLogin;
							response.setHeader('Content-Type', 'application/json');
							response.end(JSON.stringify({ ok }));
							return;
						}
						if (!ok) {
							response.setHeader('Content-Type', 'text/html');
							response.end(passwordStep.replace('Password step', 'Password rejected'));
							return;
						}
						response.writeHead(303, { Location: '/account' });
						response.end();
						return;
					}
					response.setHeader('Content-Type', 'text/html');
					if (url.pathname === '/steps/password' && url.searchParams.has('username')) {
						signedInUser = url.searchParams.get('username')!;
					}
					response.end(
						url.pathname === '/steps/user'
							? usernameStep
							: url.pathname === '/steps/password'
								? passwordStep
								: url.pathname === '/account'
									? '<title>Signed in</title><h1>Account</h1>'
									: spa(url.pathname.split('/').at(-1)!),
					);
				});
				const other = createServer((_request, response) => {
					response.setHeader('Content-Type', 'text/html');
					response.end(passwordStep);
				});
				for (const service of [server, other]) {
					await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
				}
				const endpoint = (service: typeof server) => {
					const address = service.address();
					if (!address || typeof address === 'string') {
						throw new Error('Missing login endpoint');
					}
					return `http://127.0.0.1:${address.port}`;
				};
				const origin = endpoint(server);
				const otherOrigin = endpoint(other);
				const addressLabel = locale === 'en' ? 'Browser address' : '浏览器地址';
				const saveTitle = locale === 'en' ? 'Save website password' : '保存网站密码';
				const updateTitle = locale === 'en' ? 'Update website password' : '更新网站密码';
				const saveLabel = locale === 'en' ? 'Save password' : '保存密码';
				const updateLabel = locale === 'en' ? 'Update password' : '更新密码';
				type Capture = { unexpected: string[]; restore(): void };
				const capture = () =>
					(application as ElectronApplication).evaluate(({ dialog }) => {
						const original = dialog.showMessageBox;
						const state = globalThis as typeof globalThis & { passwordPrompts?: Capture };
						state.passwordPrompts = {
							unexpected: [],
							restore: () => {
								dialog.showMessageBox = original;
								delete state.passwordPrompts;
							},
						};
						dialog.showMessageBox = ((...args: [Electron.MessageBoxOptions] | [Electron.BrowserWindow, Electron.MessageBoxOptions]) => {
							const options = args.length === 1 ? args[0] : args[1];
							state.passwordPrompts!.unexpected.push(options.title ?? '');
							return Promise.resolve({ response: options.cancelId ?? 0, checkboxChecked: false });
						}) as typeof dialog.showMessageBox;
					});
				const unexpected = () => (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { passwordPrompts?: Capture }).passwordPrompts?.unexpected ?? []);
				const editor = () => workbench.page.locator('.ash-browser-editor');
				const acquire = (prefix = origin) =>
					(application as ElectronApplication).evaluateHandle(
						({ BrowserWindow }, prefix) =>
							BrowserWindow.getAllWindows()
								.flatMap(window => window.contentView.children)
								.find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().startsWith(prefix)) as Electron.WebContentsView,
						prefix,
					);
				let view: Awaited<ReturnType<typeof acquire>> | undefined;
				const read = (selector: string) => view!.evaluate((view, selector) => view.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.value`), selector);
				const click = (selector: string) => clickBrowserControl(view!, selector);
				const enter = async (selector: string, value: string) => {
					await click(selector);
					await view!.evaluate(view => view.webContents.selectAll());
					await expect
						.poll(() =>
							view!.evaluate(view =>
								view.webContents.executeJavaScript(
									'document.activeElement.selectionStart===null||(document.activeElement.selectionStart===0&&document.activeElement.selectionEnd===document.activeElement.value.length)',
								),
							),
						)
						.toBe(true);
					await view!.evaluate((view, value) => view.webContents.insertText(value), value);
					await expect.poll(() => read(selector)).toBe(value);
				};
				const navigate = async (path: string, title: string, base = origin) => {
					const previous = view && (await view.evaluate(view => view.webContents.executeJavaScript('performance.timeOrigin')));
					const address = editor().getByRole('textbox', { name: addressLabel, exact: true });
					await address.fill(base + path);
					await address.press('Enter');
					await expect(editor().getByRole('status')).toHaveText(title);
					if (view) {
						await expect.poll(() => view!.evaluate(view => view.webContents.executeJavaScript('performance.timeOrigin'))).not.toBe(previous);
						await expect.poll(() => view!.evaluate(view => view.webContents.isLoading())).toBe(false);
					}
				};
				const state = () => workbench.page.evaluate(() => globalThis.ashTestMainProcess.call<BrowserPasswordState>('browserPasswords', 'readState', []));
				try {
					await capture();
					await installMainChannelTestClient(workbench.page);
					await workbench.page.evaluate(() =>
						globalThis.ashTestMainProcess.call('browserView', 'getOrCreateBrowserView', [
							'browser_target_' + crypto.randomUUID(),
							{ initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: 'global' } },
						]),
					);
					await navigate('/steps/user', 'Username step');
					view = await acquire();
					await enter('[name=username]', username);
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('Password step');
					await enter('[name=password]', 'rejected');
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('Password rejected');
					expect((await state()).entries).toHaveLength(0);
					await enter('[name=password]', password);
					await workbench.dialogs.confirm(application, saveTitle, saveLabel, () => click('button'));
					await expect.poll(async () => (await state()).entries.length).toBe(1);
					expect(await unexpected()).toEqual([]);
					await view.dispose();
					view = undefined;
					({ application, workbench } = await reloadWorkbench());
					await capture();
					await installMainChannelTestClient(workbench.page);
					await navigate('/steps/user', 'Username step');
					view = await acquire();
					await click('[name=username]');
					await expect.poll(() => read('[name=username]')).toBe(username);
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('Password step');
					await click('[name=password]');
					await expect.poll(() => read('[name=password]')).toBe(password);

					await navigate('/spa/form', 'SPA login');
					await click('[name=username]');
					await expect.poll(() => read('[name=password]')).toBe(password);
					await enter('[name=password]', 'rejected');
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('SPA rejected');
					expect(await unexpected()).toEqual([]);
					password = 'fetch-updated-password';
					await enter('[name=password]', password);
					pendingLogin = new Promise<void>(resolve => {
						releaseLogin = resolve;
					});
					await workbench.dialogs.confirm(application, updateTitle, updateLabel, async () => {
						try {
							await click('button');
							await expect(editor().getByRole('status')).toHaveText('Signing in');
							await view!.evaluate(view => view.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'));
							expect(
								await (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { ashTestMessage?: { options?: unknown } }).ashTestMessage?.options),
							).toBeUndefined();
						} finally {
							releaseLogin!();
							pendingLogin = undefined;
						}
					});
					await expect(editor().getByRole('status')).toHaveText('SPA account');
					await navigate('/spa/xhr', 'SPA login');
					await click('[name=username]');
					await expect.poll(() => read('[name=password]')).toBe(password);
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('SPA account');

					await navigate('/spa/steps', 'SPA login');
					await click('[name=username]');
					await expect.poll(() => read('[name=username]')).toBe(username);
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('SPA password');
					await click('[name=password]');
					await expect.poll(() => read('[name=password]')).toBe(password);
					password = 'verification-updated-password';
					await enter('[name=password]', password);
					await click('button');
					await expect(editor().getByRole('status')).toHaveText('Verification step');
					await click('[name=code]');
					await expect.poll(() => read('[name=code]')).toBe('');
					expect(await unexpected()).toEqual([]);
					await enter('[name=code]', '123456');
					await workbench.dialogs.confirm(application, updateTitle, updateLabel, () => click('button'));
					await expect(editor().getByRole('status')).toHaveText('SPA account');
					await navigate('/spa/retarget', 'SPA login');
					await click('[name=username]');
					await expect.poll(() => read('[name=username]')).toBe(username);
					await expect.poll(() => read('[name=password]')).toBe('');
					await navigate('/steps/password', 'Password step', otherOrigin);
					await click('[name=password]');
					await expect.poll(() => read('[name=password]')).toBe('');

					await view.dispose();
					view = undefined;
					const workspaceUrl = origin + '/steps/password?scope=workspace';
					await workbench.page.evaluate(
						url =>
							globalThis.ashTestMainProcess.call('browserView', 'getOrCreateBrowserView', [
								'browser_target_' + crypto.randomUUID(),
								{ initialUrl: url, owner: { type: 'user' }, session: { scope: 'workspace' } },
							]),
						workspaceUrl,
					);
					await expect(editor().getByRole('status')).toHaveText('Password step');
					view = await acquire(workspaceUrl);
					await click('[name=password]');
					await expect.poll(() => read('[name=password]')).toBe('');
					expect((await state()).entries.map(entry => [entry.username, entry.scope])).toEqual([[username, 'global']]);
					expect(await unexpected()).toEqual([]);
					expect(accepted).toEqual(['/steps/login', '/api/login', '/api/login', '/api/login']);
					await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
				} finally {
					releaseLogin?.();
					await view?.dispose();
					await (application as ElectronApplication).evaluate(() => (globalThis as typeof globalThis & { passwordPrompts?: Capture }).passwordPrompts?.restore()).catch(() => {});
					for (const service of [server, other]) {
						service.closeAllConnections();
						await new Promise<void>(resolve => service.close(() => resolve()));
					}
				}
			},
		);
	});
}

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// Exercise the sandbox preload with trusted Chromium input and a test-owned IPC sink.
const preload = transpileModule(
	readFileSync(
		new URL('../../../src/ash/platform/browserView/electron-browser/preload-browserView.ts', import.meta.url),
		'utf8',
	),
	{ compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } },
).outputText;

for (const nativeForm of [true, false]) {
	test(`Browser password submission ignores visibility toggles and retains ${nativeForm ? 'native form validation and keyboard submit' : 'SPA click submission'}`, async ({
		page,
	}) => {
		const tag = nativeForm ? 'form' : 'div role="form"';
		await page.route('https://password.test/**', route =>
			route.fulfill({
				contentType: 'text/html',
				body: `<!doctype html>
			<${tag} id="login">
			<label>Account<input name="username" autocomplete="username"></label>
			<label>Password<input name="password" type="password" autocomplete="current-password"></label>
			<button type="${nativeForm ? 'submit' : 'button'}" id="submit">Sign in</button>
			<button type="button" id="show">Show password</button>
			<button type="${nativeForm ? 'submit' : 'button'}" id="toggle">Toggle visibility</button>
			${nativeForm ? '<label>Required<input name="required" required></label>' : ''}
			</${nativeForm ? 'form' : 'div'}>
			<script>
			const login = document.getElementById('login');
			for (const id of ['show', 'toggle']) document.getElementById(id).onclick = event => {
				event.preventDefault();
				const input = login.querySelector('[name=password]');
				input.type = input.type === 'password' ? 'text' : 'password';
			};
			${nativeForm ? 'login.onsubmit = event => event.preventDefault();' : `document.getElementById('submit').onclick = () => { login.innerHTML = '<p>Signed in</p>'; };`}
			</script>`,
			}),
		);
		type PasswordHost = { passwordMessages: { type: string; data: unknown }[] };
		await page.addInitScript(() => {
			const host = window as unknown as PasswordHost;
			host.passwordMessages = [];
			Object.assign(window, {
				require: () => ({
					contextBridge: { exposeInIsolatedWorld() {} },
					ipcRenderer: {
						send(_channel: string, message: { type: string; data: unknown }) {
							if (['passwordSubmitted', 'passwordIdentitySubmitted'].includes(message.type))
								host.passwordMessages.push({ type: message.type, data: message.data });
						},
						on() {},
					},
				}),
			});
		});
		await page.addInitScript(preload);
		await page.goto('https://password.test/login');
		await page.getByRole('textbox', { name: 'Account' }).fill('user@example.test');
		await page.getByLabel('Password', { exact: true }).fill('unverified-value');
		for (const id of ['show', 'show', 'toggle', 'toggle']) {
			await page.locator(`#${id}`).click();
			// Cross an event-loop turn so deferred SPA click classification has run.
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
			expect(await page.evaluate(() => (window as unknown as PasswordHost).passwordMessages)).toEqual([]);
		}
		if (nativeForm) {
			await page.getByRole('button', { name: 'Sign in', exact: true }).click();
			expect(await page.evaluate(() => (window as unknown as PasswordHost).passwordMessages)).toEqual([]);
			await page.getByRole('textbox', { name: 'Required' }).fill('valid');
			await page.getByLabel('Password', { exact: true }).press('Enter');
		} else {
			await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		}
		await expect
			.poll(() => page.evaluate(() => (window as unknown as PasswordHost).passwordMessages))
			.toEqual([
				{
					type: 'passwordSubmitted',
					data: {
						action: 'https://password.test/login',
						username: 'user@example.test',
						hasUsername: true,
						password: 'unverified-value',
					},
				},
			]);
	});
}

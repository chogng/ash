import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// Exercise the sandbox preload with trusted Chromium input and a test-owned IPC sink.
const preload = transpileModule(readFileSync(new URL('../../../src/ash/platform/browserView/electron-browser/preload-browserView.ts', import.meta.url), 'utf8'), {
	compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;

for (const nativeForm of [true, false]) {
	test(`Browser password submission ignores visibility toggles and retains ${nativeForm ? 'native form validation and keyboard submit' : 'SPA click submission'}`, async ({ page }) => {
		const tag = nativeForm ? 'form' : 'div role="form"';
		await page.route('https://password.test/**', route => route.fulfill({
			contentType: 'text/html', body: `<!doctype html>
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
			</script>` }));
		type PasswordHost = { passwordMessages: { type: string; data: unknown; }[]; };
		await page.addInitScript(() => {
			const host = window as unknown as PasswordHost;
			host.passwordMessages = [];
			Object.assign(window, {
				require: () => ({
					contextBridge: { exposeInIsolatedWorld() { } }, ipcRenderer: {
						send(_channel: string, message: { type: string; data: unknown; }) {
							if (['passwordSubmitted', 'passwordIdentitySubmitted'].includes(message.type)) host.passwordMessages.push({ type: message.type, data: message.data });
						}, on() { },
					}
				})
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
		await expect.poll(() => page.evaluate(() => (window as unknown as PasswordHost).passwordMessages)).toEqual([{
			type: 'passwordSubmitted', data: { action: 'https://password.test/login', username: 'user@example.test', hasUsername: true, password: 'unverified-value' },
		}]);
	});
}


type PasswordTargetHost = { fillRequests: number; submissions: number; fillPassword?: () => void; };

const targetCases = [
	{ name: 'same-origin button', submitter: '<button formaction="/submit">Sign in</button>', allowed: true },
	{ name: 'cross-origin button', submitter: '<button formaction="https://other.test/submit">Sign in</button>', allowed: false },
	{ name: 'same-origin image', submitter: '<input type="image" formaction="/submit">', allowed: true },
	{ name: 'cross-origin image', submitter: '<input type="image" formaction="https://other.test/submit">', allowed: false },
	{ name: 'external associated image', outside: '<input type="image" form="login" formaction="https://other.test/submit">', allowed: false },
	{ name: 'image owned by another form', submitter: '<input type="image" form="other" formaction="https://other.test/submit">', outside: '<form id="other"></form>', allowed: true },
	{ name: 'same-origin document base', base: 'https://password.test/base/', submitter: '<button formaction="submit">Sign in</button>', allowed: true },
	{ name: 'cross-origin document base with relative override', base: 'https://other.test/base/', submitter: '<button formaction="submit">Sign in</button>', allowed: false },
	{ name: 'cross-origin document base with relative image override', base: 'https://other.test/base/', submitter: '<input type="image" formaction="submit">', allowed: false },
	{ name: 'cross-origin document base with same-origin override', base: 'https://other.test/base/', submitter: '<button formaction="https://password.test/submit">Sign in</button>', allowed: true },
	{ name: 'cross-origin document base with empty image override', base: 'https://other.test/base/', submitter: '<input type="image" formaction="">', allowed: true },
	{ name: 'cross-origin document base without override', base: 'https://other.test/base/', submitter: '<button>Sign in</button>', allowed: true },
	{ name: 'cross-origin form action', action: 'https://other.test/submit', allowed: false },
	{ name: 'cross-origin document base with relative form action', base: 'https://other.test/base/', action: 'submit', allowed: false },
	{ name: 'malformed override', submitter: '<button formaction="https://[">Sign in</button>', allowed: false },
	{ name: 'non-submitting control override', submitter: '<button type="button" formaction="https://other.test/submit">Show password</button>', allowed: true },
];

// The sink retains only counts; all supplied credentials are synthetic and stay in this page.
async function installPasswordTargetHost(page: import('@playwright/test').Page): Promise<void> {
	await page.addInitScript(() => {
		const host = window as unknown as PasswordTargetHost;
		host.fillRequests = 0;
		host.submissions = 0;
		let receive: ((event: unknown, message: unknown) => void) | undefined;
		Object.assign(window, {
			require: () => ({
				contextBridge: { exposeInIsolatedWorld() { } },
				ipcRenderer: {
					on(_channel: string, listener: typeof receive) { receive = listener; },
					send(_channel: string, message: { type: string; frameToken: string; data?: { formId: string; field: string; }; }) {
						if (message.type === 'passwordSubmitted') host.submissions++;
						if (message.type !== 'passwordFill') return;
						host.fillRequests++;
						host.fillPassword = () => receive?.({}, {
							command: 'fillPassword', data: {
								token: message.frameToken, formId: message.data!.formId, field: message.data!.field,
								origin: location.origin, username: 'fixture-account', password: 'fixture-password',
							}
						});
					},
				},
			})
		});
	});
	await page.addInitScript(preload);
}

for (const target of targetCases) {
	test(`Browser password target checks: ${target.name}`, async ({ page }) => {
		await installPasswordTargetHost(page);
		await page.route('https://password.test/**', route => route.fulfill({
			contentType: 'text/html', body: `<!doctype html>
			${target.base ? `<base href="${target.base}">` : ''}
			<form id="login" action="${target.action ?? 'https://password.test/login'}">
			<input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password">
			${target.submitter ?? '<button>Sign in</button>'}</form>${target.outside ?? ''}
			<script>document.getElementById('login').onsubmit = event => event.preventDefault();</script>` }));
		await page.goto('https://password.test/login');
		await page.locator('[name=username]').click();
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
		expect(await page.evaluate(() => (window as unknown as PasswordTargetHost).fillRequests)).toBe(target.allowed ? 1 : 0);
		await page.evaluate(() => (window as unknown as PasswordTargetHost).fillPassword?.());
		expect(await page.locator('[name=password]').evaluate((input: HTMLInputElement) => input.value === 'fixture-password')).toBe(target.allowed);
		// The same target validation also gates capture of manually entered credentials.
		await page.locator('[name=username]').fill('manual-account');
		await page.locator('[name=password]').fill('manual-password');
		await page.locator('[name=password]').click();
		await page.locator('#login').evaluate((form: HTMLFormElement) => form.requestSubmit());
		expect(await page.evaluate(() => (window as unknown as PasswordTargetHost).submissions)).toBe(target.allowed ? 1 : 0);
	});
}

for (const mutation of ['image', 'base'] as const) {
	test(`Browser password target checks: recheck ${mutation} after controlled username input`, async ({ page }) => {
		await installPasswordTargetHost(page);
		await page.route('https://password.test/**', route => route.fulfill({
			contentType: 'text/html', body: `<!doctype html>
			<base href="https://password.test/base/">
			<form id="login" action="https://password.test/login">
			<input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password">
			<input id="submit" type="image" formaction="submit"></form>
			<script>document.querySelector('[name=username]').oninput = () => {
				${mutation === 'image' ? `document.getElementById('submit').setAttribute('formaction', 'https://other.test/submit');` : `document.querySelector('base').href = 'https://other.test/base/';`}
			};</script>` }));
		await page.goto('https://password.test/login');
		await page.locator('[name=username]').click();
		expect(await page.evaluate(() => (window as unknown as PasswordTargetHost).fillRequests)).toBe(1);
		await page.evaluate(() => (window as unknown as PasswordTargetHost).fillPassword?.());
		await expect(page.locator('[name=username]')).toHaveValue('fixture-account');
		await expect(page.locator('[name=password]')).toHaveValue('');
	});
}

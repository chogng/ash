import { expect, test } from '@playwright/test';

test('the distributed SSH package declares a V8 entry and localized labels', async ({ page }) => {
	await page.goto('/remoteAuthorityResolver.html');
	try {
		const info = await page.evaluate(() => window.remoteAuthorityIntegration.packageInfo());
		expect(info).toMatchObject({ manifest: { main: './src/extension.js' }, english: 'SSH Remote Connections', chinese: 'SSH 远程连接' });
		expect(info.manifest.browser).toBeUndefined();
	} finally { await page.evaluate(() => window.remoteAuthorityIntegration.dispose()); }
});

test('Browser Workers cannot register SSH or impersonate the V8 product extension', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/remoteAuthorityResolver.html');
	try {
		const external = await page.evaluate(() => window.remoteAuthorityIntegration.activate());
		expect(external).toMatchObject({ lifecycle: 'failed', failure: { code: 'activationFailed', message: expect.stringContaining('ssh prefix') }, registrations: [] });
		const impersonated = await page.evaluate(() => window.remoteAuthorityIntegration.activate('builtIn', 'ash.remote-ssh'));
		expect(impersonated).toMatchObject({ lifecycle: 'failed', failure: { code: 'activationFailed', message: expect.stringContaining('V8 host') }, registrations: [] });
		const localized = await page.evaluate(() => window.remoteAuthorityIntegration.activate('user', 'ash.remote-ssh', 'zh-CN'));
		expect(localized).toMatchObject({ failure: { message: 'TypeError: 产品 SSH 扩展必须在 V8 宿主中执行' }, registrations: [] });
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.remoteAuthorityIntegration.dispose()); }
});

import { expect, test } from '@playwright/test';

test('Browser Workers cannot register SSH or impersonate the Rust product extension', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/remoteAuthorityResolver.html');
	try {
		const info = await page.evaluate(() => window.remoteAuthorityIntegration.packageInfo());
		expect(info).toMatchObject({ manifest: { publisher: 'ash', name: 'remote-ssh' }, english: 'SSH Remote Connections', chinese: 'SSH 远程连接' });
		expect(info.manifest.main).toBeUndefined();
		expect(info.manifest.browser).toBeUndefined();
		const external = await page.evaluate(() => window.remoteAuthorityIntegration.activate());
		expect(external).toBeUndefined();
		const impersonated = await page.evaluate(() => window.remoteAuthorityIntegration.activate('builtIn', 'ash.remote-ssh'));
		expect(impersonated).toMatchObject({ lifecycle: 'failed', failure: { code: 'activationFailed', message: expect.stringContaining('Rust provider') }, registrations: [] });
		const localized = await page.evaluate(() => window.remoteAuthorityIntegration.activate('builtIn', 'ash.remote-ssh', 'zh-CN'));
		expect(localized).toMatchObject({ failure: { message: 'TypeError: 产品 SSH 扩展必须作为 Rust Provider 执行' }, registrations: [] });
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.remoteAuthorityIntegration.dispose()); }
});

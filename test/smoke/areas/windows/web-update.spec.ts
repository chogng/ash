import { expect, test } from '../../../automation/test.js';

for (const entry of ['workbench', 'sessions'] as const) {
	test(
		`the production ${entry} Web host checks its deployed frontend version`,
		{ tag: ['@browser-ui', '@browser-app-server'] },
		async ({ workbench }) => {
			const page = workbench.page;
			if (entry === 'sessions') {
				await page.goto(new URL('../sessions/sessions.html', page.url()).href);
				await expect(page.locator('.ash-sessions-window')).toBeVisible();
			}
			const metadata = page.locator('meta[name="ash-web-build"]');
			await expect(metadata).toHaveAttribute('content', /^[a-f0-9]{64}$/u);
			const manifestUrl = await metadata.evaluate(
				element => new URL(element.getAttribute('data-version-url')!, document.baseURI).href,
			);
			const response = page.waitForResponse(
				response => response.url() === manifestUrl && response.request().method() === 'GET',
			);
			await workbench.quickaccess.runCommand('update.checkForUpdate');
			const latest = await response;
			expect(latest.ok()).toBe(true);
			expect(await latest.json()).toEqual({ version: await metadata.getAttribute('content') });
			await expect(
				page.locator('.ash-notification-host').getByText('Ash is up to date.', { exact: true }),
			).toBeVisible();
		},
	);
}

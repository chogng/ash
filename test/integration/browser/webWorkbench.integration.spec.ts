import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

test.beforeEach(async ({ page }) => {
	page.on('pageerror', error => console.error(error));
	await page.goto('/webWorkbench.html');
	await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
});

test('the built-in provider checks real HTTP deployments under a prefix and reloads into the new build', async ({ page, baseURL }) => {
	const source = new URL(baseURL!);
	const html = await (await fetch(new URL('/webWorkbench.html', source))).text();
	const original: { version: string; } = await (await fetch(new URL('/web-version.json', source))).json();
	let deployment = original.version;
	let broken = false;
	let probes = 0;
	// Model publishing a new static directory; the provider and HTTP requests are production code.
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url!, source);
			if (url.pathname === '/prefix/web-version.json') {
				probes++;
				response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
				response.end(JSON.stringify(broken ? { version: 42 } : { version: deployment }));
			} else if (url.pathname === '/prefix/webWorkbench.html') {
				response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
				response.end(html.replaceAll(original.version, deployment));
			} else {
				url.pathname = url.pathname.replace(/^\/prefix\//u, '/');
				const upstream = await fetch(url);
				response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream' });
				response.end(Buffer.from(await upstream.arrayBuffer()));
			}
		})().catch(error => { response.writeHead(500); response.end(String(error)); });
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Expected an HTTP fixture port');
		await page.goto(`http://127.0.0.1:${address.port}/prefix/webWorkbench.html?deployed`);
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		await expect.poll(() => probes).toBe(1);
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().supported)).toBe(true);
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		await expect(page.getByText('Ash is up to date.', { exact: true })).toBeVisible();
		const before = probes;
		deployment = createHash('sha256').update(`${deployment}:next-deployment`).digest('hex');
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		expect(probes).toBeGreaterThan(before); // A long-lived cache response must not hide the deployment change.
		const reload = page.getByRole('button', { name: 'Reload to Update', exact: true });
		await expect(reload).toBeVisible();
		await Promise.all([page.waitForEvent('framenavigated', frame => frame === page.mainFrame()), reload.click()]);
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().build)).toBe(deployment);
		await expect(reload).toHaveCount(0);
		broken = true;
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		await expect(page.getByText('Could not check for updates.', { exact: true })).toBeVisible();
		broken = false;
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		await expect(page.getByText('Ash is up to date.', { exact: true })).toBeVisible();
	} finally {
		const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		server.closeAllConnections();
		await stopped;
	}
});

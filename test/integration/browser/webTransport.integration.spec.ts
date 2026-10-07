import { test, expect, type WebSocketRoute } from '@playwright/test';

for (const failure of ['close', 'binary'] as const) {
	test(`built Web transport sends raw frames and handles ${failure}`, async ({ page }) => {
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket('**/ash/app-server', route => {
			socket = route;
			route.onMessage(message => {
				route.send(String(message));
			});
		});
		await page.goto('/webTransport.html');
		await page.evaluate(() => window.ashWebTransportIntegration.start());
		await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages[0]?.event)).toBe('ash:app-server:connected');
		await page.evaluate(() => window.ashWebTransportIntegration.send('{"id":1}'));
		await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages[1])).toEqual({ event: 'ash:app-server:frame', payload: { frame: '{"id":1}' } });
		expect(socket).toBeDefined();
		if (failure === 'close') socket!.close();
		else socket!.send(Buffer.from([1, 2, 3]));
		await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages[2]?.event)).toBe('ash:app-server:closed');
		await page.evaluate(() => window.ashWebTransportIntegration.dispose());
		expect(await page.evaluate(() => window.ashWebTransportIntegration.messages.length)).toBe(3);
	});
}


for (const status of [200, 401, 403]) {
	test(`reconnection reauthorizes before opening a socket: HTTP ${status}`, async ({ page }) => {
		const sockets: WebSocketRoute[] = [];
		await page.routeWebSocket('**/ash/app-server', route => { sockets.push(route); });
		let release!: () => void;
		const authentication = new Promise<void>(resolve => { release = resolve; });
		let authorizations = 0;
		await page.route('**/ash/session', async route => {
			expect(route.request().method()).toBe('POST');
			expect(route.request().headers()['authorization']).toBe(`Bearer ${'a'.repeat(64)}`);
			authorizations++;
			await authentication;
			await route.fulfill({ status, json: { token: 'a'.repeat(64), workspaceId: 'test', workspaceRoot: '/test' } });
		});
		await page.goto('/webTransport.html');
		await page.evaluate(() => window.ashWebTransportIntegration.start());
		await expect.poll(() => sockets.length).toBe(1);
		sockets[0].close();
		await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages.at(-1)?.event)).toBe('ash:app-server:closed');
		await page.evaluate(() => window.ashWebTransportIntegration.reconnect());
		await expect.poll(() => authorizations).toBe(1);
		expect(sockets).toHaveLength(1);
		release();
		if (status === 200) {
			await expect.poll(() => sockets.length).toBe(2);
			await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages.at(-1)?.event)).toBe('ash:app-server:connected');
		} else {
			await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages.at(-1)?.payload)).toEqual({ intentional: true, message: 'Web authorization expired or was revoked. Open a new authenticated link.' });
			expect(sockets).toHaveLength(1);
		}
		await page.evaluate(() => window.ashWebTransportIntegration.dispose());
	});
}

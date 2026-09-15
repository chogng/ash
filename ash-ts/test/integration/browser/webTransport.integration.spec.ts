import { test, expect, type WebSocketRoute } from '@playwright/test';

for (const failure of ['close', 'malformed'] as const) {
	test(`built Web transport sends queued requests and handles ${failure}`, async ({ page }) => {
		let socket: WebSocketRoute | undefined;
		await page.routeWebSocket('**/ash/app-server', route => {
			socket = route;
			route.onMessage(message => {
				const request = JSON.parse(String(message));
				if (request.event === 'ash:app-server:connect') {
					route.send(JSON.stringify({ event: 'ash:app-server:connected', payload: { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' } }));
				} else route.send(String(message));
			});
		});
		await page.goto('/webTransport.html');
		await page.evaluate(() => window.ashWebTransportIntegration.start());
		await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages[0]?.event)).toBe('ash:app-server:connected');
		await page.evaluate(() => window.ashWebTransportIntegration.send('{"id":1}'));
		await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages[1])).toEqual({ event: 'ash:app-server:frame', payload: { frame: '{"id":1}' } });
		expect(socket).toBeDefined();
		if (failure === 'close') socket!.close();
		else socket!.send('{');
		await expect.poll(() => page.evaluate(() => window.ashWebTransportIntegration.messages[2]?.event)).toBe('ash:app-server:closed');
		await page.evaluate(() => window.ashWebTransportIntegration.dispose());
		expect(await page.evaluate(() => window.ashWebTransportIntegration.messages.length)).toBe(3);
	});
}

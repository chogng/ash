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

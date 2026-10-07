import { test, expect } from '@playwright/test';

test('standalone starts from built chunks without a development server', async ({ page }, testInfo) => {
	const requests: string[] = [];
	page.on('request', request => requests.push(request.url()));
	await page.goto('/standalone.html');
	await page.waitForFunction(() => 'ashStandaloneIntegration' in window);
	const metrics = await page.evaluate(() => ({
		readyMilliseconds: performance.now(),
		resources: performance.getEntriesByType('resource').map(entry => {
			const resource = entry as PerformanceResourceTiming;
			return { name: resource.name, bytes: resource.decodedBodySize, durationMilliseconds: resource.duration };
		}),
	}));
	expect(requests.some(url => url.includes('/assets/') && url.endsWith('.js'))).toBe(true);
	expect(requests.filter(url => /\/@vite\/|\/@fs\/|\.ts(?:\?|$)/.test(url))).toEqual([]);
	await testInfo.attach('initial-load.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
});

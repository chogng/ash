import type { CDPSession, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';

test('production loading baseline', async ({ target, workbench }, testInfo) => {
	test.skip(process.env.ASH_LOADING_BASELINE !== '1' || target.kind !== 'browser' || target.appServerMode !== 'required', 'Opt-in production Web loading measurement');
	test.setTimeout(90_000);
	const page = workbench.page;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
	await cdp.send('Performance.enable');
	let stage = 'startup';
	const requests = new Map<string, { stage: string; url: string; type: string; bytes: number | null; status?: number; cached?: boolean; failed?: string }>();
	cdp.on('Network.requestWillBeSent', event => {
		if (event.request.url.startsWith('http')) requests.set(event.requestId, { stage, url: event.request.url, type: event.type ?? 'Other', bytes: null });
	});
	cdp.on('Network.responseReceived', event => {
		const request = requests.get(event.requestId);
		if (request) Object.assign(request, { status: event.response.status, cached: Boolean(event.response.fromDiskCache || event.response.fromServiceWorker) });
	});
	cdp.on('Network.loadingFinished', event => {
		const request = requests.get(event.requestId);
		if (request) request.bytes = event.encodedDataLength;
	});
	cdp.on('Network.loadingFailed', event => {
		const request = requests.get(event.requestId);
		if (request) request.failed = event.errorText;
	});
	const samples: { stage: string; elapsedMs: number; scriptMs: number; taskMs: number; resources: unknown[] }[] = [];
	async function measure(name: string, action: () => Promise<void>): Promise<void> {
		stage = name;
		const before = await metrics(cdp);
		const start = performance.now();
		await action();
		await workbench.waitForUiIdle();
		const elapsedMs = performance.now() - start;
		const after = await metrics(cdp);
		samples.push({ stage, elapsedMs, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, taskMs: (after.TaskDuration - before.TaskDuration) * 1000, resources: [...requests.values()].filter(request => request.stage === stage).map(request => ({ ...request })) });
	}
	try {
		await measure('startup', async () => {
			await page.reload({ waitUntil: 'domcontentloaded' });
			await page.waitForFunction(() => globalThis.ashWebWorkbenchHost !== undefined);
			await workbench.waitForReady();
		});
		expect([...requests.values()].filter(request => /\/xterm-[^/]+\.js/u.test(request.url))).toEqual([]);
		await expect(page.locator('.xterm')).toHaveCount(0);
		await measure('code', async () => {
			await page.getByRole('button', { name: 'Show Primary Side Bar', exact: true }).click();
			await openFile(page, 'main.ts');
			await expect(workbench.editors.groupAt(0).content.locator('.stanza-editor-input')).toBeAttached();
			await expect(workbench.editors.groupAt(0).content.locator('.stanza-editor-line-text').first()).toContainText('const value = 1;');
		});
		await measure('pdf', async () => {
			await openFile(page, 'paper.pdf');
			await expect(page.locator('.ash-pdf-page-canvas')).toBeVisible();
			await expect.poll(() => page.locator('.ash-pdf-page-canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width > 0 && canvas.height > 0)).toBe(true);
		});
		await measure('terminal', async () => {
			await page.getByRole('button', { name: 'Show Panel', exact: true }).click();
			await expect(page.locator('.ash-terminal-instance .xterm')).toBeVisible();
			await expect(page.locator('.ash-terminal-instance:visible')).toHaveAttribute('data-state', 'running');
		});
		expect([...requests.values()].some(request => request.stage === 'terminal' && /\/xterm-[^/]+\.js/u.test(request.url))).toBe(true);
	} finally {
		const path = testInfo.outputPath('loading-baseline.json');
		await writeFile(path, JSON.stringify({ schemaVersion: 1, repeat: testInfo.repeatEachIndex, environment: { platform: process.platform, arch: process.arch, browser: page.context().browser()?.version(), cache: 'HTTP cache disabled; existing browser process; sequential first-use scenarios', transport: 'loopback HTTP, uncompressed static artifacts', cpu: 'CDP main-renderer ScriptDuration and TaskDuration; excludes worker CPU', timing: 'Playwright action to DOM readiness plus two animation frames; includes automation overhead', network: 'CDP page target; bytes include response overhead; null means completion not observed on this target, not zero bytes; worker-internal requests excluded' }, samples }, null, 2));
		await testInfo.attach('loading-baseline', { path, contentType: 'application/json' });
		await cdp.detach();
	}
});

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
	const { metrics } = await cdp.send('Performance.getMetrics');
	return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
}

async function openFile(page: Page, name: string): Promise<void> {
	const row = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: name });
	await expect(row).toHaveCount(1);
	await row.click();
	await expect(page.locator('.ash-explorer-error')).toHaveCount(0);
}

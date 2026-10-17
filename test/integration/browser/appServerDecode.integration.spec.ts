import { expect, test } from '@playwright/test';

test('App Server Worker separates parse, validation and result serialization costs', async ({ page }, testInfo) => {
	await page.goto('/appServerDecode.html');
	try {
		await page.evaluate(() => window.ashAppServerDecodeIntegration.prepare(2048, 4096));
		await page.evaluate(() => window.ashAppServerDecodeIntegration.run('worker'));
		const worker = page.workers()[0];
		expect(worker).toBeDefined();
		await worker.evaluate(() => {
			const scope = globalThis as unknown as { postMessage(value: unknown): void; decodeTimings?: { parseMs: number; validateMs: number; serializeMs: number; }[]; };
			const parse = JSON.parse;
			const post = scope.postMessage.bind(scope);
			const timings: { parseMs: number; validateMs: number; serializeMs: number; }[] = [];
			scope.decodeTimings = timings;
			let started = 0;
			let parsed = 0;
			JSON.parse = (text, reviver) => {
				started = performance.now();
				const result = parse(text, reviver);
				parsed = performance.now();
				return result;
			};
			scope.postMessage = value => {
				const beforeSend = performance.now();
				post(value);
				const afterSend = performance.now();
				if ((value as { kind?: unknown; }).kind === 'result') timings.push({ parseMs: parsed - started, validateMs: beforeSend - parsed, serializeMs: afterSend - beforeSend });
			};
		});
		for (let run = 0; run < 5; run++) await page.evaluate(() => window.ashAppServerDecodeIntegration.run('worker'));
		const samples = await worker.evaluate(() => (globalThis as unknown as { decodeTimings: { parseMs: number; validateMs: number; serializeMs: number; }[]; }).decodeTimings);
		expect(samples).toHaveLength(5);
		await testInfo.attach('app-server-worker-phases.json', { body: JSON.stringify({ scope: 'Test-owned Worker only: parse and validation through the result postMessage call. Serialization is sender-side synchronous postMessage time; input transfer, receiver deserialization, UI task time and cold startup are excluded. Instrumented results are diagnostic, separate from the uninstrumented comparison.', samples }, null, 2), contentType: 'application/json' });
	} finally { await page.evaluate(() => window.ashAppServerDecodeIntegration.dispose()); }
});

test('App Server queued notifications yield browser tasks, preserve order and drain before EOF', async ({ page }) => {
	await page.goto('/appServerDecode.html');
	try {
		await page.evaluate(() => window.ashAppServerDecodeIntegration.prepare(128, 4096));
		const result = await page.evaluate(() => window.ashAppServerDecodeIntegration.burst());
		expect(result).toMatchObject({ count: 2000, ordered: true, turns: 128, state: 'crashed' });
		expect(result.yieldedAfter).toBeGreaterThan(0);
		expect(result.yieldedAfter).toBeLessThan(2000);
	} finally { await page.evaluate(() => window.ashAppServerDecodeIntegration.dispose()); }
});

test('App Server large response Worker preserves results and compares UI blocking with synchronous decoding', async ({ page }, testInfo) => {
	test.setTimeout(180_000);
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	let workers = 0;
	page.on('worker', () => workers++);
	await page.goto('/appServerDecode.html');
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	const samples: unknown[] = [];
	const scenarios = [{ name: 'small-control', turns: 1, textBytes: 4096 }, { name: 'schema-1MiB', turns: 128, textBytes: 4096 }, { name: 'schema-16MiB', turns: 2048, textBytes: 4096 }, { name: 'text-16MiB', turns: 1, textBytes: 8 * 1024 * 1024 }];
	try {
		for (const scenario of scenarios) {
			await page.evaluate(({ turns, textBytes }) => window.ashAppServerDecodeIntegration.prepare(turns, textBytes), scenario);
			for (const variant of ['before', 'worker'] as const) {
				const sample = await page.evaluate(variant => window.ashAppServerDecodeIntegration.run(variant), variant);
				samples.push({ scenario, phase: 'first-use', variant, ...sample });
			}
			for (let pair = 0; pair < 5; pair++) for (const variant of pair % 2 ? ['worker', 'before'] as const : ['before', 'worker'] as const) {
				await cdp.send('HeapProfiler.collectGarbage');
				const before = await cdp.send('Performance.getMetrics');
				const sample = await page.evaluate(variant => window.ashAppServerDecodeIntegration.run(variant), variant);
				const after = await cdp.send('Performance.getMetrics');
				const taskMs = (after.metrics.find(metric => metric.name === 'TaskDuration')!.value - before.metrics.find(metric => metric.name === 'TaskDuration')!.value) * 1000;
				expect(sample.turns).toBe(scenario.turns);
				expect(sample.textBytes).toBe(scenario.textBytes);
				expect(sample.state).toBe('ready');
				samples.push({ scenario, phase: 'warm', pair, variant, ...sample, taskMs });
			}
		}
		expect(workers).toBe(3);
		expect(errors).toEqual([]);
		await expect(page.locator('output')).toHaveText(/^(before|worker):1:8388608$/);
		await testInfo.attach('app-server-decode-comparison.json', { body: JSON.stringify({ browser: page.context().browser()?.version(), baseline: 'c77786dee protocol behavior; same generated decoder and routing synchronously in the production client', scope: 'Built Chromium component harness: transport-checked UTF-8 string through production AppServerProtocolClient to validated result. Includes Worker startup, postMessage and result clone on first-use; warm results retain the Worker. Byte framing, UTF-8 decode, backend, Electron Main/IPC, domain mapping and transcript rendering are outside this measurement. TaskDuration is Renderer CDP main-thread task time including setup/verification; it excludes Worker CPU.', samples }, null, 2), contentType: 'application/json' });
	} finally { await page.evaluate(() => window.ashAppServerDecodeIntegration.dispose()); await cdp.detach(); }
});

import { expect, test } from '@playwright/test';

test('Protobuf prototype preserves values and schema rejection', async ({ page }) => {
	await page.goto('/appServerCodec.html');
	expect(await page.evaluate(() => window.ashAppServerCodec.contractChecks())).toBeGreaterThan(15);
});

test('codec prototypes preserve consumption credit, ordered notifications and EOF', async ({ page }) => {
	await page.goto('/appServerCodec.html');
	const failure = new Promise<never>((_resolve, reject) => page.once('pageerror', reject));
	try {
		for (const codec of ['json', 'json-bytes', 'protobuf'] as const) expect(await Promise.race([page.evaluate(codec => window.ashAppServerCodec.creditAndOrdering(codec), codec), failure])).toEqual({ maxOutstanding: 4, acknowledgements: 21, notifications: 20, state: 'crashed' });
	} finally { await page.evaluate(() => window.ashAppServerCodec.dispose()); }
});

test('codec prototypes preserve host cancellation, retirement and failure consumption', async ({ page }) => {
	await page.goto('/appServerCodec.html');
	try {
		for (const codec of ['json', 'json-bytes', 'protobuf'] as const) expect(await page.evaluate(codec => window.ashAppServerCodec.interactionChecks(codec), codec)).toEqual({ cancelledOnce: true, retired: true, malformedConsumptionSettled: true });
	} finally { await page.evaluate(() => window.ashAppServerCodec.dispose()); }
});

test('same payloads compare optimized JSON with Protobuf decode, validation and Worker delivery', async ({ page }, testInfo) => {
	await page.goto('/appServerCodec.html');
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
	const samples: unknown[] = [];
	const cdp = await page.context().newCDPSession(page);
	try {
		const scenarios = [
			{ name: 'bounded-20-turns', turns: 20, textBytes: 4096 },
			{ name: 'schema-16MiB', turns: 2048, textBytes: 4096 },
			{ name: 'text-16MiB', turns: 1, textBytes: 8 * 1024 * 1024 },
			{ name: 'numeric-edits', edits: 65536 },
			{ name: 'unicode', turns: 20, textBytes: 1024, unicode: true },
			{ name: 'semantic-edges', turns: 128, textBytes: 1024, semanticEdges: true },
		];
		const codecs = ['json', 'json-bytes', 'protobuf'] as const;
		for (const scenario of scenarios) {
			await page.evaluate(scenario => window.ashAppServerCodec.prepare(scenario), scenario);
			for (const codec of codecs) samples.push({ scenario, phase: 'first-use', ...await page.evaluate(codec => window.ashAppServerCodec.run(codec), codec) });
			for (let pair = 0; pair < 7; pair++) {
				for (let offset = 0; offset < codecs.length; offset++) {
					const codec = codecs[(pair + offset) % codecs.length];
					await cdp.send('HeapProfiler.collectGarbage');
					samples.push({ scenario, phase: 'warm', pair, ...await page.evaluate(codec => window.ashAppServerCodec.run(codec), codec) });
				}
			}
		}
		expect(errors).toEqual([]);
		await testInfo.attach('app-server-codec-comparison.json', { body: JSON.stringify({ browser: page.context().browser()?.version(), baseline: 'e50d1e0c2 optimized JSON schema decoder; all three paths use the same generated schema, production routing/queue and 256 KiB threshold', scope: 'Chromium component. Wire-ready frame through injected decoder and production AppServerProtocolClient to complete validated result. JS encoding is measured separately, outside response/heartbeat timing. Protobuf parse, plain-object normalization and unchanged schema validation are separate. Above the production threshold both binary inputs transfer ownership and output graphs use structured clone. Return delivery includes sender serialization, scheduling and receiver deserialization. Renderer CDP GC precedes each warm sample; Workers use normal GC. Shared Worker bundle does not represent production cold startup. No Rust encoding, network/framing, Electron relay or Chat rendering.', samples }, null, 2), contentType: 'application/json' });
	} finally { await page.evaluate(() => window.ashAppServerCodec.dispose()); await cdp.detach(); }
});

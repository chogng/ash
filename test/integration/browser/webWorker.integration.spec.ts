import { expect, test } from '@playwright/test';

test('Web replaces a failed syntax Worker and keeps the live buffer and undo history', async ({ page }) => {
	await page.goto('/treeSitter.html?backend=offline');
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().execution)).toBe('worker');
	await page.evaluate(() => window.treeSitterIntegration.ready());
	await page.evaluate(() => window.treeSitterIntegration.edit());
	await page.evaluate(() => window.treeSitterIntegration.ready());
	const before = await page.evaluate(() => window.treeSitterIntegration.state());
	const failWorker = async () => {
		const worker = page.workers().find(worker => /treeSitterWorkerMain/u.test(worker.url()))!;
		expect(worker).toBeDefined();
		const failed = page.waitForEvent(
			'console',
			message => message.type() === 'error' && message.text() === 'Injected syntax Worker failure',
		);
		const replacement = page.waitForEvent('worker', candidate => /treeSitterWorkerMain/u.test(candidate.url()));
		const retired = worker.waitForEvent('close');
		await worker.evaluate(() => {
			setTimeout(() => {
				console.error('Injected syntax Worker failure');
				throw new Error('Injected syntax Worker failure');
			}, 0);
		});
		await failed;
		await replacement;
		await retired;
	};
	await failWorker();
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(await page.evaluate(() => window.treeSitterIntegration.state())).toMatchObject({
		text: before.text,
		version: before.version,
		errors: [],
	});
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^def$/ })).toBeVisible();
	await page.evaluate(() => window.treeSitterIntegration.edit());
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(
		await page.evaluate(() =>
			window.treeSitterIntegration
				.state()
				.tokens.some(token => token.type === 'string' && token.text.includes('updated updated ')),
		),
	).toBe(true);
	await failWorker();
	await page.evaluate(() => window.treeSitterIntegration.ready());
	await page.evaluate(() => window.treeSitterIntegration.undo());
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(await page.evaluate(() => window.treeSitterIntegration.state())).toMatchObject({
		text: before.text,
		errors: [],
	});
	await page.evaluate(() => window.treeSitterIntegration.dispose());
});

test('persistent syntax Worker startup failure stops after one automatic replacement', async ({ page }) => {
	let starts = 0;
	page.on('worker', worker => {
		if (/treeSitterWorkerMain/u.test(worker.url())) starts++;
	});
	await page.route('**/*treeSitterWorkerMain*.js', route =>
		route.fulfill({
			contentType: 'application/javascript',
			body: "throw new Error('Injected persistent syntax Worker failure');",
		}),
	);
	await page.goto('/treeSitter.html?backend=offline');
	await expect
		.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().errors))
		.toEqual(expect.arrayContaining([expect.stringContaining('Injected persistent syntax Worker failure')]));
	expect(starts).toBe(2);
	await expect.poll(() => page.workers().filter(worker => /treeSitterWorkerMain/u.test(worker.url())).length).toBe(0);
	await page.evaluate(() => window.treeSitterIntegration.dispose());
});

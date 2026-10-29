import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { createWebUpdateProvider } from '../../browser/updateService.js';

test('the built-in Web provider compares the running page with a real HTTP deployment and bypasses caches', async () => {
	const running = 'a'.repeat(64);
	const next = 'b'.repeat(64);
	let latest: unknown = { version: running };
	let status = 200;
	const requests: { url: string | undefined; cache: string | undefined }[] = [];
	const server = createServer((request, response) => {
		requests.push({ url: request.url, cache: request.headers['cache-control'] });
		response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
		response.end(JSON.stringify(latest));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const dom = new JSDOM(
		`<meta name="ash-web-build" content="${running}" data-version-url="../../web-version.json">`,
		{ url: `http://127.0.0.1:${address.port}/prefix/browser/workbench/workbench.html` },
	);
	Object.defineProperty(dom.window, 'fetch', { value: globalThis.fetch });
	try {
		const provider = createWebUpdateProvider(dom.window.document)!;
		assert.equal(await provider.checkForUpdate(), null);
		latest = { version: next };
		// The running identity belongs to the loaded page, not subsequently edited DOM metadata.
		dom.window.document.querySelector('meta')!.content = next;
		assert.deepEqual(await provider.checkForUpdate(), { version: next });
		for (latest of [null, {}, { version: 42 }, { version: 'bad-deployment' }]) {
			await assert.rejects(provider.checkForUpdate(), /Invalid Web deployment version/);
		}
		status = 503;
		await assert.rejects(provider.checkForUpdate(), /Web version request failed \(503\)/u);
		status = 200;
		latest = { version: running };
		assert.equal(await provider.checkForUpdate(), null);
		assert.equal(requests.length, 8);
		assert.ok(
			requests.every(request => request.url === '/prefix/web-version.json' && request.cache === 'no-cache'),
		);
	} finally {
		dom.window.close();
		const stopped = new Promise<void>((resolve, reject) =>
			server.close(error => (error ? reject(error) : resolve())),
		);
		server.closeAllConnections();
		await stopped;
	}
});

test('development pages stay disabled and malformed or cross-origin deployment metadata is rejected', () => {
	const dom = new JSDOM('', { url: 'https://ash.example/prefix/' });
	try {
		assert.equal(createWebUpdateProvider(dom.window.document), undefined);
		dom.window.document.head.innerHTML =
			'<meta name="ash-web-build" content="bad" data-version-url="web-version.json">';
		assert.throws(() => createWebUpdateProvider(dom.window.document), /Invalid Web build metadata/);
		dom.window.document.querySelector('meta')!.content = 'a'.repeat(64);
		dom.window.document
			.querySelector('meta')!
			.setAttribute('data-version-url', 'https://another.example/web-version.json');
		assert.throws(() => createWebUpdateProvider(dom.window.document), /must use the page origin/);
	} finally {
		dom.window.close();
	}
});

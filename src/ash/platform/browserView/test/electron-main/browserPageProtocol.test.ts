import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from 'electron/main';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserPageProtocol } from '../../electron-main/browserPageProtocol.js';

/** Protocol handlers receive this provenance from Chromium, independently of HTTP headers. */
function pageRequest(url: string, init?: RequestInit): Request {
	const request = new Request(url, init);
	Object.defineProperty(request, 'initiatorOrigin', { value: `ash-browser-page://${new URL(url).hostname}` });
	return request;
}

suite('Bundled browser pages', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('isolates prepared headers, binds their runtime to credentials, and fails before sending', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ash-browser-header-provider-'));
		try {
			const file = join(root, 'credentials.json');
			await writeFile(file, JSON.stringify({ token: 'fixture-one' }));
			await writeFile(join(root, 'provider.js'), 'fixture provider script');
			let respond!: (request: Request) => Promise<Response>;
			let calls = 0;
			let prepared = 0;
			let disposed = 0;
			let fail = false;
			let authorize!: (url: URL) => Promise<Headers | undefined>;
			const original = { protocol: { handle: (_scheme: string, handler: typeof respond) => { respond = handler; }, unhandle() { } }, fetch: async () => { throw new Error('Wrong browser context'); } } as unknown as Session;
			const isolated = { fetch: async (_url: string, init: RequestInit) => { calls++; assert.equal(init.credentials, 'include'); return Response.json({ id: 'fixture' }); } } as unknown as Session;
			using protocol = new BrowserPageProtocol(root, undefined, [{
				host: 'fixture', entry: 'index.html', upstream: 'https://example.test', upstreamPaths: ['/account', '/messages'], requestHeaders: ['X-Verification'],
				credentials: { file, identityRequest: '/account', fields: [{ path: ['token'], header: 'Authorization', prefix: 'Bearer ' }] },
				remoteHeaders: { url: 'https://example.test/', script: 'provider.js', paths: ['/messages'], credentialPaths: ['/verify/'], headers: ['X-Verification'] },
			}], (_url, resolver) => {
				authorize = resolver;
				return { session: isolated, [Symbol.dispose]() { this.dispose(); }, dispose() { disposed++; }, async prepareHeaders(script) { assert.equal(script, 'fixture provider script'); prepared++; if (fail) { throw new Error('Fixture verification failure'); } return { 'X-Verification': 'signed-fixture', Authorization: 'never-expose' }; } };
			});
			protocol.attach(original);
			const request = (path: string, binding?: string): Request => pageRequest('ash-browser-page://fixture/service' + path, { method: path === '/account' ? 'GET' : 'POST', headers: { 'X-Ash-Browser-Page': 'fixture', ...(binding ? { 'X-Ash-Browser-Account': binding } : {}) } });
			const identity = await respond(request('/account'));
			const binding = identity.headers.get('X-Ash-Browser-Account')!;
			const proof = await respond(request('/.headers/messages', binding));
			assert.deepEqual(await proof.json(), { 'X-Verification': 'signed-fixture' });
			assert.equal(calls, 1);
			assert.equal(prepared, 1);
			assert.equal((await authorize(new URL('https://example.test/verify/prepare')))!.get('Authorization'), 'Bearer fixture-one');
			assert.equal((await authorize(new URL('https://other.test/verify/prepare')))!.get('Authorization'), '');
			assert.equal((await respond(request('/.headers/account', binding))).status, 403);
			fail = true;
			assert.equal((await respond(request('/.headers/messages', binding))).status, 428);
			assert.equal(calls, 1);
			assert.equal(disposed, 1);
			fail = false;
			await respond(request('/.headers/messages', binding));
			const previousAuthorize = authorize;
			await writeFile(file, JSON.stringify({ token: 'fixture-two' }));
			await assert.rejects(previousAuthorize(new URL('https://example.test/verify/prepare')), /Account changed/u);
			assert.equal((await respond(request('/messages', binding))).status, 409);
			assert.equal(calls, 1);
			await respond(request('/account'));
			assert.equal(disposed, 2);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	test('rechecks account binding after an asynchronous request body before dispatch', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ash-browser-account-race-'));
		try {
			const file = join(root, 'credentials.json');
			await writeFile(file, JSON.stringify({ token: 'fixture-before' }));
			let respond!: (request: Request) => Promise<Response>;
			let calls = 0;
			const session = {
				protocol: { handle: (_scheme: string, handler: typeof respond) => { respond = handler; }, unhandle() { } },
				fetch: async () => { calls++; return Response.json({ id: 'fixture' }); },
			} as unknown as Session;
			using protocol = new BrowserPageProtocol('.', undefined, [{
				host: 'fixture', entry: 'index.html', upstream: 'https://example.test', upstreamPaths: ['/account', '/messages'],
				credentials: { file, identityRequest: '/account', fields: [{ path: ['token'], header: 'Authorization', prefix: 'Bearer ' }] },
			}]);
			protocol.attach(session);
			const headers = { 'X-Ash-Browser-Page': 'fixture' };
			const identity = await respond(pageRequest('ash-browser-page://fixture/service/account', { headers }));
			let finishBody!: () => void;
			let bodyRead!: () => void;
			const reading = new Promise<void>(resolve => { bodyRead = resolve; });
			const body = new ReadableStream<Uint8Array>({
				pull(controller) { bodyRead(); return new Promise<void>(resolve => { finishBody = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); resolve(); }; }); },
			}, { highWaterMark: 0 });
			const pending = respond(pageRequest('ash-browser-page://fixture/service/messages', {
				method: 'POST', headers: { ...headers, 'X-Ash-Browser-Account': identity.headers.get('X-Ash-Browser-Account')! }, body, duplex: 'half',
			} as RequestInit));
			await reading;
			await writeFile(file, JSON.stringify({ token: 'fixture-after' }));
			finishBody();
			assert.equal((await pending).status, 409);
			assert.equal(calls, 1);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	test('keeps file credentials in the host, fences account changes and never rewrites the source', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ash-browser-credentials-'));
		try {
			const file = join(root, 'credentials.json');
			const original = JSON.stringify({ tokens: { access_token: 'fixture-token-one', account_id: 'fixture-account-one' }, refresh_token: 'never-used' });
			await writeFile(file, original);
			let respond!: (request: Request) => Promise<Response>;
			const calls: { url: string; init: RequestInit; }[] = [];
			const session = {
				protocol: { handle: (_scheme: string, handler: typeof respond) => { respond = handler; }, unhandle() { } },
				fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json({ id: 'fixture-user' }); },
			} as unknown as Session;
			using protocol = new BrowserPageProtocol('.', undefined, [{
				host: 'fixture', entry: 'index.html', upstream: 'https://example.test', upstreamPaths: ['/account', '/messages'],
				credentials: {
					file, identityRequest: '/account', requirements: [{ path: ['mode'], value: 'account', allowMissing: true }], fields: [
						{ path: ['tokens', 'access_token'], header: 'Authorization', prefix: 'Bearer ' },
						{ path: ['tokens', 'account_id'], header: 'Account-Id', optional: true, identity: true },
					]
				},
			}]);
			protocol.attach(session);
			const request = (path: string, binding?: string): Request => pageRequest('ash-browser-page://fixture/service' + path, {
				method: path === '/account' ? 'GET' : 'POST',
				headers: { 'X-Ash-Browser-Page': 'fixture', Authorization: 'Bearer untrusted-page-token', ...(binding ? { 'X-Ash-Browser-Account': binding } : {}) },
			});
			const identity = await respond(request('/account'));
			assert.equal(identity.status, 200);
			assert.equal(await identity.text(), '{"id":"fixture-user"}');
			const binding = identity.headers.get('X-Ash-Browser-Account')!;
			assert.match(binding, /^[a-f0-9]{64}$/u);
			assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), 'Bearer fixture-token-one');
			assert.equal(new Headers(calls[0]!.init.headers).get('Account-Id'), 'fixture-account-one');
			assert.equal(calls[0]!.init.credentials, 'omit');
			assert.equal((await respond(request('/messages'))).status, 409);
			assert.equal(calls.length, 1);
			assert.equal((await respond(request('/messages', binding))).status, 200);
			assert.equal(new Headers(calls[1]!.init.headers).has('X-Ash-Browser-Account'), false);
			assert.equal(await readFile(file, 'utf8'), original);
			await writeFile(file, JSON.stringify({ tokens: { access_token: 'rotated-fixture-token', account_id: 'fixture-account-one' } }));
			const rotatedIdentity = await respond(request('/account'));
			assert.notEqual(rotatedIdentity.headers.get('X-Ash-Browser-Account'), binding);
			assert.equal(rotatedIdentity.headers.get('X-Ash-Browser-Account-Scope'), identity.headers.get('X-Ash-Browser-Account-Scope'));
			await writeFile(file, JSON.stringify({ tokens: { access_token: 'fixture-token-two', account_id: 'fixture-account-two' } }));
			assert.equal((await respond(request('/messages', binding))).status, 409);
			assert.equal(calls.length, 3);
			await writeFile(file, JSON.stringify({ mode: 'api-key', tokens: { access_token: 'stale-fixture-token' } }));
			assert.equal((await respond(request('/account'))).status, 401);
			await writeFile(file, JSON.stringify({ tokens: { access_token: 'invalid\r\nheader' } }));
			assert.equal((await respond(request('/account'))).status, 401);
			await writeFile(file, 'x'.repeat(1024 * 1024 + 1));
			assert.equal((await respond(request('/account'))).status, 401);
			await rm(file);
			assert.equal((await respond(request('/messages', binding))).status, 401);
			assert.equal(calls.length, 3);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	test('serves only packaged assets and rejects other origins and upstream escapes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ash-browser-page-'));
		try {
			await mkdir(join(root, 'assets', 'browser', 'chatgpt'), { recursive: true });
			await writeFile(join(root, 'index.html'), '<title>Bundled page</title>');
			await writeFile(join(root, 'assets', 'shared~chat-123.js'), 'export const bundled = true;');
			await writeFile(join(root, 'assets', 'browser', 'chatgpt', 'chat-123.js'), 'export const entry = true;');
			let respond!: (request: Request) => Promise<Response>;
			let registrations = 0;
			let removals = 0;
			const requests: { url: string; init: RequestInit; }[] = [];
			const session = {
				protocol: { handle: (_scheme: string, handler: typeof respond) => { respond = handler; registrations++; }, unhandle: () => { removals++; } },
				fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); },
			} as unknown as Session;
			using protocol = new BrowserPageProtocol(root, undefined, [{ host: 'chatgpt', entry: 'index.html', upstream: 'https://chatgpt.com', upstreamPaths: ['/api/auth/session', '/backend-api/'] }]);
			protocol.attach(session);
			protocol.attach(session);
			assert.equal(registrations, 1);
			const entry = await respond(pageRequest('ash-browser-page://chatgpt/index.html'));
			assert.equal(await entry.text(), '<title>Bundled page</title>');
			assert.match(entry.headers.get('content-security-policy')!, /script-src 'self'/u);
			assert.match(entry.headers.get('content-security-policy')!, /img-src 'self' data: blob:;/u);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/assets/shared~chat-123.js'))).status, 200);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/assets/browser/chatgpt/chat-123.js'))).status, 200);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/private.json'))).status, 404);
			assert.equal((await respond(pageRequest('ash-browser-page://unknown/index.html'))).status, 403);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/service/api/auth/session', { headers: { Origin: 'https://evil.test' } }))).status, 403);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/service//evil.test/backend-api/me', { headers: { 'X-Ash-Browser-Page': 'chatgpt' } }))).status, 403);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/service/backend-api/conversation/id%2f..%2fother', { headers: { 'X-Ash-Browser-Page': 'chatgpt' } }))).status, 403);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/service/backend-api/conversation/%252e%252e%252fother', { headers: { 'X-Ash-Browser-Page': 'chatgpt' } }))).status, 403);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/service/api/auth/session/other'))).status, 403);
			assert.equal((await respond(pageRequest('ash-browser-page://chatgpt/service/backend-api/f/conversation', { method: 'POST', body: '{}' }))).status, 403);
			assert.equal(requests.length, 0);
			for (const initiatorOrigin of ['https://evil.test', 'null', undefined]) {
				const foreign = new Request('ash-browser-page://chatgpt/service/backend-api/me', { headers: { Origin: 'ash-browser-page://chatgpt', 'X-Ash-Browser-Page': 'chatgpt' } });
				if (initiatorOrigin !== undefined) { Object.defineProperty(foreign, 'initiatorOrigin', { value: initiatorOrigin }); }
				assert.equal((await respond(foreign)).status, 403);
			}
			assert.equal(requests.length, 0);
			const reply = await respond(pageRequest('ash-browser-page://chatgpt/service/backend-api/f/conversation', {
				method: 'POST', headers: { 'X-Ash-Browser-Page': 'chatgpt', Authorization: 'Bearer synthetic-web-session', 'Content-Type': 'application/json', 'X-Private': 'drop-me' }, body: '{"synthetic":true}',
			}));
			assert.equal(await reply.text(), 'data: [DONE]\n\n');
			assert.equal(requests.length, 1);
			assert.equal(requests[0]!.url, 'https://chatgpt.com/backend-api/f/conversation');
			assert.equal(requests[0]!.init.credentials, 'include');
			assert.equal(requests[0]!.init.redirect, 'error');
			assert.equal(new TextDecoder().decode(requests[0]!.init.body as ArrayBuffer), '{"synthetic":true}');
			assert.deepEqual([...new Headers(requests[0]!.init.headers).keys()], ['authorization', 'content-type']);
			protocol.dispose();
			assert.equal(removals, 1);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test('does not follow redirects, replay failures or accept oversized message bodies', async () => {
		let respond!: (request: Request) => Promise<Response>;
		let calls = 0;
		let html = false;
		const session = {
			protocol: { handle: (_scheme: string, handler: typeof respond) => { respond = handler; }, unhandle() { } },
			fetch: async () => { calls++; return html ? new Response('<script>throw 1</script>', { headers: { 'Content-Type': 'text/html' } }) : new Response('denied', { status: 403 }); },
		} as unknown as Session;
		using protocol = new BrowserPageProtocol('.', undefined, [{ host: 'chatgpt', entry: 'index.html', upstream: 'https://chatgpt.com', upstreamPaths: ['/backend-api/'] }]);
		protocol.attach(session);
		const request = (body: string): Request => pageRequest('ash-browser-page://chatgpt/service/backend-api/f/conversation', { method: 'POST', headers: { 'X-Ash-Browser-Page': 'chatgpt' }, body });
		assert.equal((await respond(request('{}'))).status, 403);
		assert.equal(calls, 1);
		assert.equal((await respond(request('x'.repeat(2 * 1024 * 1024 + 1)))).status, 413);
		assert.equal(calls, 1);
		html = true;
		const blocked = await respond(request('{}'));
		assert.equal(blocked.status, 502);
		assert.equal(await blocked.text(), '');
		assert.equal(blocked.headers.get('content-security-policy'), "default-src 'none'; sandbox");
	});
});

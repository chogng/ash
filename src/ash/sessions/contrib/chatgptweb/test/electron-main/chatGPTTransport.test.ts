import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suite, test } from 'mocha';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IPCClient } from '../../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ElectronChatGPTTransport } from '../../electron-browser/electronChatGPTTransport.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatGPTTransport } from '../../electron-main/chatGPTTransport.js';
import { createChatGPTFetch } from '../../browser/chatGPTFetch.js';
import { ChatGPTAuthenticationError } from '../../common/chatGPTTransport.js';
import type { IChatGPTVerificationRuntime } from '../../electron-main/chatGPTVerificationRuntime.js';

import type { IChatGPTAuthentication, IChatGPTAuthorization } from '../../electron-main/chatGPTAuthentication.js';
import type { IChatGPTTransport } from '../../common/chatGPTTransport.js';
import type { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';

class Authentication extends Disposable implements IChatGPTAuthentication {
	private readonly changes = this._register(new Emitter<string | undefined>());
	public readonly onDidChangeContext = this.changes.event;
	public context = 'a'.repeat(32);
	public headers = new Headers({ Authorization: 'Bearer fixture-one', 'ChatGPT-Account-Id': 'account-one' });
	public available = true;
	public recovered: Headers | undefined;
	public recoveries = 0;
	public readonly grants = new Map<string, AbortController>();
	constructor() {
		super();
		this._register(toDisposable(() => { for (const controller of this.grants.values()) { controller.abort(); } this.grants.clear(); }));
	}
	public async getContext(): Promise<string> { return this.context; }
	public async authorize(id: string, context: string, signal: AbortSignal): Promise<IChatGPTAuthorization> {
		signal.throwIfAborted();
		if (!this.available || context !== this.context || this.grants.has(id)) { throw new ChatGPTAuthenticationError('Private owner failure'); }
		const controller = new AbortController();
		this.grants.set(id, controller);
		const release = toDisposable(() => { this.grants.delete(id); controller.abort(); });
		return {
			headers: new Headers(this.headers), signal: AbortSignal.any([signal, controller.signal]),
			recoverUnauthorized: async () => { this.recoveries++; return this.recovered; },
			dispose: () => release.dispose(), [Symbol.dispose]: () => release.dispose()
		};
	}
	public changeAccount(): void {
		this.context = 'b'.repeat(32);
		for (const controller of this.grants.values()) { controller.abort(); }
		this.grants.clear();
		this.changes.fire(this.context);
	}
}

async function fixture(run: (auth: Authentication) => Promise<void>): Promise<void> {
	using auth = new Authentication();
	await run(auth);
	assert.equal(auth.grants.size, 0, 'Every HTTP request must release its private authorization');
}
function adapt(transport: ChatGPTTransport, auth: Authentication): IChatGPTTransport {
	return { request: (id, request) => transport.request(id, request, auth.context), read: id => transport.read(id), cancel: id => transport.cancel(id) };
}
function scopedChannel(transport: ChatGPTTransport, auth: Authentication): IServerChannel<string> {
	const actual = transport.getChannel();
	return {
		listen: actual.listen, call: <T>(context: string, command: string, args: unknown) => actual.call<T>(context, command,
			command === 'request' && Array.isArray(args) ? [...args, auth.context] : args)
	};
}
function runtime(fetcher: typeof fetch, prepareHeaders: IChatGPTVerificationRuntime['prepareHeaders'] = async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-proof' })): IChatGPTVerificationRuntime {
	return { session: { fetch: fetcher }, prepareHeaders, dispose() { }, [Symbol.dispose]() { this.dispose(); } };
}

suite('ChatGPT transport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the first HTTP request waits for its authentication owner', async () => fixture(async auth => {
		const ready = new DeferredPromise<void>();
		const authorize = auth.authorize.bind(auth);
		auth.authorize = async (...args) => { await ready.p; return authorize(...args); };
		let requests = 0;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '',
			createRuntime: () => runtime((async () => { requests++; return Response.json({}); }) as typeof fetch)
		}, new NullLoggerService());
		const response = createChatGPTFetch(adapt(transport, auth))('/service/backend-api/models');
		assert.equal(requests, 0);
		await ready.complete();
		assert.equal((await response).status, 200);
		await (await response).text();
		assert.equal(requests, 1);
	}));

	test('Chromium subrequests replace or strip account routing through the same owner', async () => fixture(async auth => {
		auth.headers.set('X-OpenAI-Fedramp', 'true');
		let authorizeSubrequest: ((url: URL) => Promise<Headers>) | undefined;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '',
			createRuntime: authorize => { authorizeSubrequest = authorize; return runtime((async () => Response.json({})) as typeof fetch); }
		}, new NullLoggerService());
		await (await createChatGPTFetch(adapt(transport, auth))('/service/backend-api/models')).text();
		const sentinel = new URL('https://chatgpt.com/backend-api/sentinel/chat-requirements');
		assert.equal((await authorizeSubrequest!(sentinel)).get('X-OpenAI-Fedramp'), 'true');
		auth.headers.delete('X-OpenAI-Fedramp');
		assert.equal((await authorizeSubrequest!(sentinel)).get('X-OpenAI-Fedramp'), '');
		for (const url of ['https://chatgpt.com/backend-api/me', 'https://files.oaiusercontent.com/file-test']) {
			const headers = await authorizeSubrequest!(new URL(url));
			assert.equal(headers.get('Authorization'), '');
			assert.equal(headers.get('ChatGPT-Account-Id'), '');
			assert.equal(headers.get('X-OpenAI-Fedramp'), '');
		}
	}));

	for (const finalStatus of [200, 401]) {
		test(`401 recovery uses the owner once and returns the final ${finalStatus} without another retry`, async () => fixture(async auth => {
			auth.headers.set('X-OpenAI-Fedramp', 'true');
			auth.recovered = new Headers({ Authorization: 'Bearer fixture-rotated', 'ChatGPT-Account-Id': 'account-one', 'X-OpenAI-Fedramp': 'true' });
			let requests = 0, rejectedBodyCancelled = false;
			using transport = new ChatGPTTransport({
				authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime((async (_url, init) => {
					requests++;
					assert.equal(new Headers(init?.headers).get('X-OpenAI-Fedramp'), 'true');
					if (requests === 1) {
						assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-one');
						return new Response(new ReadableStream({ cancel: () => { rejectedBodyCancelled = true; } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
					}
					assert.ok(rejectedBodyCancelled);
					assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-rotated');
					return Response.json({}, { status: finalStatus });
				}) as typeof fetch)
			}, new NullLoggerService());
			const response = await createChatGPTFetch(adapt(transport, auth))('/service/backend-api/models');
			assert.equal(response.status, finalStatus); await response.text();
			assert.equal(requests, 2); assert.equal(auth.recoveries, 1);
		}));
	}

	test('the Main factory requires its logger and separates owner failures from upstream 401 without logging secrets', async () => fixture(async auth => {
		const warnings: unknown[][] = [];
		const logger = new class extends NullLoggerService { public override warn(...args: unknown[]): void { warnings.push(args); } };
		let requests = 0;
		const options = { authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime((async () => { requests++; return Response.json({}, { status: 401 }); }) as typeof fetch) };
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(ChatGPTTransport, options), /logService/u);
		services.registerInstance(ILogService, logger);
		using transport = services.createInstance(ChatGPTTransport, options);
		const fetcher = createChatGPTFetch(adapt(transport, auth));
		auth.available = false;
		await assert.rejects(fetcher('/service/backend-api/models'), ChatGPTAuthenticationError);
		assert.equal(requests, 0);
		auth.available = true;
		const response = await fetcher('/service/backend-api/models');
		assert.equal(response.status, 401); await response.text();
		assert.equal(requests, 1); assert.equal(auth.recoveries, 1);
		assert.deepEqual(warnings, [
			['chatgpt', 'Authentication owner could not authorize a request'],
			['chatgpt', 'ChatGPT rejected an HTTP request', { status: 401, method: 'GET', path: '/backend-api/models' }],
		]);
		assert.doesNotMatch(JSON.stringify(warnings), /fixture-one|Private owner failure/u);
	}));

	test('account changes revoke active HTTP streams, retire verification cookies and reject a stale context', async () => fixture(async auth => {
		let disposed = 0;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => ({
				...runtime((async (_url, init) => new Response(new ReadableStream({
					start(controller) {
						init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
					}
				}), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch), dispose() { disposed++; },
			})
		}, new NullLoggerService());
		const context = auth.context;
		const response = await createChatGPTFetch(adapt(transport, auth))('/service/backend-api/models');
		const reading = response.text();
		auth.changeAccount();
		await assert.rejects(reading);
		assert.equal(disposed, 1);
		await assert.rejects(transport.request(randomUUID(), { path: '/service/backend-api/models', method: 'GET', headers: {} }, context), ChatGPTAuthenticationError);
		await assert.rejects(transport.getChannel().call('', 'request', [randomUUID(), { path: '/service/backend-api/models', method: 'GET', headers: {} }]), TypeError);
	}));
	test('transports multipart voice SDP through JSON IPC and the existing credential owner', async () => fixture(async auth => {
		using resources = new DisposableStore();
		const fromRenderer = resources.add(new Emitter<VSBuffer>()), fromMain = resources.add(new Emitter<VSBuffer>());
		const renderer = resources.add(new IPCClient({ onMessage: fromMain.event, send: buffer => queueMicrotask(() => fromRenderer.fire(buffer)) }, 'renderer'));
		const main = resources.add(new IPCClient({ onMessage: fromRenderer.event, send: buffer => queueMicrotask(() => fromMain.fire(buffer)) }, 'main'));
		let requests = 0;
		const transport = resources.add(new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '',
			createRuntime: () => runtime((async (url, init) => {
				requests++;
				assert.equal(url, 'https://chatgpt.com/realtime/vp?dcid=0');
				assert.ok(new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '));
				const form = await new Response(init?.body, { headers: { 'Content-Type': new Headers(init?.headers).get('Content-Type')! } }).formData();
				assert.equal(form.get('sdp'), 'v=0\r\ns=Fixture\r\n');
				return new Response('v=0\r\ns=Answer\r\n', { status: 201, headers: { 'Content-Type': 'text/plain' } });
			}) as typeof fetch),
		}, new NullLoggerService()));
		main.registerChannel('sessions.chatgpt.transport', transport.getChannel());
		const adapter = resources.add(new ElectronChatGPTTransport({ getChannel: name => renderer.getChannel(name) } as IMainProcessService));
		const form = new FormData(); form.set('sdp', 'v=0\r\ns=Fixture\r\n'); form.set('session', '{}');
		const response = await createChatGPTFetch(adapter)('/service/realtime/vp?dcid=0', { method: 'POST', body: form });
		assert.equal(response.status, 201); assert.match(await response.text(), /^v=0/u);
		for (const path of ['/service/voice/get_token', '/service/realtime/vp?dcid=1', '/service/realtime/vp?dcid=0&other=1']) {
			await assert.rejects(createChatGPTFetch(adapter)(path, { method: 'POST', body: form }), /Invalid ChatGPT/u);
		}
		assert.equal(requests, 1);
	}));

	test('preserves upload bytes across the actual JSON IPC channel and rejects malformed binary envelopes', async () => fixture(async auth => {
		using resources = new DisposableStore();
		const fromRenderer = resources.add(new Emitter<VSBuffer>()), fromMain = resources.add(new Emitter<VSBuffer>());
		const renderer = resources.add(new IPCClient({ onMessage: fromMain.event, send: buffer => queueMicrotask(() => fromRenderer.fire(buffer)) }, 'renderer'));
		const main = resources.add(new IPCClient({ onMessage: fromRenderer.event, send: buffer => queueMicrotask(() => fromMain.fire(buffer)) }, 'main'));
		const bytes = new Uint8Array([0, 128, 255, 137, 80, 78, 71]);
		let received = false;
		const transport = resources.add(new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime((async (_url, init) => {
				assert.deepEqual(init?.body, bytes); received = true;
				return new Response(null, { status: 201 });
			}) as typeof fetch)
		}, new NullLoggerService()));
		main.registerChannel('sessions.chatgpt.transport', transport.getChannel());
		const adapter = resources.add(new ElectronChatGPTTransport({ getChannel: name => renderer.getChannel(name) } as IMainProcessService));
		const path = '/service/.upload?' + new URLSearchParams({ url: 'https://files.oaiusercontent.com/test?signature=fixture' });
		const response = await createChatGPTFetch(adapter)(path, { method: 'PUT', body: new Blob([bytes]) });
		assert.equal(response.status, 201); await response.text(); assert.equal(received, true);
		for (const body of [{ base64: 'AAAA=' }, { base64: 'AA==garbage' }, { base64: 'AA==', extra: true }, { base64: 'x'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 1) }]) {
			await assert.rejects(renderer.getChannel('sessions.chatgpt.transport').call('request', [randomUUID(), { path, method: 'PUT', headers: {}, body }, auth.context]), /Invalid ChatGPT upload/u);
		}
	}));

	test('uploads binary bytes only to signed storage and never forwards login or follows redirects', async () => fixture(async auth => {
		const calls: RequestInit[] = [];
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime((async (url, init) => {
				assert.equal(new URL(String(url)).origin, 'https://files.oaiusercontent.com');
				calls.push(init!);
				return new Response(null, { status: 201, headers: { 'Set-Cookie': 'private' } });
			}) as typeof fetch)
		}, new NullLoggerService());
		const path = '/service/.upload?' + new URLSearchParams({ url: 'https://files.oaiusercontent.com/test?signature=fixture' });
		const body = VSBuffer.wrap(new Uint8Array([0, 128, 255]));
		const channel = scopedChannel(transport, auth);
		const id = randomUUID();
		const result = await channel.call('', 'request', [id, { path, method: 'PUT', headers: { 'Content-Type': 'image/png', 'x-ms-blob-type': 'BlockBlob' }, body }]) as { status: number; headers: object; };
		assert.equal(result.status, 201);
		assert.deepEqual(result.headers, {});
		assert.deepEqual([...(calls[0]!.body as Uint8Array)], [0, 128, 255]);
		assert.equal(new Headers(calls[0]!.headers).get('Authorization'), null);
		assert.equal(calls[0]!.credentials, 'omit');
		assert.equal(calls[0]!.redirect, 'error');
		assert.equal(await transport.read(id), null);
		for (const change of [
			{ method: 'POST' }, { body: 'not bytes' }, { body: VSBuffer.alloc(20 * 1024 * 1024 + 1) },
			{ headers: { Authorization: 'private' } }, { headers: { 'x-conduit-token': 'proof' } },
			...['https://chatgpt.com/backend-api/files/test?signature=x', 'https://files.oaiusercontent.com/test', 'https://files.oaiusercontent.com.evil.test/test?signature=x', 'http://127.0.0.1/test?signature=x'].map(url => ({ path: '/service/.upload?' + new URLSearchParams({ url }) })),
		]) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path, method: 'PUT', headers: {}, body, ...change }]), TypeError);
		}
		assert.equal(calls.length, 1);
	}));
	test('reads web resource bytes without forwarding credentials to signed storage or following an unapproved redirect', async () => fixture(async auth => {
		auth.headers.set('X-OpenAI-Fedramp', 'true');
		const calls: Array<{ url: string; headers: Headers; }> = [];
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime((async (url, init) => {
				calls.push({ url: String(url), headers: new Headers(init?.headers) });
				if (String(url).includes('redirect')) return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
				return new Response(new Uint8Array([3, 4]), { headers: { 'Content-Type': 'image/png', 'Set-Cookie': 'not-exposed' } });
			}) as typeof fetch)
		}, new NullLoggerService());
		const channel = scopedChannel(transport, auth);
		for (const url of ['https://chatgpt.com/backend-api/files/file-test/download', 'https://files.oaiusercontent.com/file-test?signature=fixture']) {
			const id = randomUUID();
			const response = await channel.call('', 'request', [id, { path: '/service/.resource?' + new URLSearchParams({ url }), method: 'GET', headers: {} }]) as { headers: Record<string, string>; };
			assert.equal(response.headers['content-type'], 'image/png');
			assert.equal(response.headers['Set-Cookie'], undefined);
			assert.deepEqual([...(await transport.read(id))!.buffer], [3, 4]);
			await transport.cancel(id);
		}
		assert.equal(calls[0]!.headers.get('Authorization'), 'Bearer fixture-one');
		assert.equal(calls[0]!.headers.get('X-OpenAI-Fedramp'), 'true');
		assert.equal(calls[1]!.headers.get('Authorization'), null);
		assert.equal(calls[1]!.headers.get('X-OpenAI-Fedramp'), null);
		for (const url of ['file:///private', 'https://api.openai.com/v1/files', 'https://chatgpt.com/backend-api/me', 'https://files.oaiusercontent.com.evil.test/file', 'https://files.oaiusercontent.com/redirect']) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path: '/service/.resource?' + new URLSearchParams({ url }), method: 'GET', headers: {} }]), TypeError);
		}
	}));
	test('sidebar and management routes preserve their HTTP method and reject writes outside the operation contract', async () => fixture(async auth => {
		const calls: { method: string; path: string; }[] = [];
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime((async (url, init) => {
				calls.push({ method: init!.method!, path: new URL(String(url)).pathname });
				return Response.json({ success: true });
			}) as typeof fetch)
		}, new NullLoggerService());
		const channel = scopedChannel(transport, auth);
		for (const [method, path, body] of [
			['GET', '/pins?item_type=conversation', undefined],
			['POST', '/conversation/id/chat/rename', { title: 'Renamed' }],
			['PATCH', '/conversation/chat', { is_starred: true }],
			['PATCH', '/conversation/chat', { is_archived: true }],
			['PATCH', '/conversation/chat', { gizmo_id: 'g-p-project' }],
			['DELETE', '/conversation/id/chat', undefined],
			['POST', '/share/v2/create', { conversation_id: 'chat', current_node_id: 'reply', is_anonymous: true }],
			['POST', '/f/conversation/resume', { conversation_id: 'chat', offset: 0 }],
		] as const) {
			const id = randomUUID();
			await channel.call('', 'request', [id, { path: '/service/backend-api' + path, method, headers: {}, ...(body ? { body: JSON.stringify(body) } : {}) }]);
			await channel.call('', 'cancel', [id]);
		}
		assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'PATCH', 'PATCH', 'PATCH', 'DELETE', 'POST', 'POST']);
		for (const [method, path, body] of [
			['POST', '/pins', '{}'],
			['DELETE', '/models', undefined], ['POST', '/conversation/chat', '{}'], ['PATCH', '/conversation/chat', '{"is_visible":false}'],
			['PATCH', '/conversation/chat', '{"is_starred":true,"gizmo_id":"g-p-project"}'],
			['PATCH', '/conversation/chat', '{"gizmo_id":"../../other"}'], ['DELETE', '/conversation/id/chat', '{}'],
			['GET', '/f/conversation/resume', undefined], ['POST', '/f/conversation/resume/other', '{}'],
		] as const) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path: '/service/backend-api' + path, method, headers: {}, body }]), TypeError);
		}
		assert.equal(calls.length, 8);
	}));

	test('validates IPC routes, methods, headers, sizes and operation shapes', async () => fixture(async auth => {
		using transport = new ChatGPTTransport({ authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime(fetch) }, new NullLoggerService());
		const channel = scopedChannel(transport, auth);
		const valid = { path: '/service/backend-api/models', method: 'GET', headers: {} };
		for (const change of [
			{ path: '/service/https://other.test' }, { path: '/service/../not-allowed' }, { path: '/service/backend-api/conversation/%252fsecret' },
			{ path: '/service/https://api.openai.com/v1/responses' }, { path: '/service/v1/responses' }, { path: '/service/backend-api/me' },
			{ headers: { 'X-Ash-ChatGPT-Account': 'removed-binding' } }, { path: '/service/backend-api/not-allowed' }, { method: 'DELETE' }, { headers: { Authorization: 'untrusted' } }, { body: 'x' },
			{ headers: { 'X-OpenAI-Fedramp': 'true' } },
			{ method: 'POST', path: '/service/backend-api/f/conversation', body: 'x'.repeat(2 * 1024 * 1024 + 1) },
			{ method: 'POST', path: '/service/.headers/backend-api/f/conversation', body: '{}' },
		]) { await assert.rejects(channel.call('', 'request', [randomUUID(), { ...valid, ...change }]), TypeError); }
		await assert.rejects(channel.call('', 'request', ['bad-id', valid]), TypeError);
		await assert.rejects(channel.call('', 'runUiCommand', [randomUUID()]), TypeError);
	}));
	test('filters verification output and retires a failed runtime without sending a message', async () => fixture(async auth => {
		let calls = 0, disposed = 0, fail = false;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => 'fixture-script', createRuntime: () => ({
				...runtime((async () => { calls++; return Response.json({ id: 'fixture' }); }) as typeof fetch, async script => {
					assert.equal(script, 'fixture-script');
					if (fail) { throw new Error('Fixture proof failure'); }
					return { 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof', Authorization: 'never-expose' };
				}), dispose() { disposed++; },
			})
		}, new NullLoggerService());
		const fetcher = createChatGPTFetch(adapt(transport, auth));
		const proof = await fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST' });
		assert.deepEqual(await proof.json(), { 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
		fail = true;
		const failed = await fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST' });
		assert.equal(failed.status, 428); await failed.text();
		assert.equal(calls, 0); assert.equal(disposed, 1);
	}));
	test('cancels pending verification and streamed reads across the pull transport', async () => fixture(async auth => {
		let verifying!: () => void, finish!: () => void;
		const started = new Promise<void>(resolve => verifying = resolve);
		const proof = new Promise<unknown>(resolve => finish = () => resolve({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }));
		using transport = new ChatGPTTransport({ authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime((async () => Response.json({ id: 'fixture' })) as typeof fetch, async () => { verifying(); return proof; }) }, new NullLoggerService());
		const fetcher = createChatGPTFetch(adapt(transport, auth));
		const controller = new AbortController();
		const pending = fetcher('/service/.headers/backend-api/f/conversation', { method: 'POST', signal: controller.signal });
		await started; controller.abort();
		await assert.rejects(pending, error => (error as Error).name === 'AbortError' || (error as Error).name === 'Canceled');
		finish();
		assert.equal(await transport.read(randomUUID()), null);
	}));
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
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
import { StorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { ChatGPTRecentHistoryGate } from '../../electron-main/chatGPTRecentHistoryGate.js';
import { ChatGPTTransport } from '../../electron-main/chatGPTTransport.js';
import { createChatGPTFetch } from '../../browser/chatGPTFetch.js';
import { ChatGPTClient } from '../../browser/chatGPTClient.js';
import { ChatGPTAuthenticationError, type ChatGPTResponse } from '../../common/chatGPTTransport.js';
import type { ChatGPTRequestHeaderHandler, IChatGPTVerificationRuntime } from '../../electron-main/chatGPTVerificationRuntime.js';

import type { IChatGPTAuthentication, IChatGPTAuthorization } from '../../electron-main/chatGPTAuthentication.js';
import type { ChatGPTAuthenticationContext, IChatGPTTransport } from '../../common/chatGPTTransport.js';
import type { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';

class Authentication extends Disposable implements IChatGPTAuthentication {
	private readonly changes = this._register(new Emitter<ChatGPTAuthenticationContext | undefined>());
	public readonly onDidChangeContext = this.changes.event;
	public context = 'a'.repeat(32);
	public headers = new Headers({ Authorization: 'Bearer fixture-one', 'ChatGPT-Account-Id': 'account-one' });
	public available = true;
	public recovered: Headers | undefined;
	public recoveries = 0;
	public readonly grants = new Map<string, AbortController>();
	constructor(public cacheScope?: string) {
		super();
		this._register(toDisposable(() => { for (const controller of this.grants.values()) { controller.abort(); } this.grants.clear(); }));
	}
	public async getContext(): Promise<ChatGPTAuthenticationContext> { return { id: this.context }; }
	public async authorize(id: string, context: string, signal: AbortSignal): Promise<IChatGPTAuthorization> {
		signal.throwIfAborted();
		if (!this.available || context !== this.context || this.grants.has(id)) { throw new ChatGPTAuthenticationError('Private owner failure'); }
		const controller = new AbortController();
		this.grants.set(id, controller);
		const release = toDisposable(() => { this.grants.delete(id); controller.abort(); });
		return {
			headers: new Headers(this.headers), signal: AbortSignal.any([signal, controller.signal]), cacheScope: this.cacheScope,
			recoverUnauthorized: async () => { this.recoveries++; return this.recovered; },
			dispose: () => release.dispose(), [Symbol.dispose]: () => release.dispose()
		};
	}
	public changeAccount(): void {
		this.context = 'b'.repeat(32);
		for (const controller of this.grants.values()) { controller.abort(); }
		this.grants.clear();
		this.changes.fire({ id: this.context });
	}
}

async function fixture(run: (auth: Authentication) => Promise<void>): Promise<void> {
	using auth = new Authentication();
	await run(auth);
	assert.equal(auth.grants.size, 0, 'Every HTTP request must release its private authorization');
}
function adapt(transport: ChatGPTTransport, auth: Authentication): IChatGPTTransport {
	return { getCacheScope: async () => undefined, request: (id, request) => transport.request(id, request, auth.context), read: id => transport.read(id), cancel: id => transport.cancel(id) };
}
function scopedChannel(transport: ChatGPTTransport, auth: Authentication): IServerChannel<string> {
	const actual = transport.getChannel();
	return {
		listen: actual.listen, call: <T>(context: string, command: string, args: unknown) => actual.call<T>(context, command,
			command === 'request' && Array.isArray(args) ? [...args, auth.context] : args)
	};
}
function runtime(fetcher: typeof fetch, prepareHeaders: IChatGPTVerificationRuntime['prepareHeaders'] = async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-proof' })): IChatGPTVerificationRuntime {
	return { isDisposed: false, session: { fetch: fetcher, getUserAgent: () => 'Ash/0.1.0 Chrome/152.0.0.0 Electron/44.0.0 Safari/537.36' }, prepareHeaders, dispose() { }, [Symbol.dispose]() { this.dispose(); } };
}

suite('ChatGPT transport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const native of [false, true]) {
		test(`${native ? 'Native' : 'Web'} recent history shares the original 429 deadline across windows and desktop restarts`, async () => {
			mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
			const directory = await mkdtemp(join(tmpdir(), 'ash-chatgpt-cooldown-'));
			try {
				const statePath = join(directory, 'workbench-state.json');
				const account = 'a'.repeat(64);
				const retryAfter = native ? 120 : 30;
				let upstreamCalls = 0;
				let upstream: DeferredPromise<Response> | undefined;
				const requested = new DeferredPromise<void>();
				const fetch = async () => {
					upstreamCalls++;
					if (upstream) { void requested.complete(); return upstream.p; }
					return Response.json({ items: [] });
				};
				const openWindow = (resources: DisposableStore, gate: ChatGPTRecentHistoryGate, scope = account, channel = native) => {
					const auth = resources.add(new Authentication(scope));
					const transport = resources.add(new ChatGPTTransport({
						native: channel ? true : undefined, recentHistoryGate: gate, authentication: auth,
						readVerificationScript: async () => '', createRuntime: () => runtime(fetch),
					}, new NullLoggerService()));
					const request = createChatGPTFetch(adapt(transport, auth));
					return () => request('/service/backend-api/conversations?offset=0');
				};
				{
					using storage = new StorageMainService(statePath);
					await storage.initialize();
					using gate = new ChatGPTRecentHistoryGate(storage, new NullLoggerService());
					using windows = new DisposableStore();
					const firstWindow = openWindow(windows, gate);
					const secondWindow = openWindow(windows, gate);
					upstream = new DeferredPromise<Response>();
					const first = firstWindow();
					await requested.p;
					const fromAnotherWindow = secondWindow();
					await upstream.complete(new Response(null, { status: 429, headers: { 'Retry-After': String(retryAfter) } }));
					assert.equal((await first).headers.get('Retry-After'), String(retryAfter));
					const blocked = await fromAnotherWindow;
					assert.equal(blocked.status, 429);
					assert.equal(blocked.headers.get('Retry-After'), String(retryAfter));
					assert.equal(upstreamCalls, 1);
					upstream = undefined;
					await storage.close();
				}
				{
					using storage = new StorageMainService(statePath);
					await storage.initialize();
					using gate = new ChatGPTRecentHistoryGate(storage, new NullLoggerService());
					using windows = new DisposableStore();
					const reopened = openWindow(windows, gate);
					mock.timers.tick((retryAfter - 5) * 1000);
					const blocked = await reopened();
					assert.equal(blocked.status, 429);
					assert.equal(blocked.headers.get('Retry-After'), '5');
					assert.equal(upstreamCalls, 1);
					await (await openWindow(windows, gate, 'b'.repeat(64))()).json();
					await (await openWindow(windows, gate, account, !native)()).json();
					assert.equal(upstreamCalls, 3);
					mock.timers.tick(5000);
					assert.deepEqual(await (await reopened()).json(), { items: [] });
					assert.equal(upstreamCalls, 4);
					await storage.close();
				}
			} finally {
				mock.timers.reset();
				await rm(directory, { recursive: true, force: true });
			}
		});
	}

	test('admits native history only on the experimental channel', async () => fixture(async auth => {
		const path = '/service/backend-api/conversations/thread/messages?num_turns=20&include_has_versions=true&before=cursor';
		for (const native of [false, true]) {
			let fetched = false;
			using transport = new ChatGPTTransport({
				native, authentication: auth, readVerificationScript: async () => '',
				createRuntime: prepareRequestHeaders => runtime(async url => {
					assert.equal((await prepareRequestHeaders(new URL(String(url)), 'GET', {})).authorization, 'Bearer fixture-one');
					fetched = true;
					return Response.json({});
				}),
			}, new NullLoggerService());
			const channel = transport.getChannel();
			const id = randomUUID();
			const args = [id, { path, method: 'GET', headers: {} }, auth.context];
			if (native) {
				assert.equal((await channel.call<ChatGPTResponse>('window', 'request', args)).status, 200);
				await channel.call('window', 'cancel', [id]);
			} else {
				await assert.rejects(channel.call('window', 'request', args), /Invalid ChatGPT endpoint/u);
			}
			assert.equal(fetched, native);
		}
	}));

	test('limits entity detail requests to their exact endpoint, method and body', async () => fixture(async auth => {
		let fetched = 0;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime(async () => {
				fetched++;
				return new Response(null, { status: 204 });
			}),
		}, new NullLoggerService());
		const channel = scopedChannel(transport, auth);
		const body = {
			category: 'generic_entity', conversation_id: 'conversation', message_id: 'reply', locale: 'zh-CN',
			generic_entity_params: { category: 'software', name: 'GPUI', extra_params: { disambiguation: 'Zed toolkit' }, multi_message_mode: true },
		};
		const request = {
			path: '/service/backend-api/sidebar/conversation', method: 'POST', body: JSON.stringify(body),
			headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'OpenAI-Sentinel-Chat-Requirements-Prepare-Token': 'fixture' },
		};
		for (const change of [{ path: request.path + '?unexpected=1' }, { method: 'GET', body: undefined }, { headers: {} },
		{ body: JSON.stringify({ ...body, message_id: 'invalid/reply' }) }, { body: JSON.stringify({ ...body, messages: [] }) }]) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { ...request, ...change }]), TypeError);
		}
		assert.equal(fetched, 0);
		const id = randomUUID();
		assert.equal((await channel.call<ChatGPTResponse>('', 'request', [id, request])).status, 204);
		await channel.call('', 'cancel', [id]);
		assert.equal(fetched, 1);
	}));

	test('uses a separate sidebar preparation for each entity opened on an experimental account', async () => fixture(async auth => {
		let runtimes = 0;
		let preparations = 0;
		const submitted: (string | null)[] = [];
		const tokenHeader = 'OpenAI-Sentinel-Chat-Requirements-Prepare-Token';
		using transport = new ChatGPTTransport({
			native: true, authentication: auth, readVerificationScript: async () => '', createRuntime: () => {
				runtimes++;
				return runtime(async (url, init) => {
					assert.equal(new URL(String(url)).pathname, '/backend-api/sidebar/conversation');
					submitted.push(new Headers(init?.headers).get(tokenHeader));
					return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
				}, async (_script, _signal, sidebar) => {
					assert.equal(sidebar, true);
					return { [tokenHeader]: `preparation-${++preparations}` };
				});
			},
		}, new NullLoggerService());
		const client = new ChatGPTClient(createChatGPTFetch(adapt(transport, auth)));
		for (const [label, disambiguation] of [['GPUI', 'Zed toolkit'], ['Floem', 'Lapce toolkit']]) {
			const details = client.inspectEntity({ conversationId: 'conversation', messageId: 'reply' }, { label, category: 'software', disambiguation }, 'en', new AbortController().signal);
			assert.equal((await details.next()).done, true);
		}
		assert.equal(runtimes, 1);
		assert.deepEqual(submitted, ['preparation-1', 'preparation-2']);
	}));

	test('uses the Chromium user agent for conversation history reads only', async () => fixture(async auth => {
		const agents: (string | null)[] = [];
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '',
			createRuntime: () => runtime(async (_url, init) => {
				agents.push(new Headers(init?.headers).get('User-Agent'));
				return Response.json({});
			}),
		}, new NullLoggerService());
		const channel = scopedChannel(transport, auth);
		for (const [path, method] of [['/conversation/thread', 'GET'], ['/conversation/thread', 'PATCH'], ['/conversations', 'GET']]) {
			const id = randomUUID();
			const request = { path: '/service/backend-api' + path, method, headers: {}, ...(method === 'PATCH' && { body: '{"is_archived":true}' }) };
			assert.equal((await channel.call<ChatGPTResponse>('window', 'request', [id, request])).status, 200);
			await channel.call('window', 'cancel', [id]);
		}
		assert.deepEqual(agents, ['Ash/0.1.0 Chrome/152.0.0.0 Safari/537.36', null, null]);
	}));

	for (const contentType of ['application/json', 'text/html']) {
		test(`preserves Retry-After on a ${contentType} 429 through the transport`, async () => fixture(async auth => {
			using transport = new ChatGPTTransport({
				authentication: auth, readVerificationScript: async () => '',
				createRuntime: () => runtime(async () => new Response('throttled', {
					status: 429, headers: { 'Content-Type': contentType, 'Retry-After': '26', 'Set-Cookie': 'private' },
				})),
			}, new NullLoggerService());
			const fetcher = createChatGPTFetch(adapt(transport, auth));
			const response = await fetcher('/service/backend-api/conversations?offset=0');
			assert.equal(response.status, 429);
			assert.equal(response.headers.get('Retry-After'), '26');
			assert.equal(response.headers.has('Set-Cookie'), false);
			await response.text();
		}));
	}
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
		let prepareRequestHeaders: ChatGPTRequestHeaderHandler | undefined;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '',
			createRuntime: handler => { prepareRequestHeaders = handler; return runtime(async () => Response.json({})); }
		}, new NullLoggerService());
		await (await createChatGPTFetch(adapt(transport, auth))('/service/backend-api/models')).text();
		assert.ok(prepareRequestHeaders);
		const incoming = {
			Authorization: 'Bearer stale', authorization: 'Bearer duplicate',
			'CHATGPT-ACCOUNT-ID': 'stale-account', 'X-OpenAI-Fedramp': 'true', Accept: 'application/json',
		};
		const authorized = { Accept: incoming.Accept, authorization: 'Bearer fixture-one', 'chatgpt-account-id': 'account-one' };
		const sentinel = new URL('https://chatgpt.com/backend-api/sentinel/chat-requirements');
		assert.deepEqual(await prepareRequestHeaders(sentinel, 'POST', incoming), { ...authorized, 'x-openai-fedramp': 'true' });
		auth.headers.delete('X-OpenAI-Fedramp');
		assert.deepEqual(await prepareRequestHeaders(sentinel, 'POST', incoming), authorized);
		const downloadPath = '/files/download/file-example?gizmo_id=g-p-project&inline=false';
		for (const [method, path] of [
			['GET', '/gizmos/g-p-project?include_file_limits=true'],
			['GET', '/gizmos/g-p-project/conversations?limit=20&owned_only=false'],
			['PATCH', '/projects/g-p-project'],
			['POST', '/projects/g-p-project/files'],
			['DELETE', '/projects/g-p-project/files/file-example'],
			['GET', downloadPath],
		]) {
			const url = new URL('https://chatgpt.com/backend-api' + path);
			assert.deepEqual(await prepareRequestHeaders(url, method, incoming), authorized, `${method} ${path}`);
		}
		for (const [method, path] of [
			['GET', '/me'],
			['GET', '/gizmos/g-custom'],
			['GET', '/gizmos/g-p-project%2Fother'],
			['GET', '/projects/g-p-project/files'],
			['POST', '/projects/g-p-project/files?unexpected=true'],
			['POST', '/projects/g-custom/files'],
			['DELETE', '/projects/g-p-project/files/file-example%2Fother'],
			['DELETE', '/projects/g-p-project/files/invalid-file'],
			['DELETE', '/projects/g-p-project/files/file-example?all=true'],
			['POST', downloadPath],
			['GET', '/files/download/file-example'],
			['GET', downloadPath + '&gizmo_id=g-p-other'],
			['GET', downloadPath.replace('file-example', 'invalid-file')],
		]) {
			const url = new URL('https://chatgpt.com/backend-api' + path);
			assert.deepEqual(await prepareRequestHeaders(url, method, incoming), { Accept: incoming.Accept }, `${method} ${path}`);
		}
		const cdn = new URL('https://files.oaiusercontent.com/backend-api' + downloadPath);
		assert.deepEqual(await prepareRequestHeaders(cdn, 'GET', incoming), { Accept: incoming.Accept });
	}));

	test('retries a connection closed during a ChatGPT read once', async () => fixture(async auth => {
		let requests = 0;
		let available = true;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime(async () => {
				if (++requests === 1 || !available) { throw new Error('net::ERR_CONNECTION_CLOSED'); }
				return Response.json({ models: [] });
			}),
		}, new NullLoggerService());
		const fetcher = createChatGPTFetch(adapt(transport, auth));
		const response = await fetcher('/service/backend-api/models');
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { models: [] });
		assert.equal(requests, 2);

		available = false;
		assert.equal((await fetcher('/service/backend-api/models')).status, 502);
		assert.equal(requests, 4);
		assert.equal((await fetcher('/service/backend-api/stop_conversation', { method: 'POST', body: '{}' })).status, 502);
		assert.equal(requests, 5);
	}));

	test('cancels a pending connection retry when the ChatGPT account changes', async () => fixture(async auth => {
		const attempted = new DeferredPromise<void>();
		let requests = 0;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime(async () => {
				requests++;
				void attempted.complete();
				throw new Error('net::ERR_CONNECTION_CLOSED');
			}),
		}, new NullLoggerService());
		const request = transport.request(randomUUID(), { path: '/service/backend-api/models', method: 'GET', headers: {} }, auth.context);
		const rejected = assert.rejects(request, { name: 'AbortError' });
		await attempted.p;
		await new Promise<void>(resolve => setImmediate(resolve));
		auth.changeAccount();
		await rejected;
		assert.equal(requests, 1);
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

	test('logs the conversation send stage and challenge signal for a 403 without request or response contents', async () => fixture(async auth => {
		const warnings: unknown[][] = [];
		const logger = new class extends NullLoggerService { public override warn(...args: unknown[]): void { warnings.push(args); } };
		using transport = new ChatGPTTransport({
			native: true, authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime(async input => {
				return String(input).endsWith('/prepare')
					? new Response('Private HTML', { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' } })
					: Response.json({ message: 'Private service error' }, { status: 403 });
			}),
		}, logger);
		const fetcher = createChatGPTFetch(adapt(transport, auth));
		for (const path of ['/backend-api/f/conversation/prepare', '/backend-api/f/conversation']) {
			const response = await fetcher(`/service${path}`, { method: 'POST', body: 'Private prompt' });
			assert.equal(response.status, 403);
			await response.text();
		}
		assert.deepEqual(warnings, [
			['chatgpt', 'ChatGPT rejected an HTTP request', { status: 403, method: 'POST', path: '/backend-api/f/conversation/prepare', channel: 'native', cloudflareChallenge: true, isHtml: true }],
			['chatgpt', 'ChatGPT rejected an HTTP request', { status: 403, method: 'POST', path: '/backend-api/f/conversation', channel: 'native', cloudflareChallenge: false, isHtml: false }],
		]);
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
				return calls.length === 1 ? new Response(null, { status: 201, headers: { 'Set-Cookie': 'private' } })
					: new Response(null, { status: 503, headers: { 'Retry-After': '2', 'Set-Cookie': 'private' } });
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
		const limited = randomUUID();
		assert.deepEqual(await channel.call('', 'request', [limited, { path, method: 'PUT', headers: {}, body }]), { status: 503, headers: { 'retry-after': '2' } });
		assert.equal(await transport.read(limited), null);
		for (const change of [
			{ method: 'POST' }, { body: 'not bytes' }, { body: VSBuffer.alloc(20 * 1024 * 1024 + 1) },
			{ headers: { Authorization: 'private' } }, { headers: { 'x-conduit-token': 'proof' } },
			...['https://chatgpt.com/backend-api/files/test?signature=x', 'https://files.oaiusercontent.com/test', 'https://files.oaiusercontent.com.evil.test/test?signature=x', 'http://127.0.0.1/test?signature=x'].map(url => ({ path: '/service/.upload?' + new URLSearchParams({ url }) })),
		]) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path, method: 'PUT', headers: {}, body, ...change }]), TypeError);
		}
		assert.equal(calls.length, 2);
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

	test('links a processed project upload through desktop IPC and rejects NDJSON on unrelated routes', async () => fixture(async auth => {
		using resources = new DisposableStore();
		const fromRenderer = resources.add(new Emitter<VSBuffer>()), fromMain = resources.add(new Emitter<VSBuffer>());
		const renderer = resources.add(new IPCClient({ onMessage: fromMain.event, send: buffer => queueMicrotask(() => fromRenderer.fire(buffer)) }, 'renderer'));
		const main = resources.add(new IPCClient({ onMessage: fromRenderer.event, send: buffer => queueMicrotask(() => fromMain.fire(buffer)) }, 'main'));
		const projectId = 'g-p-project';
		const fileId = 'file-project-notes';
		const uploadUrl = 'https://files.oaiusercontent.com/test?signature=fixture';
		const contentType = 'application/x-ndjson; charset=utf-8';
		const frames = [
			JSON.stringify({ event: 'file.processing.started', file_id: fileId }),
			JSON.stringify({ event: 'file.processing.completed', file_id: fileId, extra: { metadata_object_id: 'library-fixture' } }),
		].join('\n') + '\n';
		const requests: Array<{ url: string; init?: RequestInit; }> = [];
		const transport = resources.add(new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '',
			createRuntime: () => runtime(async (url, init) => {
				requests.push({ url: String(url), init });
				switch (String(url)) {
					case 'https://chatgpt.com/backend-api/files':
						return Response.json({ file_id: fileId, upload_url: uploadUrl });
					case uploadUrl:
						return new Response(null, { status: 201 });
					case `https://chatgpt.com/backend-api/projects/${projectId}/files`:
						return new Response(null, { status: 204 });
					default:
						return new Response(frames, { headers: { 'Content-Type': contentType } });
				}
			}),
		}, new NullLoggerService()));
		main.registerChannel('sessions.chatgpt.transport', transport.getChannel());
		const adapter = resources.add(new ElectronChatGPTTransport({ getChannel: name => renderer.getChannel(name) } as IMainProcessService));
		const fetcher = createChatGPTFetch(adapter);
		const file = new File(['notes'], 'notes.txt', { type: 'text/plain', lastModified: 1 });
		assert.equal(await new ChatGPTClient(fetcher).addProjectFile(projectId, file, new AbortController().signal), fileId);
		assert.deepEqual(requests.map(({ url, init }) => [init?.method, url]), [
			['POST', 'https://chatgpt.com/backend-api/files'],
			['PUT', uploadUrl],
			['POST', 'https://chatgpt.com/backend-api/files/process_upload_stream'],
			['POST', `https://chatgpt.com/backend-api/projects/${projectId}/files`],
		]);
		assert.deepEqual(JSON.parse(String(requests[3].init?.body)), {
			files: [{ file_id: fileId, last_modified: 1, library_file_id: 'library-fixture', location: 'fs', name: file.name, size: file.size, type: file.type }],
		});
		const rejected = await fetcher('/service/backend-api/models');
		assert.equal(rejected.status, 502);
		assert.equal(await rejected.text(), '');
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
			['GET', '/gizmos/g-p-project/conversations?limit=20&owned_only=false&cursor=next%2Bpage', undefined],
			['POST', '/projects', { name: 'Project', instructions: 'Keep an experiment log.', emoji: null, theme: null, memory_scope: 'project_v2' }],
			['POST', '/conversation/id/chat/rename', { title: 'Renamed' }],
			['PATCH', '/conversation/chat', { is_starred: true }],
			['PATCH', '/conversation/chat', { is_archived: true }],
			['PATCH', '/conversation/chat', { gizmo_id: 'g-p-project' }],
			['PATCH', '/conversation/chat', { gizmo_id: null }],
			['DELETE', '/conversation/id/chat', undefined],
			['DELETE', '/gizmos/g-p-project', undefined],
			['POST', '/share/v2/create', { conversation_id: 'chat', current_node_id: 'reply', is_anonymous: true }],
			['POST', '/f/conversation/resume', { conversation_id: 'chat', offset: 0 }],
			['PATCH', '/conversation/chat', { current_node_id: 'reply-original' }],
			['POST', '/conversation/new_branch', { conversation_id: 'chat', message_id: 'reply-original' }],
		] as const) {
			const id = randomUUID();
			await channel.call('', 'request', [id, { path: '/service/backend-api' + path, method, headers: {}, ...(body ? { body: JSON.stringify(body) } : {}) }]);
			await channel.call('', 'cancel', [id]);
		}
		assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST', 'POST', 'PATCH', 'PATCH', 'PATCH', 'PATCH', 'DELETE', 'DELETE', 'POST', 'POST', 'PATCH', 'POST']);
		assert.deepEqual(calls[2], { method: 'POST', path: '/backend-api/projects' });
		assert.deepEqual(calls[9], { method: 'DELETE', path: '/backend-api/gizmos/g-p-project' });
		const projectHeaders = { 'ChatGPT-Project-Id': 'g-p-project' };
		const upload = { gizmo_id: 'g-p-project', use_case: 'gizmo', mime_type: 'text/plain', file_name: 'notes.txt' };
		const file = { file_id: 'file-project-notes', location: 'fs', name: 'notes.txt', size: 12, type: 'text/plain', last_modified: 1 };
		for (const [method, path, headers, body] of [
			['GET', '/gizmos/g-p-project?include_file_limits=true', {}, undefined],
			['PATCH', '/projects/g-p-project', {}, { name: 'Project', instructions: '', emoji: null, theme: null, memory_scope: 'global' }],
			['POST', '/files', projectHeaders, { ...upload, file_size: 12, reset_rate_limits: false, supports_direct_azure_multipart: false, timezone_offset_min: 0 }],
			['POST', '/files/process_upload_stream', projectHeaders, { ...upload, file_id: file.file_id, entry_surface: 'project_sources', index_for_retrieval: true }],
			['POST', '/projects/g-p-project/files', {}, { files: [file] }],
			['DELETE', '/projects/g-p-project/files/file-project-notes', {}, undefined],
		] as const) {
			const id = randomUUID();
			await channel.call('', 'request', [id, { path: '/service/backend-api' + path, method, headers, body: body && JSON.stringify(body) }]);
			await channel.call('', 'cancel', [id]);
		}
		assert.equal(calls.length, 20);
		await assert.rejects(channel.call('', 'request', [randomUUID(), {
			path: '/service/backend-api/files/process_upload_stream', method: 'POST', headers: projectHeaders,
			body: JSON.stringify({ ...upload, gizmo_id: 'g-p-other', file_id: file.file_id, entry_surface: 'project_sources', index_for_retrieval: true }),
		}]), TypeError);
		for (const [method, path, body] of [
			['POST', '/pins', '{}'],
			['POST', '/projects', '{"name":" ","instructions":"","emoji":null,"theme":null}'],
			['POST', '/projects', '{"name":"Project","instructions":2,"emoji":null,"theme":null}'],
			['POST', '/projects', JSON.stringify({ name: 'Project', instructions: '', emoji: null, theme: null, memory_scope: 'unknown' })],
			['PATCH', '/projects/g-p-project', JSON.stringify({ name: 'Project', instructions: '', emoji: null, theme: null, memory_scope: null })],
			['POST', '/projects', JSON.stringify({ name: 'Project', instructions: 'x'.repeat(20001), emoji: null, theme: null })],
			['POST', '/projects', '{"name":"Project","instructions":"","emoji":null,"theme":null,"owner":"other"}'],
			['POST', '/projects?unexpected=true', '{"name":"Project","instructions":"","emoji":null,"theme":null}'],
			['POST', '/gizmos/g-p-project/conversations', '{}'],
			['GET', '/gizmos/g-custom/conversations?limit=20&owned_only=false', undefined],
			['GET', '/gizmos/g-p-project/conversations?limit=20&owned_only=false&cursor=one&cursor=two', undefined],
			['DELETE', '/gizmos/g-custom', undefined],
			['DELETE', '/gizmos/g-p-project/conversations', undefined],
			['DELETE', '/gizmos/g-p-project?all=true', undefined],
			['DELETE', '/gizmos/g-p-project', '{}'],
			['GET', '/gizmos/g-p-project?include_file_limits=true&include_file_limits=true', undefined],
			['POST', '/projects/g-p-project/files', JSON.stringify({ files: [{ ...file, file_id: '../other' }] })],
			['DELETE', '/projects/g-p-project/files/file-project-notes?all=true', undefined],
			['DELETE', '/models', undefined], ['POST', '/conversation/chat', '{}'], ['PATCH', '/conversation/chat', '{"is_visible":false}'],
			['PATCH', '/conversation/chat', '{"is_starred":true,"gizmo_id":"g-p-project"}'],
			['PATCH', '/conversation/chat', '{"current_node_id":"../other"}'],
			['PATCH', '/conversation/chat', '{"current_node_id":"reply","is_archived":true}'],
			['POST', '/conversation/new_branch', '{"conversation_id":"chat","message_id":"../other"}'],
			['POST', '/conversation/new_branch', '{"conversation_id":"chat","message_id":"reply","unexpected":true}'],
			['PATCH', '/conversation/new_branch', '{"current_node_id":"reply"}'],
			['PATCH', '/conversation/chat', '{"gizmo_id":"../../other"}'], ['DELETE', '/conversation/id/chat', '{}'],
			['GET', '/f/conversation/resume', undefined], ['POST', '/f/conversation/resume/other', '{}'],
		] as const) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path: '/service/backend-api' + path, method, headers: {}, body }]), TypeError);
		}
		assert.equal(calls.length, 20);
	}));

	test('only permits ChatGPT response audio with one valid conversation and message', async () => fixture(async auth => {
		const audio = new Uint8Array([0x49, 0x44, 0x33]);
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => runtime(async () =>
				new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } })),
		}, new NullLoggerService());
		const channel = scopedChannel(transport, auth);
		const id = randomUUID();
		const path = '/service/backend-api/synthesize?conversation_id=chat&message_id=reply&voice=juniper&format=mp3';
		const response = await channel.call<ChatGPTResponse>('', 'request', [id, { path, method: 'GET', headers: {} }]);
		assert.equal(response.status, 200);
		assert.deepEqual((await channel.call<VSBuffer>('', 'read', [id])).buffer, audio);
		await channel.call('', 'cancel', [id]);
		for (const badPath of [path + '&message_id=other', path.replace('message_id=reply', 'message_id=%2F'), path.replace('format=mp3', 'format=html')]) {
			await assert.rejects(channel.call('', 'request', [randomUUID(), { path: badPath, method: 'GET', headers: {} }]), TypeError);
		}
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
	for (const recover of [true, false]) test(`retries a Main verification timeout once and ${recover ? 'submits only once' : 'leaves the message unsent'}`, async () => fixture(async auth => {
		let runtimes = 0, proofs = 0, preparations = 0, submissions = 0, disposed = 0;
		const deadlines: AbortController[] = [];
		const timeout = mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
			assert.equal(milliseconds, 35_000);
			const deadline = new AbortController();
			deadlines.push(deadline);
			return deadline.signal;
		});
		using restoreTimeout = toDisposable(() => timeout.mock.restore());
		const fetcher = (async (url, init) => {
			if (String(url).endsWith('/prepare')) { preparations++; return Response.json({ conduit_token: 'fixture' }); }
			assert.equal(new Headers(init?.headers).get('OpenAI-Sentinel-Chat-Requirements-Token'), 'proof');
			submissions++;
			return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
		}) as typeof fetch;
		using transport = new ChatGPTTransport({
			authentication: auth, readVerificationScript: async () => '', createRuntime: () => {
				runtimes++;
				return {
					...runtime(fetcher, async () => {
						const attempt = proofs++;
						if (attempt > 0 && recover) return { 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' };
						queueMicrotask(() => deadlines[attempt].abort(new DOMException('Timed out', 'TimeoutError')));
						return new Promise(() => { });
					}),
					dispose() { disposed++; },
				};
			},
		}, new NullLoggerService());
		const client = new ChatGPTClient(createChatGPTFetch(adapt(transport, auth)));
		const send = async () => {
			for await (const _ of client.send({ text: 'fixture', model: 'fixture', parentId: 'parent', messageId: 'message' }, new AbortController().signal)) { /* Drain the reply. */ }
		};
		if (recover) await send();
		else await assert.rejects(send(), /verification could not finish/u);
		assert.deepEqual({ runtimes, proofs, preparations, submissions, disposed }, { runtimes: 2, proofs: 2, preparations: 1, submissions: recover ? 1 : 0, disposed: recover ? 1 : 2 });
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

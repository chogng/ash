import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { suite, suiteSetup, teardown, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('ChatGPT verification background activity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let Runtime: typeof import('../../electron-main/chatGPTVerificationRuntime.js').ChatGPTVerificationRuntime;
	let boundary: { setApi(api: unknown): void; };
	const boundaryUrl = `data:text/javascript,${encodeURIComponent('let api; export const session = { fromPartition: () => api.session }; export class WebContentsView { constructor(options) { return api.createView(options); } } export function setApi(value) { api = value; }')}`;
	suiteSetup(async () => {
		const hooks = registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === 'electron/main') return { url: boundaryUrl, shortCircuit: true };
				return nextResolve(specifier, context);
			},
		});
		try {
			({ ChatGPTVerificationRuntime: Runtime } = await import('../../electron-main/chatGPTVerificationRuntime.js'));
			boundary = await import(boundaryUrl);
		} finally { hooks.deregister(); }
	});

	teardown(() => mock.timers.reset());

	function fixture(options?: { deferDocument?: boolean; deferNavigation?: boolean; deferLoad?: boolean; failLoad?: boolean; deferFinalization?: boolean; }) {
		mock.timers.enable({ apis: ['setTimeout'] });
		const proof = new DeferredPromise<unknown>();
		const load = new DeferredPromise<void>();
		let response = proof;
		let created = 0;
		let installs = 0;
		let warmups = 0;
		let primed = false;
		let closed = false;
		let frozen = false;
		let throttled = true;
		let failFreeze = false;
		let failEvaluation = false;
		const transitions: string[] = [];
		let documentReady!: () => void;
		let requestId = 0;
		let completeRequest: ((details: { id: number; statusCode: number; }) => void) | undefined;
		let prepareRequest: ((details: { id: number; url: string; method: string; requestHeaders: object; }, callback: (value: unknown) => void) => void) | undefined;
		boundary.setApi({
			session: {
				setPermissionRequestHandler() { }, setPermissionCheckHandler() { },
				webRequest: {
					onCompleted(_filter: unknown, callback: typeof completeRequest) { completeRequest = callback; },
					onErrorOccurred() { },
					onBeforeSendHeaders(callback: typeof prepareRequest) { prepareRequest = callback; },
				},
				clearStorageData: async () => { }, clearCache: async () => { },
			},
			createView: (viewOptions: { webPreferences: { backgroundThrottling: boolean; }; }) => {
				created++;
				primed = false;
				throttled = viewOptions.webPreferences.backgroundThrottling;
				closed = false;
				let scripts = 0;
				const contents = Object.assign(new EventEmitter(), {
					setWindowOpenHandler() { },
					loadURL: async () => {
						if (options?.failLoad) throw new Error('Navigation failed');
						if (!options?.deferNavigation) contents.emit('did-navigate');
						if (!options?.deferDocument) contents.emit('dom-ready');
						if (options?.deferLoad) await load.p;
					},
					debugger: {
						attach() { },
						async sendCommand(method: string, params: { state?: string; expression?: string; awaitPromise?: boolean; returnByValue?: boolean; }) {
							if (method === 'Runtime.evaluate') {
								if (failEvaluation) return { exceptionDetails: { text: 'Uncaught error' } };
								assert.equal(params.awaitPromise, true);
								assert.equal(params.returnByValue, true);
								assert.deepEqual([closed, frozen, throttled], [false, false, false], 'Verification must run on an active page');
								if (++scripts === 1) { installs++; return { result: {} }; }
								if (params.expression === 'globalThis.__ashWarmChatGPTVerification()') {
									if (primed) return { result: { value: { requestsStarted: false } } };
									warmups++;
									const id = ++requestId;
									prepareRequest?.({ id, url: 'https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize', method: 'POST', requestHeaders: {} }, () => { });
									if (!options?.deferFinalization) { primed = true; completeRequest?.({ id, statusCode: 200 }); }
									return { result: { value: { requestsStarted: true } } };
								}
								primed = false;
								return { result: { value: await response.p } };
							}
							assert.equal(method, 'Page.setWebLifecycleState');
							transitions.push(params.state!);
							if (params.state === 'frozen' && failFreeze) throw new Error('Cannot freeze');
							frozen = params.state === 'frozen';
						},
					},
					setBackgroundThrottling(value: boolean) { throttled = value; },
					isDestroyed: () => closed,
					close: () => { closed = true; if (options?.deferLoad) void load.error(new Error('Navigation cancelled')); },
				});
				documentReady = () => contents.emit('dom-ready');
				return { webContents: contents, setBounds() { }, setVisible() { } };
			},
		});
		const runtime = new Runtime(async (_url, _method, headers) => ({ ...headers }));
		return {
			runtime, proof, transitions,
			documentReady: () => documentReady(),
			finishWarmup: (statusCode = 200) => { primed = statusCode === 200; completeRequest?.({ id: requestId, statusCode }); },
			expireProof: () => { primed = false; },
			setProof(value: DeferredPromise<unknown>) { response = value; },
			setFreezeFailure() { failFreeze = true; },
			setEvaluationFailure() { failEvaluation = true; },
			get created() { return created; }, get installs() { return installs; }, get warmups() { return warmups; },
			get closed() { return closed; }, get frozen() { return frozen; },
		};
	}

	test('prewarms once and freezes until the first send, then refills in the background', async () => {
		const f = fixture();
		using runtime = f.runtime;
		await Promise.all([runtime.warmup(async () => 'fixture'), runtime.warmup(async () => 'fixture')]);
		assert.deepEqual([f.created, f.installs, f.warmups, f.frozen], [1, 1, 1, true]);
		await f.proof.complete('proof');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		await runtime.warmup(async () => 'fixture');
		assert.deepEqual([f.created, f.installs, f.frozen], [1, 1, true]);
		assert.equal(f.warmups, 2);
		assert.ok(f.transitions.every((state, index) => state === (index % 2 ? 'frozen' : 'active')));
	});

	test('rechecks SDK expiry after idle without duplicating a valid preparation', async () => {
		const f = fixture();
		using runtime = f.runtime;
		await runtime.warmup(async () => 'fixture');
		await runtime.warmup(async () => 'fixture');
		assert.equal(f.warmups, 1);
		f.expireProof();
		await runtime.warmup(async () => 'fixture');
		assert.deepEqual([f.warmups, f.created, f.frozen], [2, 1, true]);
	});

	test('keeps priming active until finalization and does not delay the submitted proof for its refill', async () => {
		const f = fixture({ deferFinalization: true });
		using runtime = f.runtime;
		const warming = runtime.warmup(async () => 'fixture');
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual([f.warmups, f.frozen], [1, false]);
		f.finishWarmup();
		await warming;
		assert.equal(f.frozen, true);
		await f.proof.complete('proof');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual([f.warmups, f.frozen], [2, false]);
		f.finishWarmup();
		await runtime.warmup(async () => 'fixture');
		assert.equal(f.frozen, true);
	});

	test('failed background finalization releases the page for a foreground retry', async () => {
		const f = fixture({ deferFinalization: true });
		using runtime = f.runtime;
		const warming = runtime.warmup(async () => 'fixture');
		await new Promise(resolve => setImmediate(resolve));
		f.finishWarmup(503);
		await warming;
		assert.equal(f.closed, true);
		await f.proof.complete('proof');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
	});

	test('failed prewarming permits a fresh foreground verification', async () => {
		const f = fixture();
		using runtime = f.runtime;
		await runtime.warmup(async () => { throw new Error('Prewarm script unavailable'); });
		assert.equal(f.created, 0);
		await f.proof.complete('proof');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
	});

	test('disposal cancels prewarming before a page is created', async () => {
		const f = fixture();
		const script = new DeferredPromise<string>();
		let signal: AbortSignal | undefined;
		const pending = f.runtime.warmup(async current => { signal = current; return script.p; });
		await new Promise(resolve => setImmediate(resolve));
		f.runtime.dispose();
		await pending;
		assert.equal(signal?.aborted, true);
		assert.equal(f.created, 0);
	});

	test('installs verification after navigation commits without waiting for the document or unrelated page loads', async () => {
		const f = fixture({ deferDocument: true, deferLoad: true });
		using runtime = f.runtime;
		const pending = runtime.prepareHeaders('fixture', new AbortController().signal);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.installs, 1);
		f.documentReady();
		await f.proof.complete('proof');
		assert.equal(await pending, 'proof');
		assert.deepEqual([f.installs, f.frozen], [1, true]);
	});

	test('rejects failed navigation before the document is ready', async () => {
		const f = fixture({ failLoad: true });
		using runtime = f.runtime;
		await assert.rejects(runtime.prepareHeaders('fixture', new AbortController().signal), /Navigation failed/);
		assert.deepEqual([f.installs, f.closed], [0, true]);
	});

	test('rejects page evaluation exceptions and closes the failed page', async () => {
		const f = fixture();
		using runtime = f.runtime;
		f.setEvaluationFailure();
		await assert.rejects(runtime.prepareHeaders('fixture', new AbortController().signal), /ChatGPT verification script failed/);
		assert.equal(f.closed, true);
	});

	test('cancels navigation before the document is ready', async () => {
		const f = fixture({ deferNavigation: true, deferDocument: true, deferLoad: true });
		using runtime = f.runtime;
		const controller = new AbortController();
		const pending = runtime.prepareHeaders('fixture', controller.signal);
		await new Promise(resolve => setImmediate(resolve));
		controller.abort();
		await assert.rejects(pending, /Navigation cancelled/);
		assert.deepEqual([f.installs, f.closed], [0, true]);
	});

	test('freezes after verification and reuses the installed page after a long idle period', async () => {
		const f = fixture();
		using runtime = f.runtime;
		await f.proof.complete('proof');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		await runtime.warmup(async () => 'fixture');
		assert.deepEqual([f.closed, f.frozen], [false, true]);
		mock.timers.tick(20 * 60_000);
		assert.equal(f.closed, false, 'Idle time does not discard verification state');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		await runtime.warmup(async () => 'fixture');
		assert.deepEqual([f.created, f.installs, f.frozen], [1, 1, true]);
		assert.ok(f.transitions.every((state, index) => state === (index % 2 ? 'frozen' : 'active')));
		assert.equal(runtime.verificationPhase, undefined);
	});

	test('does not suspend verification while its proof is still running', async () => {
		const f = fixture();
		using runtime = f.runtime;
		await f.proof.complete('proof');
		await runtime.prepareHeaders('fixture', new AbortController().signal);
		const nextProof = new DeferredPromise<unknown>();
		f.setProof(nextProof);
		const pending = runtime.prepareHeaders('fixture', new AbortController().signal);
		await new Promise(resolve => setImmediate(resolve));
		mock.timers.tick(30 * 60_000);
		assert.deepEqual([f.closed, f.frozen], [false, false]);
		await nextProof.complete('next proof');
		assert.equal(await pending, 'next proof');
		assert.equal(f.frozen, true);
	});

	test('failed verification closes the page and a later attempt creates a fresh page', async () => {
		const f = fixture();
		using runtime = f.runtime;
		const rejected = assert.rejects(runtime.prepareHeaders('fixture', new AbortController().signal), /fixture failure/);
		await f.proof.error(new Error('fixture failure'));
		await rejected;
		assert.equal(f.closed, true);
		assert.equal(runtime.verificationPhase, undefined);
		await assert.rejects(runtime.prepareHeaders('fixture', new AbortController().signal), /fixture failure/);
		assert.equal(f.created, 2);
	});

	test('failure to suspend releases the page without rejecting a valid proof', async () => {
		const f = fixture();
		using runtime = f.runtime;
		f.setFreezeFailure();
		await f.proof.complete('proof');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		assert.equal(f.closed, true);
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		assert.equal(f.created, 2);
	});

	test('cancellation closes active Chromium', async () => {
		const f = fixture();
		using runtime = f.runtime;
		const controller = new AbortController();
		const pending = runtime.prepareHeaders('fixture', controller.signal);
		controller.abort();
		await f.proof.complete(undefined);
		await assert.rejects(pending);
		assert.equal(f.closed, true);
	});
});

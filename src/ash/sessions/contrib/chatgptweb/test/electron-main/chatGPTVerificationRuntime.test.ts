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
	const boundaryUrl = `data:text/javascript,${encodeURIComponent('let api; export const session = { fromPartition: () => api.session }; export class WebContentsView { constructor() { return api.createView(); } } export function setApi(value) { api = value; }')}`;
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

	function fixture() {
		mock.timers.enable({ apis: ['setTimeout'] });
		const proof = new DeferredPromise<unknown>();
		let response = proof;
		let created = 0;
		let installs = 0;
		let closed = false;
		let frozen = false;
		let throttled = true;
		let failFreeze = false;
		const transitions: string[] = [];
		boundary.setApi({
			session: {
				setPermissionRequestHandler() { }, setPermissionCheckHandler() { },
				webRequest: { onCompleted() { }, onErrorOccurred() { }, onBeforeSendHeaders() { } },
				clearStorageData: async () => { }, clearCache: async () => { },
			},
			createView: () => {
				created++;
				closed = false;
				let scripts = 0;
				const contents = Object.assign(new EventEmitter(), {
					setWindowOpenHandler() { },
					loadURL: async () => { },
					executeJavaScript: async () => {
						if (++scripts === 1) { installs++; return; }
						assert.deepEqual([closed, frozen, throttled], [false, false, false], 'Verification must run on an active page');
						return response.p;
					},
					debugger: {
						attach() { },
						async sendCommand(method: string, params: { state: string; }) {
							assert.equal(method, 'Page.setWebLifecycleState');
							transitions.push(params.state);
							if (params.state === 'frozen' && failFreeze) throw new Error('Cannot freeze');
							frozen = params.state === 'frozen';
						},
					},
					setBackgroundThrottling(value: boolean) { throttled = value; },
					isDestroyed: () => closed,
					close: () => { closed = true; },
				});
				return { webContents: contents, setBounds() { }, setVisible() { } };
			},
		});
		const runtime = new Runtime(async (_url, _method, headers) => ({ ...headers }));
		return {
			runtime, proof, transitions,
			setProof(value: DeferredPromise<unknown>) { response = value; },
			setFreezeFailure() { failFreeze = true; },
			get created() { return created; }, get installs() { return installs; },
			get closed() { return closed; }, get frozen() { return frozen; },
		};
	}

	test('freezes after verification and reuses the installed page after a long idle period', async () => {
		const f = fixture();
		using runtime = f.runtime;
		await f.proof.complete('proof');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		assert.deepEqual([f.closed, f.frozen], [false, true]);
		mock.timers.tick(20 * 60_000);
		assert.equal(f.closed, false, 'Idle time does not discard verification state');
		assert.equal(await runtime.prepareHeaders('fixture', new AbortController().signal), 'proof');
		assert.deepEqual([f.created, f.installs, f.frozen], [1, 1, true]);
		assert.deepEqual(f.transitions, ['active', 'frozen', 'active', 'frozen']);
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

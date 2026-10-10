import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { AbstractDisposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { registerAppServerBrowserHost } from '../../../../../platform/agentHost/electron-browser/appServerBrowserHost.js';
import { WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../../../platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../../../platform/agentHost/test/common/testAppServerProtocol.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import type { BrowserViewEvent } from '../../../../../platform/browserView/common/browserView.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import '../../electron-browser/playwrightWorkbenchService.js';

const targetId = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
const options = { includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false };
const observation = { targetId, url: 'https://example.test/', title: 'Shared page', loading: false, accessibilityTree: 'Page content' };

suite('Workbench Playwright service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the registered service requires its Main connection before first use', () => {
		using services = new InstantiationService(registrations());
		assert.throws(() => services.get(IPlaywrightService), /mainProcessService/);
	});

	test('App Server observation and navigation pass Thread and network authority through the registered service', async () => {
		const calls: { command: string; arg: unknown; }[] = [];
		using fixture = hostFixture(async (command, arg) => {
			calls.push({ command, arg });
			return command === 'observe' ? observation : { targetId };
		});
		await fixture.client.connect();
		const observed = await fixture.transport.request('browser/observe', { threadId: 'thread-one', targetId, ...options, networkToken: 'tool-authority' });
		const navigated = await fixture.transport.request('browser/perform', { threadId: 'thread-one', action: { type: 'navigate', targetId, url: 'https://example.test/next' }, networkToken: 'next-authority' });
		assert.deepEqual([observed.result, navigated.result, calls.map(call => [call.command, (call.arg as { params: unknown; }).params])], [
			observation, { targetId }, [
				['observe', { threadId: 'thread-one', targetId, ...options, networkToken: 'tool-authority' }],
				['perform', { threadId: 'thread-one', action: { type: 'navigate', targetId, url: 'https://example.test/next' }, networkToken: 'next-authority' }],
			],
		]);
		await fixture.playwright.disposeSession('thread-one');
	});

	test('cancelling a backend request cancels its Main operation and leaves the next observation usable', async () => {
		const started = promiseWithResolvers<string>();
		const pending = promiseWithResolvers<unknown>();
		let cancelled: unknown;
		let hold = true;
		using fixture = hostFixture(async (command, arg) => {
			if (command === 'cancel') {
				cancelled = arg;
				pending.reject(new Error('BrowserRequestCancelled'));
				return;
			}
			if (command === 'observe' && hold) {
				started.resolve((arg as { id: string; }).id);
				return pending.promise;
			}
			return command === 'observe' ? observation : undefined;
		});
		await fixture.client.connect();
		const request = fixture.transport.request('browser/observe', { threadId: 'thread-one', targetId, ...options });
		const operationId = await started.promise;
		fixture.transport.emitFrame({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'host-1' } });
		assert.deepEqual([(await request).error, cancelled], [{ code: -32800, message: 'Host request cancelled', data: null }, { id: operationId }]);
		hold = false;
		assert.deepEqual((await fixture.transport.request('browser/observe', { threadId: 'thread-one', targetId, ...options })).result, observation);
		await fixture.playwright.disposeSession('thread-one');
	});

	test('releasing a Thread cancels its queued operations and blocks reuse until release completes', async () => {
		const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = promiseWithResolvers<unknown>();
		const releaseStarted = promiseWithResolvers<void>();
		const releaseFinished = promiseWithResolvers<void>();
		const calls: string[] = [];
		using fixture = hostFixture(async command => {
			calls.push(command);
			if (command === 'observe') { return pending.promise; }
			if (command === 'cancel') { pending.reject(new Error('BrowserRequestCancelled')); }
			if (command === 'disposeSession') { releaseStarted.resolve(); await releaseFinished.promise; }
		});
		const observed = fixture.playwright.getObservation(operationId, 'thread-one', targetId, options);
		const rejected = assert.rejects(observed, /BrowserRequestCancelled/);
		const released = fixture.playwright.disposeSession('thread-one');
		await releaseStarted.promise;
		assert.equal(fixture.playwright.disposeSession('thread-one'), released);
		await assert.rejects(fixture.playwright.getObservation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'thread-one', targetId, options), /being released/);
		releaseFinished.resolve();
		await Promise.all([rejected, released]);
		assert.deepEqual(calls, ['observe', 'cancel', 'disposeSession']);
	});

	test('renderer teardown cancels pending automation before releasing its Thread', async () => {
		const pending = promiseWithResolvers<unknown>();
		const released = promiseWithResolvers<void>();
		const calls: string[] = [];
		const fixture = hostFixture(async command => {
			calls.push(command);
			if (command === 'observe') { return pending.promise; }
			if (command === 'cancel') { pending.reject(new Error('BrowserRequestCancelled')); }
			if (command === 'disposeSession') { released.resolve(); }
		});
		try {
			const observed = fixture.playwright.getObservation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'thread-one', targetId, options);
			const rejected = assert.rejects(observed, /BrowserRequestCancelled/);
			fixture.dispose();
			await Promise.all([released.promise, rejected]);
			assert.deepEqual(calls, ['observe', 'cancel', 'disposeSession']);
			assert.throws(() => fixture.playwright.getObservation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'thread-one', targetId, options), /disposed/);
		} finally { fixture.dispose(); }
	});

	test('invalid screenshot content cannot escape the transport adapter', async () => {
		using fixture = hostFixture(async command => command === 'observe' ? { ...observation, screenshot: { mimeType: 'text/html', dataBase64: 'aGVsbG8=', decodedLength: 5 } } : undefined);
		await assert.rejects(fixture.playwright.getObservation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'thread-one', targetId, options), /screenshot MIME/);
		await fixture.playwright.disposeSession('thread-one');
	});

	test('Main network requests retain backend authorization and closed pages release their sharing grant', async () => {
		const acknowledged = promiseWithResolvers<unknown>();
		using fixture = hostFixture(async (command, arg) => {
			if (command === 'network') { acknowledged.resolve(arg); }
			return command === 'sharing' ? null : undefined;
		});
		await fixture.client.connect();
		fixture.events.fire({ type: 'networkRequested', targetId, requestId: 'network-one', networkToken: 'network-authority', url: 'https://example.test/data', method: 'GET' });
		assert.deepEqual(await acknowledged.promise, { targetId, requestId: 'network-one', allowed: false });
		assert.deepEqual(fixture.transport.backendRequests[0], { method: 'browser/network/authorize', params: { networkToken: 'network-authority', url: 'https://example.test/data', method: 'GET' } });
		const shared = await fixture.transport.request('browser/sharing/set', { targetId, threadIds: ['thread-one'] });
		assert.equal(shared.result, null);
		fixture.events.fire({ type: 'closed', targetId });
		assert.deepEqual(fixture.transport.backendRequests[1], { method: 'browser/sharing/set', params: { targetId, threadIds: [] } });
	});
});

function registrations(): ServiceCollection {
	const descriptors = getSingletonServiceDescriptors().filter(([id]) => id === IPlaywrightService);
	assert.equal(descriptors.length, 1);
	return new ServiceCollection(...descriptors);
}

function hostFixture(call: (command: string, arg: unknown) => Promise<unknown>): DisposableStore & { readonly playwright: IPlaywrightService; readonly transport: HostTransport; readonly client: AppServerProtocolClient; readonly events: Emitter<BrowserViewEvent>; } {
	const resources = new DisposableStore();
	const events = resources.add(new Emitter<BrowserViewEvent>());
	const services = resources.add(new InstantiationService(registrations()));
	services.registerSingleton(IMainProcessService, () => services.createInstance(TestMainProcessService, call, events.event));
	const mainProcessService = services.get(IMainProcessService);
	const playwright = services.get(IPlaywrightService);
	const transport = new HostTransport();
	const client = new AppServerProtocolClient(transport);
	resources.add(toDisposable(() => client.dispose()));
	resources.add(registerAppServerBrowserHost(client, playwright, mainProcessService));
	return Object.assign(resources, { playwright, transport, client, events });
}

class TestMainProcessService extends AbstractDisposable implements IMainProcessService {
	declare public readonly _serviceBrand: undefined;
	private readonly channel: IChannel;

	constructor(call: (command: string, arg: unknown) => Promise<unknown>, events: Event<BrowserViewEvent>) {
		super();
		this.channel = {
			call: async <T>(command: string, arg: unknown): Promise<T> => { this.assertNotDisposed(); return await call(command, arg) as T; },
			listen: <T>() => events as Event<T>,
		};
	}

	public getChannel(name: string): IChannel {
		assert.equal(name, 'browserHost');
		return this.channel;
	}

	public registerChannel(): void { throw new Error('Unexpected renderer channel'); }
	protected override disposeCore(): void { }
}

class HostTransport extends EventEmitter implements AppServerTransport {
	private sequence = 0;
	private readonly requests = new Map<string, ReturnType<typeof promiseWithResolvers<Record<string, unknown>>>>();
	public readonly backendRequests: { method: string; params: unknown; }[] = [];

	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'browser-test', workspaceRoot: '/workspace' });
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const message = JSON.parse((payload as { frame: string; }).frame);
		if (message.method === 'initialize') { this.emitFrame({ jsonrpc: '2.0', id: message.id, result: createTestInitializeResult() }); }
		if (message.method === 'browser/network/authorize' || message.method === 'browser/sharing/set') {
			this.backendRequests.push({ method: message.method, params: message.params });
			this.emitFrame({ jsonrpc: '2.0', id: message.id, result: message.method === 'browser/network/authorize' ? { allowed: false } : null });
		}
		if (typeof message.id === 'string') {
			this.requests.get(message.id)?.resolve(message);
			this.requests.delete(message.id);
		}
	}

	public request(method: string, params: unknown): Promise<Record<string, unknown>> {
		const id = 'host-' + ++this.sequence;
		const response = promiseWithResolvers<Record<string, unknown>>();
		this.requests.set(id, response);
		this.emitFrame({ jsonrpc: '2.0', id, method, params });
		return response.promise;
	}

	public emitFrame(message: object): void {
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify(message) });
	}
}

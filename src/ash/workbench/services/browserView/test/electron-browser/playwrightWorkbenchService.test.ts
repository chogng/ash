import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { AbstractDisposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IServerChannel, IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { registerAppServerBrowserHost } from '../../../../../platform/agentHost/electron-browser/appServerBrowserHost.js';
import { WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../../../platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../../../platform/agentHost/test/common/testAppServerProtocol.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import type { BrowserViewEvent } from '../../../../../platform/browserView/common/browserView.js';
import { BrowserCDPSettingId, BrowserChatToolsSettingId } from '../../../../../platform/browserView/common/browserView.js';
import { ConfigurationService } from '../../../../../platform/configuration/common/configurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IPolicyService, NullPolicyService } from '../../../../../platform/policy/common/policy.js';
import '../../../../contrib/browserView/browser/browserView.contribution.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import '../../electron-browser/playwrightWorkbenchService.js';
import type { IAgentCanvasHost } from '../../../../../platform/agentHost/common/agentService.js';

const targetId = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
const options = { includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false };
const observation = { targetId, url: 'https://example.test/', title: 'Shared page', loading: false, accessibilityTree: 'Page content' };

suite('Workbench Playwright service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registered Canvas requests resolve in the originating conversation and retain Agent network authority', async () => {
		const calls: { command: string; arg: unknown; }[] = [];
		const opens: unknown[] = [];
		const requests: unknown[] = [];
		const closes: unknown[] = [];
		const definition = { id: { extensionId: 'fixture.extension', canvasId: 'board' }, displayName: 'Board', description: '', requiresInput: false };
		using f = hostFixture(async (command, arg) => { calls.push({ command, arg }); return command === 'create' ? { targetId } : null; }, {
			listCanvases: async (session, thread) => { assert.deepEqual([session, thread], ['source-session', 'source-thread']); return [definition]; },
			openCanvasSource: async request => { opens.push(request); return { url: 'http://localhost:9000/board', title: 'Resolved board' }; },
			closeCanvasSource: async (thread, target) => { closes.push([thread, target]); },
			acceptCanvasOpen: (request, state) => { requests.push({ request, state }); },
		});
		await f.client.connect();
		assert.deepEqual((await f.transport.request('browser/canvases/list', { sessionId: 'source-session', threadId: 'source-thread' })).result, { canvases: [definition] });
		const canvas = { sessionId: 'source-session', instanceId: 'preview', title: 'board', definition: definition.id };
		const result = await f.transport.request('browser/create', { threadId: 'source-thread', url: 'about:blank', canvas, networkToken: 'execution-network-grant' });
		assert.deepEqual(result.result, { targetId });
		assert.deepEqual(opens, [{ sessionId: 'source-session', threadId: 'source-thread', instanceId: 'preview', definition: definition.id }]);
		assert.deepEqual((calls[0]!.arg as { params: unknown; }).params, { threadId: 'source-thread', url: 'http://localhost:9000/board', canvas: { ...canvas, title: 'Resolved board' }, networkToken: 'execution-network-grant' });
		const states = requests as { state: { id: string; succeeded: boolean; }; }[];
		assert.equal(states[0]!.state.id, states[1]!.state.id);
		assert.deepEqual(states.map(value => value.state.succeeded), [false, true]);
		await f.transport.request('browser/close', { threadId: 'source-thread', targetId });
		assert.deepEqual(closes, [['source-thread', targetId]]);
	});

	test('an untrusted registered Canvas source cannot use privileged or plaintext remote navigation', async () => {
		let creates = 0;
		let url = 'file:///private/secret';
		using f = hostFixture(async () => { creates++; return { targetId }; }, { openCanvasSource: async () => ({ url }), acceptCanvasOpen: () => { } } as unknown as IAgentCanvasHost);
		await f.client.connect();
		for (const source of ['file:///private/secret', 'http://example.test/', 'https://user:password@example.test/']) {
			url = source;
			const result = await f.transport.request('browser/create', { threadId: 'source-thread', url: 'about:blank', canvas: { sessionId: 'source-session', instanceId: 'preview', title: 'board', definition: { extensionId: 'fixture', canvasId: 'board' } } });
			assert.match(JSON.stringify(result.error), /CanvasSourceDenied/);
		}
		assert.equal(creates, 0);
	});

	test('live settings revoke browser requests and advanced CDP preserves newly created page identity', async () => {
		const calls: string[] = [];
		using fixture = hostFixture(async command => { calls.push(command); return { targetId, createdTargetId: 'new-page', output: '{"result":{"targetId":"chromium-page"}}' }; });
		await fixture.client.connect();
		const params = { threadId: 'thread-one', action: { type: 'cdp', targetId, operation: { type: 'command', method: 'Target.createTarget', params: { url: 'about:blank' } } } };
		assert.match(JSON.stringify((await fixture.transport.request('browser/perform', params)).error), /BrowserCDPDisabled/);
		assert.deepEqual(calls, []);
		await fixture.configuration.updateValue(BrowserCDPSettingId, true);
		assert.deepEqual((await fixture.transport.request('browser/perform', params)).result, { targetId, createdTargetId: 'new-page', output: '{"result":{"targetId":"chromium-page"}}' });
		await fixture.configuration.updateValue(BrowserChatToolsSettingId, false);
		assert.match(JSON.stringify((await fixture.transport.request('browser/perform', params)).error), /BrowserCapabilityUnavailable/);
		assert.deepEqual(calls, ['perform']);
		assert.deepEqual(fixture.transport.preferences.at(-1), { enabled: false, cdpEnabled: true });
	});

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

	test('user sharing goes through backend authorization and rejects malformed or retired requests', async () => {
		using fixture = hostFixture(async () => null);
		await fixture.client.connect();
		await fixture.sharing.call('main', 'setSharing', [targetId, ['thread-one']]);
		assert.deepEqual(fixture.transport.backendRequests, [{ method: 'browser/sharing/set', params: { targetId, threadIds: ['thread-one'] } }]);
		await assert.rejects(fixture.sharing.call('main', 'setSharing', [targetId, [1]]));
		await assert.rejects(fixture.sharing.call('main', 'dispose', []), /Invalid browser sharing command/);
		assert.equal(fixture.transport.backendRequests.length, 1);
		fixture.dispose();
		await assert.rejects(fixture.sharing.call('main', 'setSharing', [targetId, []]), /BrowserCapabilityUnavailable/);
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

function hostFixture(call: (command: string, arg: unknown) => Promise<unknown>, canvases?: IAgentCanvasHost): DisposableStore & { readonly configuration: ConfigurationService; readonly playwright: IPlaywrightService; readonly transport: HostTransport; readonly client: AppServerProtocolClient; readonly events: Emitter<BrowserViewEvent>; readonly sharing: IServerChannel<string>; } {
	const resources = new DisposableStore();
	const events = resources.add(new Emitter<BrowserViewEvent>());
	const services = resources.add(new InstantiationService(registrations()));
	const files = resources.add(new FileService());
	resources.add(files.registerProvider('test', resources.add(new InMemoryFileSystemProvider())));
	services.registerInstance(IFileService, files);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(IPolicyService, new NullPolicyService());
	const configuration = resources.add(services.createInstance(ConfigurationService, URI.parse('test:/settings.json')));
	services.registerSingleton(IMainProcessService, () => services.createInstance(TestMainProcessService, call, events.event));
	const mainProcessService = services.get(IMainProcessService);
	const playwright = services.get(IPlaywrightService);
	const transport = new HostTransport();
	const client = new AppServerProtocolClient(transport);
	resources.add(toDisposable(() => client.dispose()));
	resources.add(registerAppServerBrowserHost(client, playwright, mainProcessService, configuration, canvases));
	return Object.assign(resources, { configuration, playwright, transport, client, events, sharing: (mainProcessService as TestMainProcessService).rendererChannels.get('browserSharing')! });
}

class TestMainProcessService extends AbstractDisposable implements IMainProcessService {
	declare public readonly _serviceBrand: undefined;
	private readonly channel: IChannel;
	public readonly rendererChannels = new Map<string, IServerChannel<string>>();

	constructor(call: (command: string, arg: unknown) => Promise<unknown>, events: Event<BrowserViewEvent>) {
		super();
		this.channel = {
			call: async <T>(command: string, arg: unknown): Promise<T> => { this.assertNotDisposed(); return command === 'configure' ? undefined as T : await call(command, arg) as T; },
			listen: <T>() => events as Event<T>,
		};
	}

	public getChannel(name: string): IChannel {
		assert.equal(name, 'browserHost');
		return this.channel;
	}

	public registerChannel(name: string, channel: IServerChannel<string>): void { this.rendererChannels.set(name, channel); }
	protected override disposeCore(): void { }
}

class HostTransport extends EventEmitter implements AppServerTransport {
	private sequence = 0;
	private readonly requests = new Map<string, ReturnType<typeof promiseWithResolvers<Record<string, unknown>>>>();
	public readonly backendRequests: { method: string; params: unknown; }[] = [];
	public readonly preferences: unknown[] = [];

	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'browser-test', workspaceRoot: '/workspace' });
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const message = JSON.parse((payload as { frame: string; }).frame);
		if (message.method === 'initialize') { this.emitFrame({ jsonrpc: '2.0', id: message.id, result: createTestInitializeResult() }); }
		if (message.method === 'browser/configure') {
			this.preferences.push(message.params);
			this.emitFrame({ jsonrpc: '2.0', id: message.id, result: null });
		}
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

import { IWebWorkerService } from '../../../webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../../../webWorker/browser/webWorkerServiceImpl.js';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DisposableTracker, installDisposableTracker } from '../../../../base/common/lifecycle.js';
import type { ISandboxGlobals } from '../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ILogService, type LogEntry } from '../../../log/common/log.js';
import { LogService } from '../../../log/common/logServiceImpl.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../remote/common/remoteSocketFactoryService.js';
import { AppServerCallService } from '../../../call/browser/appServerCallService.js';
import { createAppServerVoiceCodeTranscriptionBackend } from '../../../renderer/browser/appServerVoiceCodeTranscriptionBackend.js';
import { APP_SERVER_METHODS } from '../../../../../../.build/protocol/typescript/index.js';
import { createTestInitializeResult } from '../common/testAppServerProtocol.js';
import { AppServerConnectionStoppedError } from '../../common/appServerError.js';

suite('Local Agent Host connection service', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const channels: MessageChannel[] = [];
	const traffic: { channel: string; method: string; }[] = [];
	const portChannels: string[] = [];
	const restarts = new Set<(value: unknown) => void>();
	let Service: typeof import('../../electron-browser/localAgentHostService.js').LocalAgentHostServiceClient;
	let tracking: ReturnType<typeof installDisposableTracker>;
	let tracker: DisposableTracker;
	let acquisitions: number;
	let initialized: number;
	let repairs: number;
	let enabled: boolean;
	let mismatch: boolean;
	let failAcquisition: boolean;
	let pendingAcquisition: (() => Promise<void>) | undefined;
	let beforeAcquireReply: ((ports: MessageChannel) => Promise<void>) | undefined;

	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send() { },
			on: (channel, listener) => {
				assert.match(channel, /^ash:app-server(?::local|:host:[0-9a-f-]{36})?:restart$/);
				restarts.add(listener);
				return { dispose: () => { restarts.delete(listener); } };
			},
			invoke: async (channel, params) => {
				if (channel.endsWith(':initialized')) { initialized++; return; }
				if (channel.endsWith(':recover-runtime')) { repairs++; return true; }
				assert.match(channel, /^ash:app-server(?::local|:host:[0-9a-f-]{36})?:acquire$/);
				acquisitions++;
				await pendingAcquisition?.();
				if (failAcquisition) { throw new Error('acquisition refused'); }
				if (!enabled) { return { enabled: false }; }
				const ports = new MessageChannel();
				channels.push(ports);
				ports.port2.on('message', value => {
					if (!(value.data instanceof Uint8Array)) { return; }
					ports.port2.postMessage({ ack: true });
					const frame = JSON.parse(new TextDecoder().decode(value.data).trim());
					traffic.push({ channel, method: frame.method });
					if (frame.method === 'initialize') {
						const result = createTestInitializeResult();
						if (mismatch && acquisitions === 1) { result.schemaHash = 'incompatible'; }
						const response = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n';
						ports.port2.postMessage({ data: new TextEncoder().encode(response) });
					} else if (frame.method === 'dictation/audio' || frame.method === 'session/list' || frame.method === 'call/start') {
						const response = frame.method === 'call/start'
							? { jsonrpc: '2.0', id: frame.id, error: { code: -32073, message: 'fixture refuses devices', data: { kind: 'PermissionRequired' } } }
							: { jsonrpc: '2.0', id: frame.id, result: frame.method === 'session/list' ? { sessions: [] } : null };
						ports.port2.postMessage({ data: new TextEncoder().encode(JSON.stringify(response) + '\n') });
					}
				});
				dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
					source: dom.window as unknown as Window,
					data: { nonce: (params as { nonce: string; }).nonce },
					ports: [ports.port1 as unknown as MessagePort],
				}));
				await beforeAcquireReply?.(ports);
				return { enabled: true, byteStream: true, protocolVersion: 1, workspaceId: 'window', workspaceRoot: '/workspace' };
			},
		},
		ipcMessagePort: { acquire: channel => { portChannels.push(channel); return { dispose() { } }; } },
		process: { platform: process.platform, arch: process.arch, isBuilt: false },
		webUtils: { getPathForFile: () => '' },
	};

	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		Service = (await import('../../electron-browser/localAgentHostService.js')).LocalAgentHostServiceClient;
	});
	suiteTeardown(() => {
		if (previousWindow) { Object.defineProperty(globalThis, 'window', previousWindow); } else { Reflect.deleteProperty(globalThis, 'window'); }
		if (previousGlobals) { Object.defineProperty(globalThis, 'ash', previousGlobals); } else { Reflect.deleteProperty(globalThis, 'ash'); }
		dom.window.close();
	});
	setup(() => {
		acquisitions = initialized = repairs = 0;
		traffic.length = portChannels.length = 0;
		enabled = true;
		mismatch = failAcquisition = false;
		pendingAcquisition = undefined;
		beforeAcquireReply = undefined;
		tracker = new DisposableTracker();
		tracking = installDisposableTracker(tracker);
	});
	teardown(() => {
		try {
			for (const ports of channels.splice(0)) { ports.port1.close(); ports.port2.close(); }
			assert.equal(restarts.size, 0);
			tracker.assertNoLeaks();
		} finally { tracking[Symbol.dispose](); }
	});

	function assemble(services: InstantiationService, logger: ILogService) {
		services.registerInstance(ILogService, logger);
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
		return services.createInstance(Service, { clientName: 'test-desktop' });
	}

	test('SSH workspace and local media use distinct carriers and keep Agent requests on the workspace', async () => {
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [] });
		services.registerInstance(ILogService, logger);
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
		using local = services.createInstance(Service, { clientName: 'desktop-media', connection: 'local' });
		using workspace = services.createInstance(Service, { clientName: 'desktop-workspace' });
		assert.equal(await local.connect(), true);
		assert.equal(await workspace.connect(), true);
		using calls = new AppServerCallService(local.client);
		await assert.rejects(calls.start({ type: 'local' }), /fixture refuses devices/);
		await createAppServerVoiceCodeTranscriptionBackend(local.client).pushAudio('dictation', 'AAA=');
		await workspace.client.request(APP_SERVER_METHODS['session/list'], {});
		assert.deepEqual(traffic.filter(item => ['call/start', 'dictation/audio', 'session/list'].includes(item.method)), [
			{ channel: 'ash:app-server:local:acquire', method: 'call/start' },
			{ channel: 'ash:app-server:local:acquire', method: 'dictation/audio' },
			{ channel: 'ash:app-server:acquire', method: 'session/list' },
		]);
		assert.deepEqual(portChannels, ['ash:app-server:local:port', 'ash:app-server:port']);
	});


	test('additional hosts own independent protocol clients and retiring one leaves the other usable', async () => {
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [] });
		services.registerInstance(ILogService, logger);
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
		const firstId = '00000000-0000-0000-0000-000000000001';
		const secondId = '00000000-0000-0000-0000-000000000002';
		using first = services.createInstance(Service, { clientName: 'host-a', connection: { id: firstId } });
		using second = services.createInstance(Service, { clientName: 'host-b', connection: { id: secondId } });
		await Promise.all([first.connect(), second.connect()]);
		await first.client.request(APP_SERVER_METHODS['session/list'], {});
		first.dispose();
		await second.client.request(APP_SERVER_METHODS['session/list'], {});
		assert.deepEqual(traffic.filter(item => item.method === 'session/list'), [
			{ channel: `ash:app-server:host:${firstId}:acquire`, method: 'session/list' },
			{ channel: `ash:app-server:host:${secondId}:acquire`, method: 'session/list' },
		]);
		assert.equal(second.client.state, 'ready');
		assert.deepEqual(portChannels, [`ash:app-server:host:${firstId}:port`, `ash:app-server:host:${secondId}:port`]);
	});

	test('production assembly requires the connection log service', () => {
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
		assert.throws(() => services.createInstance(Service, {}), /Unknown service: logService/);
	});

	test('disabled development hosts settle without initializing a protocol', async () => {
		enabled = false;
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [] });
		using service = assemble(services, logger);
		assert.equal(await service.connect(), false);
		assert.equal(service.client.state, 'stopped');
		assert.equal(initialized, 0);
	});

	test('cold connection acquisition retains the configured initialization budget', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			let release!: () => void;
			let entered!: () => void;
			const acquiring = new Promise<void>(resolve => { entered = resolve; });
			pendingAcquisition = () => new Promise(resolve => { release = resolve; entered(); });
			enabled = false;
			using services = new InstantiationService();
			services.registerInstance(IWebWorkerService, new WebWorkerService());
			using logger = new LogService({ sinks: [] });
			services.registerInstance(ILogService, logger);
			services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
			using service = services.createInstance(Service, { clientName: 'cold-ssh', initializeTimeoutMs: 180_000 });
			let settled = false;
			const ready = service.connect().finally(() => { settled = true; });
			await acquiring;
			mock.timers.tick(15_000);
			await Promise.resolve();
			assert.equal(settled, false);
			release();
			assert.equal(await ready, false);
			assert.equal(acquisitions, 1);
		} finally { mock.timers.reset(); }
	});

	test('restart replaces the local lease once and preserves the protocol client for consumers', async () => {
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [] });
		using service = assemble(services, logger);
		const client = service.client;
		assert.equal(await service.connect(), true);
		let reconnects = 0;
		using listener = service.onDidReconnect(() => { reconnects++; });
		for (const restart of restarts) { restart(undefined); restart(undefined); }
		await service.whenConnected();
		assert.equal(service.client, client);
		assert.equal(client.state, 'ready');
		assert.equal(client.generation, 2);
		assert.deepEqual({ acquisitions, initialized, reconnects }, { acquisitions: 2, initialized: 2, reconnects: 1 });
	});

	test('runtime incompatibility repairs and reacquires before publishing readiness', async () => {
		mismatch = true;
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [] });
		using service = assemble(services, logger);
		assert.equal(await service.connect(), true);
		assert.equal(service.client.state, 'ready');
		assert.deepEqual({ acquisitions, initialized, repairs }, { acquisitions: 2, initialized: 1, repairs: 1 });
	});

	test('carrier failure preserves its diagnostic and automatically restores the local connection', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const entries: LogEntry[] = [];
			using services = new InstantiationService();
			services.registerInstance(IWebWorkerService, new WebWorkerService());
			using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
			using service = assemble(services, logger);
			await service.connect();
			let crashed!: () => void;
			const failure = new Promise<void>(resolve => { crashed = resolve; });
			using listener = service.client.onStateChange(state => { if (state === 'crashed') { crashed(); } });
			channels[0].port2.postMessage({ closed: 'Carrier exited with code 23' });
			await failure;
			mock.timers.tick(100);
			await service.whenConnected();
			assert.equal(service.client.state, 'ready');
			assert.deepEqual({ acquisitions, initialized }, { acquisitions: 2, initialized: 2 });
			const errors = entries.filter(entry => entry.error !== undefined);
			assert.equal(errors.length, 1);
			assert.match((errors[0].error as Error).message, /Carrier exited with code 23/);
		} finally { mock.timers.reset(); }
	});

	test('acquisition failure reaches the caller and the persistent log', async () => {
		failAcquisition = true;
		const entries: LogEntry[] = [];
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
		using service = assemble(services, logger);
		await assert.rejects(service.connect(), /acquisition refused/);
		assert.equal(entries.length, 1);
		assert.match((entries[0].error as Error).message, /acquisition refused/);
	});

	async function closePort(ports: MessageChannel, message: { intentional: true; } | { closed: string; }): Promise<void> {
		const closed = new Promise<void>(resolve => ports.port2.once('close', resolve));
		ports.port2.postMessage(message);
		await closed;
	}

	for (const phase of ['initial acquisition', 'reacquisition', 'socket lease'] as const) {
		test(`intentional Main closure during ${phase} stops recovery without logging a failure or retrying`, async () => {
			mock.timers.enable({ apis: ['setTimeout'] });
			try {
				const entries: LogEntry[] = [];
				using services = new InstantiationService();
				services.registerInstance(IWebWorkerService, new WebWorkerService());
				using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
				using service = assemble(services, logger);
				if (phase === 'reacquisition') { await service.connect(); }
				const previousInitializations = initialized;
				if (phase === 'socket lease') {
					const factories = services.get(IRemoteSocketFactoryService);
					const connect = factories.connect.bind(factories);
					const interception = mock.method(factories, 'connect', async (...args: Parameters<typeof connect>) => {
						await closePort(channels.at(-1)!, { intentional: true });
						return connect(...args);
					});
					try {
						await assert.rejects(service.connect(), AppServerConnectionStoppedError);
					} finally { interception.mock.restore(); }
				} else {
					beforeAcquireReply = ports => closePort(ports, { intentional: true });
					await assert.rejects(service.connect(), AppServerConnectionStoppedError);
				}
				assert.equal(service.client.state, 'stopped');
				assert.equal(service.recovery.status, 'unavailable');
				assert.equal(initialized, previousInitializations);
				assert.deepEqual(entries.filter(entry => entry.level === 'error'), []);
				const attempts = acquisitions;
				mock.timers.tick(10_000);
				await Promise.resolve();
				assert.equal(acquisitions, attempts);
			} finally { mock.timers.reset(); }
		});
	}

	test('a port lost before the acquire reply preserves its cause and permits a fresh connection', async () => {
		beforeAcquireReply = ports => closePort(ports, { closed: 'Carrier exited with code 23' });
		const entries: LogEntry[] = [];
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
		using service = assemble(services, logger);
		await assert.rejects(service.connect(), /Carrier exited with code 23/);
		assert.equal(initialized, 0);
		const errors = entries.filter(entry => entry.level === 'error');
		assert.equal(errors.length, 1);
		assert.match((errors[0].error as Error).message, /Carrier exited with code 23/);
		beforeAcquireReply = undefined;
		assert.equal(await service.connect(), true);
		assert.equal(service.client.state, 'ready');
	});

	test('disposal cancels pending acquisition and cannot resurrect its socket factory', async () => {
		let release!: () => void;
		let entered!: () => void;
		const acquiring = new Promise<void>(resolve => { entered = resolve; });
		pendingAcquisition = () => new Promise(resolve => { release = resolve; entered(); });
		using services = new InstantiationService();
		services.registerInstance(IWebWorkerService, new WebWorkerService());
		using logger = new LogService({ sinks: [] });
		using service = assemble(services, logger);
		const result = assert.rejects(service.connect(), { name: 'CancellationError' });
		await acquiring;
		service.dispose();
		enabled = false;
		release();
		await result;
		assert.equal(service.client.state, 'stopped');
		assert.equal(initialized, 0);
	});
});

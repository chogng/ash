import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type ExtensionHostInvocationRequest, type JsonValue } from '../../../../../platform/extensionHost/common/extensionHostApi.js';
import { IRemoteAuthorityResolverService, RemoteConnectionType, WebSocketRemoteConnection, RemoteAuthorityResolverErrorCode } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../../../../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../../../platform/remote/common/remoteSocketFactoryService.js';
import { NativeExtensionService } from '../../electron-browser/nativeExtensionService.js';
import { URI } from '../../../../../base/common/uri.js';

function fleet(incarnation = 3): ExtensionHostFleetSnapshot {
	return { generation: 1, extensions: [{ id: 'local.resolver', version: '1.0.0', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1, lifecycle: 'ready', incarnation, activationGeneration: 2, failure: undefined, stderr: '', outputEvents: [], registrations: [{ kind: 'remoteAuthorityResolver', registrationId: 'resolve', authorityPrefix: 'team' }] }] };
}

function setup(invoke: IExtensionHostApi['invoke'], snapshot: () => ExtensionHostFleetSnapshot = () => fleet()): { services: InstantiationService; changed: Emitter<number>; } {
	const services = new InstantiationService();
	const changed = new Emitter<number>();
	services.registerInstance(IExtensionHostApi, {
		start: async () => { throw new Error('Startup is outside this fixture'); }, registerClientHandler: () => Disposable.None, isAvailable: async () => true, list: async () => snapshot(), reconcile: async () => snapshot(), activateByEvent: async () => snapshot(),
		invoke, getConnectionState: async () => 'ready', onDidChange: changed.event, onConnectionState: () => Disposable.None,
	});
	services.registerSingleton(IRemoteAuthorityResolverService, () => services.createInstance(RemoteAuthorityResolverService));
	services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
	return { services, changed };
}

test('local extension authority resolution publishes a real endpoint before socket connection', async () => {
	const requests: ExtensionHostInvocationRequest[] = [];
	const { services, changed } = setup(async (request): Promise<JsonValue> => {
		requests.push(request);
		return { type: 'webSocket', host: '127.0.0.1', port: 5000, connectionToken: 'capability' };
	});
	using scope = services;
	using changes = changed;
	using extensions = services.createInstance(NativeExtensionService);
	const result = await extensions.resolveAuthority('team+build', 2);
	assert.deepEqual(result.authority, { authority: 'team+build', connectTo: new WebSocketRemoteConnection('127.0.0.1', 5000), connectionToken: 'capability' });
	assert.deepEqual(services.get(IRemoteAuthorityResolverService).getConnectionData('team+build'), { connectTo: result.authority.connectTo, connectionToken: result.authority.connectionToken });
	assert.deepEqual(requests.map(({ extensionId, incarnation, activationGeneration, operation, payload }) => ({ extensionId, incarnation, activationGeneration, operation, payload })), [{ extensionId: 'local.resolver', incarnation: 3, activationGeneration: 2, operation: 'resolveAuthority', payload: { authority: 'team+build', resolveAttempt: 2 } }]);
	await assert.rejects(extensions.resolveAuthority('other+build', 1), error => (error as { _code: string; })._code === RemoteAuthorityResolverErrorCode.NoResolverFound);
});

test('a new resolver incarnation retires cached options and pending canonical queries', async () => {
	let incarnation = 3;
	const entered = new DeferredPromise<void>();
	const late = new DeferredPromise<JsonValue>();
	const { services, changed } = setup(async (request): Promise<JsonValue> => {
		if (request.operation === 'resolveAuthority') { return { type: 'webSocket', host: 'localhost', port: 5000, connectionToken: null, options: { isTrusted: false } }; }
		if (request.incarnation === 3) { await entered.complete(); return late.p; }
		return null;
	}, () => fleet(incarnation));
	using scope = services;
	using changes = changed;
	using extensions = services.createInstance(NativeExtensionService);
	await extensions.resolveAuthority('team+build', 1);
	const resolver = services.get(IRemoteAuthorityResolverService);
	const uri = URI.parse('ash-remote://team+build/alias');
	const querying = resolver.getCanonicalURI(uri);
	await entered.p;
	const rejected = assert.rejects(querying, /[Cc]ancel/);
	const retired = new DeferredPromise<void>();
	using listener = resolver.onDidChangeConnectionData(() => { if (!resolver.getConnectionData(uri.authority)) { void retired.complete(); } });
	incarnation = 4;
	changed.fire(2);
	await retired.p;
	await rejected;
	await extensions.resolveAuthority(uri.authority, 2);
	assert.equal(await resolver.getCanonicalURI(uri), uri);
	await late.complete({ scheme: 'ash-remote', authority: uri.authority, path: '/stale', query: '', fragment: '', external: 'ash-remote://team+build/stale' });
	assert.equal(await resolver.getCanonicalURI(uri), uri);
});

test('canonical callbacks run in the same local resolver incarnation and options survive publication', async () => {
	const options = { isTrusted: false, extensionHostEnv: { SET: 'value', REMOVE: null }, authenticationSession: { id: 'session', providerId: 'provider' } };
	const operations: string[] = [];
	const { services, changed } = setup(async (request): Promise<JsonValue> => {
		assert.equal(request.incarnation, 3);
		operations.push(request.operation);
		if (request.operation === 'resolveAuthority') { return { type: 'webSocket', host: 'localhost', port: 5000, connectionToken: null, options }; }
		const payload = request.payload as { uri: { path: string; }; };
		return payload.uri.path === '/identity' ? null : { scheme: 'ash-remote', authority: 'team+build', path: '/canonical', query: '', fragment: '', external: 'ash-remote://team+build/canonical' };
	});
	using scope = services;
	using changes = changed;
	using extensions = services.createInstance(NativeExtensionService);
	assert.deepEqual((await extensions.resolveAuthority('team+build', 1)).options, options);
	const resolver = services.get(IRemoteAuthorityResolverService);
	const uri = URI.parse('ash-remote://team+build/alias');
	assert.equal((await resolver.getCanonicalURI(uri)).path, '/canonical');
	await resolver.getCanonicalURI(uri);
	const identity = URI.parse('ash-remote://team+build/identity');
	assert.equal(await resolver.getCanonicalURI(identity), identity);
	assert.deepEqual(operations, ['resolveAuthority', 'getCanonicalURI', 'getCanonicalURI']);
});

test('the extension wire boundary rejects token-bearing authentication metadata and inconsistent URI results', async () => {
	let canonical = false;
	const { services, changed } = setup(async (): Promise<JsonValue> => canonical
		? { scheme: 'ash-remote', authority: 'team+build', path: '/wrong', query: '', fragment: '', external: 'ash-remote://team+build/right' }
		: { type: 'webSocket', host: 'localhost', port: 5000, connectionToken: null, options: { authenticationSession: { id: 'session', providerId: 'provider', accessToken: 'secret' } } });
	using scope = services;
	using changes = changed;
	using extensions = services.createInstance(NativeExtensionService);
	await assert.rejects(extensions.resolveAuthority('team+build', 1), /Invalid resolver authentication/);
	canonical = true;
	await assert.rejects(services.get(IRemoteAuthorityResolverService).getCanonicalURI(URI.parse('ash-remote://team+build/alias')), /Inconsistent canonical/);
});

test('managed sockets use the local incarnation, drain accepted writes and retire on re-resolution', async () => {
	let nextFactory = 11;
	let buffered = '';
	const releases = new DeferredPromise<void>();
	const operations: string[] = [];
	const { services, changed } = setup(async (request): Promise<JsonValue> => {
		assert.equal(request.incarnation, 3);
		assert.equal(request.activationGeneration, 2);
		operations.push(request.operation);
		const payload = request.payload as Record<string, JsonValue>;
		switch (request.operation) {
			case 'resolveAuthority': return { type: 'managed', id: nextFactory++, connectionToken: null };
			case 'remoteConnect': return { id: 20 };
			case 'remoteWrite': buffered += payload.data; return null;
			case 'remoteRead': { const data = buffered; buffered = ''; return { data, closed: false, ended: false, error: null }; }
			case 'remoteDrain': return null;
			case 'remoteRelease': await releases.complete(); return null;
			default: throw new Error(`Unexpected ${request.operation}`);
		}
	});
	using scope = services;
	using changes = changed;
	using extensions = services.createInstance(NativeExtensionService);
	const first = await extensions.resolveAuthority('team+build', 1);
	const factories = services.get(IRemoteSocketFactoryService);
	using socket = await factories.connect(first.authority.connectTo, '', '', 'test');
	const received = new DeferredPromise<VSBuffer>();
	using listener = socket.onData(data => { void received.complete(data); });
	socket.write(VSBuffer.wrap(Uint8Array.of(0, 255, 240, 159, 152, 128)));
	await socket.drain();
	assert.deepEqual((await received.p).buffer, Uint8Array.of(0, 255, 240, 159, 152, 128));
	await extensions.resolveAuthority('team+build', 2);
	await releases.p;
	await assert.rejects(factories.connect(first.authority.connectTo, '', '', 'test'), /No socket factory/);
	assert.ok(operations.indexOf('remoteDrain') > operations.indexOf('remoteWrite'));
});

test('retiring the local resolver while it is executing prevents a late endpoint from being published', async () => {
	const result = new DeferredPromise<JsonValue>();
	const entered = new DeferredPromise<void>();
	const { services, changed } = setup(async () => { await entered.complete(); return result.p; });
	using scope = services;
	using changes = changed;
	using extensions = services.createInstance(NativeExtensionService);
	const resolving = extensions.resolveAuthority('team+build', 1);
	await entered.p;
	extensions.dispose();
	await result.complete({ type: 'webSocket', host: '127.0.0.1', port: 5000, connectionToken: null });
	await assert.rejects(resolving, /[Cc]ancel/);
	assert.equal(services.get(IRemoteAuthorityResolverService).getConnectionData('team+build'), null);
});

test('the window routes local resolver and remote commands to distinct host incarnations', async () => {
	const localCalls: ExtensionHostInvocationRequest[] = [];
	const { services, changed } = setup(async request => {
		localCalls.push(request);
		return { type: 'webSocket', host: 'localhost', port: 5000, connectionToken: null, options: { extensionHostEnv: { REMOTE: 'yes' } } };
	});
	using scope = services;
	using changes = changed;
	using remoteStates = new Emitter<'ready' | 'crashed'>();
	using extensions = services.createInstance(NativeExtensionService);
	await extensions.resolveAuthority('team+build', 1);
	const remoteCalls: ExtensionHostInvocationRequest[] = [];
	const environments: Readonly<Record<string, string | null>>[] = [];
	const remoteFleet: ExtensionHostFleetSnapshot = { generation: 1, extensions: [...fleet().extensions, { ...fleet().extensions[0]!, id: 'remote.command', registrations: [{ kind: 'command', registrationId: 'run', command: 'remote.run', title: 'Run' }] }] };
	const remote: IExtensionHostApi = {
		start: async environment => { environments.push(environment); return remoteFleet; },
		list: async () => remoteFleet, reconcile: async () => remoteFleet, activateByEvent: async () => remoteFleet,
		invoke: async request => { remoteCalls.push(request); return 'remote'; }, isAvailable: async () => true, getConnectionState: async () => 'ready',
		registerClientHandler: () => Disposable.None, onDidChange: () => Disposable.None, onConnectionState: remoteStates.event,
	};
	const windowApi = await extensions.startRemoteExtensionHost(remote, 'team+build');
	const snapshot = await windowApi.list();
	const localRuntime = snapshot.extensions.find(entry => entry.id === 'local.resolver')!;
	const remoteRuntime = snapshot.extensions.find(entry => entry.id === 'remote.command')!;
	assert.notEqual(localRuntime.incarnation, remoteRuntime.incarnation);
	assert.deepEqual(snapshot.extensions.map(entry => entry.id), ['local.resolver', 'remote.command']);
	const request = { extensionId: 'remote.command', activationGeneration: remoteRuntime.activationGeneration, incarnation: remoteRuntime.incarnation!, registrationId: 'run', operation: 'execute', payload: null, deadlineUnixMillis: Date.now() + 5000 };
	assert.equal(await windowApi.invoke(request, new AbortController().signal), 'remote');
	await assert.rejects(windowApi.invoke({ ...request, activationGeneration: localRuntime.activationGeneration, incarnation: localRuntime.incarnation! }, new AbortController().signal), /[Cc]ancel/);
	await windowApi.invoke({ ...request, extensionId: 'local.resolver', activationGeneration: localRuntime.activationGeneration, incarnation: localRuntime.incarnation!, registrationId: 'resolve', operation: 'resolveAuthority' }, new AbortController().signal);
	assert.equal(remoteCalls.length, 1);
	assert.deepEqual(remoteCalls[0], { ...request, activationGeneration: 2, incarnation: 3 });
	assert.equal(localCalls.at(-1)?.extensionId, 'local.resolver');
	remoteStates.fire('crashed');
	remoteStates.fire('ready');
	assert.equal(await extensions.startRemoteExtensionHost(remote, 'team+build'), windowApi);
	await windowApi.list();
	await assert.rejects(windowApi.invoke(request, new AbortController().signal), /[Cc]ancel/);
	assert.deepEqual(environments, [{ REMOTE: 'yes' }, { REMOTE: 'yes' }]);
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IExtensionHostApi } from '../../../../../platform/extensionHost/common/extensionHostApi.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IRemoteAuthorityResolverService, WebSocketRemoteConnection } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../../../../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import { RemoteExtensionHost } from '../../common/remoteExtensionHost.js';

test('remote startup applies resolver environment before readiness and obtains new options after reconnect', async () => {
	using services = new InstantiationService();
	using states = new Emitter<AppServerConnectionState>();
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<void>();
	const environments: Readonly<Record<string, string | null>>[] = [];
	const fleet = { generation: 1, extensions: [] };
	services.registerInstance(IExtensionHostApi, {
		start: async environment => { environments.push(environment); await entered.complete(); if (environments.length === 1) { await finish.p; } return fleet; },
		list: async () => fleet, reconcile: async () => fleet, activateByEvent: async () => fleet,
		invoke: async () => null, isAvailable: async () => true, getConnectionState: async () => 'ready',
		registerClientHandler: () => Disposable.None, onDidChange: () => Disposable.None, onConnectionState: states.event,
	});
	services.registerSingleton(IRemoteAuthorityResolverService, () => services.createInstance(RemoteAuthorityResolverService));
	const resolver = services.get(IRemoteAuthorityResolverService);
	const address = { authority: 'team+host', connectTo: new WebSocketRemoteConnection('localhost', 5000), connectionToken: undefined };
	resolver._setResolvedAuthority(address, { extensionHostEnv: { SET: 'first', REMOVE: null }, authenticationSession: { id: 'reference', providerId: 'provider' } });
	using host = services.createInstance(RemoteExtensionHost, address.authority);
	let ready = false;
	void host.whenReady().then(() => { ready = true; });
	const starting = host.start();
	await entered.p;
	assert.equal(ready, false);
	await finish.complete();
	await starting;
	assert.equal(ready, true);
	states.fire('crashed');
	resolver._clearResolvedAuthority(address.authority);
	resolver._setResolvedAuthority(address, { extensionHostEnv: { SET: 'second' } });
	states.fire('ready');
	await host.start();
	await host.whenReady();
	assert.deepEqual(environments, [{ SET: 'first', REMOVE: null }, { SET: 'second' }]);
});

test('closing during the remote handshake prevents late startup from making the host ready', async () => {
	using services = new InstantiationService();
	using states = new Emitter<AppServerConnectionState>();
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<void>();
	const fleet = { generation: 1, extensions: [] };
	services.registerInstance(IExtensionHostApi, {
		start: async () => { await entered.complete(); await finish.p; return fleet; }, list: async () => fleet, reconcile: async () => fleet, activateByEvent: async () => fleet,
		invoke: async () => null, isAvailable: async () => true, getConnectionState: async () => 'ready', registerClientHandler: () => Disposable.None, onDidChange: () => Disposable.None, onConnectionState: states.event,
	});
	services.registerSingleton(IRemoteAuthorityResolverService, () => services.createInstance(RemoteAuthorityResolverService));
	services.get(IRemoteAuthorityResolverService)._setResolvedAuthority({ authority: 'team+host', connectTo: new WebSocketRemoteConnection('localhost', 5000), connectionToken: undefined });
	using host = services.createInstance(RemoteExtensionHost, 'team+host');
	const readiness = assert.rejects(host.whenReady(), /[Cc]ancel/);
	const starting = host.start();
	const rejected = assert.rejects(starting, /[Cc]ancel/);
	await entered.p;
	states.fire('crashed');
	await finish.complete();
	await Promise.all([readiness, rejected]);
});

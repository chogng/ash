import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { ISocket } from '../../../../base/parts/ipc/common/ipc.net.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { RemoteSocketFactoryService } from '../../common/remoteSocketFactoryService.js';
import { ManagedRemoteConnection, RemoteConnectionType } from '../../common/remoteAuthorityResolver.js';

test('retired managed factory handles cannot connect to their replacement', async () => {
	using services = new InstantiationService();
	using factories = services.createInstance(RemoteSocketFactoryService);
	let dials = 0;
	using old = factories.register(RemoteConnectionType.Managed, {
		supports: target => target.id === 4,
		connect: async () => {
			dials++;
			throw new Error('old');
		},
	});
	old.dispose();
	using replacement = factories.register(RemoteConnectionType.Managed, {
		supports: target => target.id === 5,
		connect: async () => {
			dials++;
			throw new Error('replacement');
		},
	});
	await assert.rejects(factories.connect(new ManagedRemoteConnection(4), '', '', 'test'), /No socket factory/);
	assert.equal(dials, 0);
	await assert.rejects(factories.connect(new ManagedRemoteConnection(5), '', '', 'test'), /replacement/);
	assert.equal(dials, 1);
});

test('retiring a pending factory closes its late socket instead of returning it', async () => {
	using services = new InstantiationService();
	using factories = services.createInstance(RemoteSocketFactoryService);
	let finish!: (socket: ISocket) => void;
	using registration = factories.register(RemoteConnectionType.Managed, {
		supports: () => true,
		connect: () => new Promise(resolve => { finish = resolve; }),
	});
	const connecting = factories.connect(new ManagedRemoteConnection(1), '', '', 'test');
	registration.dispose();
	let disposed = false;
	// Only the disposal capability is reached after retirement; no simulated socket IO is involved.
	finish({ dispose: () => { disposed = true; } } as ISocket);
	await assert.rejects(connecting, /[Cc]ancel/);
	assert.equal(disposed, true);
});

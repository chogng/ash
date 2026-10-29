import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IRemoteConnectionApi, RemoteConnectionService } from '../../common/remoteConnectionService.js';

const connection = { name: 'build', host: 'build-linux', workspace: '/srv/project' };

function createServices(): InstantiationService {
	const services = new InstantiationService();
	services.registerInstance(IRemoteConnectionApi, {
		available: true, list: async () => [connection], save: async value => value, update: async (_name, value) => value,
		remove: async () => undefined, connect: async () => assert.fail('Resolution must not connect'),
	});
	return services;
}

test('built-in SSH and contributed authorities resolve through the same saved catalog', async () => {
	using services = createServices();
	using resolver = services.createInstance(RemoteConnectionService);
	using registration = resolver.registerResolvers([{
		authorityPrefix: 'ssh', resolve: async authority => ({ connectionName: authority.slice(4) }),
	}, {
		authorityPrefix: 'team', resolve: async authority => {
			assert.equal(authority, 'team+linux');
			return { connectionName: 'build' };
		}
	}]);
	const signal = new AbortController().signal;
	assert.deepEqual(await Promise.all([resolver.resolveConnection('ssh+build', signal), resolver.resolveConnection('team+linux', signal)]), [connection, connection]);
});

test('Remote resolution rejects arbitrary targets and conflicting prefixes atomically', async () => {
	using services = createServices();
	using resolver = services.createInstance(RemoteConnectionService);
	using registration = resolver.registerResolvers([{ authorityPrefix: 'team', resolve: async () => ({ connectionName: 'missing' }) }]);
	assert.throws(() => registration.replace([
		{ authorityPrefix: 'team', resolve: async () => ({ connectionName: 'build' }) },
		{ authorityPrefix: 'team', resolve: async () => ({ connectionName: 'build' }) },
	]), /already has a resolver/);
	assert.throws(() => resolver.registerResolvers([{ authorityPrefix: 'team', resolve: async () => ({ connectionName: 'build' }) }]), /already has a resolver/);
	await assert.rejects(resolver.resolveConnection('team+linux', new AbortController().signal), /no longer exists/);
	await assert.rejects(resolver.resolveConnection('unknown+target', new AbortController().signal), /No Remote resolver/);
	await assert.rejects(resolver.resolveConnection('ssh+build', new AbortController().signal), /No Remote resolver/);
});

test('replacing a resolver cancels its pending invocation and prevents a late target', async () => {
	using services = createServices();
	using resolver = services.createInstance(RemoteConnectionService);
	let pendingSignal: AbortSignal | undefined;
	let finish!: (value: { connectionName: string; }) => void;
	using registration = resolver.registerResolvers([{
		authorityPrefix: 'team', resolve: (_authority, signal) => {
			pendingSignal = signal;
			return new Promise(resolve => { finish = resolve; });
		}
	}]);
	const pending = resolver.resolveConnection('team+linux', new AbortController().signal);
	registration.replace([]);
	assert.equal(pendingSignal?.aborted, true);
	finish({ connectionName: 'build' });
	await assert.rejects(pending, /[Cc]ancel/);
	await assert.rejects(resolver.resolveConnection('team+linux', new AbortController().signal), /No Remote resolver/);
});

test('cancelled and malformed authorities cannot invoke a resolver or read the catalog', async () => {
	using services = createServices();
	using resolver = services.createInstance(RemoteConnectionService);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(resolver.resolveConnection('ssh+build', controller.signal), /[Cc]ancel/);
	for (const authority of ['ssh+', 'SSH+build', 'ssh+build\n', 'team', 'team+']) {
		await assert.rejects(resolver.resolveConnection(authority, new AbortController().signal), /Invalid Remote/);
	}
});


test('disposing a selector or its window service cancels a pending catalog read', async () => {
	for (const retireService of [false, true]) {
		using services = new InstantiationService();
		let finish!: (value: readonly typeof connection[]) => void;
		let readStarted!: () => void;
		const reading = new Promise<void>(resolve => { readStarted = resolve; });
		services.registerInstance(IRemoteConnectionApi, {
			available: true,
			list: () => { readStarted(); return new Promise(resolve => { finish = resolve; }); },
			save: async value => value, update: async (_name, value) => value,
			remove: async () => undefined, connect: async () => assert.fail('Resolution must not connect'),
		});
		using resolver = services.createInstance(RemoteConnectionService);
		using registration = resolver.registerResolvers([{ authorityPrefix: 'team', resolve: async () => ({ connectionName: 'build' }) }]);
		const pending = resolver.resolveConnection('team+linux', new AbortController().signal);
		await reading;
		if (retireService) { resolver.dispose(); } else { registration.dispose(); }
		finish([connection]);
		await assert.rejects(pending, /[Cc]ancel/);
	}
});


test('caller cancellation reaches the selector and rejects a late connection result', async () => {
	using services = createServices();
	using resolver = services.createInstance(RemoteConnectionService);
	let pendingSignal: AbortSignal | undefined;
	let finish!: (value: { connectionName: string; }) => void;
	using registration = resolver.registerResolvers([{
		authorityPrefix: 'team', resolve: (_authority, signal) => {
			pendingSignal = signal;
			return new Promise(resolve => { finish = resolve; });
		},
	}]);
	const caller = new AbortController();
	const pending = resolver.resolveConnection('team+linux', caller.signal);
	caller.abort('Connection picker closed');
	assert.equal(pendingSignal?.aborted, true);
	assert.equal(pendingSignal?.reason, 'Connection picker closed');
	finish({ connectionName: 'build' });
	await assert.rejects(pending, /[Cc]ancel/);
});

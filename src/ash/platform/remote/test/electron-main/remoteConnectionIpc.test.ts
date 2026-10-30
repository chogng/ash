import { isCancellationError } from '../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { REMOTE_AGENT_HOST_OPEN_CHANNEL, REMOTE_AGENT_HOST_CLOSE_CHANNEL } from '../../common/remoteConnectionIpc.js';
import { RemoteAgentHostConnectionPool } from '../../electron-main/remoteConnectionIpc.js';
import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { REMOTE_CONNECTION_CONNECT_CHANNEL } from '../../../../platform/remote/common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_LIST_CHANNEL } from '../../../../platform/remote/common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_REMOVE_CHANNEL } from '../../../../platform/remote/common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_SAVE_CHANNEL } from '../../../../platform/remote/common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_UPDATE_CHANNEL } from '../../../../platform/remote/common/remoteConnectionIpc.js';
import type { RemoteConnectionDefinition } from '../../../../platform/remote/common/remoteConnectionService.js';
import type { IRemoteConnectionApi } from '../../../../platform/remote/common/remoteConnectionService.js';
import { remoteConnectionIpcRoutes } from '../../../../platform/remote/electron-main/remoteConnectionIpc.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('Remote connection IPC exposes only credential-free canonical catalog operations', async () => {
	const calls: unknown[] = [];
	const build = { name: 'build', host: 'build-linux', workspace: '/srv/project' };
	const service: IRemoteConnectionApi = {
		available: true,
		list: async () => [build],
		save: async connection => { calls.push(['save', connection]); return connection; },
		update: async (originalName, connection) => { calls.push(['update', originalName, connection]); return connection; },
		remove: async name => { calls.push(['remove', name]); return build; },
		connect: async name => { calls.push(['connect', name]); },
	};
	const routes = remoteConnectionIpcRoutes(service);

	assert.deepEqual(await route(routes, REMOTE_CONNECTION_LIST_CHANNEL).invoke(route(routes, REMOTE_CONNECTION_LIST_CHANNEL).validate(undefined)), [build]);
	const save = route(routes, REMOTE_CONNECTION_SAVE_CHANNEL);
	await save.invoke(save.validate({ connection: { name: ' BUILD ', host: 'BUILD-LINUX', workspace: '/srv/project' } }));
	const update = route(routes, REMOTE_CONNECTION_UPDATE_CHANNEL);
	await update.invoke(update.validate({ originalName: 'BUILD', connection: { name: 'prod', host: 'prod-linux', workspace: '/srv/prod' } }));
	const remove = route(routes, REMOTE_CONNECTION_REMOVE_CHANNEL);
	await remove.invoke(remove.validate({ name: 'BUILD' }));
	const connect = route(routes, REMOTE_CONNECTION_CONNECT_CHANNEL);
	await connect.invoke(connect.validate({ name: 'BUILD' }));

	assert.deepEqual(calls, [
		['save', build],
		['update', 'build', { name: 'prod', host: 'prod-linux', workspace: '/srv/prod' }],
		['remove', 'build'],
		['connect', 'build'],
	]);
});

test('Remote connection IPC rejects credentials, extra fields, invalid paths, and overwrite modes', () => {
	const routes = remoteConnectionIpcRoutes(testService());
	const save = route(routes, REMOTE_CONNECTION_SAVE_CHANNEL);
	const update = route(routes, REMOTE_CONNECTION_UPDATE_CHANNEL);
	const connect = route(routes, REMOTE_CONNECTION_CONNECT_CHANNEL);

	assert.throws(() => save.validate({ connection: { name: 'build', host: 'build', workspace: '/srv/project', password: 'secret' } }), /exactly required keys/);
	assert.throws(() => save.validate({ connection: { name: 'build', host: 'user@host', workspace: '/srv/project' } }), /without credentials/);
	assert.throws(() => save.validate({ connection: { name: 'build', host: 'build', workspace: '/srv/project/' } }), /canonical/);
	assert.throws(() => save.validate({ connection: { name: 'build', host: 'build', workspace: '/srv/project' }, mode: 'replace' }), /exactly required keys/);
	assert.throws(() => update.validate({ originalName: 'build', connection: { name: 'prod', host: 'prod', workspace: '/srv/prod' }, identityFile: '/tmp/key' }), /exactly required keys/);
	assert.throws(() => connect.validate({ name: 'build', host: 'build-linux' }), /exactly required keys/);
	assert.throws(() => connect.validate({ name: 'a'.repeat(65) }), /maximum encoded length/);
});

function route(routes: readonly { readonly channel: string; readonly validate: (value: unknown) => unknown; readonly invoke: (value: unknown) => unknown; }[], channel: string) {
	return routes.find(candidate => candidate.channel === channel)!;
}

function testService(): IRemoteConnectionApi {
	return {
		available: true,
		list: async () => [],
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async () => { },
	};
}


test('Remote connection IPC pins the confirmation to the exact canonical target', async () => {
	const target = { name: 'build', host: 'build-linux', workspace: '/srv/project' };
	let expected: RemoteConnectionDefinition | undefined;
	const connect = route(remoteConnectionIpcRoutes({ ...testService(), connect: async (_name, connection) => { expected = connection; } }), REMOTE_CONNECTION_CONNECT_CHANNEL);
	await connect.invoke(connect.validate({ name: 'build', expectedConnection: target }));
	assert.deepEqual(expected, target);
	assert.throws(() => connect.validate({ name: 'build', expectedConnection: { ...target, name: 'other' } }), /same saved target/);
	assert.throws(() => connect.validate({ name: 'build', expectedConnection: { ...target, identityFile: '/tmp/key' } }), /exactly required keys/);
});

const leaseA = '00000000-0000-0000-0000-000000000001';
const leaseB = '00000000-0000-0000-0000-000000000002';
const hostA = { name: 'build-a', host: 'server-a', workspace: '/srv/project' };
const hostB = { name: 'build-b', host: 'server-b', workspace: '/srv/project' };

function invokeLease(pool: RemoteAgentHostConnectionPool, channel: string, value: unknown): unknown {
	const handler = route(pool.routes(), channel);
	return handler.invoke(handler.validate(value));
}

test('Agent host leases retain independent carriers and close only the selected host', async () => {
	const opened: unknown[] = [];
	const closed: string[] = [];
	using pool = new RemoteAgentHostConnectionPool({ list: async () => [hostA, hostB] }, (host, id) => {
		opened.push([id, host]);
		return toDisposable(() => { closed.push(id); });
	});
	await Promise.all([
		invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA }),
		invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseB, connection: hostB }),
	]);
	assert.deepEqual(opened, [[leaseA, hostA], [leaseB, hostB]]);
	invokeLease(pool, REMOTE_AGENT_HOST_CLOSE_CHANNEL, { id: leaseA });
	assert.deepEqual(closed, [leaseA]);
	pool.reset();
	assert.deepEqual(closed, [leaseA, leaseB]);
});

test('Agent host close retires a pending catalog read without creating a late carrier', async () => {
	const catalog = new DeferredPromise<readonly RemoteConnectionDefinition[]>();
	let created = 0;
	using pool = new RemoteAgentHostConnectionPool({ list: () => catalog.p }, () => {
		created++;
		return toDisposable(() => { });
	});
	const pending = invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA }) as Promise<void>;
	const rejected = assert.rejects(pending, isCancellationError);
	invokeLease(pool, REMOTE_AGENT_HOST_CLOSE_CHANNEL, { id: leaseA });
	await rejected;
	await catalog.complete([hostA]);
	assert.equal(created, 0);
});

test('Agent host navigation retires setup and does not retire a reused successor lease', async () => {
	const catalog = new DeferredPromise<readonly RemoteConnectionDefinition[]>();
	let reads = 0;
	let created = 0;
	let closed = 0;
	using pool = new RemoteAgentHostConnectionPool({ list: () => ++reads === 1 ? catalog.p : Promise.resolve([hostA]) }, () => {
		created++;
		return toDisposable(() => { closed++; });
	});
	const pending = invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA }) as Promise<void>;
	const rejected = assert.rejects(pending, isCancellationError);
	pool.reset();
	await rejected;
	await invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA });
	await catalog.complete([hostA]);
	assert.equal(created, 1);
	assert.equal(closed, 0);
});

test('disposing the Agent host pool rejects setup before a failing catalog read completes', async () => {
	const catalog = new DeferredPromise<readonly RemoteConnectionDefinition[]>();
	let created = 0;
	using pool = new RemoteAgentHostConnectionPool({ list: () => catalog.p }, () => {
		created++;
		return toDisposable(() => { });
	});
	const pending = invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA }) as Promise<void>;
	const rejected = assert.rejects(pending, isCancellationError);
	pool.dispose();
	await rejected;
	// The retired read still needs a rejection handler, even after the OPEN route has replied.
	await catalog.error(new Error('The old catalog connection closed'));
	assert.equal(created, 0);
});

test('Agent host leases reject changed targets, duplicate IDs and arbitrary transport options', async () => {
	let created = 0;
	using pool = new RemoteAgentHostConnectionPool({ list: async () => [hostA] }, () => {
		created++;
		return toDisposable(() => { });
	});
	await assert.rejects(invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: { ...hostA, workspace: '/other' } }) as Promise<void>, /changed/);
	assert.equal(created, 0);
	await invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA });
	await assert.rejects(invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA }) as Promise<void>, /already exists/);
	assert.throws(() => invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: '../local', connection: hostA }), /Invalid Agent host/);
	assert.throws(() => invokeLease(pool, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseB, connection: { ...hostA, command: 'shell' } }), /exactly required keys/);
});

test('Agent host leases are owned by their requesting window and release on disposal', async () => {
	let closed = 0;
	const factory = () => toDisposable(() => { closed++; });
	using first = new RemoteAgentHostConnectionPool({ list: async () => [hostA] }, factory);
	using second = new RemoteAgentHostConnectionPool({ list: async () => [hostA] }, factory);
	await invokeLease(first, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseA, connection: hostA });
	invokeLease(second, REMOTE_AGENT_HOST_CLOSE_CHANNEL, { id: leaseA });
	assert.equal(closed, 0);
	first.dispose();
	assert.equal(closed, 1);
	assert.throws(() => first.routes()[0].validate({ id: leaseA, connection: { ...hostA, host: 'user@host' } }), /without credentials/);
	await assert.rejects(invokeLease(first, REMOTE_AGENT_HOST_OPEN_CHANNEL, { id: leaseB, connection: hostA }) as Promise<void>, /disposed/);
});

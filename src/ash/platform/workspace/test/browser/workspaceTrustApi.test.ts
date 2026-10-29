import { AppServerRemoteError } from '../../../agentHost/common/appServerError.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { ServerNotification } from '../../../../../../.build/protocol/typescript/index.js';
import { createAppServerWorkspaceTrustApi, createDisconnectedWorkspaceTrustApi } from '../../browser/workspaceTrustApi.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type WorkspaceTrustPermission } from '../../common/workspaceTrust.js';

test('workspace trust reads exact capabilities and persists only explicit revision-checked grants', async () => {
	using notifications = new Emitter<ServerNotification>();
	const requests: { method: string; params: unknown }[] = [];
	let permissions: readonly WorkspaceTrustPermission[] | null = null;
	let revision = 7;
	let failure: Error | undefined;
	const api = createAppServerWorkspaceTrustApi({
		onNotification: notifications.event,
		async request(definition: { method: string }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			switch (definition.method) {
				case 'config/directoryGrants/read':
					return { dir: 'canonical-dir', permissions };
				case 'config/read':
					return { revision };
				case 'config/directoryGrants/set':
					if (failure) {
						throw failure;
					}
					return { revision: ++revision, generation: 2, disposition: 'updated' };
				default:
					throw new Error(`Unexpected request: ${definition.method}`);
			}
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await api.readDirectory('/alias'), { dir: 'canonical-dir', permissions: undefined });
	for (const exact of [[], READ_DIR_PERMISSIONS, [...READ_DIR_PERMISSIONS, 'executeCommands'] as const, DEVELOPMENT_DIR_PERMISSIONS]) {
		permissions = exact;
		assert.deepEqual(await api.readDirectory('/alias'), { dir: 'canonical-dir', permissions: exact });
	}
	assert.ok(requests.every(request => request.method === 'config/directoryGrants/read'));
	const selected = Object.freeze(['readFiles', 'executeCommands'] as const);
	const grant = await api.createGrant('/alias', selected);
	assert.equal(grant.type, 'user');
	assert.equal(grant.expectedRevision, 7);
	assert.ok(grant.commandId);
	assert.deepEqual(grant.permissions, selected);
	assert.notEqual(grant.permissions, selected);
	assert.deepEqual(requests.at(-1), { method: 'config/read', params: {} });
	await api.persistGrant('/alias', grant);
	assert.deepEqual(requests.at(-1), {
		method: 'config/directoryGrants/set',
		params: { path: '/alias', commandId: grant.commandId, expectedRevision: 7, permissions: selected },
	});
	const before = requests.length;
	await api.persistGrant('/alias', { type: 'config' });
	assert.equal(requests.length, before);
	await assert.rejects(api.persistGrant('/alias', { type: 'host', permissions: selected }), /Invalid directory grant/);
	assert.equal(requests.length, before);
	failure = new Error('Revision conflict');
	await assert.rejects(api.persistGrant('/alias', grant), error => error === failure);
	assert.equal(requests.length, before + 1);
});

test('workspace trust config notifications respect listener scope and disposal', () => {
	using notifications = new Emitter<ServerNotification>();
	const api = createAppServerWorkspaceTrustApi({
		onNotification: notifications.event,
	} as unknown as AppServerProtocolClient);
	const receiver = { changes: 0 };
	using subscriptions = new DisposableStore();
	api.onDidChangeTrust(
		function (this: typeof receiver) {
			this.changes++;
		},
		receiver,
		subscriptions,
	);
	notifications.fire({ method: 'session/changed', params: { sessionId: 'session', agentTreeChanged: false } });
	assert.equal(receiver.changes, 0);
	notifications.fire({ method: 'config/changed', params: { revision: 8, generation: 2 } });
	assert.equal(receiver.changes, 1);
	subscriptions.dispose();
	notifications.fire({ method: 'config/changed', params: { revision: 9, generation: 3 } });
	assert.equal(receiver.changes, 1);
});

test('disconnected workspace trust cannot read or grant authorization', async () => {
	const failure = new Error('Disconnected');
	const api = createDisconnectedWorkspaceTrustApi(async () => {
		throw failure;
	});
	await assert.rejects(api.readWorkspaceDirectory('workspace'), error => error === failure);
	await assert.rejects(api.readDirectory('/workspace'), error => error === failure);
	await assert.rejects(api.createGrant('/workspace', READ_DIR_PERMISSIONS), error => error === failure);
	await assert.rejects(api.persistGrant('/workspace', { type: 'config' }), error => error === failure);
	await assert.rejects(api.listDirectories(), error => error === failure);
	await assert.rejects(api.setDirectoryPermissions('/workspace', [], 1), error => error === failure);
	await assert.rejects(api.forgetDirectory('directory', 1), error => error === failure);
});

test('workspace trust lists partial grants and manages canonical identities with backend revisions', async () => {
	const requests: { method: string; params: unknown }[] = [];
	const precise = Object.freeze(['readFiles', 'loadInstructions', 'useLanguageServices'] as const);
	const failure = new Error('Revision conflict');
	let conflict = false;
	const api = createAppServerWorkspaceTrustApi({
		async request(definition: { method: string }, params: unknown): Promise<unknown> {
			requests.push({ method: definition.method, params });
			if (definition.method === 'config/directoryGrants/list') {
				return {
					revision: 4,
					entries: [
						{ dir: 'dir-1', path: null, permissions: [] },
						{ dir: 'dir-2', path: 'C:\\canonical', permissions: precise },
					],
				};
			}
			if (definition.method === 'config/directoryGrants/read') {
				return { dir: 'dir-2', permissions: precise };
			}
			if (conflict) {
				throw failure;
			}
			return { revision: 5, generation: 2, disposition: 'updated' };
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await api.listDirectories(), {
		revision: 4,
		entries: [
			{ dir: 'dir-1', path: undefined, permissions: [] },
			{ dir: 'dir-2', path: 'C:\\canonical', permissions: precise },
		],
	});
	assert.deepEqual(await api.readDirectory('C:\\alias'), { dir: 'dir-2', permissions: precise });
	assert.deepEqual(requests.at(-1), { method: 'config/directoryGrants/read', params: { path: 'C:\\alias' } });
	assert.deepEqual(await api.setDirectoryPermissions('C:\\alias', precise, 4), {
		revision: 5,
		generation: 2,
		disposition: 'updated',
	});
	const set = requests.at(-1)!;
	const setParams = set.params as { commandId: string; permissions: readonly WorkspaceTrustPermission[] };
	assert.ok(setParams.commandId);
	assert.notEqual(setParams.permissions, precise);
	assert.deepEqual(
		{ ...set, params: { ...setParams, commandId: 'command' } },
		{
			method: 'config/directoryGrants/set',
			params: { path: 'C:\\alias', permissions: precise, expectedRevision: 4, commandId: 'command' },
		},
	);
	assert.deepEqual(await api.forgetDirectory('dir-2', 5), { revision: 5, generation: 2, disposition: 'updated' });
	const forget = requests.at(-1)!;
	const forgetParams = forget.params as { commandId: string };
	assert.ok(forgetParams.commandId);
	assert.notEqual(forgetParams.commandId, setParams.commandId);
	assert.deepEqual(
		{ ...forget, params: { ...forgetParams, commandId: 'command' } },
		{
			method: 'config/directoryGrants/forget',
			params: { dir: 'dir-2', expectedRevision: 5, commandId: 'command' },
		},
	);
	conflict = true;
	const before = requests.length;
	await assert.rejects(api.setDirectoryPermissions('C:\\alias', precise, 4), error => error === failure);
	await assert.rejects(api.forgetDirectory('dir-2', 4), error => error === failure);
	assert.equal(requests.length, before + 2);
});

test('workspace trust reads active directory permissions through the bounded environment contract', async () => {
	const requests: unknown[] = [];
	const api = createAppServerWorkspaceTrustApi({
		async request(definition: { method: string }, params: unknown) {
			requests.push({ method: definition.method, params });
			return { id: 'workspace', path: '/workspace', permissions: READ_DIR_PERMISSIONS };
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await api.readWorkspaceDirectory('workspace'), READ_DIR_PERMISSIONS);
	assert.deepEqual(requests, [{ method: 'env/dir/read', params: { dirId: 'workspace' } }]);
});

test('retired active directory permissions fail closed without hiding connection failures', async () => {
	let failure: Error = new AppServerRemoteError(-32043, 'untranslated diagnostic', { kind: 'PermissionRequired' });
	const api = createAppServerWorkspaceTrustApi({
		request: async () => {
			throw failure;
		},
	} as unknown as AppServerProtocolClient);
	assert.equal(await api.readWorkspaceDirectory('retired'), undefined);
	failure = new Error('Connection closed');
	await assert.rejects(api.readWorkspaceDirectory('retired'), error => error === failure);
});

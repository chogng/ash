import { createSshRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import type { ISandboxGlobals } from '../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { IWorkspaceContextApi } from '../../../workspace/common/workspaceIpc.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type IWorkspaceTrustApi, type WorkspaceTrustPermission } from '../../../workspace/common/workspaceTrust.js';

suite('workspace trust during directory opening', () => {
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const listeners = new Map<string, (value: unknown) => void>();
	let reply: ((value: unknown) => void) | undefined;
	let host: typeof import('../../electron-browser/appServerWorkspaceHost.js');
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send() { },
			invoke: async (channel, value) => {
				assert.equal(channel, 'ash:workspace:completed');
				reply?.(value);
			},
			on: (channel, listener) => {
				listeners.set(channel, listener);
				return { dispose: () => { listeners.delete(channel); } };
			},
		},
		ipcMessagePort: { acquire: () => ({ dispose() { } }) },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		host = await import('../../electron-browser/appServerWorkspaceHost.js');
	});
	suiteTeardown(() => {
		if (previousGlobals) { Object.defineProperty(globalThis, 'ash', previousGlobals); }
		else { Reflect.deleteProperty(globalThis, 'ash'); }
	});

	function workspace(paths: readonly string[]): IWorkspaceContextApi {
		return {
			getWorkspace: async () => ({ id: 'workspace', folders: paths.map((path, index) => ({ id: `folder-${index}`, uri: `file://${path}`, name: `folder-${index}`, index })) }),
			onDidChange: Event.None,
		};
	}

	function trustApi(saved: ReadonlyMap<string, readonly WorkspaceTrustPermission[]>, grants: WorkspaceTrustPermission[][]): IWorkspaceTrustApi {
		return {
			onDidChangeTrust: Event.None,
			listDirectories: async () => { throw new Error('Unexpected directory management'); },
			setDirectoryPermissions: async () => { throw new Error('Unexpected directory management'); },
			forgetDirectory: async () => { throw new Error('Unexpected directory management'); },
			readDirectory: async path => ({ dir: `canonical:${path}`, permissions: saved.get(path) }),
			createGrant: async (_path, permissions) => {
				grants.push([...permissions]);
				return { type: 'user', commandId: 'command', expectedRevision: 7, permissions: [...permissions] };
			},
			persistGrant: async () => { throw new Error('Startup persists its grant through env/dirs/set'); },
		};
	}

	test('saved partial and empty grants are reused without prompting or widening capabilities', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const requests: unknown[] = [];
		const client = { request: async (method: { method: string; }, params: unknown) => { requests.push({ method: method.method, params }); return { dirs: [] }; } } as unknown as AppServerProtocolClient;
		const api = trustApi(new Map([['/partial', ['readFiles', 'executeCommands']], ['/empty', []]]), grants);
		await host.initializeWorkspace(client, { requestWorkspaceTrust: async () => { throw new Error('Unexpected trust request'); } }, api, workspace(['/partial', '/empty']));
		assert.deepEqual(grants, []);
		assert.deepEqual(requests, [{
			method: 'env/dirs/set', params: {
				dirs: [
					{ id: 'folder-0', path: '/partial', grant: { type: 'config' } },
					{ id: 'folder-1', path: '/empty', grant: { type: 'config' } },
				]
			}
		}]);
	});

	for (const choice of ['readOnly', 'development'] as const) {
		test(`new ${choice} authorization uses only the explicitly selected capabilities`, async () => {
			const grants: WorkspaceTrustPermission[][] = [];
			const requests: unknown[] = [];
			const prompts: string[] = [];
			const client = { request: async (_method: unknown, params: unknown) => { requests.push(params); return { dirs: [] }; } } as unknown as AppServerProtocolClient;
			await host.initializeWorkspace(client, { requestWorkspaceTrust: async path => { prompts.push(path); return choice; } }, trustApi(new Map(), grants), workspace(['/new']));
			const permissions = choice === 'readOnly' ? READ_DIR_PERMISSIONS : DEVELOPMENT_DIR_PERMISSIONS;
			assert.deepEqual(prompts, ['/new']);
			assert.deepEqual(grants, [permissions]);
			assert.deepEqual(requests, [
				{ dirs: [{ id: 'folder-0', path: '/new', grant: { type: 'user', commandId: 'command', expectedRevision: 7, permissions } }] },
				{ dirs: [{ id: 'folder-0', path: '/new', grant: { type: 'config' } }] },
			]);
		});
	}

	test('cancelling a trust request does not create or persist a grant', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const client = { request: async () => { throw new Error('Unexpected environment write'); } } as unknown as AppServerProtocolClient;
		await assert.rejects(host.initializeWorkspace(client, { requestWorkspaceTrust: async () => 'cancel' }, trustApi(new Map(), grants), workspace(['/new'])), /selection cancelled/);
		assert.deepEqual(grants, []);
	});

	test('a grant revision conflict stops startup without an automatic retry', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const failure = new Error('Revision conflict');
		let writes = 0;
		const client = { request: async () => { writes++; throw failure; } } as unknown as AppServerProtocolClient;
		await assert.rejects(host.initializeWorkspace(client, { requestWorkspaceTrust: async () => 'readOnly' }, trustApi(new Map(), grants), workspace(['/new'])), error => error === failure);
		assert.equal(writes, 1);
		assert.deepEqual(grants, [READ_DIR_PERMISSIONS]);
	});

	test('the IPC boundary rejects unknown capabilities before creating a grant and releases its route', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const client = {} as AppServerProtocolClient;
		using registration = host.registerAppServerWorkspaceHost(client, async () => { }, { requestWorkspaceTrust: async () => 'cancel' }, trustApi(new Map(), grants));
		const completion = new Promise<unknown>(resolve => { reply = resolve; });
		try {
			listeners.get('ash:workspace:operation')!({ nonce: 'request', operation: 'createGrant', params: { path: '/new', permissions: ['readFiles', 'futureCapability'] } });
			assert.deepEqual(await completion, { nonce: 'request', error: 'Invalid workspace trust grant', failure: undefined });
			assert.deepEqual(grants, []);
			registration.dispose();
			assert.equal(listeners.size, 0);
		} finally { reply = undefined; }
	});

	test('the IPC route reads and persists precise authorization through workspace trust', async () => {
		const selected = ['readFiles', 'executeCommands'] as const;
		const writes: unknown[] = [];
		const api: IWorkspaceTrustApi = {
			...trustApi(new Map([['/partial', selected]]), []),
			persistGrant: async (path, grant) => { writes.push({ path, grant }); },
		};
		using registration = host.registerAppServerWorkspaceHost({} as AppServerProtocolClient, async () => { }, { requestWorkspaceTrust: async () => 'cancel' }, api);
		try {
			let completion = new Promise<unknown>(resolve => { reply = resolve; });
			listeners.get('ash:workspace:operation')!({ nonce: 'read', operation: 'readPermissions', params: { path: '/partial' } });
			assert.deepEqual(await completion, { nonce: 'read', result: selected });
			completion = new Promise<unknown>(resolve => { reply = resolve; });
			const grant = { type: 'user', commandId: 'command', expectedRevision: 7, permissions: selected };
			listeners.get('ash:workspace:operation')!({ nonce: 'save', operation: 'persistDirectoryGrant', params: { path: '/partial', grant } });
			assert.deepEqual(await completion, { nonce: 'save', result: undefined });
			assert.deepEqual(writes, [{ path: '/partial', grant }]);
		} finally { reply = undefined; }
	});
	test('Remote folder validation preserves the remote resource identity for dirty-owner checks', async () => {
		const client = { request: async () => { throw new Error('must not mutate directories'); } } as unknown as AppServerProtocolClient;
		using registration = host.registerAppServerWorkspaceHost(client, async () => { }, { requestWorkspaceTrust: async () => 'cancel' }, trustApi(new Map(), []), folders => {
			assert.equal(folders[0]?.toString(), 'ash-remote://ssh+host/second');
		}, path => createSshRemoteWorkspaceUri('host', path));
		const completion = new Promise<unknown>(resolve => { reply = resolve; });
		try {
			listeners.get('ash:workspace:operation')!({ nonce: 'remote', operation: 'validateFolders', params: { folders: [{ id: 'second', path: '/second', grant: { type: 'config' } }] } });
			assert.deepEqual(await completion, { nonce: 'remote', result: undefined });
		} finally { reply = undefined; }
	});

	test('folder validation asks the editor owner without sending a backend directory mutation', async () => {
		const client = { request: async () => { throw new Error('must not mutate directories'); } } as unknown as AppServerProtocolClient;
		using registration = host.registerAppServerWorkspaceHost(client, async () => { }, { requestWorkspaceTrust: async () => 'cancel' }, trustApi(new Map(), []), folders => {
			assert.equal(folders[0]?.fsPath, '/first');
			throw new Error('unsaved files');
		});
		const completion = new Promise<unknown>(resolve => { reply = resolve; });
		try {
			listeners.get('ash:workspace:operation')!({ nonce: 'validate', operation: 'validateFolders', params: { folders: [{ id: 'first', path: '/first', grant: { type: 'config' } }] } });
			assert.deepEqual(await completion, { nonce: 'validate', error: 'unsaved files', failure: undefined });
		} finally { reply = undefined; }
	});

});

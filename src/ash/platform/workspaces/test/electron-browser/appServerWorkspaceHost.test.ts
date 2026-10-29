import { createSshRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import type { ISandboxGlobals } from '../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { IWorkspaceContextApi } from '../../../workspace/common/workspaceIpc.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type IWorkspaceTrustApi, type WorkspaceTrustPermission } from '../../../workspace/common/workspaceTrust.js';

suite('workspace trust during directory opening', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const previousGlobals = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const listeners = new Map<string, (value: unknown) => void>();
	let reply: ((value: unknown) => void) | undefined;
	let host: typeof import('../../electron-browser/appServerWorkspaceHost.js');
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send() {},
			invoke: async (channel, value) => {
				assert.equal(channel, 'ash:workspace:completed');
				reply?.(value);
			},
			on: (channel, listener) => {
				listeners.set(channel, listener);
				return {
					dispose: () => {
						listeners.delete(channel);
					},
				};
			},
		},
		ipcMessagePort: { acquire: () => ({ dispose() {} }) },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
		host = await import('../../electron-browser/appServerWorkspaceHost.js');
	});
	suiteTeardown(() => {
		if (previousGlobals) {
			Object.defineProperty(globalThis, 'ash', previousGlobals);
		} else {
			Reflect.deleteProperty(globalThis, 'ash');
		}
	});

	function workspace(paths: readonly string[]): IWorkspaceContextApi {
		return {
			getWorkspace: async () => ({
				id: 'workspace',
				folders: paths.map((path, index) => ({
					id: `folder-${index}`,
					uri: URI.file(path).toString(),
					name: `folder-${index}`,
					index,
				})),
			}),
			onDidChange: Event.None,
		};
	}

	function trustApi(saved: ReadonlyMap<string, readonly WorkspaceTrustPermission[]>, grants: WorkspaceTrustPermission[][]): IWorkspaceTrustApi {
		const permissionsByPath = new Map([...saved].map(([path, permissions]) => [URI.file(path).fsPath, permissions]));
		return {
			onDidChangeTrust: Event.None,
			listDirectories: async () => {
				throw new Error('Unexpected directory management');
			},
			setDirectoryPermissions: async () => {
				throw new Error('Unexpected directory management');
			},
			forgetDirectory: async () => {
				throw new Error('Unexpected directory management');
			},
			readWorkspaceDirectory: async () => {
				throw new Error('Workspace host selects grants through the management owner');
			},
			readDirectory: async path => ({
				dir: `canonical:${path}`,
				permissions: permissionsByPath.get(URI.file(path).fsPath),
			}),
			createGrant: async (_path, permissions) => {
				grants.push([...permissions]);
				return { type: 'user', commandId: 'command', expectedRevision: 7, permissions: [...permissions] };
			},
			persistGrant: async () => {
				throw new Error('Startup persists its grant through env/dirs/set');
			},
		};
	}

	test('saved partial and empty grants are reused without prompting or widening capabilities', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const requests: unknown[] = [];
		const client = {
			state: 'ready',
			generation: 1,
			onStateChange: Event.None,
			request: async (method: { method: string }, params: unknown) => {
				requests.push({ method: method.method, params });
				return { dirs: [] };
			},
		} as unknown as AppServerProtocolClient;
		const api = trustApi(
			new Map([
				['/partial', ['readFiles', 'executeCommands']],
				['/empty', []],
			]),
			grants,
		);
		await host.initializeWorkspace(
			client,
			{
				requestDirectoryPermissions: async () => {
					throw new Error('Unexpected trust request');
				},
			},
			api,
			workspace(['/partial', '/empty']),
		);
		assert.deepEqual(grants, []);
		assert.deepEqual(requests, [
			{
				method: 'env/dirs/set',
				params: {
					dirs: [
						{ id: 'folder-0', path: URI.file('/partial').fsPath, grant: { type: 'config' } },
						{ id: 'folder-1', path: URI.file('/empty').fsPath, grant: { type: 'config' } },
					],
				},
			},
		]);
	});

	for (const choice of ['readOnly', 'development'] as const) {
		test(`new ${choice} authorization uses only the explicitly selected capabilities`, async () => {
			const grants: WorkspaceTrustPermission[][] = [];
			const requests: unknown[] = [];
			const prompts: string[] = [];
			const client = {
				state: 'ready',
				generation: 1,
				onStateChange: Event.None,
				request: async (_method: unknown, params: unknown) => {
					requests.push(params);
					return { dirs: [] };
				},
			} as unknown as AppServerProtocolClient;
			await host.initializeWorkspace(
				client,
				{
					requestDirectoryPermissions: async path => {
						prompts.push(path);
						return choice;
					},
				},
				trustApi(new Map(), grants),
				workspace(['/new']),
			);
			const permissions = choice === 'readOnly' ? READ_DIR_PERMISSIONS : DEVELOPMENT_DIR_PERMISSIONS;
			assert.deepEqual(prompts, [URI.file('/new').fsPath]);
			assert.deepEqual(grants, [permissions]);
			assert.deepEqual(requests, [
				{
					dirs: [
						{
							id: 'folder-0',
							path: URI.file('/new').fsPath,
							grant: { type: 'user', commandId: 'command', expectedRevision: 7, permissions },
						},
					],
				},
				{ dirs: [{ id: 'folder-0', path: URI.file('/new').fsPath, grant: { type: 'config' } }] },
			]);
		});
	}

	for (const stage of ['read', 'choice', 'grant', 'write'] as const) {
		test(`directory setup cannot use a retired connection's ${stage} receipt`, async () => {
			const entered = new DeferredPromise<void>();
			const gate = new DeferredPromise<void>();
			using changes = new Emitter<'ready' | 'stopped'>();
			const grants: WorkspaceTrustPermission[][] = [];
			const original = trustApi(new Map(), grants);
			let writes = 0;
			let prompts = 0;
			let listeners = 0;
			const wait = async (current: typeof stage): Promise<void> => {
				if (stage === current) {
					void entered.complete();
					await gate.p;
				}
			};
			const client = {
				state: 'ready',
				generation: 1,
				onStateChange: (listener: (state: 'ready' | 'stopped') => void) => {
					listeners++;
					const subscription = changes.event(listener);
					return toDisposable(() => {
						subscription.dispose();
						listeners--;
					});
				},
				request: async () => {
					writes++;
					await wait('write');
					return { dirs: [] };
				},
			} as unknown as AppServerProtocolClient;
			const setup = host.initializeWorkspaceDirectories(
				client,
				{
					requestDirectoryPermissions: async (_path, signal) => {
						assert.ok(signal);
						assert.equal(signal.aborted, false);
						prompts++;
						await wait('choice');
						return 'readOnly';
					},
				},
				{
					...original,
					readDirectory: async path => {
						const value = await original.readDirectory(path);
						await wait('read');
						return value;
					},
					createGrant: async (path, permissions) => {
						const value = await original.createGrant(path, permissions);
						await wait('grant');
						return value;
					},
				},
				[{ id: 'remote-root', path: '/srv/project' }],
			);
			const rejected = assert.rejects(setup, isCancellationError);
			await entered.p;
			changes.fire('stopped');
			changes.fire('ready');
			if (stage === 'choice') {
				await rejected;
				assert.equal(gate.isSettled, false);
				assert.equal(listeners, 0);
			}
			await gate.complete();
			await rejected;
			assert.equal(prompts, stage === 'read' ? 0 : 1);
			assert.equal(grants.length, stage === 'read' || stage === 'choice' ? 0 : 1);
			assert.equal(writes, stage === 'write' ? 1 : 0);
			assert.equal(listeners, 0);
		});
	}

	test('retired directory setup observes a late prompt rejection without granting or writing directories', async () => {
		const entered = new DeferredPromise<void>();
		const choice = new DeferredPromise<'readOnly'>();
		using changes = new Emitter<'ready' | 'stopped'>();
		const grants: WorkspaceTrustPermission[][] = [];
		let writes = 0;
		const client = {
			state: 'ready',
			generation: 1,
			onStateChange: changes.event,
			request: async () => {
				writes++;
				return { dirs: [] };
			},
		} as unknown as AppServerProtocolClient;
		const setup = host.initializeWorkspaceDirectories(
			client,
			{
				requestDirectoryPermissions: () => {
					void entered.complete();
					return choice.p;
				},
			},
			trustApi(new Map(), grants),
			[{ id: 'retired-root', path: '/srv/project' }],
		);
		const rejected = assert.rejects(setup, isCancellationError);
		await entered.p;
		changes.fire('stopped');
		await rejected;
		assert.equal(choice.isSettled, false);
		assert.equal(changes.hasListeners(), false);
		await choice.error(new Error('The old prompt owner closed'));
		assert.deepEqual(grants, []);
		assert.equal(writes, 0);
	});

	test('remote directory prompts display the host while granting only the original server path', async () => {
		const paths: string[] = [];
		const labels: string[] = [];
		const api = trustApi(new Map(), []);
		const client = {
			state: 'ready',
			generation: 1,
			onStateChange: Event.None,
			request: async () => ({ dirs: [] }),
		} as unknown as AppServerProtocolClient;
		await host.initializeWorkspaceDirectories(
			client,
			{
				requestDirectoryPermissions: async label => {
					labels.push(label);
					return 'readOnly';
				},
			},
			{
				...api,
				createGrant: (path, permissions) => {
					paths.push(path);
					return api.createGrant(path, permissions);
				},
			},
			[{ id: 'root', path: '/srv/project', label: 'server-a:/srv/project' }],
		);
		assert.deepEqual(labels, ['server-a:/srv/project']);
		assert.deepEqual(paths, ['/srv/project']);
	});

	test('cancelling a trust request does not create or persist a grant', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const client = {
			state: 'ready',
			generation: 1,
			onStateChange: Event.None,
			request: async () => {
				throw new Error('Unexpected environment write');
			},
		} as unknown as AppServerProtocolClient;
		await assert.rejects(host.initializeWorkspace(client, { requestDirectoryPermissions: async () => 'cancel' }, trustApi(new Map(), grants), workspace(['/new'])), isCancellationError);
		assert.deepEqual(grants, []);
	});

	test('a grant revision conflict stops startup without an automatic retry', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const failure = new Error('Revision conflict');
		let writes = 0;
		const client = {
			state: 'ready',
			generation: 1,
			onStateChange: Event.None,
			request: async () => {
				writes++;
				throw failure;
			},
		} as unknown as AppServerProtocolClient;
		await assert.rejects(host.initializeWorkspace(client, { requestDirectoryPermissions: async () => 'readOnly' }, trustApi(new Map(), grants), workspace(['/new'])), error => error === failure);
		assert.equal(writes, 1);
		assert.deepEqual(grants, [READ_DIR_PERMISSIONS]);
	});

	test('the IPC boundary rejects unknown capabilities before creating a grant and releases its route', async () => {
		const grants: WorkspaceTrustPermission[][] = [];
		const client = {} as AppServerProtocolClient;
		using registration = host.registerAppServerWorkspaceHost(client, async () => {}, { requestDirectoryPermissions: async () => 'cancel' }, trustApi(new Map(), grants));
		const completion = new Promise<unknown>(resolve => {
			reply = resolve;
		});
		try {
			listeners.get('ash:workspace:operation')!({
				nonce: 'request',
				operation: 'createGrant',
				params: { path: '/new', permissions: ['readFiles', 'futureCapability'] },
			});
			assert.deepEqual(await completion, {
				nonce: 'request',
				error: 'Invalid workspace trust grant',
				failure: undefined,
			});
			assert.deepEqual(grants, []);
			registration.dispose();
			assert.equal(listeners.size, 0);
		} finally {
			reply = undefined;
		}
	});

	test('the IPC route reads and persists precise authorization through workspace trust', async () => {
		const selected = ['readFiles', 'executeCommands'] as const;
		const writes: unknown[] = [];
		const api: IWorkspaceTrustApi = {
			...trustApi(new Map([['/partial', selected]]), []),
			persistGrant: async (path, grant) => {
				writes.push({ path, grant });
			},
		};
		using registration = host.registerAppServerWorkspaceHost({} as AppServerProtocolClient, async () => {}, { requestDirectoryPermissions: async () => 'cancel' }, api);
		try {
			let completion = new Promise<unknown>(resolve => {
				reply = resolve;
			});
			listeners.get('ash:workspace:operation')!({
				nonce: 'read',
				operation: 'readPermissions',
				params: { path: '/partial' },
			});
			assert.deepEqual(await completion, { nonce: 'read', result: selected });
			completion = new Promise<unknown>(resolve => {
				reply = resolve;
			});
			const grant = { type: 'user', commandId: 'command', expectedRevision: 7, permissions: selected };
			listeners.get('ash:workspace:operation')!({
				nonce: 'save',
				operation: 'persistDirectoryGrant',
				params: { path: '/partial', grant },
			});
			assert.deepEqual(await completion, { nonce: 'save', result: undefined });
			assert.deepEqual(writes, [{ path: '/partial', grant }]);
		} finally {
			reply = undefined;
		}
	});
	test('Remote folder validation preserves the remote resource identity for dirty-owner checks', async () => {
		const client = {
			state: 'ready',
			generation: 1,
			onStateChange: Event.None,
			request: async () => {
				throw new Error('must not mutate directories');
			},
		} as unknown as AppServerProtocolClient;
		using registration = host.registerAppServerWorkspaceHost(
			client,
			async () => {},
			{ requestDirectoryPermissions: async () => 'cancel' },
			trustApi(new Map(), []),
			folders => {
				assert.equal(folders[0]?.toString(), 'ash-remote://ssh+host/second');
			},
			path => createSshRemoteWorkspaceUri('host', path),
		);
		const completion = new Promise<unknown>(resolve => {
			reply = resolve;
		});
		try {
			listeners.get('ash:workspace:operation')!({
				nonce: 'remote',
				operation: 'validateFolders',
				params: { folders: [{ id: 'second', path: '/second', grant: { type: 'config' } }] },
			});
			assert.deepEqual(await completion, { nonce: 'remote', result: undefined });
		} finally {
			reply = undefined;
		}
	});

	test('folder validation asks the editor owner without sending a backend directory mutation', async () => {
		const client = {
			state: 'ready',
			generation: 1,
			onStateChange: Event.None,
			request: async () => {
				throw new Error('must not mutate directories');
			},
		} as unknown as AppServerProtocolClient;
		using registration = host.registerAppServerWorkspaceHost(
			client,
			async () => {},
			{ requestDirectoryPermissions: async () => 'cancel' },
			trustApi(new Map(), []),
			folders => {
				assert.equal(folders[0]?.fsPath, URI.file('/first').fsPath);
				throw new Error('unsaved files');
			},
		);
		const completion = new Promise<unknown>(resolve => {
			reply = resolve;
		});
		try {
			listeners.get('ash:workspace:operation')!({
				nonce: 'validate',
				operation: 'validateFolders',
				params: { folders: [{ id: 'first', path: '/first', grant: { type: 'config' } }] },
			});
			assert.deepEqual(await completion, { nonce: 'validate', error: 'unsaved files', failure: undefined });
		} finally {
			reply = undefined;
		}
	});
});

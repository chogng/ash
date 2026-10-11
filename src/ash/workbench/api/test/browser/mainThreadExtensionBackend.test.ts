import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionBackendApi } from '../../../../platform/agentHost/common/extensionBackendApi.js';
import type { IAppServerApi, IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { MainThreadExtensionBackend } from '../../browser/mainThreadExtensionBackend.js';

const source = { extensionId: 'ash.git', activationGeneration: 1, incarnation: 1 };
const manifest = { ashFrontend: { capabilities: { 'git.repository': { methods: { read: { route: 'config/read', fields: [], resultFields: ['revision', 'git', 'gitConfigured'] }, write: { route: 'config/update', fields: ['commandId', 'expectedRevision', 'git'] } }, notifications: ['config/changed'] } } } };
function fixture(sourceKind = 'builtIn') {
 const calls: { method: string; params: unknown }[] = [];
 const extensions = { list: async () => ({ extensions: [{ id: 'ash.git', sourceKind, manifestJson: JSON.stringify(manifest) }] }) } as unknown as IExtensionApi;
 const backend = { request: async (method, params) => { calls.push({ method, params }); return { revision: 1, git: { autofetch: 'off', autofetchPeriod: 180 }, gitConfigured: true, providers: { token: 'private' } }; } } satisfies IExtensionBackendApi;
 const connection = { getConnectionState: async () => 'ready', connectionGeneration: 1 } as IAppServerApi;
 const events: IServerEventApi = { subscribe: Event.None };
 const workspace = { getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService;
 return { bridge: new MainThreadExtensionBackend(extensions, backend, connection, events, workspace), calls };
}

test('product backend grants restrict methods, input fields and returned configuration', async () => {
 const value = fixture(); using cleanup = value.bridge; const signal = new AbortController().signal;
 assert.deepEqual(await value.bridge.handle(source, 'git.repository', 'read', {}, 0, signal), { revision: 1, git: { autofetch: 'off', autofetchPeriod: 180 }, gitConfigured: true });
 await assert.rejects(value.bridge.handle(source, 'git.repository', 'unknown', {}, 0, signal), /not authorized/);
 await assert.rejects(value.bridge.handle(source, 'git.repository', 'write', { providers: { token: 'secret' } }, 0, signal), /exceed/);
 assert.deepEqual(value.calls, [{ method: 'config/read', params: {} }]);
});

test('an installed extension cannot grant itself product backend access', async () => {
 const value = fixture('user'); using cleanup = value.bridge;
 await assert.rejects(value.bridge.handle(source, 'git.repository', 'read', {}, 0, new AbortController().signal), /not authorized/);
 assert.deepEqual(value.calls, []);
});

test('cancelled backend requests cannot publish a result or launch another operation', async () => {
 const value = fixture(); using cleanup = value.bridge; const controller = new AbortController(); controller.abort();
 await assert.rejects(value.bridge.handle(source, 'git.repository', 'read', {}, 0, controller.signal)); assert.deepEqual(value.calls, []);
});

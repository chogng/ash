import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../base/common/async.js';
import { BrowserProgressService } from '../../../../platform/progress/browser/progressService.js';
import type { IProgressService } from '../../../../platform/progress/common/progress.js';
import { AppServerRemoteError } from '../../../../platform/agentHost/common/appServerError.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import type { JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { Event } from '../../../../base/common/event.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionBackendApi } from '../../../../platform/agentHost/common/extensionBackendApi.js';
import type { IAppServerApi, IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { MainThreadExtensionBackend } from '../../browser/mainThreadExtensionBackend.js';

const source = { extensionId: 'ash.git', activationGeneration: 1, incarnation: 1 };
const manifest = { ashFrontend: { capabilities: { 'git.repository': { methods: { read: { route: 'config/read', fields: [], resultFields: ['revision', 'git', 'gitConfigured'] }, write: { route: 'config/update', fields: ['commandId', 'expectedRevision', 'git'] }, transport: { route: 'git/transport', cancellationRoute: 'git/transport/cancel', fields: ['operationId'] } }, notifications: ['config/changed'] } } } };
function fixture(sourceKind = 'builtIn', request?: IExtensionBackendApi['request'], progress?: IProgressService) {
	const calls: { method: string; params: unknown; }[] = [];
	const extensions = { list: async () => ({ extensions: [{ id: 'ash.git', sourceKind, manifestJson: JSON.stringify(manifest) }] }) } as unknown as IExtensionApi;
	const backend = { request: async (method, params, signal) => { calls.push({ method, params }); if (request) return request(method, params, signal); return { revision: 1, git: { autofetch: 'off', autofetchPeriod: 180 }, gitConfigured: true, providers: { token: 'private' } }; } } satisfies IExtensionBackendApi;
	const connection = { getConnectionState: async () => 'ready', connectionGeneration: 1 } as IAppServerApi;
	const events: IServerEventApi = { subscribe: Event.None };
	const workspace = { getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService;
	return { bridge: new MainThreadExtensionBackend(extensions, backend, connection, events, workspace, progress), calls };
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

for (const retire of [false, true]) test(`backend cancellation retains its exact operation until terminal completion${retire ? ' during retirement' : ''}`, async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const container = browser.window.document.body;
	const operation = new DeferredPromise<JsonValue>();
	const cancellation = new DeferredPromise<void>();
	const controller = new AbortController();
	let settled = false;
	setNlsMessages('zh-CN', { ash: { 'progress.region': '进度', 'progress.cancel': '取消' } });
	try {
		using progress = new BrowserProgressService(container);
		const value = fixture('builtIn', async (method, params) => {
			if (method === 'git/transport') return operation.p;
			assert.equal(method, 'git/transport/cancel');
			assert.deepEqual(params, { operationId: 'window-owned-operation' });
			await cancellation.complete();
			return { status: 'requested' };
		}, progress);
		using cleanup = value.bridge;
		const result = value.bridge.handle(source, 'git.repository', 'transport', { operationId: 'window-owned-operation' }, 0, controller.signal, { title: 'Git', cancellable: true });
		void result.then(() => { settled = true; }, () => { settled = true; });
		// Admission reads the product catalog before creating the existing progress surface.
		await Promise.resolve(); await Promise.resolve();
		const cancel = container.querySelector<HTMLButtonElement>('button');
		assert.equal(cancel?.textContent, '取消');
		assert.equal(container.querySelector('[role="region"]')?.getAttribute('aria-label'), '进度');
		if (retire) controller.abort('extension retired');
		else cancel!.click();
		await cancellation.p;
		assert.equal(settled, false);
		assert.equal(value.calls.filter(call => call.method.endsWith('/cancel')).length, 1);
		await operation.error(new AppServerRemoteError(-32800, 'cancelled', { kind: 'RequestCancelled' }));
		if (retire) await assert.rejects(result);
		else assert.deepEqual(await result, { backendError: { name: 'RequestCancelled', message: 'cancelled' } });
		assert.equal(container.querySelector('button'), null);
	} finally { resetNlsResolver(); browser.window.close(); }
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../../platform/extensions/common/extensionHostApi.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { ChatContextPickService, IChatContextPickService } from '../../../contrib/chat/browser/attachments/chatContextPickService.js';
import { ChatContextService, IChatContextService } from '../../../contrib/chat/browser/contextContrib/chatContextService.js';
import { MainThreadChatContext } from '../../browser/mainThreadChatContext.js';

function fixture(invoke: (registration: string, data: Record<string, JsonValue>, signal: AbortSignal) => Promise<JsonValue>) {
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const errors: unknown[][] = [];
	services.registerInstance(ILogService, { error: (...args: unknown[]) => errors.push(args) } as unknown as ILogService);
	services.registerInstance(IExtensionService, {
		activateByEvent: async () => { },
		getExtensionPointContributions: () => [{ description: { id: 'test.context' }, value: [{ id: 'records', displayName: 'Records', icon: '$(file)' }] }],
	} as unknown as IExtensionService);
	services.registerInstance(IExtensionHostApi, {
		invoke: async (request, signal) => invoke(request.registrationId, (request.payload as { data: Record<string, JsonValue>; }).data, signal),
	} as IExtensionHostApi);
	services.registerInstance(IChatContextPickService, new ChatContextPickService());
	const contexts = lifetime.add(services.createInstance(ChatContextService));
	const firstWorkspaceUpdate = new DeferredPromise<void>();
	const updateWorkspace = contexts.updateWorkspaceContextItems.bind(contexts);
	contexts.updateWorkspaceContextItems = (id, items) => {
		updateWorkspace(id, items);
		void firstWorkspaceUpdate.complete();
	};
	services.registerInstance(IChatContextService, contexts);
	const adapter = lifetime.add(services.createInstance(MainThreadChatContext, 30_000));
	const snapshot = (enabled = true, incarnation = 1): ExtensionHostFleetSnapshot => ({
		generation: 1, extensions: enabled ? [{
			id: 'test.context', packageDigest: 'digest', lifecycle: 'ready', incarnation, activationGeneration: 1,
			registrations: ['workspace', 'resource'].map(registrationId => ({ kind: 'dataChannel', channelId: 'chat.context.v1', registrationId })),
		}] : []
	} as unknown as ExtensionHostFleetSnapshot);
	return { services, contexts, adapter, snapshot, errors, firstWorkspaceUpdate: firstWorkspaceUpdate.p, [Symbol.dispose]: () => lifetime.dispose() };
}

test('chat context bridge maps resource selectors, captures metadata and retires source commands', async () => {
	const commands: unknown[] = [];
	using f = fixture(async (registration, data): Promise<JsonValue> => {
		if (data.action === 'describe') return registration === 'workspace'
			? { id: 'workspace', kind: 'workspace' }
			: { id: 'document', kind: 'resource', selector: { viewType: 'pdf' } };
		if (data.action === 'provide') return registration === 'workspace'
			? [{ handle: 1, label: 'Branch', value: 'main' }]
			: { handle: 1, label: 'PDF', command: { id: 'extension.open' }, tooltip: { value: '[Source](command:untrusted)', isTrusted: true } };
		if (data.action === 'resolve') return { handle: 1, label: 'PDF', value: 'Captured PDF text', command: { id: 'extension.open' } };
		commands.push(data);
		return null;
	});
	await f.adapter.update(f.snapshot());
	await f.firstWorkspaceUpdate;
	assert.equal(f.contexts.getWorkspaceContextItems()[0].value, 'main');
	assert.equal(await f.contexts.contextForResource(URI.file('/report.pdf'), undefined, 'other'), undefined);
	const resource = await f.contexts.contextForResource(URI.file('/report.pdf'), undefined, 'pdf');
	assert.ok(resource);
	assert.equal(resource.tooltip?.isTrusted, undefined);
	const resolved = await f.contexts.resolveChatContext(resource);
	assert.equal(resolved.value, 'Captured PDF text');
	await f.contexts.executeChatContextItemCommand(resolved.handle);
	assert.deepEqual(commands, [{ action: 'execute', handle: 1 }]);
	await f.adapter.update(f.snapshot(false));
	assert.deepEqual(f.contexts.getWorkspaceContextItems(), []);
	await assert.rejects(f.contexts.executeChatContextItemCommand(resolved.handle), /cancel/i);
	assert.equal(resolved.value, 'Captured PDF text');
	assert.deepEqual(f.errors, []);
});

test('workspace changes reject retired incarnations and discard cancelled older reads', async () => {
	const pending = new DeferredPromise<JsonValue>();
	let reads = 0;
	let oldSignal: AbortSignal | undefined;
	using f = fixture(async (registration, data, signal): Promise<JsonValue> => {
		if (data.action === 'describe') return registration === 'workspace'
			? { id: 'workspace', kind: 'workspace' }
			: { id: 'document', kind: 'resource', selector: { uri: '*' } };
		if (registration !== 'workspace') return null;
		if (++reads === 2) { oldSignal = signal; return pending.p; }
		return [{ handle: 1, label: 'Branch', value: reads === 1 ? 'initial' : 'latest' }];
	});
	await f.adapter.update(f.snapshot());
	await f.firstWorkspaceUpdate;
	const source = { extensionId: 'test.context', incarnation: 1, activationGeneration: 1 };
	const old = f.adapter.handleChange({ method: 'chatContextChanged', registrationId: 'workspace' }, source);
	await f.adapter.handleChange({ method: 'chatContextChanged', registrationId: 'workspace' }, source);
	assert.equal(oldSignal?.aborted, true);
	void pending.complete([{ handle: 1, value: 'stale' }]);
	await old;
	assert.equal(f.contexts.getWorkspaceContextItems()[0].value, 'latest');
	await f.adapter.update(f.snapshot(true, 2));
	await assert.rejects(f.adapter.handleChange({ method: 'chatContextChanged', registrationId: 'workspace' }, source), /cancel/i);
	await assert.rejects(f.adapter.handleChange({ method: 'chatContextChanged', registrationId: 'workspace', forged: true }, { ...source, incarnation: 2 }));
});

test('provider wire values are bounded and invalid registration never reaches the domain', async () => {
	using f = fixture(async (_registration, data): Promise<JsonValue> => data.action === 'describe'
		? { id: 'workspace', kind: 'workspace' }
		: [{ handle: 1, value: 'x'.repeat(1024 * 1024 + 1) }]);
	await f.adapter.update(f.snapshot());
	assert.deepEqual(f.contexts.getWorkspaceContextItems(), []);
	assert.ok(f.errors.length > 0);
});


test('concurrent activation and fleet updates both wait for provider descriptor registration', async () => {
	const definition = new DeferredPromise<JsonValue>();
	using f = fixture(async (registration, data): Promise<JsonValue> => {
		if (data.action === 'describe') return registration === 'workspace' ? { id: 'workspace', kind: 'workspace' } : definition.p;
		return registration === 'workspace' ? [] : { handle: 1, label: 'Ready resource', value: 'Captured' };
	});
	const notification = f.adapter.update(f.snapshot());
	let activationReady = false;
	const activation = f.adapter.update(f.snapshot()).then(() => { activationReady = true; });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(activationReady, false);
	void definition.complete({ id: 'document', kind: 'resource', selector: { uri: '*' } });
	await Promise.all([notification, activation]);
	assert.equal(activationReady, true);
	assert.equal((await f.contexts.contextForResource(URI.file('/source.ts')))?.value, 'Captured');
});

import { StatusbarService } from '../../../browser/parts/statusbar/statusbarPart.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { mock } from 'node:test';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import type { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { URI } from '../../../../base/common/uri.js';
import { TestNotificationService } from '../../../services/notification/test/common/testNotificationService.js';
import { CommandService } from '../../../services/commands/common/commandService.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ProgressService } from '../../../services/progress/browser/progressService.js';

import type { IProgressService } from '../../../../platform/progress/common/progress.js';
import { AppServerRemoteError } from '../../../../platform/agentHost/common/appServerError.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import type { JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import type { ServerNotification } from '../../../../../../.build/protocol/typescript/index.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionBackendApi } from '../../../../platform/agentHost/common/extensionBackendApi.js';
import type { IAppServerApi, IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ConfigurationTarget, type IConfigurationChangeEvent, type IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { MainThreadExtensionBackend } from '../../browser/mainThreadExtensionBackend.js';
import type { EditorPartChangeEvent } from '../../../services/editor/common/editorState.js';

const source = { extensionId: 'ash.git', activationGeneration: 1, incarnation: 1 };
const manifest = {
	ashFrontend: {
		capabilities: {
			'git.repository': {
				methods: {
					read: { route: 'config/read', fields: [], resultFields: ['revision', 'git', 'gitConfigured'] },
					write: { route: 'config/update', fields: ['commandId', 'expectedRevision', 'git'] },
					transport: {
						route: 'git/transport',
						cancellationRoute: 'git/transport/cancel',
						fields: ['operationId'],
					},
				},
				notifications: ['config/changed'],
			},
		},
	},
};
function fixture(sourceKind = 'builtIn', request?: IExtensionBackendApi['request'], progress?: IProgressService, editor?: ICodeEditor, editorPart?: IEditorPart) {
	const calls: { method: string; params: unknown }[] = [];
	const extensions = {
		list: async () => ({ extensions: [{ id: 'ash.git', sourceKind, manifestJson: JSON.stringify(manifest) }] }),
	} as unknown as IExtensionApi;
	const backend = {
		request: async (method, params, signal) => {
			calls.push({ method, params });
			if (request) return request(method, params, signal);
			return {
				revision: 1,
				git: { autofetch: 'off', autofetchPeriod: 180 },
				gitConfigured: true,
				providers: { token: 'private' },
			};
		},
	} satisfies IExtensionBackendApi;
	const connection = {
		getConnectionState: async () => 'ready',
		getSlashCommands: async () => [],
		connectionGeneration: 1,
		onConnectionState: Event.None,
	} satisfies IAppServerApi;
	const notifications = new Emitter<ServerNotification>();
	const events: IServerEventApi = { subscribe: listener => notifications.event(listener) };
	const workspace = {
		getWorkspace: () => ({ folders: [] }),
		onDidChangeWorkspace: Event.None,
	} as unknown as IWorkspaceContextService;
	const configurationChanges = new Emitter<IConfigurationChangeEvent>();
	const configuration = { onDidChangeConfiguration: configurationChanges.event } as unknown as IConfigurationService;
	const editors =
		editorPart ??
		({
			activeGroup: { activeInput: { resource: URI.file('/file.ts') } },
			groups: [{ inputs: [{ resource: URI.file('/file.ts') }] }],
			onDidChangeEditors: Event.None,
		} as unknown as IEditorPart);
	const codeEditors = {
		listCodeEditors: () => (editor ? [editor] : []),
		onCodeEditorAdd: Event.None,
		onCodeEditorRemove: Event.None,
	} as unknown as ICodeEditorService;
	return {
		bridge: new MainThreadExtensionBackend(
			extensions,
			backend,
			connection,
			events,
			workspace,
			configuration,
			progress ?? { withProgress: async (_options, task) => task({ report() {} }) },
			editors,
			codeEditors,
		),
		calls,
		notifications,
		configurationChanges,
	};
}

test('client settings invalidate backend state without fabricating a server configuration notification', async () => {
	const value = fixture();
	using bridge = value.bridge;
	using changes = value.configurationChanges;
	using notifications = value.notifications;
	const signal = new AbortController().signal;
	const waiting = bridge.handle(source, 'git.repository', undefined, {}, 0, signal, undefined, true);
	await Promise.resolve();
	await Promise.resolve();
	changes.fire({
		source: ConfigurationTarget.USER_LOCAL,
		affectedKeys: new Set(['git.autorefresh']),
		change: { keys: ['git.autorefresh'], overrides: [] },
		affectsConfiguration: () => true,
	});
	const result = (await waiting) as { reset: boolean; sequence: number; events: JsonValue[] };
	assert.equal(result.reset, true);
	assert.equal(result.sequence, 1);
	assert.deepEqual(result.events, []);
	const current = (await bridge.handle(source, 'git.repository', undefined, {}, result.sequence, signal)) as {
		reset: boolean;
	};
	assert.equal(current.reset, false);
});

test('editor folder changes are retained separately from resets and same-folder blame wakeups', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using events = new Emitter<EditorPartChangeEvent>();
		const inputs = [{ resource: URI.file('/repo/first.ts') }];
		const editors = {
			activeGroup: { activeInput: inputs[0] },
			groups: [{ inputs }],
			onDidChangeEditors: events.event,
		} as unknown as IEditorPart;
		const value = fixture('builtIn', undefined, undefined, undefined, editors);
		using bridge = value.bridge;
		using notifications = value.notifications;
		using changes = value.configurationChanges;
		let sequence = 0;
		const cases = [
			{ change: () => {}, foldersChanged: false },
			{
				change: () => {
					inputs[0] = { resource: URI.file('/repo/second.ts') };
				},
				foldersChanged: false,
			},
			{
				change: () => {
					inputs.push({ resource: URI.parse('ash-diff:/compare?revision=1') });
				},
				foldersChanged: true,
			},
			{
				change: () => {
					inputs[1] = { resource: URI.parse('ash-diff:/compare?revision=2') };
				},
				foldersChanged: false,
			},
			{
				change: () => {
					inputs.push({ resource: URI.file('/repo/nested/third.ts') });
				},
				foldersChanged: true,
			},
			{
				change: () => {
					inputs.push({ resource: URI.file('/repo/nested/fourth.ts') });
				},
				foldersChanged: false,
			},
			{
				change: () => {
					inputs.pop();
				},
				foldersChanged: false,
			},
			{
				change: () => {
					inputs.pop();
				},
				foldersChanged: true,
			},
		];
		for (const { change, foldersChanged } of cases) {
			const waiting = bridge.handle(source, 'git.repository', undefined, {}, sequence, new AbortController().signal, undefined, true);
			await Promise.resolve();
			await Promise.resolve();
			change();
			events.fire({
				kind: 'groupChanged',
				groupId: 1,
				event: { kind: 'activeEditorChanged', editor: undefined },
			});
			mock.timers.tick(75);
			const result = (await waiting) as {
				reset: boolean;
				editorFoldersChanged: boolean;
				sequence: number;
				events: JsonValue[];
			};
			assert.equal(result.reset, false);
			assert.equal(result.editorFoldersChanged, foldersChanged);
			assert.deepEqual(result.events, []);
			assert.equal(result.sequence, ++sequence);
		}
	} finally {
		mock.timers.reset();
	}
});

test('backend state subscriptions wake on admitted changes and replay notifications that precede the wait', async () => {
	const value = fixture();
	using bridge = value.bridge;
	using notifications = value.notifications;
	const signal = new AbortController().signal;
	let settled = false;
	const waiting = bridge.handle(source, 'git.repository', undefined, {}, 0, signal, undefined, true);
	void waiting.then(() => {
		settled = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	notifications.fire({ method: 'git/repositoriesChanged', params: {} } as ServerNotification);
	await Promise.resolve();
	assert.equal(settled, false, 'Other capabilities cannot wake this subscription');
	const change = { method: 'config/changed', params: { revision: 1 } } as ServerNotification;
	notifications.fire(change);
	const result = (await waiting) as { sequence: number; events: JsonValue[] };
	assert.equal(result.events.length, 1);
	assert.equal(JSON.stringify(result.events[0]), JSON.stringify(change));
	notifications.fire(change);
	const replay = (await bridge.handle(source, 'git.repository', undefined, {}, result.sequence, signal, undefined, true)) as { events: JsonValue[] };
	assert.deepEqual(replay.events, result.events);
});

test('backend state waits release on caller cancellation and bridge disposal', async () => {
	for (const reason of ['caller', 'dispose'] as const) {
		const value = fixture();
		using bridge = value.bridge;
		using notifications = value.notifications;
		const controller = new AbortController();
		const waiting = bridge.handle(source, 'git.repository', undefined, {}, 0, controller.signal, undefined, true);
		await Promise.resolve();
		await Promise.resolve();
		if (reason === 'caller') controller.abort();
		else bridge.dispose();
		await assert.rejects(waiting, /cancelled/i);
	}
});

test('product backend grants restrict methods, input fields and returned configuration', async () => {
	const value = fixture();
	using cleanup = value.bridge;
	const signal = new AbortController().signal;
	assert.deepEqual(await value.bridge.handle(source, 'git.repository', 'read', {}, 0, signal), {
		revision: 1,
		git: { autofetch: 'off', autofetchPeriod: 180 },
		gitConfigured: true,
	});
	await assert.rejects(value.bridge.handle(source, 'git.repository', 'unknown', {}, 0, signal), /not authorized/);
	await assert.rejects(value.bridge.handle(source, 'git.repository', 'write', { providers: { token: 'secret' } }, 0, signal), /exceed/);
	assert.deepEqual(value.calls, [{ method: 'config/read', params: {} }]);
});

test('an installed extension cannot grant itself product backend access', async () => {
	const value = fixture('user');
	using cleanup = value.bridge;
	await assert.rejects(value.bridge.handle(source, 'git.repository', 'read', {}, 0, new AbortController().signal), /not authorized/);
	assert.deepEqual(value.calls, []);
});

test('cancelled backend requests cannot publish a result or launch another operation', async () => {
	const value = fixture();
	using cleanup = value.bridge;
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(value.bridge.handle(source, 'git.repository', 'read', {}, 0, controller.signal));
	assert.deepEqual(value.calls, []);
});

for (const retire of [false, true])
	test(`backend cancellation retains its exact operation until terminal completion${retire ? ' during retirement' : ''}`, async () => {
		const operation = new DeferredPromise<JsonValue>();
		const cancellation = new DeferredPromise<void>();
		const controller = new AbortController();
		let settled = false;
		setNlsMessages('zh-CN', { ash: { 'progress.region': '进度', 'progress.cancel': '取消' } });
		try {
			using statusbar = new StatusbarService();
			using notifications = new TestNotificationService();
			using commands = new CommandService({
				get() {
					throw new Error('Unexpected command service request');
				},
				getOptional() {
					return undefined;
				},
			});
			using progress = new ProgressService(statusbar, notifications, commands, {} as never, {} as never, {} as never);
			const value = fixture(
				'builtIn',
				async (method, params) => {
					if (method === 'git/transport') return operation.p;
					assert.equal(method, 'git/transport/cancel');
					assert.deepEqual(params, { operationId: 'window-owned-operation' });
					await cancellation.complete();
					return { status: 'requested' };
				},
				progress,
			);
			using cleanup = value.bridge;
			const result = value.bridge.handle(source, 'git.repository', 'transport', { operationId: 'window-owned-operation' }, 0, controller.signal, { title: 'Git', cancellable: true });
			void result.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			// Admission reads the product catalog before creating the existing progress surface.
			await Promise.resolve();
			await Promise.resolve();
			const cancel = notifications.model.getNotifications()[0]?.actions?.primary?.[0];
			assert.equal(cancel?.label, '取消');
			if (retire) controller.abort('extension retired');
			else await cancel!.run();
			await cancellation.p;
			assert.equal(settled, false);
			assert.equal(value.calls.filter(call => call.method.endsWith('/cancel')).length, 1);
			await operation.error(new AppServerRemoteError(-32800, 'cancelled', { kind: 'RequestCancelled' }));
			if (retire) await assert.rejects(result);
			else assert.deepEqual(await result, { backendError: { name: 'RequestCancelled', message: 'cancelled' } });
			assert.deepEqual(notifications.model.getNotifications(), []);
		} finally {
			resetNlsResolver();
		}
	});

test('idle backend waits renew at the service deadline rather than polling editor state', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const value = fixture();
		using bridge = value.bridge;
		using notifications = value.notifications;
		using changes = value.configurationChanges;
		let completed = false;
		const waiting = bridge.handle(source, 'git.repository', undefined, {}, 0, new AbortController().signal, undefined, true);
		void waiting.then(() => {
			completed = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		mock.timers.tick(19_999);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(completed, false);
		mock.timers.tick(1);
		await waiting;
		assert.equal(completed, true);
	} finally {
		mock.timers.reset();
	}
});

test('cursor and unsaved text changes wake blame without invalidating repository discovery', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using cursor = new Emitter<void>();
		using content = new Emitter<void>();
		const editor = {
			getModel: () => ({ uri: URI.file('/file.ts') }),
			onDidChangeCursorPosition: cursor.event,
			onDidChangeModelContent: content.event,
			onDidChangeModel: Event.None,
		} as unknown as ICodeEditor;
		const value = fixture('builtIn', undefined, undefined, editor);
		using bridge = value.bridge;
		using notifications = value.notifications;
		using changes = value.configurationChanges;
		const signal = new AbortController().signal;
		let sequence = 0;
		for (const event of [cursor, content]) {
			const waiting = bridge.handle(source, 'git.repository', undefined, {}, sequence, signal, undefined, true);
			await Promise.resolve();
			await Promise.resolve();
			event.fire();
			event.fire();
			mock.timers.tick(75);
			const result = (await waiting) as { reset: boolean; sequence: number; events: JsonValue[] };
			assert.deepEqual(result.events, []);
			assert.equal(result.reset, false);
			assert.equal(result.sequence, ++sequence, 'One cursor revision per burst');
		}
		// A change arriving between requests must also wake the next subscription.
		cursor.fire();
		mock.timers.tick(75);
		const replay = (await bridge.handle(source, 'git.repository', undefined, {}, sequence, signal, undefined, true)) as { sequence: number };
		assert.equal(replay.sequence, sequence + 1);
	} finally {
		mock.timers.reset();
	}
});

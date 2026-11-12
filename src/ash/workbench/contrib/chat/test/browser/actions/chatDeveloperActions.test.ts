import { languagePackCatalog as chineseCatalog } from '../../../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { commandActionLabel } from '../../../../../../platform/action/common/action.js';
import { MenuId, MenusRegistry } from '../../../../../../platform/actions/common/actions.js';
import { IAppServerApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IMessageHistoryService, type MessageHistoryQuery } from '../../../../../../platform/messageHistory/common/messageHistory.js';
import { IChatService, type ThreadRead } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IUntitledTextEditorService, type INewUntitledTextEditorOptions } from '../../../../../services/untitled/common/untitledTextEditorService.js';
import { UntitledTextEditorInput } from '../../../../../services/untitled/common/untitledTextEditorInput.js';
import { getChatInputAccessibilityHelp } from '../../../browser/actions/chatAccessibilityHelp.js';
import { registerChatDeveloperActions } from '../../../browser/actions/chatDeveloperActions.js';
import { IAgentSessionsService } from '../../../browser/agentSessions/agentSessionsService.js';
import { IChatWidgetService } from '../../../browser/chat.js';

const ids = ['logInputHistory', 'logChatIndex', 'inspectChatModel'].map(name => `workbench.action.chat.${name}`);
const importedCommands = ids.map(id => CommandsRegistry.getCommand(id));
const snapshot = { thread: { sessionId: 'source', threadId: 'thread', turns: [] }, transcript: { entries: [] } } as unknown as ThreadRead;

function fixture(resources: DisposableStore, options: { readonly history?: IMessageHistoryService | null; readonly local?: boolean; } = {}) {
	const services = resources.add(new InstantiationService());
	const widget = { visible: true, sessionId: 'source', threadId: 'thread' };
	const state = { disabled: false, revision: 1, focused: widget as typeof widget | undefined, retired: false, checks: 0, disposals: 0 };
	const logs: { event: string; value: unknown; }[] = [];
	const created: INewUntitledTextEditorOptions[] = [];
	const opened: unknown[] = [];
	const reads: [string, string][] = [];
	const queries: MessageHistoryQuery[] = [];
	let read = async () => snapshot;
	services.registerInstance(IConfigurationService, { getValue: () => state.disabled } as unknown as IConfigurationService);
	services.registerInstance(IChatWidgetService, { get lastFocusedWidget() { return state.focused; } } as unknown as IChatWidgetService);
	services.registerInstance(IChatSessionNavigationService, {
		get revision() { return state.revision; },
		captureConnection: options.local ? undefined : () => ({
			generation: 1,
			assertCurrent: async () => { state.checks++; if (state.retired) throw new Error('Connection retired'); },
			dispose: () => { state.disposals++; },
		}),
	} as unknown as IChatSessionNavigationService);
	services.registerInstance(IChatService, { readThread: async (sessionId: string, threadId: string) => { reads.push([sessionId, threadId]); return read(); } } as unknown as IChatService);
	services.registerInstance(ILogService, { info: (event: string, value: string) => logs.push({ event, value: JSON.parse(value) }) } as unknown as ILogService);
	services.registerInstance(IMessageHistoryService, options.history === null ? undefined : options.history ?? {
		read: async (query: MessageHistoryQuery) => {
			queries.push(query);
			return query.before === undefined
				? { entries: [{ id: '3', text: 'sent', kind: 'agent', submittedAtMs: 3 }, { id: '2', text: 'terminal', kind: 'shell', submittedAtMs: 2 }], nextBefore: '2' }
				: { entries: [{ id: '1', text: '/config', kind: 'command', submittedAtMs: 1 }] };
		},
	} as unknown as IMessageHistoryService);
	services.registerInstance(IUntitledTextEditorService, {
		create: (options: INewUntitledTextEditorOptions) => {
			created.push(options);
			return { resource: URI.parse('untitled:/inspection'), initialValue: options.initialValue, getLanguageId: () => options.languageId };
		},
	} as unknown as IUntitledTextEditorService);
	services.registerInstance(IEditorService, {
		openEditor: async (input: UntitledTextEditorInput, options: unknown) => { resources.add(input); opened.push([input, options]); },
	} as unknown as IEditorService);
	return {
		services, state, widget, logs, reads, queries, created, opened,
		readWith: (operation: () => Promise<ThreadRead>) => { read = operation; },
		run: async (name: 'logInputHistory' | 'logChatIndex' | 'inspectChatModel') => { await services.invokeFunction(CommandsRegistry.getCommand(`workbench.action.chat.${name}`)!); },
	};
}

suite('Chat developer commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	suiteSetup(() => {
		setNlsMessages('zh-CN', chineseCatalog.bundles);
		try { registerChatDeveloperActions(); } finally { resetNlsResolver(); }
	});

	test('registration is explicit and command labels and input help are localized', () => {
		assert.deepEqual(importedCommands, [undefined, undefined, undefined]);
		const labels = MenusRegistry.getMenuItems(MenuId.CommandPalette).flatMap(item => 'command' in item && ids.includes(item.command.id) ? [commandActionLabel(item.command.title)] : []);
		assert.deepEqual(labels, ['开发人员：记录聊天输入历史', '开发人员：记录聊天索引', '开发人员：检查聊天模型']);
		setNlsMessages('zh-CN', chineseCatalog.bundles);
		try { assert.match(getChatInputAccessibilityHelp('', false, false), /新的 JSON 编辑器.*保留草稿和当前对话/u); }
		finally { resetNlsResolver(); }
	});

	test('history pages retain submitted Chat records without changing history or logging terminal inputs', async () => {
		using resources = new DisposableStore(); const f = fixture(resources);
		await f.run('logInputHistory');
		assert.deepEqual(f.queries, [{ text: '', before: undefined, limit: 100 }, { text: '', before: '2', limit: 100 }]);
		assert.deepEqual(f.logs, [
			{ event: 'chat.inputHistory', value: { nextBefore: '2', entries: [{ id: '3', text: 'sent', kind: 'agent', submittedAtMs: 3 }] } },
			{ event: 'chat.inputHistory', value: { before: '2', entries: [{ id: '1', text: '/config', kind: 'command', submittedAtMs: 1 }] } },
		]);
	});

	test('unavailable history and read failures propagate without claiming a successful page', async () => {
		using resources = new DisposableStore();
		const unavailable = fixture(resources, { history: null });
		await assert.rejects(unavailable.run('logInputHistory'), /Input history is unavailable/);
		const failed = fixture(resources, { history: { read: async () => { throw new Error('Profile read failed'); } } as unknown as IMessageHistoryService });
		await assert.rejects(failed.run('logInputHistory'), /Profile read failed/);
		assert.deepEqual([...unavailable.logs, ...failed.logs], []);
	});

	test('index refreshes its owner and serializes Session and child Thread identities and current flags', async () => {
		using resources = new DisposableStore(); const f = fixture(resources);
		let refreshed = false;
		const child = { resource: URI.parse('ash-session:/child'), label: 'Thread', kind: 'session', target: { sessionId: 'source', threadId: 'child' }, isArchived: () => false, isPinned: () => false };
		f.services.registerInstance(IAgentSessionsService, {
			model: {
				refresh: async () => { refreshed = true; }, state: 'ready', error: undefined,
				get sessions() { assert.equal(refreshed, true); return [{ ...child, resource: URI.parse('ash-session:/source'), label: 'Session', target: { sessionId: 'source' }, isArchived: () => true, isPinned: () => true, children: [child] }]; },
			}
		} as unknown as IAgentSessionsService);
		await f.run('logChatIndex');
		assert.deepEqual(f.logs, [{
			event: 'chat.index', value: {
				state: 'ready', sessions: [{
					resource: 'ash-session:/source', label: 'Session', kind: 'session', target: { sessionId: 'source' }, archived: true, pinned: true,
					children: [{ resource: 'ash-session:/child', label: 'Thread', kind: 'session', target: { sessionId: 'source', threadId: 'child' }, archived: false, pinned: false }]
				}]
			}
		}]);
	});

	test('inspection opens the captured backend snapshot through the standard untitled editor', async () => {
		using resources = new DisposableStore(); const f = fixture(resources);
		await f.run('inspectChatModel');
		assert.deepEqual(f.reads, [['source', 'thread']]);
		assert.deepEqual(f.created, [{ initialValue: JSON.stringify(snapshot, null, 2), languageId: 'json' }]);
		assert.equal(f.opened.length, 1);
		const [input, options] = f.opened[0] as [UntitledTextEditorInput, unknown];
		assert.ok(input instanceof UntitledTextEditorInput);
		assert.equal(input.resource.toString(), 'untitled:/inspection');
		assert.equal(input.initialText, JSON.stringify(snapshot, null, 2));
		assert.equal(input.languageId, 'json');
		assert.deepEqual(options, { pinned: true });
		assert.equal(f.state.checks, 2); assert.equal(f.state.disposals, 1);
	});

	for (const change of ['navigation', 'focus', 'hidden', 'thread', 'disabled', 'retired'] as const) {
		test(`pending inspection cannot open over a changed ${change}`, async () => {
			using resources = new DisposableStore(); const f = fixture(resources);
			const pending = new DeferredPromise<ThreadRead>(); const requested = new DeferredPromise<void>();
			f.readWith(async () => { await requested.complete(); return pending.p; });
			const result = f.run('inspectChatModel');
			await requested.p;
			if (change === 'navigation') f.state.revision++;
			if (change === 'focus') f.state.focused = undefined;
			if (change === 'hidden') f.widget.visible = false;
			if (change === 'thread') f.widget.threadId = 'other';
			if (change === 'disabled') f.state.disabled = true;
			if (change === 'retired') f.state.retired = true;
			const assertion = change === 'retired' ? assert.rejects(result, /Connection retired/) : result;
			await pending.complete(snapshot); await assertion;
			assert.deepEqual(f.created, []); assert.deepEqual(f.opened, []); assert.equal(f.state.disposals, 1);
		});
	}

	test('inspection releases its connection on failure and rejects a different conversation snapshot', async () => {
		using resources = new DisposableStore(); const f = fixture(resources);
		f.readWith(async () => { throw new Error('Read failed'); });
		await assert.rejects(f.run('inspectChatModel'), /Read failed/);
		f.readWith(async () => ({ ...snapshot, thread: { ...snapshot.thread, threadId: 'other' } }));
		await assert.rejects(f.run('inspectChatModel'), /unavailable on this connection/);
		assert.equal(f.state.disposals, 2); assert.deepEqual(f.created, []);
	});

	test('local connection retirement invalidates a resolved snapshot before its consumer opens', async () => {
		using resources = new DisposableStore(); const f = fixture(resources, { local: true });
		const connection = resources.add(new Emitter<'stopped' | 'ready'>());
		f.services.registerInstance(IAppServerApi, { connectionGeneration: 1, onConnectionState: connection.event, getConnectionState: async () => 'ready' } as unknown as IAppServerApi);
		f.readWith(async () => { connection.fire('stopped'); return snapshot; });
		await assert.rejects(f.run('inspectChatModel'), isCancellationError);
		assert.deepEqual(f.created, []);
	});

	test('disabled commands and inspection without a visible durable Chat do no work', async () => {
		using resources = new DisposableStore(); const f = fixture(resources);
		f.state.disabled = true;
		for (const command of ['logInputHistory', 'logChatIndex', 'inspectChatModel'] as const) await f.run(command);
		f.state.disabled = false;
		for (const target of [undefined, { ...f.widget, visible: false }, { ...f.widget, threadId: '' }]) {
			f.state.focused = target; await f.run('inspectChatModel');
		}
		assert.deepEqual(f.reads, []); assert.deepEqual(f.queries, []); assert.deepEqual(f.logs, []); assert.deepEqual(f.opened, []);
	});
});

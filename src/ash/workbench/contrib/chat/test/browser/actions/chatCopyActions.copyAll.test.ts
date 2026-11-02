import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { suite, test } from 'mocha';
import { Event } from '../../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../../nls.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IAppServerApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatService, type ThreadRead, type ThreadTranscriptEntry } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { registerChatCopyActions } from '../../../browser/actions/chatCopyActions.js';

registerChatCopyActions();

suite('Copy conversation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('message, final response and conversation commands share portable Markdown without changing transcript state', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		const text = 'See [source.ts](/workspace/source.ts) and [Docs](https://example.com).';
		const item = { type: 'agentMessage' as const, itemId: 'reply', turnId: 'turn', text };
		const conversation = snapshot('session', 'root', [{ type: 'item', entryId: 'reply', turnId: 'turn', transient: false, item }]);
		f.readWith(async () => conversation);
		await f.services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.copyItem')!, item);
		await f.services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.copyFinalResponse')!);
		await f.copy();
		assert.deepEqual(f.copied, [
			'See `source.ts` and [Docs](https://example.com).',
			'See `source.ts` and [Docs](https://example.com).',
			'Assistant: See `source.ts` and [Docs](https://example.com).',
		]);
		assert.equal(item.text, text);
	});

	function fixture(lifetime: DisposableStore, options: { readonly registerAmbientConnection?: boolean; } = {}) {
		const services = lifetime.add(new InstantiationService());
		let active: { sessionId: string; threadId: string; } | undefined = { sessionId: 'session', threadId: 'root' };
		let focused: { sessionId?: string; threadId?: string; } | undefined;
		let generation = 1;
		const reads: unknown[] = [];
		const copied: string[] = [];
		const announcements: string[] = [];
		let read = async (sessionId: string, threadId: string): Promise<ThreadRead> => ({
			thread: { sessionId, threadId },
			transcript: { sessionId, threadId, entries: [], durableSequence: 1, revision: 1 },
		} as unknown as ThreadRead);
		services.registerInstance(IChatService, {
			readThread: (sessionId, threadId, history) => {
				reads.push({ sessionId, threadId, history });
				return read(sessionId, threadId);
			}
		} as IChatService);
		services.registerInstance(IClipboardService, { writeText: async text => { copied.push(text); } } as IClipboardService);
		services.registerInstance(IAccessibilityService, { status: text => { announcements.push(text); } } as IAccessibilityService);
		services.registerInstance(IChatWidgetService, { get lastFocusedWidget() { return focused; } } as IChatWidgetService);
		const navigation = { getActiveConversation: () => active } as IChatSessionNavigationService;
		services.registerInstance(IChatSessionNavigationService, navigation);
		if (options.registerAmbientConnection !== false) {
			services.registerInstance(IAppServerApi, {
				isAvailable: true,
				get connectionGeneration() { return generation; },
				getConnectionState: async () => 'ready', getSlashCommands: async () => [], onConnectionState: Event.None,
			} as IAppServerApi);
		}
		return {
			services, reads, copied, announcements, navigation,
			select: (value: typeof active) => { active = value; },
			focus: (value: typeof focused) => { focused = value; },
			reconnect: () => { generation++; },
			readWith: (value: typeof read) => { read = value; },
			copy: (context?: unknown) => Promise.resolve(services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.copyAll')!, context)),
		};
	}

	function snapshot(sessionId: string, threadId: string, entries: readonly ThreadTranscriptEntry[]): ThreadRead {
		return { thread: { sessionId, threadId }, transcript: { sessionId, threadId, entries, durableSequence: 1, revision: 1 } } as unknown as ThreadRead;
	}

	const messages: readonly ThreadTranscriptEntry[] = [
		{ type: 'item', entryId: 'old', turnId: 'old-turn', transient: false, item: { type: 'userMessage', itemId: 'old', turnId: 'old-turn', text: 'Earlier **question**' } },
		{ type: 'item', entryId: 'private', turnId: 'turn', transient: false, item: { type: 'reasoning', itemId: 'private', turnId: 'turn', text: 'Internal reasoning', state: [] } },
		{ type: 'item', entryId: 'answer', turnId: 'turn', transient: true, item: { type: 'agentMessage', itemId: 'answer', turnId: 'turn', text: '```ts\nconst answer = 42;\n```' } },
		{ type: 'voiceTranscript', entryId: 'voice', transcript: { itemId: 'voice', voiceSessionId: 'voice-session', mediaEpoch: 1, speaker: 'user', text: 'Spoken follow-up', startMs: 0, endMs: 100, afterItemId: 'answer' } },
	];

	test('final response copies the last completed assistant source, excluding later streaming text', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		f.readWith(async (sessionId, threadId) => snapshot(sessionId, threadId, [
			{ type: 'item', entryId: 'final', turnId: 'turn', transient: false, item: { type: 'agentMessage', itemId: 'final', turnId: 'turn', text: '**Completed reply**' } },
			...messages,
			{ type: 'item', entryId: 'commentary', turnId: 'turn', transient: false, item: { type: 'agentMessage', itemId: 'commentary', turnId: 'turn', text: 'Later commentary', phase: 'commentary' } },
		]));
		await f.services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.copyFinalResponse')!);
		assert.deepEqual(f.copied, ['**Completed reply**']);
	});

	test('copies the complete captured conversation without reading the rendered list or changing selection', async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		const pending = new DeferredPromise<ThreadRead>();
		f.readWith(() => pending.p);
		const operation = f.copy({ sessionId: 'chosen', threadId: 'child' });
		f.select({ sessionId: 'later', threadId: 'other' });
		await pending.complete(snapshot('chosen', 'child', messages));
		await operation;
		assert.deepEqual(f.reads, [{ sessionId: 'chosen', threadId: 'child', history: undefined }]);
		assert.deepEqual(f.copied, ['User: Earlier **question**\n\nAssistant: ```ts\nconst answer = 42;\n```\n\nUser: Spoken follow-up']);
		assert.deepEqual(f.announcements, ['Conversation copied to clipboard']);
	});

	test('targets the last focused visible Chat and keeps an explicit draft or empty conversation out of the clipboard', async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		f.focus({ sessionId: 'quick', threadId: 'quick-thread' });
		f.readWith(async (sessionId, threadId) => snapshot(sessionId, threadId, messages));
		await f.copy();
		assert.deepEqual(f.reads, [{ sessionId: 'quick', threadId: 'quick-thread', history: undefined }]);
		f.focus({});
		await f.copy();
		await f.copy({});
		f.readWith(async (sessionId, threadId) => snapshot(sessionId, threadId, []));
		await f.copy({ sessionId: 'empty', threadId: 'root' });
		assert.equal(f.copied.length, 1);
		assert.equal(f.announcements.length, 1);
	});

	test('a reconnect or failed history read never overwrites the clipboard', async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime);
		const pending = new DeferredPromise<ThreadRead>();
		f.readWith(() => pending.p);
		const operation = f.copy();
		const rejected = assert.rejects(operation, /cancelled/);
		f.reconnect();
		await pending.complete(snapshot('session', 'root', messages));
		await rejected;
		f.readWith(async () => { throw new Error('History unavailable'); });
		await assert.rejects(f.copy(), /History unavailable/);
		assert.deepEqual(f.copied, []);
		assert.deepEqual(f.announcements, []);
	});

	test('multi-host reads use the owning connection and release it on failure', async () => {
		using lifetime = new DisposableStore();
		const f = fixture(lifetime, { registerAmbientConnection: false });
		let current = true;
		let disposed = 0;
		const pending = new DeferredPromise<ThreadRead>();
		f.navigation.captureConnection = sessionId => {
			assert.equal(sessionId, 'qualified-session');
			return Object.assign(toDisposable(() => { disposed++; }), { generation: 7, assertCurrent: async () => { if (!current) throw new Error('Owner retired'); } });
		};
		f.readWith(() => pending.p);
		const operation = f.copy({ sessionId: 'qualified-session', threadId: 'qualified-thread' });
		const rejected = assert.rejects(operation, /Owner retired/);
		await Promise.resolve();
		current = false;
		await pending.complete(snapshot('qualified-session', 'qualified-thread', messages));
		await rejected;
		assert.equal(disposed, 1);
		assert.deepEqual(f.copied, []);
	});

	test('Chinese content roles and completion use the product catalog', async () => {
		const messagesByBundle = JSON.parse(readFileSync(resolve('extensions/language-pack-zh-cn/translations/chat.json'), 'utf8'));
		setNlsMessages('zh-CN', messagesByBundle);
		try {
			using lifetime = new DisposableStore();
			const f = fixture(lifetime);
			f.readWith(async (sessionId, threadId) => snapshot(sessionId, threadId, messages));
			await f.copy();
			assert.match(f.copied[0]!, /^用户: Earlier \*\*question\*\*[\s\S]*助手: ```ts/u);
			assert.deepEqual(f.announcements, ['对话已复制到剪贴板']);
		} finally {
			resetNlsResolver();
		}
	});
});

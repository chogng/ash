import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { autorun, observableValue } from '../../../../../base/common/observable.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatWidgetService, type IChatWidget } from '../../browser/chat.js';
import { captureSideChatSelection } from '../../browser/chatSideChat.js';
import { ChatSideChatProvider } from '../../browser/chatSideChatProvider.js';
import { BtwSlashCommandContribution } from '../../browser/btwSlashCommand.js';
import { IChatSideChatService, ChatSideChatService, type IChatSideChatOrigin, type IChatSideChatProvider } from '../../common/chatSideChatService.js';
import { IChatSlashCommandService, ChatSlashCommandService } from '../../common/participants/chatSlashCommands.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';

function fixture() {
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const changed = lifetime.add(new Emitter<void>());
	const domNode = browserEnvironment.window.document.createElement('div');
	domNode.innerHTML = '<div class="ash-chat-list-widget"><p>Source selection</p></div><div class="outside">Unrelated editor</div>';
	browserEnvironment.window.document.body.append(domNode);
	const state = { mode: 'ask', isAutomaticModel: false, selectedModel: { provider: 'test', model: 'model' }, selectedReasoningEffort: 'high', approvalMode: 'manual' };
	const model = { composerGeneration: 1, onDidChange: changed.event, sessionId: 'session', threadId: 'source', thread: { origin: { type: 'root' }, turns: [{ turnId: 'turn-source', status: 'running' }] }, inputState: state, items: [] };
	const widget = { sessionId: 'session', threadId: 'source', visible: true, domNode, model, isTranscriptProgressActive: false } as unknown as IChatWidget;
	const widgets = [widget];
	const calls: { create: unknown[]; start: unknown[]; navigate: unknown[]; } = { create: [], start: [], navigate: [] };
	const threads = { canCreateSideChat: () => true, createSideChat: async (options: unknown) => { calls.create.push(options); return { sessionId: 'session', threadId: 'side' }; } };
	services.registerInstance(IAgentThreadService, threads as unknown as IAgentThreadService);
	services.registerInstance(IChatWidgetService, { getAllWidgets: () => widgets, onDidChangeWidgets: changed.event } as unknown as IChatWidgetService);
	services.registerInstance(IChatService, { readThread: async () => ({ thread: { sequence: 4 } }), startTurn: async (options: unknown) => { calls.start.push(options); } } as unknown as IChatService);
	services.registerInstance(IChatSessionNavigationService, { getConversations: () => [{ sessionId: 'session', threadId: 'source', title: 'Source title' }], openConversation: async (...args: unknown[]) => { calls.navigate.push(args); } } as unknown as IChatSessionNavigationService);
	const sideChats = lifetime.add(new ChatSideChatService());
	const commands = lifetime.add(new ChatSlashCommandService());
	services.registerInstance(IChatSideChatService, sideChats);
	services.registerInstance(IChatSlashCommandService, commands);
	const provider = lifetime.add(services.createInstance(ChatSideChatProvider));
	lifetime.add(services.createInstance(BtwSlashCommandContribution));
	return { commands, sideChats, provider, widget, widgets, model, state, changed, threads, calls, resource: LocalChatSessionUri.forSession('session', 'source'), [Symbol.dispose]: () => { lifetime.dispose(); domNode.remove(); } };
}

test('/btw is a registered client command and submits to the captured source with its model and attachments', async () => {
	using f = fixture();
	// Agents keeps a hidden Code widget alongside the visible Cowork widget for the same Thread.
	f.widgets.unshift({ ...f.widget, visible: false } as IChatWidget);
	assert.deepEqual(f.commands.getCommands().map(command => [command.command, command.executeDuringRequest]), [['btw', true]]);
	await assert.rejects(f.commands.executeCommand('btw', '  ', f.resource), /Enter a question/);
	assert.equal(f.calls.create.length, 0);
	await f.commands.executeCommand('btw', 'Question\nsecond line', f.resource, { attachedContext: [{ id: 'context', kind: 'context', name: 'frozen', resolve: async () => ({ name: 'frozen', content: 'captured bytes' }) }] });
	assert.deepEqual(f.calls.create.map(value => { const { commandId, ...options } = value as Record<string, unknown>; assert.equal(typeof commandId, 'string'); return options; }), [{ sessionId: 'session', threadId: 'source', sourceTurnId: 'turn-source', title: 'Side question: Question second line' }]);
	assert.equal(f.calls.start.length, 1);
	assert.deepEqual(f.calls.start[0], { sessionId: 'session', threadId: 'side', commandId: (f.calls.start[0] as { commandId: string; }).commandId, expectedSequence: 4, text: 'Question\nsecond line', mode: 'ask', model: f.state.selectedModel, reasoningEffort: 'high', approvalMode: 'manual', contexts: [{ name: 'frozen', content: 'captured bytes' }], signal: undefined });
	assert.deepEqual(f.calls.navigate, [['session', 'side']]);
	assert.equal(f.model.thread.turns[0].status, 'running');
});

test('Side Chat rejects stale source lifetimes after branch creation without submitting or navigating elsewhere', async () => {
	using f = fixture();
	const created = new DeferredPromise<{ sessionId: string; threadId: string; }>();
	f.threads.createSideChat = async () => created.p;
	const operation = f.commands.executeCommand('btw', 'Captured source', f.resource);
	await Promise.resolve();
	Object.assign(f.widget, { threadId: 'successor' });
	created.complete({ sessionId: 'session', threadId: 'side' });
	await assert.rejects(operation, /Cancel/i);
	assert.deepEqual(f.calls.start, []);
	assert.deepEqual(f.calls.navigate, []);
});

test('Side Chat origin is read from the backend model, including on a restored branch', () => {
	using f = fixture();
	Object.assign(f.widget, { threadId: 'restored-side' });
	Object.assign(f.model, { thread: { origin: { type: 'sideChat', parentThreadId: 'source', sourceTurnId: 'turn-source', selection: 'original selection' }, turns: [] } });
	const resource = LocalChatSessionUri.forSession('session', 'restored-side');
	const origin = f.provider.observeSideChatOrigin(resource).get()!;
	assert.deepEqual(LocalChatSessionUri.parse(origin.sourceSessionResource), { sessionId: 'session', threadId: 'source' });
	assert.equal(origin.sourceTitle, 'Source title');
	assert.equal(origin.sourceTurnId, 'turn-source');
	assert.deepEqual(origin.selection, { text: 'original selection' });
});

function addSideChat(f: ReturnType<typeof fixture>, sourceTurnId: string): void {
	const source = f.widget.model!;
	f.widgets.push({
		...f.widget,
		threadId: 'side',
		model: {
			...source,
			thread: {
				...source.thread!,
				origin: {
					type: 'sideChat',
					parentThreadId: 'source',
					parentSequence: 4,
					sourceTurnId,
					contextThreadId: 'context',
					contextSequence: 1,
				},
			},
		},
	});
}

test('Side Chat return loads the source request from earlier history and reveals it', async () => {
	using f = fixture();
	const side = LocalChatSessionUri.forSession('session', 'side');
	addSideChat(f, 'older');
	const request = { id: 'older-request', type: 'userMessage', text: 'Original question', transient: false, requestSource: { sessionId: 'session', threadId: 'source', turnId: 'older', itemId: 'original' } };
	const revealed: string[] = [];
	let pages = 0;
	f.widget.reveal = item => { revealed.push(item.id); };
	Object.assign(f.model, {
		olderHistory: { loading: false },
		loadOlderHistory: async () => {
			pages++;
			f.model.thread.turns.unshift({ turnId: pages === 1 ? 'middle' : 'older', status: 'complete' });
			if (pages === 2) Object.assign(f.model, { items: [request] });
		},
	});

	await f.sideChats.revealSideChatSource(side);

	assert.deepEqual(f.calls.navigate, [['session', 'source']]);
	assert.equal(pages, 2);
	assert.deepEqual(revealed, [request.id]);
});

test('Side Chat return stops when source history makes no progress', async () => {
	using f = fixture();
	addSideChat(f, 'older');
	let pages = 0;
	Object.assign(f.model, {
		olderHistory: { loading: false },
		loadOlderHistory: async () => { pages++; },
	});
	f.widget.reveal = () => assert.fail('No source request was loaded');

	await f.sideChats.revealSideChatSource(LocalChatSessionUri.forSession('session', 'side'));

	assert.equal(pages, 1);
});

test('Side Chat selection accepts only text owned by its transcript, including Cowork', () => {
	using f = fixture();
	const document = f.widget.domNode.ownerDocument;
	const selection = document.getSelection()!;
	const range = document.createRange();
	range.selectNodeContents(f.widget.domNode.querySelector('p')!);
	selection.removeAllRanges(); selection.addRange(range);
	assert.deepEqual(captureSideChatSelection(f.widget), { text: 'Source selection' });
	f.widget.domNode.querySelector('p')!.parentElement!.className = 'ash-cowork-list-widget';
	assert.deepEqual(captureSideChatSelection(f.widget), { text: 'Source selection' });
	range.selectNodeContents(f.widget.domNode.querySelector('.outside')!);
	selection.removeAllRanges(); selection.addRange(range);
	assert.equal(captureSideChatSelection(f.widget), undefined);
	selection.removeAllRanges();
});

test('Side Chat provider disposal invalidates observed origins and retires the slash handler', async () => {
	using service = new ChatSideChatService();
	using commands = new ChatSlashCommandService();
	const origin = observableValue<IChatSideChatOrigin | undefined>('origin', { sourceSessionResource: URI.parse('test:source'), sourceTurnId: 'turn', sourceTitle: undefined });
	const provider: IChatSideChatProvider = { canAskInSideChat: () => true, askInSideChat: async () => { }, observeSideChatOrigin: () => origin, revealSideChatSource: async () => { } };
	const registration = service.registerProvider(provider);
	assert.throws(() => service.registerProvider(provider), /already registered/);
	const observed: boolean[] = [];
	using reaction = autorun(reader => { observed.push(!!service.observeSideChatOrigin(URI.parse('test:side')).read(reader)); });
	assert.deepEqual(observed, [true]);
	registration.dispose();
	assert.deepEqual(observed, [true, false]);
	assert.equal(service.canAskInSideChat(URI.parse('test:source')), false);
	const command = commands.registerSlashCommand({ command: 'btw', detail: 'Side question' }, async () => { });
	command.dispose();
	await assert.rejects(commands.executeCommand('btw', 'question', URI.parse('test:source')), /Unknown client/);
});

test('Chat resources preserve both opaque IDs and reject malformed external resources', () => {
	const coordinates = { sessionId: 'session/%中文', threadId: 'thread/with spaces' };
	assert.deepEqual(LocalChatSessionUri.parse(LocalChatSessionUri.forSession(coordinates.sessionId, coordinates.threadId)), coordinates);
	for (const uri of ['test:/session/thread', 'ash-chat-session:/session/thread#fragment', 'ash-chat-session:/session', 'ash-chat-session:/session/', 'ash-chat-session://authority/session/thread']) assert.equal(LocalChatSessionUri.parse(URI.parse(uri)), undefined);
});

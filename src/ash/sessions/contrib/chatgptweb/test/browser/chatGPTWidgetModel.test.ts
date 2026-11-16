import { IDocsService } from '../../../../contrib/docs/common/docsService.js';
import { chatMarkdownRichContentExtension } from '../../../../../workbench/contrib/chat/browser/widget/chatMarkdownRichContent.js';
import { Marked } from '../../../../../base/common/marked/marked.js';
import { initializeTestLocalization } from '../../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { createTestArtifactCatalogService, createTestDocsService } from '../../../../test/common/testArtifactCatalogService.js';
import { chatGPTWritingSource } from '../../browser/chatGPTRichContent.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { artifactSourceKey, type ArtifactResource } from '../../../../../platform/artifactCatalog/common/artifactCatalog.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { IArtifactCatalogService } from '../../../../services/artifactCatalog/common/artifactCatalogService.js';
import { IChatGPTService, type ChatGPTState } from '../../browser/chatGPTService.js';
import type { ChatGPTMessage } from '../../browser/chatGPTClient.js';
import { ChatGPTWidgetModel } from '../../electron-browser/chatGPTWidgetModel.js';

const initialState: ChatGPTState = {
	catalogScope: 'a'.repeat(64), localConversationId: 'local-chat', conversationId: 'provider-chat', title: 'ChatGPT', parentId: 'parent',
	linkedTasks: [], draft: '', attachments: [], voice: 'idle', voiceTranscript: [], connected: true, networkAvailable: true,
	canQueue: false, pendingSync: false, busy: false, sending: false, conversations: [], projects: [], projectHistory: new Map(),
	hasMore: false, models: [], model: '', messages: [], error: '', uncertain: false, stopped: false, managing: false,
};

const writing = (title: string, body: string): string => `:::writing{title="${title}"}\n${body}\n:::`;
const reply = (text: string, completion: ChatGPTMessage['completion'] = 'complete'): ChatGPTMessage => ({ id: 'reply', role: 'assistant', text, completion });

function fixture(options?: { registerGenerated?: boolean; }) {
	const resources = new DisposableStore();
	const changed = resources.add(new Emitter<void>());
	const state = observableValue<ChatGPTState>('ChatGPT publication test', initialState);
	const files: ArtifactResource[] = [];
	const generated: IArtifactCatalogService = {
		...createTestArtifactCatalogService(),
		onDidChange: changed.event, files, loading: false, error: undefined,
		findBySource: source => files.find(file => artifactSourceKey(file.source) === artifactSourceKey(source)),
	};
	const registerFile = (account: string, index: number, title: string): ArtifactResource => {
		const source = chatGPTWritingSource(account, initialState.conversationId!, 'reply', index);
		const file: ArtifactResource = { id: String(files.length), resource: URI.file(`/generated/${files.length}.md`), title, contentType: 'text/markdown', source, createdAt: 1 };
		files.push(file);
		changed.fire();
		return file;
	};
	const collection = new ServiceCollection(
		[IChatGPTService, { state, newDraftRevision: 0 } as unknown as IChatGPTService],
		[ISessionPrimaryProviderServices, { models: { onDidChangeModels: Event.None, listModelCatalog: async () => [], isModelVisible: () => true } } as unknown as SessionProviderServices],
		[ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService],
	);
	if (options?.registerGenerated !== false) collection.set(IArtifactCatalogService, generated);
	const services = resources.add(new InstantiationService(collection));
	try {
		const model = resources.add(services.createInstance(ChatGPTWidgetModel));
		return { resources, state, registerFile, model };
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

function frameClock() {
	mock.timers.enable({ apis: ['setTimeout'] });
	return toDisposable(() => { mock.timers.tick(16); mock.timers.reset(); });
}

suite('ChatGPT generated Markdown publication', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('production model construction requires the generated files service', () => {
		assert.throws(() => fixture({ registerGenerated: false }), /artifactCatalogService/u);
	});

	test('shows first content synchronously and projects the latest live append once per frame', () => {
		const f = fixture();
		using resources = f.resources;
		using clock = frameClock();
		let changes = 0;
		resources.add(f.model.onDidChange(() => changes++));
		f.state.set({ ...initialState, sending: true, messages: [reply('First', 'incomplete')] });
		assert.equal(f.model.items[0]?.text, 'First');
		for (let i = 1; i <= 8; i++) f.state.set({ ...f.state.get(), messages: [reply(`First${'.'.repeat(i)}`, 'incomplete')] });
		assert.equal(f.state.get().messages[0]?.text, 'First........', 'The provider model accepts every update immediately');
		assert.equal(f.model.items[0]?.text, 'First');
		assert.equal(changes, 1);
		mock.timers.tick(16);
		assert.equal(f.model.items[0]?.text, 'First........');
		assert.equal(changes, 2);
	});

	test('completion, cancellation and corrections synchronously supersede a queued append', () => {
		for (const terminal of ['complete', 'cancel', 'correct'] as const) {
			const f = fixture();
			using resources = f.resources;
			using clock = frameClock();
			f.state.set({ ...initialState, sending: true, messages: [reply('First', 'incomplete')] });
			f.state.set({ ...f.state.get(), messages: [reply('First append', 'incomplete')] });
			let changes = 0;
			resources.add(f.model.onDidChange(() => changes++));
			const text = terminal === 'correct' ? 'Corrected' : 'First append';
			f.state.set({
				...f.state.get(),
				sending: terminal === 'correct', stopped: terminal === 'cancel',
				messages: [reply(text, terminal === 'complete' ? 'complete' : 'incomplete')],
			});
			assert.equal(f.model.items[0]?.text, text);
			assert.equal(f.model.items[0]?.transient, terminal === 'correct');
			assert.equal(changes, 1);
			mock.timers.tick(16);
			assert.equal(changes, 1, 'The replaced frame cannot publish the older append');
		}
	});

	test('conversation switching retires the old frame and publishes the new conversation immediately', () => {
		const f = fixture();
		using resources = f.resources;
		using clock = frameClock();
		f.state.set({ ...initialState, sending: true, messages: [reply('First', 'incomplete')] });
		f.state.set({ ...f.state.get(), messages: [reply('First append', 'incomplete')] });
		f.state.set({ ...initialState, localConversationId: 'another-local', conversationId: 'another-provider', messages: [reply('Another conversation')] });
		assert.equal(f.model.items[0]?.text, 'Another conversation');
		mock.timers.tick(16);
		assert.equal(f.model.items[0]?.text, 'Another conversation');
	});

	test('disposal cancels a pending projection', () => {
		const f = fixture();
		using resources = f.resources;
		using clock = frameClock();
		f.state.set({ ...initialState, sending: true, messages: [reply('First', 'incomplete')] });
		f.state.set({ ...f.state.get(), messages: [reply('First append', 'incomplete')] });
		let changes = 0;
		resources.add(f.model.onDidChange(() => changes++));
		f.model.dispose();
		mock.timers.tick(16);
		assert.equal(changes, 0);
	});

	test('completion reuses the decoded body while new attachments still update immediately', () => {
		const f = fixture();
		using resources = f.resources;
		const text = '<entity value="Zed" category="software"/>';
		f.state.set({ ...initialState, sending: true, messages: [reply(text, 'incomplete')] });
		const entity = f.model.items[0]?.markdown?.richContent?.parts[0];
		assert.equal(entity?.kind, 'entity');
		const attachment = { uri: 'file-service://report', kind: 'document' as const, name: 'Report.md', mimeType: 'text/markdown' };
		f.state.set({ ...f.state.get(), sending: false, messages: [{ ...reply(text), resources: [attachment] }] });
		assert.equal(f.model.items[0]?.transient, false);
		assert.equal(f.model.items[0]?.markdown?.richContent?.parts[0], entity);
		assert.deepEqual(f.model.items[0]?.resources, [attachment]);
	});

	test('a changed citation target is decoded even when the reply text is unchanged', () => {
		const f = fixture();
		using resources = f.resources;
		const text = 'Reference \uE200cite\uE202turn0search0\uE201';
		const reference = { id: 'turn0search0', url: 'https://example.com/first', title: 'First', snippet: '', cited: true as const };
		f.state.set({ ...initialState, messages: [{ ...reply(text), references: [reference] }] });
		assert.deepEqual(f.model.items[0]?.citations, [{ type: 'web', url: reference.url, title: reference.title }]);
		const next = { ...reference, url: 'https://example.com/second', title: 'Second' };
		f.state.set({ ...f.state.get(), messages: [{ ...reply(text), references: [next] }] });
		assert.deepEqual(f.model.items[0]?.citations, [{ type: 'web', url: next.url, title: next.title }]);
	});

	test('conversation sources and resolved image groups invalidate the decoded body', () => {
		const f = fixture();
		using resources = f.resources;
		const text = '<AsyncImage query="Zed"/>';
		f.state.set({ ...initialState, messages: [reply(text)] });
		const unavailable = () => f.model.items[0]?.markdown?.richContent?.parts.find(part => part.kind === 'unavailableMedia');
		assert.equal(unavailable()?.fallback.href, 'https://chatgpt.com/c/provider-chat');
		f.state.set({ ...f.state.get(), conversationId: 'another-provider' });
		assert.equal(unavailable()?.fallback.href, 'https://chatgpt.com/c/another-provider');
		const image = { uri: 'https://images.openai.com/example.png', label: 'Zed' };
		f.state.set({ ...f.state.get(), messages: [{ ...reply(text), imageGroups: [{ query: 'Zed', images: [image] }] }] });
		const gallery = f.model.items[0]?.markdown?.richContent?.parts.find(part => part.kind === 'imageGallery');
		assert.deepEqual(gallery?.images, [image]);
	});

	test('a managed writing block exposes its editor only after its exact file has been published', () => {
		const f = fixture();
		using resources = f.resources;
		const text = `${writing('First', '# First')}\n\n${writing('Second', '# Second')}`;
		f.state.set({ ...initialState, sending: true, messages: [reply(text, 'incomplete')] });
		const parts = () => f.model.items[0]?.markdown?.richContent?.parts.filter(part => part.kind === 'writing');
		assert.deepEqual(parts()?.map(part => part.awaitingPublication), [true, true]);
		const render = () => {
			const item = f.model.items[0]!;
			return new Marked(chatMarkdownRichContentExtension(item.markdown!.richContent!)).parse(item.text, { async: false });
		};
		assert.doesNotMatch(render(), /chat-response-writing:/u);
		f.state.set({ ...initialState, messages: [reply(text)] });
		const first = f.registerFile(initialState.catalogScope!, 0, 'First');
		assert.deepEqual(f.model.items[0]?.files, [{ resource: first.resource.toString(), label: 'First' }]);
		assert.deepEqual(parts()?.map(part => [part.resource, part.awaitingPublication]), [[first.resource.toString(), undefined], [undefined, true]]);

		const secondAccount = 'b'.repeat(64);
		f.state.set({ ...f.state.get(), catalogScope: secondAccount });
		assert.equal(f.model.items[0]?.files, undefined);
		assert.deepEqual(parts()?.map(part => part.awaitingPublication), [true, true]);
		const second = f.registerFile(secondAccount, 0, 'Second account');
		assert.deepEqual(f.model.items[0]?.files, [{ resource: second.resource.toString(), label: 'Second account' }]);
		assert.match(render(), />Edit in Docs</u);
		f.state.set({ ...initialState, catalogScope: 'c'.repeat(64), messages: [{ ...reply(text), completion: undefined }] });
		assert.match(render(), />Edit a copy in Docs</u);
		assert.doesNotMatch(render(), />Edit in Docs</u);
		initializeTestLocalization('zh-CN');
		try {
			assert.match(render(), />在 Docs 中编辑副本</u);
		} finally {
			initializeTestLocalization('en');
		}
	});
});

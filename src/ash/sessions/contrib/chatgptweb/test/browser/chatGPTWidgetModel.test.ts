import { chatMarkdownRichContentExtension } from '../../../../../workbench/contrib/chat/browser/widget/chatMarkdownRichContent.js';
import { Marked } from '../../../../../base/common/marked/marked.js';
import { initializeTestLocalization } from '../../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { createTestGeneratedFilesService } from '../../../../test/common/testGeneratedFilesService.js';
import { chatGPTWritingSource } from '../../browser/chatGPTRichContent.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { generatedFileSourceKey, type GeneratedFile } from '../../../../../platform/generatedFiles/common/generatedFiles.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { IGeneratedFilesService } from '../../../../services/generatedFiles/common/generatedFilesService.js';
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
	const files: GeneratedFile[] = [];
	const generated: IGeneratedFilesService = {
		...createTestGeneratedFilesService(),
		onDidChange: changed.event, files, loading: false, error: undefined,
		findBySource: source => files.find(file => generatedFileSourceKey(file.source) === generatedFileSourceKey(source)),
	};
	const registerFile = (account: string, index: number, title: string): GeneratedFile => {
		const source = chatGPTWritingSource(account, initialState.conversationId!, 'reply', index);
		const file: GeneratedFile = { id: String(files.length), resource: URI.file(`/generated/${files.length}.md`), title, contentType: 'text/markdown', source, createdAt: 1 };
		files.push(file);
		changed.fire();
		return file;
	};
	const collection = new ServiceCollection(
		[IChatGPTService, { state, newDraftRevision: 0 } as unknown as IChatGPTService],
		[ISessionPrimaryProviderServices, { models: { onDidChangeModels: Event.None, listModelCatalog: async () => [], isModelVisible: () => true } } as unknown as SessionProviderServices],
		[ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService],
	);
	if (options?.registerGenerated !== false) collection.set(IGeneratedFilesService, generated);
	const services = resources.add(new InstantiationService(collection));
	try {
		const model = resources.add(services.createInstance(ChatGPTWidgetModel));
		return { resources, state, registerFile, model };
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

suite('ChatGPT generated Markdown publication', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('production model construction requires the generated files service', () => {
		assert.throws(() => fixture({ registerGenerated: false }), /generatedFilesService/u);
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

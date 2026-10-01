import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../workbench/services/dialogs/common/dialogService.js';
import { FileDialogService } from '../../../workbench/services/dialogs/browser/fileDialogService.js';
import type { IWebWorkspaceClient } from '../../../workbench/services/workspaces/browser/workspaceOpenService.js';
import { registerTestDictationOnboarding } from '../../../workbench/test/common/testDictationServices.js';
import { IDictationService } from '../../../platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { observableValue } from '../../../base/common/observable.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event } from "../../../base/common/event.js";
import { DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import type { ICommandEvent, ICommandService } from "../../../platform/commands/common/commands.js";
import { IContextMenuService, IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import type { IChatService, ThreadUpdateEnvelope } from "../../../workbench/services/chat/common/chatService.js";
import { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { IUntitledChatSession } from "../../services/sessions/common/session.js";
import { SessionsService } from "../../../sessions/services/sessions/browser/sessionsService.js";
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { ChatTipService, IChatTipService } from '../../../workbench/contrib/chat/browser/chatTipService.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from '../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { migrateNewChatDraftState, readNewChatDraftState, writeNewChatDraftState } from '../../contrib/chat/common/newChatDraftState.js';
import type { SessionsPartOptions } from '../../browser/parts/sessionsPart.js';
import { builtinLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, setNlsResolver, resetNlsResolver } from '../../../nls.js';
import { ChatAttachmentModel } from '../../../workbench/contrib/chat/browser/attachments/chatAttachmentModel.js';
import { NewChatContextAttachments } from '../../contrib/chat/browser/newChatContextAttachments.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>", { url: 'http://localhost/' });
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	FileReader: browserEnvironment.window.FileReader,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
const { SessionsPart } = await import("../../../sessions/browser/parts/sessionsPart.js");
await import('../../contrib/design/browser/design.contribution.js');
const { NewChatInputWidget } = await import('../../contrib/chat/browser/newChatInput.js');
const { createCodeEditorServices } = await import('../../../editor/test/browser/testCodeEditor.js');

suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "MouseEvent", "FileReader", "navigator"]) Reflect.deleteProperty(globalThis, name);
});

test("SessionsPart remains owned by the Sessions product layer", async () => {
	const dom = browserEnvironment;
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	dom.window.document.body.replaceChildren();
	const onDidChange = new Emitter<void>();
	let untitledSessions: readonly IUntitledChatSession[] = [];
	let nextUntitledSessionId = 0;
	let activeUntitledSessionId: string | undefined;
	const sessionService: ISessionsManagementService = {
		onDidChange: onDidChange.event,
		materializedSessions: observableValue("materialized drafts", new Map()),
		sessions: [],
		active: undefined,
		get untitledSessions() { return untitledSessions; },
		get activeUntitledSession() { return untitledSessions.find(session => session.untitledSessionId === activeUntitledSessionId); },
		state: "ready",
		error: undefined,
		async initialize() {},
		async listAgents() { return []; },
		async openThread() {},
		selectThread() {},
		async interruptThread() {},
		createUntitledSession() {
			const untitledSession = { untitledSessionId: `untitled-${++nextUntitledSessionId}`, title: "New code session", model: undefined, agent: undefined, workspace: { type: 'current' as const } };
			untitledSessions = [...untitledSessions, untitledSession];
			activeUntitledSessionId = untitledSession.untitledSessionId;
			onDidChange.fire();
			return untitledSession;
		},
		restoreUntitledSession(session) {
			untitledSessions = [session, ...untitledSessions];
			onDidChange.fire();
		},
		selectUntitledSession(untitledSessionId) {
			activeUntitledSessionId = untitledSessionId;
			onDidChange.fire();
		},
		discardUntitledSession(untitledSessionId) {
			untitledSessions = untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
			if (activeUntitledSessionId === untitledSessionId) activeUntitledSessionId = untitledSessions[0]?.untitledSessionId;
			onDidChange.fire();
		},
		setUntitledSessionModel() {},
		setUntitledSessionDefaultModel() {},
		setUntitledSessionAgent() {},
		async materializeUntitledSession() {
			throw new Error("Session creation is unavailable");
		},
		promoteUntitledSession() {},
		async ensureActiveThread() {
			throw new Error("No active thread");
		},
		async startNewSession() {
			throw new Error("Session creation is unavailable");
		},
		async stopSession() {
			throw new Error("Session stopping is unavailable");
		},
		async setModel() {
			throw new Error("Model selection is unavailable");
		},
		async archiveSession() {
			throw new Error("Session archiving is unavailable");
		},
	};
	const threadUpdates = new Emitter<ThreadUpdateEnvelope>();
	const transcriptUpdates = new Emitter<import("../../../workbench/services/chat/common/chatService.js").ThreadTranscriptUpdateEnvelope>();
	const ready = new Emitter<void>();
	const chatService: IChatService = {
		configureAdvisor: async () => {},
		consultAdvisor: async () => {},
		readAdvisorDefault: async () => null,
		saveAdvisorDefault: async () => {},
		onDidUpdateThread: threadUpdates.event,
		onDidUpdateThreadTranscript: transcriptUpdates.event,
		onDidUpdateGoal: () => toDisposable(() => {}),
		onDidBecomeReady: ready.event,
		onDidChangeModels: ready.event,
		onDidChangeQueue: ready.event,
		onDidChangeSkills: ready.event,
		onDidUpdateTurnChanges: () => toDisposable(() => {}),
		async listModels() { return []; },
		getDefaultNewChatModel() { return undefined; },
		rememberSelectedModel() {},
		async listModelCatalog() { return []; },
		async listModelProviders() { return []; },
		async setModelProviderApiKey() {},
		async removeModelProviderApiKey() {},
		async listAdvisorModels() { return []; },
		async refreshModels() { return []; },
		isModelVisible() { return true; },
		async setModelVisible() {},
		async listSlashCommands() { return []; },
		async listSkillSelectors() { return []; },
		async readThread() { throw new Error("No active Thread"); },
		async subscribeThread() { throw new Error("No active Thread"); },
		async unsubscribeThread() {},
		async startTurn() {},
		async queueTurn() {},
		async queuedMessageCount() { return 0; },
		async compactContext() {},
		async steerTurn() {},
		async interruptTurn() {},
		async resolveInteraction() {},
		async listTurnChanges() { return []; },
		async readTurnChange() { throw new Error("No ChangeSet"); },
		async readTurnChangeFile() { throw new Error("No ChangeSet file"); },
		async generateTurnChangeMessage() { return []; },
		async updateTurnChangeDraft() { return []; },
		async commitTurnChange() { return []; },
		async discardThreadChanges() { return []; },
	};
	const contextMenuEvents = new Emitter<void>();
	const contextMenuService: IContextMenuService = {
		onDidShowContextMenu: contextMenuEvents.event,
		onDidHideContextMenu: contextMenuEvents.event,
		showContextMenu() {},
		hideContextMenu() {},
	};
	const contextViewService: IContextViewService = {
		container: dom.window.document.body,
		show() { return false; },
		hide() {},
		layout() {},
	};
	const commandEvents = new Emitter<ICommandEvent>();
	const commandService: ICommandService = {
		onWillExecuteCommand: commandEvents.event,
		onDidExecuteCommand: commandEvents.event,
		async executeCommand() { throw new Error("No commands registered"); },
	};
	using resources = new DisposableStore();
	const services = resources.add(createCodeEditorServices(resources).createChild());
	services.registerInstance(IDictationService, undefined);
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	using notifications = new NotificationService();
	services.registerInstance(IContextMenuService, contextMenuService);
	services.registerInstance(IContextViewService, contextViewService);
	const dialogs = resources.add(new DialogService());
	services.registerInstance(IDialogService, dialogs);
	const unexpectedFileOperation = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
	services.registerInstance(IFileService, { onDidChangeFiles: Event.None, stat: unexpectedFileOperation, readDirectory: unexpectedFileOperation, readFile: unexpectedFileOperation, readFileBytes: unexpectedFileOperation, writeFile: unexpectedFileOperation, writeFileBytes: unexpectedFileOperation, createFile: unexpectedFileOperation, createDirectory: unexpectedFileOperation, copy: unexpectedFileOperation, rename: unexpectedFileOperation, delete: unexpectedFileOperation });
	services.registerInstance(IWorkspaceContextService, resources.add(new WorkspaceContextService({ id: 'sessions-test', folders: [] })));

	services.registerInstance(IFileDialogService, new FileDialogService({ kind: 'server', client: {} as IWebWorkspaceClient, quickInput: () => { throw new Error('Unexpected picker'); }, fileService: () => { throw new Error('Unexpected files'); }, workspaceRoot: () => undefined }, () => dialogs));
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(INotificationService, notifications);
	const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, applicationId: 'test', workspaceId: 'test', flushInterval: 0 }));
	services.registerInstance(IStorageService, storage);
	registerTestDictationOnboarding(services);
	services.registerInstance(ISessionsManagementService, sessionService);
	const viewService = services.createInstance(SessionsService);
	viewService.openNewSession("New code session");
	viewService.openNewSession("New code session");
	services.registerInstance(IChatTipService, resources.add(services.createInstance(ChatTipService)));
	Object.defineProperty(dom.window.performance, 'getEntriesByType', { value: () => [] });
	services.registerInstance(ILifecycleService, resources.add(services.createInstance(BrowserLifecycleService, { ownerWindow: dom.window as unknown as Window, onError: (error: unknown) => { throw error; } })));
	const inputs: InstanceType<typeof NewChatInputWidget>[] = [];
	const part = services.createInstance(SessionsPart, dom.window.document.body, {
		sessionService,
		chatService,
		contextMenuService,
		contextViewService,
		accessibleViewService: { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService,
		notifications,
		commandService,
		createInputPart: (container, delegate, model, page) => {
			const input = services.createInstance(NewChatInputWidget, container, delegate, model, undefined, page);
			inputs.push(input);
			return input;
		},
		activateSelection: (selection, page) => viewService.activateSelection(selection, page),
		closeSelection: (selection, page) => viewService.closeVisibleSelection(selection, page),
		createNewSession: page => { viewService.openNewSession(undefined, page); },
	} satisfies SessionsPartOptions);
	const updatePart = (): void => {
		for (const page of ['chat', 'code'] as const) {
			const selection = viewService.getPageSelection(page);
			part.updateVisibleSelections(selection.visibleSelections, selection.activeSelection, page);
		}
	};
	const partListener = viewService.onDidChange(updatePart);
	updatePart();

	assert.equal(part.domNode.dataset.part, "sessions");
	assert.equal(part.domNode.querySelector(".ash-sessions-surface-header"), null);
	assert.ok(part.domNode.querySelector(".ash-sessions-chat-view"));
	assert.equal(part.domNode.querySelectorAll(".ash-sessions-chat-slot").length, 2);
	assert.equal(part.domNode.querySelectorAll(".ash-chat-input-part").length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-input .ash-chat-input-editor').length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-welcome-heading:not([hidden])').length, 2);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-tip').length, 2);
	const firstTip = part.domNode.querySelector('.ash-chat-input-tip');
	assert.ok(firstTip);
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		assert.match(part.domNode.querySelector('.ash-chat-input-tip')?.textContent ?? '', /用 \+ 按钮添加文本文件或图片/u);
		assert.equal(part.domNode.querySelector('[data-action-id="ash.chat.input.attach"] button')?.getAttribute('aria-label'), '添加附件');
		assert.equal(part.domNode.querySelector('.ash-sessions-chat-input-footer button')?.getAttribute('aria-label'), '权限：请求权限');
	} finally {
		resetNlsResolver();
	}
	const translatedTip = part.domNode.querySelector('.ash-chat-input-tip');
	viewService.activateSelection(viewService.activeSelection!);
	assert.equal(part.domNode.querySelector('.ash-chat-input-tip'), translatedTip);
	translatedTip!.querySelector<HTMLButtonElement>('button')!.click();
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-tip').length, 0);
	assert.equal(services.get(IChatTipService).getWelcomeTip(), undefined);

	(part.domNode.querySelector(".ash-sessions-chat-slot-title") as HTMLButtonElement).click();
	assert.ok(part.domNode.querySelector(".ash-sessions-chat-slot.active:first-of-type"));

	(part.domNode.querySelector(".ash-sessions-chat-slot-close") as HTMLButtonElement).click();
	assert.equal(part.domNode.querySelectorAll(".ash-sessions-chat-slot").length, 1);
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-view.single-chat'));
	const retainedInput = part.domNode.querySelector('.ash-chat-input-part');
	const draft = { mode: 'plan' as const, text: 'Keep this Chat draft', contexts: [{ id: 'chat-file', kind: 'file', name: 'chat.txt', content: 'Chat context' }] };
	part.restoreDraft(draft);
	viewService.selectPage('code');
	if (!viewService.activeSelection) viewService.openNewSession('New code session');
	part.setPage('code');
	const codeInput = part.domNode.querySelector('.code-composer');
	assert.notEqual(codeInput, retainedInput);
	assert.equal(part.domNode.querySelector('.ash-sessions-code-page')?.getAttribute('aria-label'), 'Code');
	assert.equal(part.domNode.querySelector('.ash-sessions-code-page .ash-sessions-chat-view')?.hasAttribute('hidden'), false);
	assert.equal(retainedInput?.closest('.ash-sessions-chat-view')?.hasAttribute('hidden'), true);
	assert.equal(inputs.length, 3);
	assert.equal(await inputs[2]!.captureDraft(), undefined);
	const separateDraft = { mode: 'plan' as const, text: 'Keep this Code draft', contexts: [{ id: 'code-file', kind: 'file', name: 'code.ts', content: 'Code context' }] };
	part.restoreDraft(separateDraft);
	const codeDraft = await inputs[2]!.captureDraft();
	assert.ok(codeDraft);
	assert.deepEqual(codeDraft.draft, separateDraft);
	const chatSelection = viewService.getPageSelection('chat').activeSelection;
	const codeSelection = viewService.activeSelection;
	assert.ok(chatSelection?.kind === 'untitled' && codeSelection?.kind === 'untitled');
	assert.deepEqual(readNewChatDraftState(storage, 'chat', `untitled:${chatSelection.session.untitledSessionId}`), draft);
	assert.deepEqual(readNewChatDraftState(storage, 'code', `untitled:${codeSelection.session.untitledSessionId}`), separateDraft);
	viewService.openNewSession('Another Code draft');
	assert.equal(part.domNode.querySelectorAll('.code-composer').length, 2);
	part.setPage('empty');
	assert.equal(part.domNode.querySelector('.ash-sessions-chat-view')?.hasAttribute('hidden'), true);
	viewService.selectPage('chat');
	part.setPage('chat');
	assert.equal(part.domNode.querySelector('.ash-sessions-chat-view .ash-chat-input-part'), retainedInput);
	assert.equal(part.domNode.querySelectorAll('.chat-composer').length, 1);
	assert.equal(part.domNode.querySelectorAll('.code-composer:not([hidden])').length, 0);
	const chatDraft = await inputs[1]!.captureDraft();
	assert.ok(chatDraft);
	assert.deepEqual(chatDraft.draft, draft);
	part.setPage('code');
	assert.equal(part.domNode.querySelector('.code-composer'), codeInput);
	assert.deepEqual((await inputs[2]!.captureDraft())?.draft, separateDraft);

	part.setPage('empty');
	assert.equal(part.domNode.querySelector('[data-sessions-page="design"]'), null);
	assert.equal(part.domNode.querySelector('.ash-sessions-design-view'), null);
	assert.equal(part.domNode.querySelector('.ash-sessions-chat-view')?.hasAttribute('hidden'), true);
	part.setPage('chat');
	assert.equal(part.domNode.querySelector('.ash-sessions-chat-view')?.hasAttribute('hidden'), false);

	partListener.dispose();
	part.dispose();
	viewService.dispose();
	contextMenuEvents.dispose();
	commandEvents.dispose();
	threadUpdates.dispose();
	ready.dispose();
	onDidChange.dispose();
});

test('Sessions draft state restores text and images while isolating Threads and workspaces', async () => {
	const ownerWindow = browserEnvironment.window as unknown as Window;
	using storage = new BrowserStorageService({ ownerWindow, applicationId: 'draft-test', workspaceId: 'workspace-a', flushInterval: 0 });
	const draft = { mode: 'debug' as const, text: 'Review this', contexts: [{ id: 'image', kind: 'image', name: 'image.png', content: 'data:image/png;base64,aGVsbG8=' }] };
	writeNewChatDraftState(storage, 'chat', draft, 'untitled:first');
	writeNewChatDraftState(storage, 'chat', { mode: 'plan', text: 'Thread draft', contexts: [] }, 'thread-1');
	writeNewChatDraftState(storage, 'code', { mode: 'agent', text: 'Code draft', contexts: [] }, 'untitled:first');
	writeNewChatDraftState(storage, 'code', { mode: 'agent', text: 'Code Thread draft', contexts: [] }, 'thread-1');
	await storage.flush();
	using restored = new BrowserStorageService({ ownerWindow, applicationId: 'draft-test', workspaceId: 'workspace-a', flushInterval: 0 });
	assert.deepEqual(readNewChatDraftState(restored, 'chat', 'untitled:first'), draft);
	assert.deepEqual(readNewChatDraftState(restored, 'chat', 'thread-1'), { mode: 'plan', text: 'Thread draft', contexts: [] });
	assert.equal(readNewChatDraftState(restored, 'chat', 'thread-2'), undefined);
	assert.equal(readNewChatDraftState(restored, 'code', 'untitled:first')?.text, 'Code draft');
	assert.equal(readNewChatDraftState(restored, 'code', 'thread-1')?.text, 'Code Thread draft');
	restored.switchWorkspace('workspace-b');
	assert.equal(readNewChatDraftState(restored, 'chat', 'untitled:first'), undefined);
	assert.equal(readNewChatDraftState(restored, 'code', 'untitled:first'), undefined);
	restored.switchWorkspace('workspace-a');
	writeNewChatDraftState(restored, 'chat', undefined, 'untitled:first');
	assert.equal(readNewChatDraftState(restored, 'chat', 'untitled:first'), undefined);
	assert.equal(readNewChatDraftState(restored, 'chat', 'thread-1')?.text, 'Thread draft');
	assert.equal(readNewChatDraftState(restored, 'code', 'untitled:first')?.text, 'Code draft');
});

test('untitled draft migration moves the page draft once and isolates subsequent pane identities', async () => {
	const ownerWindow = browserEnvironment.window as unknown as Window;
	using storage = new BrowserStorageService({ ownerWindow, applicationId: 'draft-migration-test', workspaceId: 'sessions', flushInterval: 0 });
	const legacy = { mode: 'agent' as const, text: 'Old page draft', contexts: [] };
	storage.store('sessions.draftState', JSON.stringify(legacy), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	migrateNewChatDraftState(storage, 'chat', 'first');
	migrateNewChatDraftState(storage, 'chat', 'second');
	writeNewChatDraftState(storage, 'chat', { ...legacy, text: 'Second pane draft' }, 'untitled:second');
	await storage.flush();
	using restored = new BrowserStorageService({ ownerWindow, applicationId: 'draft-migration-test', workspaceId: 'sessions', flushInterval: 0 });
	assert.deepEqual({ legacy: restored.get('sessions.draftState', StorageScope.WORKSPACE), first: readNewChatDraftState(restored, 'chat', 'untitled:first'), second: readNewChatDraftState(restored, 'chat', 'untitled:second') }, {
		legacy: undefined, first: legacy, second: { ...legacy, text: 'Second pane draft' },
	});
	const conflict = JSON.stringify({ ...legacy, text: 'Conflicting legacy draft' });
	restored.store('sessions.draftState', conflict, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.throws(() => migrateNewChatDraftState(restored, 'chat', 'first'), /Conflicting/);
	assert.equal(restored.get('sessions.draftState', StorageScope.WORKSPACE), conflict);
});

test('Sessions file acquisition preserves valid UTF-8 and rejects binary content without adding it', async () => {
	using model = new ChatAttachmentModel();
	using notifications = new NotificationService();
	using attachments = new NewChatContextAttachments(document.body, model, notifications);
	await attachments.attachFiles([new browserEnvironment.window.File(['A literal \uFFFD character'], 'context.txt', { type: 'text/plain' })]);
	assert.deepEqual(await model.attachments[0]!.resolve(), { name: 'context.txt', content: 'A literal \uFFFD character' });
	await attachments.attachFiles([new browserEnvironment.window.File([new Uint8Array([0xFF, 0x00])], 'binary.dat')]);
	assert.equal(model.size, 1);
	assert.match(notifications.getNotifications()[0]?.message ?? '', /binary.dat must be a UTF-8 text file/u);
});

test('Closing Sessions file acquisition cancels its readers and does not mutate attachments', async () => {
	using model = new ChatAttachmentModel();
	using notifications = new NotificationService();
	using attachments = new NewChatContextAttachments(document.body, model, notifications);
	const pending = attachments.attachFiles([new browserEnvironment.window.File(['Pending read'], 'context.txt', { type: 'text/plain' })]);
	attachments.dispose();
	await pending;
	assert.equal(model.size, 0);
	assert.deepEqual(notifications.getNotifications(), []);
});

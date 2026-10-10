import { IExecutionSettingsService } from '../../../platform/execution/common/executionSettingsService.js';
import { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IAppServerSkillApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../workbench/test/common/testEditorService.js';
import { createTestFileService, registerTestComponentServices, createTestEditorServices } from '../../../workbench/test/common/testEditorServices.js';
import { IGitHubService as ISessionsGitHubService } from '../../contrib/github/browser/githubService.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import { IFileService, FileSystemProviderCapabilities } from '../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../workbench/services/dialogs/common/dialogService.js';
import { FileDialogService } from '../../../workbench/services/dialogs/browser/fileDialogService.js';
import { BrowserPathService } from '../../../workbench/services/path/browser/pathService.js';
import { IPathService } from '../../../platform/path/common/pathService.js';
import { IRendererHostService } from '../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../platform/agentHost/browser/rendererApi.js';
import type { IWebWorkspaceClient } from '../../../workbench/services/workspaces/browser/workspaceOpenService.js';
import { registerTestDictationOnboarding } from '../../../workbench/test/common/testDictationServices.js';
import { IDictationService } from '../../../platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { observableValue } from '../../../base/common/observable.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event } from "../../../base/common/event.js";
import { DisposableStore, toDisposable, Disposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { ICommandEvent, ICommandService } from "../../../platform/commands/common/commands.js";
import { IContextMenuService, IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import { IChatService, type ThreadUpdateEnvelope } from "../../../workbench/services/chat/common/chatService.js";
import { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { IUntitledChatSession } from "../../services/sessions/common/session.js";
import { SessionsService } from "../../../sessions/services/sessions/browser/sessionsService.js";
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { ChatTipService, IChatTipService } from '../../../workbench/contrib/chat/browser/chatTipService.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from '../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { migrateNewChatDraftState, readNewChatDraftState, writeNewChatDraftState } from '../../contrib/chat/common/newChatDraftState.js';
import type { SessionsPartOptions } from '../../browser/parts/sessions/sessionsPart.js';
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
const { SessionsPart } = await import("../../browser/parts/sessions/sessionsPart.js");
await import('../../contrib/creator/browser/creatorEditor.contribution.js');
const { NewChatInputWidget } = await import('../../contrib/chat/browser/newChatInput.js');
const { CoworkPaneFactory } = await import('../../contrib/cowork/browser/cowork.contribution.js');
const { ChatTipService: CoworkTipService, IChatTipService: ICoworkTipService } = await import('../../contrib/cowork/browser/chatTipService.js');
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
		async initialize() { },
		async listAgents() { return []; },
		async openThread() { },
		selectThread() { },
		async interruptThread() { },
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
		setUntitledSessionModel() { },
		setUntitledSessionDefaultModel() { },
		setUntitledSessionAgent() { },
		async materializeUntitledSession() {
			throw new Error("Session creation is unavailable");
		},
		promoteUntitledSession() { },
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
	const chatService: IChatService & ILanguageModelsService = {
		configureAdvisor: async () => { },
		consultAdvisor: async () => { },
		readAdvisorDefault: async () => null,
		saveAdvisorDefault: async () => { },
		onDidChangeSession: Event.None,
		onDidUpdateThread: threadUpdates.event,
		onDidUpdateThreadTranscript: transcriptUpdates.event,
		onDidUpdateGoal: () => toDisposable(() => { }),
		onDidBecomeReady: ready.event,
		onDidChangeModels: ready.event,
		onDidChangeQueue: ready.event,
		onDidUpdateTurnChanges: () => toDisposable(() => { }),
		discoverProviderModels: async () => [],
		async listModels() { return []; },
		getDefaultNewChatModel() { return undefined; },
		rememberSelectedModel() { },
		async listModelCatalog() { return []; },
		async listModelProviders() { return []; },
		setModelPreferences: async () => { },
		readApprovalReviewModel: async () => ({ type: 'automatic' }),
		setApprovalReviewModel: async () => { },
		listCustomModelProviders: async () => [],
		saveCustomModelProvider: async () => { },
		testProviderModel: async () => ({ type: 'passed' }),
		async setModelProviderApiKey() { },
		async removeModelProviderApiKey() { },
		async listAdvisorModels() { return []; },
		async refreshModels() { return []; },
		isModelVisible() { return true; },
		async setModelVisible() { },
		async listSlashCommands() { return []; },
		async readThread() { throw new Error("No active Thread"); },
		async subscribeThread() { throw new Error("No active Thread"); },
		async unsubscribeThread() { },
		async startTurn() { },
		async queueTurn() { },
		async queuedMessageCount() { return 0; },
		async compactContext() { },
		async steerTurn() { },
		async interruptTurn() { },
		async resolveInteraction() { },
		async listTurnChanges() { return []; },
		async readTurnChange() { throw new Error("No ChangeSet"); },
		async readTurnChangeFile() { throw new Error("No ChangeSet file"); },
		async generateTurnChangeMessage() { return []; },
		async updateTurnChangeDraft() { return []; },
		async prepareTurnCommit() { throw new Error('No selected changes'); },
		async readTurnCommit() { throw new Error('No selected changes'); },
		async readTurnCommitFile() { throw new Error('No selected changes'); },
		async commitTurnChange() { return []; },
		async discardThreadChanges() { return []; },
	};
	const contextMenuEvents = new Emitter<void>();
	const contextMenuService: IContextMenuService = {
		onDidShowContextMenu: contextMenuEvents.event,
		onDidHideContextMenu: contextMenuEvents.event,
		showContextMenu() { },
		hideContextMenu() { },
	};
	const contextViewService: IContextViewService = {
		container: dom.window.document.body,
		show() { return false; },
		hide() { },
		layout() { },
	};
	const commandEvents = new Emitter<ICommandEvent>();
	const commandService: ICommandService = {
		onWillExecuteCommand: commandEvents.event,
		onDidExecuteCommand: commandEvents.event,
		async executeCommand() { throw new Error("No commands registered"); },
	};
	using resources = new DisposableStore();
	const services = resources.add(createCodeEditorServices(resources).createChild());
	services.registerInstance(IRendererHostService, createDisconnectedRendererApi());
	services.registerSingleton(IPathService, () => services.createInstance(BrowserPathService));
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(ISessionsGitHubService, {
		onDidChange: Event.None,
		getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { },
		initialize() { },
		attachPullRequest: async () => { throw new Error('Unexpected PR attachment'); },
		detachPullRequest: async () => { throw new Error('Unexpected PR removal'); },
	});
	services.registerInstance(ILanguageModelsService, chatService);
	services.registerInstance(IExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IChatService, chatService);
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { assert.fail('Unexpected editor navigation'); }, focusActiveEditor: () => { } });
	services.registerInstance(IAppServerSkillApi, { onDidChangeSkills: ready.event, readInstructions: async () => { throw new Error("No Skill body in this test fixture"); }, list: async () => ({ generation: 0, skills: [] }), read: async () => ({ revision: 0, catalog: { generation: 0, skills: [] }, diagnostics: [] }), setEnabled: async () => { } });
	services.registerInstance(IChatSessionNavigationService, { openConversation: async () => { throw new Error('Unexpected conversation navigation'); } } as unknown as IChatSessionNavigationService);
	services.registerInstance(IDictationService, undefined);
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	using notifications = new NotificationService();
	services.registerInstance(IContextMenuService, contextMenuService);
	services.registerInstance(IContextViewService, contextViewService);
	const dialogs = resources.add(new DialogService());
	services.registerInstance(IDialogService, dialogs);
	const unexpectedFileOperation = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
	services.registerSingleton(IFileService, () => createTestFileService({
		capabilities: FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy,
		onDidChangeCapabilities: Event.None,
		watch: (): IDisposable => Disposable.None,
		onDidChangeFiles: Event.None, stat: unexpectedFileOperation, readDirectory: unexpectedFileOperation, readFile: unexpectedFileOperation, writeFile: unexpectedFileOperation, createFile: unexpectedFileOperation, createDirectory: unexpectedFileOperation, copy: unexpectedFileOperation, rename: unexpectedFileOperation, delete: unexpectedFileOperation
	}));
	services.registerInstance(IUriIdentityService, resources.add(services.createInstance(UriIdentityService)));
	services.registerInstance(IWorkspaceContextService, resources.add(new WorkspaceContextService({ id: 'sessions-test', folders: [] })));

	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(INotificationService, notifications);
	const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', flushInterval: 0 }));
	services.registerInstance(IStorageService, storage);
	registerTestDictationOnboarding(services);
	services.registerInstance(ISessionsManagementService, sessionService);
	const initialDrafts = ['saved-first', 'saved-second'].map(untitledSessionId => ({ untitledSessionId, title: 'New code session', workspace: { type: 'current' } }));
	storage.store('sessions.viewState', JSON.stringify({
		version: 1, pages: {
			chat: { visible: initialDrafts.map(session => ({ kind: 'untitled', session })), active: 1 },
			code: { visible: [], active: -1 },
		}
	}), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const viewService = services.createInstance(SessionsService);
	await viewService.initialize();
	services.registerInstance(IChatTipService, resources.add(services.createInstance(ChatTipService)));
	services.registerInstance(ICoworkTipService, resources.add(services.createInstance(CoworkTipService)));
	Object.defineProperty(dom.window.performance, 'getEntriesByType', { value: () => [] });
	services.registerInstance(ILifecycleService, resources.add(services.createInstance(BrowserLifecycleService, { ownerWindow: dom.window as unknown as Window, onError: (error: unknown) => { throw error; } })));
	const inputs: InstanceType<typeof NewChatInputWidget>[] = [];
	using editorServices = createTestEditorServices(undefined, services, dom.window.document);
	services.registerInstance(IFileDialogService, editorServices.createInstance(FileDialogService, { kind: 'server', client: {} as IWebWorkspaceClient, quickInput: () => { throw new Error('Unexpected picker'); }, fileService: () => { throw new Error('Unexpected files'); }, workspaceRoot: () => undefined }, () => dialogs));
	const paneServices = registerTestComponentServices(editorServices);
	paneServices.registerInstance(IEditorService, {
		...emptyEditorServiceState,
		onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [],
		openEditor: async () => { throw new Error('Unexpected editor navigation'); }, focusActiveEditor: () => { },
	});
	const cowork = resources.add(paneServices.createInstance(CoworkPaneFactory));
	const part = paneServices.createInstance(SessionsPart, dom.window.document.body, {
		sessionService,
		chatService,
		contextMenuService,
		contextViewService,
		accessibleViewService: { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService,
		notifications,
		commandService,
		createInputPart: (container, delegate, model) => {
			const input = paneServices.createInstance(NewChatInputWidget, container, delegate, model);
			inputs.push(input);
			return input;
		},
		createCoworkPane: (container, panelId, selection) => cowork.createPane(container, panelId, selection, () => { viewService.openNewSession(); }),
		activateSelection: selection => viewService.activateSelection(selection),
		closeSelection: selection => viewService.closeVisibleSelection(selection),
		createNewSession: () => { viewService.openNewSession(); },
	} satisfies SessionsPartOptions);
	const updatePart = (): void => {
		const selection = viewService.getSelection();
		part.updateVisibleSelections(selection.visibleSelections, selection.activeSelection);
	};
	const partListener = viewService.onDidChange(updatePart);
	updatePart();

	await part.captureActiveDraft();
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
	assert.match(firstTip.textContent ?? '', /Attach text files or images with the \+ button/u);
	const retainedTip = part.domNode.querySelector('.ash-chat-input-tip');
	viewService.activateSelection(viewService.activeSelection!);
	assert.equal(part.domNode.querySelector('.ash-chat-input-tip'), retainedTip);
	retainedTip!.querySelector<HTMLButtonElement>('button')!.click();
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-tip').length, 0);
	assert.equal(services.get(IChatTipService).getWelcomeTip(), undefined);

	(part.domNode.querySelector("[role=tab]") as HTMLElement).click();
	assert.ok(part.domNode.querySelector(".ash-editor-group:first-of-type .ash-sessions-chat-slot.active"));

	(part.domNode.querySelector(".ash-tab-close-action button") as HTMLButtonElement).click();
	await part.captureActiveDraft();
	assert.equal(part.domNode.querySelectorAll(".ash-sessions-chat-slot").length, 1);
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-view.single-chat'));
	const retainedInput = part.domNode.querySelector('.ash-chat-input-part');
	const draft = { mode: 'plan' as const, text: 'Keep this Chat draft', contexts: [{ id: 'chat-file', kind: 'file', name: 'chat.txt', content: 'Chat context' }, { id: 'tool-selection', kind: 'toolSelection', name: 'Tool selection: 1 disabled', content: '["read_file"]' }] };
	part.restoreDraft(draft);
	const selected = viewService.activeSelection!;
	assert.equal(selected.kind, 'untitled');
	part.setVisible(false);
	part.setVisible(true);
	assert.equal(part.domNode.querySelector('.ash-chat-input-part'), retainedInput);
	assert.equal(inputs.length, 2);
	assert.deepEqual((await part.captureActiveDraft())?.draft, draft);
	const second = viewService.openNewSession('Another draft');
	const separateDraft = { mode: 'plan' as const, text: 'Keep this second draft', contexts: [{ id: 'code-file', kind: 'file', name: 'code.ts', content: 'Code context' }] };
	part.restoreDraft(separateDraft);
	await part.captureActiveDraft();
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-part').length, 1);
	assert.deepEqual((await part.captureActiveDraft())?.draft, separateDraft);
	assert.deepEqual(readNewChatDraftState(storage, `untitled:${second.untitledSessionId}`), separateDraft);
	viewService.activateSelection(selected);
	assert.deepEqual((await part.captureActiveDraft())?.draft, draft);
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-part').length, 1);
	assert.equal(part.domNode.querySelector('.ash-sessions-code-page'), null);

	const retainedCodeInput = part.domNode.querySelector('.ash-chat-input-part');
	const codeView = part.domNode.querySelector('[data-conversation-kind="code"]')!;
	await part.setConversationKind('cowork');
	const coworkView = part.domNode.querySelector('[data-conversation-kind="cowork"]')!;
	assert.ok(coworkView.querySelector('.ash-chat-input-part'));
	assert.equal(coworkView.querySelector('[data-action-id="ash.chat.input.mode"]'), null);
	assert.ok(coworkView.querySelector('.ash-chat-input-container [data-action-id="ash.chat.input.model"]'));
	assert.equal(coworkView.querySelector('.ash-chat'), null);
	assert.deepEqual((await part.captureActiveDraft())?.draft, draft);
	assert.equal(codeView.isConnected, false);
	const retainedCoworkInput = coworkView.querySelector('.ash-chat-input-part');
	part.appendToDraft('Continue the presentation in Cowork');
	const coworkDraft = (await part.captureActiveDraft())!.draft;
	await part.setConversationKind('code');
	assert.equal(part.domNode.querySelector('.ash-chat-input-part'), retainedCodeInput);
	assert.deepEqual((await part.captureActiveDraft())?.draft, coworkDraft);
	const transferred = await part.captureActiveDraft();
	transferred!.clear();
	await part.setConversationKind('cowork');
	assert.equal(coworkView.querySelector('.ash-chat-input-part'), retainedCoworkInput);
	assert.equal(await part.captureActiveDraft(), undefined);
	assert.equal(coworkView.querySelectorAll('.ash-cowork-attachment').length, 0);

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
	using storage = new BrowserStorageService({ ownerWindow, workspaceId: 'workspace-a', flushInterval: 0 });
	const draft = { mode: 'debug' as const, text: 'Review this', contexts: [{ id: 'image', kind: 'image', name: 'image.png', content: 'data:image/png;base64,aGVsbG8=' }, { id: 'file', kind: 'file', name: 'brief.ts', content: 'const answer = 42;', resource: 'file:///workspace/brief.ts' }] };
	writeNewChatDraftState(storage, draft, 'untitled:first');
	writeNewChatDraftState(storage, { mode: 'plan', text: 'Thread draft', contexts: [] }, 'thread-1');
	await storage.flush();
	using restored = new BrowserStorageService({ ownerWindow, workspaceId: 'workspace-a', flushInterval: 0 });
	assert.deepEqual(readNewChatDraftState(restored, 'untitled:first'), draft);
	assert.deepEqual(readNewChatDraftState(restored, 'thread-1'), { mode: 'plan', text: 'Thread draft', contexts: [] });
	assert.equal(readNewChatDraftState(restored, 'thread-2'), undefined);
	restored.switchWorkspace('workspace-b');
	assert.equal(readNewChatDraftState(restored, 'untitled:first'), undefined);
	restored.switchWorkspace('workspace-a');
	writeNewChatDraftState(restored, undefined, 'untitled:first');
	assert.equal(readNewChatDraftState(restored, 'untitled:first'), undefined);
	assert.equal(readNewChatDraftState(restored, 'thread-1')?.text, 'Thread draft');
});

test('legacy drafts merge by session identity and conflicting content survives until recovery', async () => {
	const ownerWindow = browserEnvironment.window as unknown as Window;
	using storage = new BrowserStorageService({ ownerWindow, workspaceId: 'sessions', flushInterval: 0 });
	const chatDraft = { mode: 'agent' as const, text: 'Chat text', contexts: [] };
	const codeDraft = { mode: 'plan' as const, text: 'Code text', contexts: [{ id: 'image', kind: 'image', name: 'image.png', content: 'data:image/png;base64,aGVsbG8=' }, { id: 'file', kind: 'file', name: 'brief.ts', content: 'const answer = 42;', resource: 'file:///workspace/brief.ts' }] };
	storage.store('sessions.draftState:thread-1', JSON.stringify(chatDraft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.codeDraftState:thread-1', JSON.stringify(codeDraft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.activityBar.activePage', 'code', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const recovered = migrateNewChatDraftState(storage);
	assert.deepEqual({ selected: readNewChatDraftState(storage, 'thread-1'), recovered }, { selected: codeDraft, recovered: [{ draft: chatDraft, key: 'sessions.draftState:thread-1' }] });
	assert.equal(storage.get(recovered[0]!.key, StorageScope.WORKSPACE), JSON.stringify(chatDraft));
	writeNewChatDraftState(storage, recovered[0]!.draft, 'untitled:recovered');
	storage.remove(recovered[0]!.key, StorageScope.WORKSPACE);
	assert.deepEqual(migrateNewChatDraftState(storage), []);
	await storage.flush();
	using restored = new BrowserStorageService({ ownerWindow, workspaceId: 'sessions', flushInterval: 0 });
	assert.deepEqual([readNewChatDraftState(restored, 'thread-1'), readNewChatDraftState(restored, 'untitled:recovered')], [codeDraft, chatDraft]);
});

test('Sessions file acquisition preserves valid UTF-8 and rejects binary content without adding it', async () => {
	using model = new ChatAttachmentModel();
	using notifications = new NotificationService();
	using attachments = new NewChatContextAttachments(document.body, model, () => true, notifications);
	await attachments.attachFiles([new browserEnvironment.window.File(['A literal \uFFFD character'], 'context.txt', { type: 'text/plain' })]);
	assert.deepEqual(await model.attachments[0]!.resolve(), { name: 'context.txt', content: 'A literal \uFFFD character' });
	await attachments.attachFiles([new browserEnvironment.window.File([new Uint8Array([0xFF, 0x00])], 'binary.dat')]);
	assert.equal(model.size, 1);
	assert.match(notifications.getNotifications()[0]?.message ?? '', /binary.dat must be a UTF-8 text file/u);
});

test('Closing Sessions file acquisition cancels its readers and does not mutate attachments', async () => {
	using model = new ChatAttachmentModel();
	using notifications = new NotificationService();
	using attachments = new NewChatContextAttachments(document.body, model, () => true, notifications);
	const pending = attachments.attachFiles([new browserEnvironment.window.File(['Pending read'], 'context.txt', { type: 'text/plain' })]);
	attachments.dispose();
	await pending;
	assert.equal(model.size, 0);
	assert.deepEqual(notifications.getNotifications(), []);
});

test('Sessions file acquisition rejects image inputs for a text-only model while keeping text available', async () => {
	using model = new ChatAttachmentModel();
	using notifications = new NotificationService();
	using attachments = new NewChatContextAttachments(document.body, model, () => false, notifications);
	await attachments.attachFiles([new browserEnvironment.window.File(['image'], 'preview.png', { type: 'image/png' })]);
	assert.deepEqual({ size: model.size, message: notifications.getNotifications()[0]?.message }, { size: 0, message: 'Could not attach files: Error: The selected model does not support images' });
	await attachments.attachFiles([new browserEnvironment.window.File(['Text remains available'], 'context.txt', { type: 'text/plain' })]);
	assert.deepEqual(await model.attachments[0]!.resolve(), { name: 'context.txt', content: 'Text remains available' });
});

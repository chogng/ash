import { BrowserImageEditorService } from '../../../workbench/services/imageEditor/browser/browserImageEditorService.js';
import { IImageEditorService } from '../../../workbench/services/imageEditor/common/imageEditorService.js';
import { ISessionProviderScopeService } from '../../browser/agentHost/sessionProviderScopeService.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { createDisconnectedRendererApi } from '../../../workbench/browser/rendererApi.js';
import { IAgentVoiceService } from '../../../platform/agentHost/common/agentService.js';
import { IRendererHostService } from '../../../platform/renderer/common/rendererHost.js';
import { CustomViewService, ICustomViewService } from '../../services/customView/browser/customViewService.js';
import { IPathService } from '../../../platform/path/common/pathService.js';
import { BrowserPathService } from '../../../workbench/services/path/browser/pathService.js';
import { IAgentExecutionSettingsService } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IAppServerHookApi, IAppServerSkillApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../workbench/test/common/testEditorService.js';
import { createTestFileService, registerTestComponentServices, createTestEditorServices } from '../../../workbench/test/common/testEditorServices.js';
import { IGitHubService as ISessionsGitHubService } from '../../contrib/github/browser/githubService.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import { IFileService, FileSystemProviderCapabilities } from '../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../workbench/services/dialogs/common/dialogService.js';
import { FileDialogService } from '../../../workbench/services/dialogs/browser/fileDialogService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { TestHostService } from '../../../workbench/services/host/test/browser/testHostService.js';
import type { IWebWorkspaceClient } from '../../../workbench/services/workspaces/browser/appServerWebWorkspaceClient.js';
import { registerTestDictationOnboarding } from '../../../workbench/test/common/testDictationServices.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../platform/renderer/common/dictation.js';
import { ISpeechService } from '../../../workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../workbench/contrib/speech/browser/speechService.js';
import { observableValue } from '../../../base/common/observable.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore, toDisposable, Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { ICommandEvent, ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../workbench/services/notification/test/common/testNotificationService.js';
import { IChatService, type ThreadUpdateEnvelope } from '../../../workbench/services/chat/common/chatService.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession } from '../../services/sessions/common/session.js';
import { SessionsService } from '../../../sessions/services/sessions/browser/sessionsService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { ChatTipService, IChatTipService } from '../../../workbench/contrib/chat/browser/chatTipService.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from '../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { migrateNewChatDraftState, readNewChatDraftState, writeNewChatDraftState } from '../../contrib/chat/common/newChatDraftState.js';
import type { SessionsPartOptions } from '../../browser/parts/sessionsPart.js';
import { NewChatContextAttachments } from '../../contrib/chat/browser/newChatContextAttachments.js';
import { NewChatInputPasteTarget } from '../../contrib/chat/browser/newChatInputPasteTarget.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
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
const { SessionsPart } = await import('../../browser/parts/sessionsPart.js');
await import('../../contrib/creator/browser/creatorEditor.contribution.js');
const { NewChatInputWidget } = await import('../../contrib/chat/browser/newChatInput.js');
const { CoworkPaneFactory } = await import('../../contrib/cowork/browser/cowork.contribution.js');
const { ChatTipService: CoworkTipService, IChatTipService: ICoworkTipService } = await import('../../contrib/cowork/browser/chatTipService.js');
const { createCodeEditorServices } = await import('../../../editor/test/browser/testCodeEditor.js');

suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'FileReader', 'navigator']) Reflect.deleteProperty(globalThis, name);
});

test('SessionsPart remains owned by the Sessions product layer', async () => {
	const dom = browserEnvironment;
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	dom.window.document.body.replaceChildren();
	const onDidChange = new Emitter<void>();
	let untitledSessions: readonly IUntitledChatSession[] = [];
	let nextUntitledSessionId = 0;
	let activeUntitledSessionId: string | undefined;
	const sessionService: ISessionsManagementService = {
		navigationRevision: 0,
		onDidChange: onDidChange.event,
		materializedSessions: observableValue('materialized drafts', new Map()),
		sessions: [],
		active: undefined,
		get untitledSessions() { return untitledSessions; },
		get activeUntitledSession() { return untitledSessions.find(session => session.untitledSessionId === activeUntitledSessionId); },
		state: 'ready',
		error: undefined,
		whenDirectoriesReady(): Promise<void> { return Promise.resolve(); },
		async initialize() { },
		async listAgents() { return []; },
		async openThread() { },
		selectThread() { },
		async interruptThread() { },
		createUntitledSession() {
			const untitledSession = { untitledSessionId: `untitled-${++nextUntitledSessionId}`, title: 'New code session', model: undefined, agent: undefined, workspace: { type: 'current' as const } };
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
			throw new Error('Session creation is unavailable');
		},
		promoteUntitledSession() { },
		async ensureActiveThread() {
			throw new Error('No active thread');
		},
		async startNewSession() {
			throw new Error('Session creation is unavailable');
		},
		async stopSession() {
			throw new Error('Session stopping is unavailable');
		},
		async setModel() {
			throw new Error('Model selection is unavailable');
		},
		async archiveSession() {
			throw new Error('Session archiving is unavailable');
		},
		async renameSession() { throw new Error('Unexpected rename'); },
		async deleteSession() { throw new Error('Unexpected deletion'); },
		async restoreSession() {
			throw new Error('Session restoration is unavailable');
		},
	};
	const threadUpdates = new Emitter<ThreadUpdateEnvelope>();
	const transcriptUpdates = new Emitter<import('../../../workbench/services/chat/common/chatService.js').ThreadTranscriptUpdateEnvelope>();
	const ready = new Emitter<void>();
	const chatService: IChatService & ILanguageModelsService = {
		rewriteRequest: async () => { throw new Error('Unexpected request rewrite'); },
		renameThread: async () => { throw new Error('Unexpected rename'); },
		configureAdvisor: async () => { },
		consultAdvisor: async () => { },
		readContextUsage: async () => { throw new Error('No active Thread'); },
		readAdvisorDefault: async () => null,
		saveAdvisorDefault: async () => { },
		onDidSubmitRequest: () => toDisposable(() => { }),
		onDidChangeSession: Event.None,
		getInteractionOffer: () => undefined, onDidChangeInteractionOffer: Event.None, onDidUpdateThread: threadUpdates.event,
		onDidUpdateThreadTranscript: transcriptUpdates.event,
		onDidUpdateGoal: () => toDisposable(() => { }),
		onDidBecomeReady: ready.event,
		onDidChangeModels: ready.event,
		onDidChangeQueue: ready.event,
		onDidUpdateTurnChanges: () => toDisposable(() => { }),
		discoverProviderModels: async () => [],
		async listModels() { return []; },
		getDefaultNewChatModel() { return undefined; },
		async rememberSelectedModel() { },
		readModelDefaults: async () => ({ revision: 1, model: null, reasoningEffort: null }),
		saveReasoningEffort: async () => { },
		async listModelCatalog() { return []; },
		async listModelProviders() { return []; },
		setModelPreferences: async () => { },
		readApprovalReviewModel: async () => ({ type: 'automatic' }),
		setApprovalReviewModel: async () => { },
		listCustomModelProviders: async () => [],
		removeCustomModelProvider: async () => { },
		saveCustomModelProvider: async () => { },
		testProviderModel: async () => ({ type: 'passed' }),
		async setModelProviderApiKey() { },
		async removeModelProviderApiKey() { },
		async listAdvisorModels() { return []; },
		async refreshModels() { return []; },
		isModelVisible() { return true; },
		async setModelVisible() { },
		async listSlashCommands() { return []; },
		async readCheckpoints() { return []; },
		async readHistoryState() { return { sequence: 0, canUndo: false, canRedo: false }; },
		async moveHistory() { throw new Error('History is not configured in this fixture'); },
		async restoreCheckpoint() { throw new Error('Checkpoint restore is not configured in this fixture'); },
		async readThread() { throw new Error('No active Thread'); },
		async subscribeThread() { throw new Error('No active Thread'); },
		async unsubscribeThread() { },
		async startTurn() { },
		async queueTurn() { },
		async queuedMessageCount() { return 0; },
		async compactContext() { },
		async steerTurn() { },
		async interruptTurn() { },
		async resolveInteraction() { },
		async listTurnChanges() { return []; },
		async readThreadChanges() { throw new Error('No Thread changes'); },
		async readThreadChangeFile() { throw new Error('No Thread change file'); },
		async readTurnChange() { throw new Error('No ChangeSet'); },
		async readTurnChangeFile() { throw new Error('No ChangeSet file'); },
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
		contextMenuStyle: 'custom' as const,
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
		async executeCommand() { throw new Error('No commands registered'); },
	};
	using resources = new DisposableStore();
	const editorRoot = createCodeEditorServices(resources);
	editorRoot.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	const services = resources.add(editorRoot.createChild());
	services.registerInstance(IHostService, new TestHostService());
	services.registerInstance(IRendererHostService, createDisconnectedRendererApi());
	services.registerInstance(IAgentVoiceService, createDisconnectedRendererApi().agentVoice);
	services.registerSingleton(IPathService, () => services.createInstance(BrowserPathService));
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
	services.registerInstance(ISessionsGitHubService, {
		onDidChange: Event.None,
		getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { },
		initialize() { },
		attachPullRequest: async () => { throw new Error('Unexpected PR attachment'); },
		detachPullRequest: async () => { throw new Error('Unexpected PR removal'); },
	});
	services.registerInstance(ILanguageModelsService, chatService);
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IChatService, chatService);
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { assert.fail('Unexpected editor navigation'); }, focusActiveEditor: () => { } });
	services.registerInstance(IAppServerSkillApi, { onDidChangeSkills: ready.event, readTextResource: async () => { throw new Error('No Skill body in this test fixture'); }, list: async () => ({ generation: 0, skills: [] }), read: async () => ({ revision: 0, catalog: { generation: 0, skills: [] }, diagnostics: [] }), registerSource: async () => { throw new Error('Unexpected skill source registration'); }, setEnabled: async () => { } });
	services.registerInstance(IChatSessionNavigationService, { openConversation: async () => { throw new Error('Unexpected conversation navigation'); } } as unknown as IChatSessionNavigationService);
	services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	using notifications = new TestNotificationService();
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
	services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'sessions-test', folders: [] })));

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
	const customViews = resources.add(services.createInstance(CustomViewService));
	services.registerInstance(ICustomViewService, customViews);
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
	paneServices.registerInstance(ISessionProviderScopeService, {
		onDidChange: Event.None, onDidChangeScopes: Event.None,
		getScopes: () => [], getScope: () => { throw new Error('Unexpected host routing'); }, getProviderScope: () => { throw new Error('Unexpected host routing'); },
		createScope: () => paneServices.createChild(),
	});
	paneServices.registerInstance(IImageEditorService, resources.add(paneServices.createInstance(BrowserImageEditorService)));
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
		createNewSession: () => { viewService.openNewSession(); },
	} satisfies SessionsPartOptions);
	const updatePart = (): void => {
		const selection = viewService.getSelection();
		part.updateVisibleSelections(selection.visibleSelections, selection.activeSelection);
	};
	const partListener = viewService.onDidChange(updatePart);
	updatePart();

	await part.captureActiveDraft();
	assert.equal(part.domNode.dataset.part, 'sessions');
	assert.equal(part.domNode.querySelector('.ash-sessions-surface-header'), null);
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-view'));
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-slot').length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-part').length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-input .ash-chat-input-editor').length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-loading:not([hidden])').length, 0);
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

	(part.domNode.querySelector('.ash-sessions-chat-slot input, .ash-sessions-chat-slot textarea') as HTMLElement).focus();
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-slot.active'));
	assert.equal(part.domNode.querySelector('.ash-editor-group, .ash-editor-title-control, [role=tab]'), null);
	viewService.closeVisibleSelection(viewService.activeSelection!);
	await part.captureActiveDraft();
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-slot').length, 1);
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-view.single-chat'));
	const retainedInput = part.domNode.querySelector('.ash-chat-input-part');
	const draft = { mode: 'plan' as const, text: 'Keep this Chat draft chat.txt Tool selection: 1 disabled ', contexts: [{ id: 'chat-file', kind: 'file', name: 'chat.txt', content: 'Chat context', reference: { start: 21, end: 29 } }, { id: 'tool-selection', kind: 'toolSelection', name: 'Tool selection: 1 disabled', content: '["read_file"]', reference: { start: 30, end: 56 } }] };
	part.restoreDraft(draft);
	const selected = viewService.activeSelection!;
	assert.equal(selected.kind, 'untitled');
	part.setVisible(false);
	part.setVisible(true);
	assert.equal(part.domNode.querySelector('.ash-chat-input-part'), retainedInput);
	assert.equal(inputs.length, 2);
	assert.deepEqual((await part.captureActiveDraft())?.draft, draft);
	const second = viewService.openNewSession('Another draft');
	const separateDraft = { mode: 'plan' as const, text: 'Keep this second draft code.ts ', contexts: [{ id: 'code-file', kind: 'file', name: 'code.ts', content: 'Code context', reference: { start: 23, end: 30 } }] };
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
	assert.equal(codeView, coworkView);
	assert.equal(codeView.isConnected, true);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-grid').length, 1);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-slot').length, 1);
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
	const grid = part.domNode.querySelector('.ash-sessions-chat-grid');
	part.restoreDraft(draft);
	await Promise.all([part.setConversationKind('code'), part.setConversationKind('cowork'), part.setConversationKind('code')]);
	assert.equal(part.domNode.querySelector('.ash-sessions-chat-grid'), grid);
	assert.equal(part.domNode.querySelector('[data-conversation-kind="code"]'), codeView);
	assert.equal(part.domNode.querySelector('.ash-chat-input-part'), retainedCodeInput);
	assert.deepEqual((await part.captureActiveDraft())?.draft, draft);

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

test('Sessions file picker forwards the original files to the shared composer', () => {
	const container = document.createElement('div');
	const batches: (readonly File[])[] = [];
	const files = [new browserEnvironment.window.File(['Selected context'], 'context.txt', { type: 'text/plain' })];
	using attachments = new NewChatContextAttachments(container, async selected => { batches.push(selected); });
	const picker = container.querySelector<HTMLInputElement>('input[type=file]')!;
	Object.defineProperty(picker, 'files', { value: files });
	picker.dispatchEvent(new browserEnvironment.window.Event('change'));
	assert.deepEqual(batches, [files]);
	assert.equal(batches[0]![0], files[0]);
	assert.equal(picker.value, '');
});

test('Closing the Sessions file picker removes its event source and rejects later acquisition', async () => {
	const container = document.createElement('div');
	const files = [new browserEnvironment.window.File(['Selected context'], 'context.txt')];
	let reads = 0;
	using attachments = new NewChatContextAttachments(container, async () => { reads++; });
	const picker = container.querySelector<HTMLInputElement>('input[type=file]')!;
	attachments.dispose();
	await attachments.attachFiles(files);
	picker.dispatchEvent(new browserEnvironment.window.Event('change'));
	assert.equal(reads, 0);
	assert.equal(container.childElementCount, 0);
});

test('Sessions file paste reaches the shared composer once and text paste stays editable', () => {
	const container = document.createElement('div');
	const batches: (readonly File[])[] = [];
	using attachments = new NewChatContextAttachments(container, async selected => { batches.push(selected); });
	using target = new NewChatInputPasteTarget(container, attachments);
	const files = [new browserEnvironment.window.File(['image'], 'preview.png', { type: 'image/png' })];
	const paste = new browserEnvironment.window.Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(paste, 'clipboardData', { value: { files } });
	container.dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual(batches, [files]);
	const text = new browserEnvironment.window.Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(text, 'clipboardData', { value: { files: [] } });
	container.dispatchEvent(text);
	assert.equal(text.defaultPrevented, false);
	assert.equal(batches.length, 1);
});

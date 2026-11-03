import { createDisconnectedAgentHostInputCompletionService } from '../../../platform/agentHost/browser/appServerAgentService.js';

import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { emptyEditorGroupsService } from '../../../workbench/test/common/testWorkbenchContextKeys.js';

import { ISearchService } from '../../../workbench/services/search/common/search.js';
import { IVoiceInputModeService, VoiceInputModeService } from '../../../workbench/contrib/chat/browser/voiceInputMode/voiceInputMode.js';
import { registerTestWorkbenchHostServices } from '../../../workbench/test/common/workbenchHostTestServices.js';
import * as chatInputStatePersistence from '../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISCMService } from '../../../workbench/contrib/scm/common/scm.js';
import { SCMService } from '../../../workbench/contrib/scm/common/scmService.js';
import { BrowserImageEditorService } from '../../../workbench/services/imageEditor/browser/browserImageEditorService.js';
import { IImageEditorService } from '../../../workbench/services/imageEditor/common/imageEditorService.js';
import { IRemoteConnectionService, RemoteConnectionService, UnavailableRemoteConnectionApi } from '../../../platform/remote/common/remoteConnectionService.js';
import { ISessionChangesService } from '../../contrib/changes/common/sessionChangesService.js';
import { ISessionProviderScopeService } from '../../browser/agentHost/sessionProviderScopeService.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { createDisconnectedRendererApi } from '../../../workbench/browser/rendererApi.js';
import { IAgentHostInputCompletionService, IAgentVoiceService } from '../../../platform/agentHost/common/agentService.js';

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
import { IWorkspacesService } from '../../../platform/workspaces/common/workspaces.js';
import { TestWorkspaceService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { IDialogService, IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../workbench/services/dialogs/common/dialogService.js';
import { FileDialogService } from '../../../workbench/services/dialogs/browser/fileDialogService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { TestHostService } from '../../../workbench/services/host/test/browser/testHostService.js';
import type { IWebWorkspaceClient } from '../../../workbench/services/workspaces/browser/appServerWebWorkspaceClient.js';
import { registerTestDictationOnboarding } from '../../../workbench/test/common/testDictationServices.js';
import { registerTestExtensionService } from '../../../workbench/test/common/testExtensionServices.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../platform/dictation/common/dictation.js';
import { ISpeechService } from '../../../workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../workbench/contrib/speech/browser/speechService.js';
import { autorun, observableValue } from '../../../base/common/observable.js';
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
import { IChatWidgetService } from '../../../workbench/contrib/chat/browser/chat.js';
import { ChatConfiguration } from '../../../workbench/contrib/chat/common/constants.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { unavailableOperation } from '../../../platform/agentHost/browser/disconnectedAppServer.js';
import { createDisconnectedLocalGitService } from '../../../platform/git/browser/appServerLocalGitService.js';
import { ILocalGitService } from '../../../platform/git/common/localGitService.js';
import { BrowserLayoutService, ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { getWindowById, getWindowId } from '../../../base/browser/window.js';

ensureNoDisposablesAreLeakedInTestSuite();

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
Object.defineProperty(browserEnvironment.window, 'ResizeObserver', { configurable: true, value: globalThis.ResizeObserver });
const { SessionsPart } = await import('../../browser/parts/sessionsPart.js');
await import('../../contrib/creator/browser/creatorEditor.contribution.js');
await import('../../../workbench/contrib/chat/browser/chat.shared.contribution.js');
const { NewChatWidget } = await import('../../contrib/chat/browser/newChatWidget.js');
const { CoworkPaneFactory } = await import('../../contrib/cowork/browser/cowork.contribution.js');
const { ChatTipService: CoworkTipService, IChatTipService: ICoworkTipService } = await import('../../contrib/cowork/browser/chatTipService.js');
const { createCodeEditorServices } = await import('../../../editor/test/browser/testCodeEditor.js');

suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'FileReader', 'navigator']) Reflect.deleteProperty(globalThis, name);
});

test('SessionsPart remains owned by the Sessions product layer', async () => {
	const dom = browserEnvironment;
	using windowLifetime = toDisposable(() => {
		// jsdom.close() does not dispatch the browser lifecycle that retires window monitors.
		dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide'));
		getWindowById(getWindowId(dom.window as unknown as Window)!)?.disposables.dispose();
	});
	using resources = new DisposableStore();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	dom.window.document.body.replaceChildren();
	const onDidChange = resources.add(new Emitter<void>());
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
		async refresh() { },
		async listAgents() { return []; },
		async prepareThread() { },
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
		setUntitledSessionWorkspace() { throw new Error('Unexpected workspace edit'); },
		cancelUntitledSessionPreparation() { throw new Error('Unexpected preparation cancellation'); },
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
	const threadUpdates = resources.add(new Emitter<ThreadUpdateEnvelope>());
	const transcriptUpdates = resources.add(new Emitter<import('../../../workbench/services/chat/common/chatService.js').ThreadTranscriptUpdateEnvelope>());
	const ready = resources.add(new Emitter<void>());
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
		readModelDefaults: async () => ({ codeReviewModel: null, commitMessageModel: null, commitMessageEnabled: false, revision: 1, model: null, reasoningEffort: null }),
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
		async startReview() { throw new Error('Unexpected review in this fixture'); },
		async startTurn() { },
		async queueTurn() { },
		async queuedMessageCount() { return 0; },
		getPendingRequests: async () => { throw new Error('Unexpected queue operation'); },
		pausePendingRequest: async () => { throw new Error('Unexpected queue operation'); },
		resumePendingRequest: async () => { throw new Error('Unexpected queue operation'); },
		editPendingRequest: async () => { throw new Error('Unexpected queue operation'); },
		removePendingRequest: async () => { throw new Error('Unexpected queue operation'); },
		sendPendingRequestImmediately: async () => { throw new Error('Unexpected queue operation'); },
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
	const contextMenuEvents = resources.add(new Emitter<void>());
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
	const commandEvents = resources.add(new Emitter<ICommandEvent>());
	const commandService: ICommandService = {
		onWillExecuteCommand: commandEvents.event,
		onDidExecuteCommand: commandEvents.event,
		async executeCommand() { throw new Error('No commands registered'); },
	};
	const editorRoot = createCodeEditorServices(resources);
	editorRoot.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	registerTestExtensionService(resources, editorRoot);
	const services = resources.add(editorRoot.createChild());

	services.registerInstance(IHostService, new TestHostService());
	registerTestWorkbenchHostServices(services, createDisconnectedRendererApi());
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
		invokePullRequestArtifact: async () => { throw new Error('Unexpected PR artifact action'); },
	});
	services.registerInstance(ILanguageModelsService, chatService);
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IChatService, chatService);
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { assert.fail('Unexpected editor navigation'); }, focusActiveEditor: () => { } });
	services.registerInstance(IAppServerSkillApi, { onDidChangeSkills: ready.event, readTextResource: async () => { throw new Error('No Skill body in this test fixture'); }, list: async () => ({ generation: 0, skills: [] }), read: async () => ({ revision: 0, catalog: { generation: 0, skills: [] }, diagnostics: [] }), registerSource: async () => { throw new Error('Unexpected skill source registration'); }, setEnabled: async () => { } });
	services.registerInstance(IChatSessionNavigationService, { openConversation: async () => { throw new Error('Unexpected conversation navigation'); } } as unknown as IChatSessionNavigationService);
	services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	services.registerSingleton(IVoiceInputModeService, () => services.createInstance(VoiceInputModeService));
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
	services.registerInstance(IWorkspacesService, {
		onDidChangeRecentlyOpened: Event.None,
		getRecentlyOpened: async () => ({ workspaces: [] }),
	} as unknown as IWorkspacesService);

	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(INotificationService, notifications);
	const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', flushInterval: 0 }));
	services.registerInstance(IStorageService, storage);
	services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root: dom.window.document.body })));
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
	using viewService = services.createInstance(SessionsService);
	await viewService.initialize();
	services.registerInstance(IChatTipService, resources.add(services.createInstance(ChatTipService)));
	services.registerInstance(ICoworkTipService, resources.add(services.createInstance(CoworkTipService)));
	Object.defineProperty(dom.window.performance, 'getEntriesByType', { value: () => [] });
	services.registerInstance(ILifecycleService, resources.add(services.createInstance(BrowserLifecycleService, { ownerWindow: dom.window as unknown as Window, onError: (error: unknown) => { throw error; } })));
	using editorServices = createTestEditorServices(undefined, services, dom.window.document);
	services.registerInstance(IFileDialogService, editorServices.createInstance(FileDialogService, { kind: 'server', client: {} as IWebWorkspaceClient, quickInput: () => { throw new Error('Unexpected picker'); }, fileService: () => { throw new Error('Unexpected files'); }, workspaceRoot: () => undefined }, () => dialogs));
	const paneServices = registerTestComponentServices(editorServices);
	paneServices.registerInstance(IRemoteConnectionService, resources.add(new RemoteConnectionService(UnavailableRemoteConnectionApi)));
	paneServices.registerInstance(ISessionChangesService, {} as ISessionChangesService);
	paneServices.registerInstance(ILocalGitService, createDisconnectedLocalGitService(unavailableOperation));
	paneServices.registerInstance(IEditorGroupsService, emptyEditorGroupsService);
	paneServices.registerInstance(IAgentHostInputCompletionService, createDisconnectedAgentHostInputCompletionService());


	paneServices.registerInstance(ISearchService, {
		registerSearchResultProvider: () => { throw new Error('Search registration is outside this composer fixture'); },
		fileSearch: async () => ({ results: [], messages: [] }),
		textSearch: async () => { throw new Error('Text search is outside this composer fixture'); },
	});
	paneServices.registerSingleton(ISCMService, () => paneServices.createInstance(SCMService));
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
	using part = paneServices.createInstance(SessionsPart, dom.window.document.body, {
		createCoworkPane: (container, panelId, selection) => cowork.createPane(container, panelId, selection, () => { viewService.openNewSession(); }),
		activateSelection: selection => viewService.activateSelection(selection),
		closeSelection: selection => viewService.closeVisibleSelection(selection),
		createNewSession: () => { viewService.openNewSession(); },
	} satisfies SessionsPartOptions);
	using partListener = autorun(reader => {
		const { visibleSelections, activeSelection } = viewService.getSelection(reader);
		part.updateVisibleSessions(visibleSelections, activeSelection);
	});

	await part.captureActiveDraft();
	assert.equal(part.domNode.dataset.part, 'sessions');
	assert.equal(part.domNode.querySelector('.ash-sessions-surface-header'), null);
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-view'));
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-slot').length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-part').length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-input .ash-chat-input-editor').length, 2);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-tip').length, 0);
	const initialWidgets = paneServices.get(IChatWidgetService).getAllWidgets().filter(widget => widget instanceof NewChatWidget);
	assert.equal(initialWidgets.length, 2);

	(part.domNode.querySelector('.ash-sessions-chat-slot input, .ash-sessions-chat-slot textarea') as HTMLElement).focus();
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-slot.active'));
	assert.equal(part.domNode.querySelector('.ash-editor-group, .ash-editor-title-control, [role=tab]'), null);
	const closeButtons = part.domNode.querySelectorAll<HTMLButtonElement>('.ash-sessions-chat-slot-close:not([hidden]) button');
	assert.equal(closeButtons.length, 2);
	closeButtons[1]!.click();
	assert.equal(part.domNode.querySelector('.ash-sessions-chat-slot-close:not([hidden])'), null);
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
	assert.equal(paneServices.get(IChatWidgetService).getAllWidgets().filter(widget => widget instanceof NewChatWidget).length, 1);
	assert.equal(initialWidgets.filter(widget => widget.isDisposed).length, 1);
	const firstTip = part.domNode.querySelector('.ash-chat-input-tip');
	assert.ok(firstTip);
	assert.match(firstTip.textContent ?? '', /Attach text files or images with the \+ button/u);
	viewService.activateSelection(viewService.activeSelection!);
	assert.equal(part.domNode.querySelector('.ash-chat-input-tip'), firstTip);
	const configuration = paneServices.get(IConfigurationService);
	firstTip.querySelector('button')!.focus();
	await configuration.updateValue(ChatConfiguration.TipsEnabled, false);
	assert.equal(part.domNode.querySelector('.ash-chat-input-tip'), null);
	assert.ok(retainedInput?.querySelector('.ash-chat-input-container')?.contains(dom.window.document.activeElement));
	await configuration.updateValue(ChatConfiguration.TipsEnabled, true);
	const restoredTip = part.domNode.querySelector('.ash-chat-input-tip');
	assert.ok(restoredTip);
	restoredTip.querySelector('button')!.click();
	assert.equal(part.domNode.querySelector('.ash-chat-input-tip'), null);
	assert.equal(services.get(IChatTipService).getWelcomeTip(), undefined);
	assert.deepEqual((await part.captureActiveDraft())?.draft, draft);
	const second = viewService.openNewSession('Another draft');
	const separateDraft = { mode: 'plan' as const, text: 'Keep this second draft code.ts ', contexts: [{ id: 'code-file', kind: 'file', name: 'code.ts', content: 'Code context', reference: { start: 23, end: 30 } }] };
	part.restoreDraft(separateDraft);
	await part.captureActiveDraft();
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-part').length, 1);
	assert.deepEqual((await part.captureActiveDraft())?.draft, separateDraft);
	assert.deepEqual(readNewChatDraftState(storage, `untitled:${second.untitledSessionId}`, chatInputStatePersistence), separateDraft);
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
});

test('Sessions draft state restores text and images while isolating Threads and workspaces', async () => {
	const ownerWindow = browserEnvironment.window as unknown as Window;
	using storage = new BrowserStorageService({ ownerWindow, workspaceId: 'workspace-a', flushInterval: 0 });
	const draft = { mode: 'debug' as const, text: 'Review this', contexts: [{ id: 'image', kind: 'image', name: 'image.png', content: 'data:image/png;base64,aGVsbG8=' }, { id: 'file', kind: 'file', name: 'brief.ts', content: 'const answer = 42;', resource: 'file:///workspace/brief.ts' }] };
	writeNewChatDraftState(storage, draft, 'untitled:first', chatInputStatePersistence);
	writeNewChatDraftState(storage, { mode: 'plan', text: 'Thread draft', contexts: [] }, 'thread-1', chatInputStatePersistence);
	await storage.flush();
	using restored = new BrowserStorageService({ ownerWindow, workspaceId: 'workspace-a', flushInterval: 0 });
	assert.deepEqual(readNewChatDraftState(restored, 'untitled:first', chatInputStatePersistence), draft);
	assert.deepEqual(readNewChatDraftState(restored, 'thread-1', chatInputStatePersistence), { mode: 'plan', text: 'Thread draft', contexts: [] });
	assert.equal(readNewChatDraftState(restored, 'thread-2', chatInputStatePersistence), undefined);
	restored.switchWorkspace('workspace-b');
	assert.equal(readNewChatDraftState(restored, 'untitled:first', chatInputStatePersistence), undefined);
	restored.switchWorkspace('workspace-a');
	writeNewChatDraftState(restored, undefined, 'untitled:first', chatInputStatePersistence);
	assert.equal(readNewChatDraftState(restored, 'untitled:first', chatInputStatePersistence), undefined);
	assert.equal(readNewChatDraftState(restored, 'thread-1', chatInputStatePersistence)?.text, 'Thread draft');
});

test('legacy drafts merge by session identity and conflicting content survives until recovery', async () => {
	const ownerWindow = browserEnvironment.window as unknown as Window;
	using storage = new BrowserStorageService({ ownerWindow, workspaceId: 'sessions', flushInterval: 0 });
	const chatDraft = { mode: 'agent' as const, text: 'Chat text', contexts: [] };
	const codeDraft = { mode: 'plan' as const, text: 'Code text', contexts: [{ id: 'image', kind: 'image', name: 'image.png', content: 'data:image/png;base64,aGVsbG8=' }, { id: 'file', kind: 'file', name: 'brief.ts', content: 'const answer = 42;', resource: 'file:///workspace/brief.ts' }] };
	storage.store('sessions.draftState:thread-1', JSON.stringify(chatDraft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.codeDraftState:thread-1', JSON.stringify(codeDraft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.activityBar.activePage', 'code', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const recovered = migrateNewChatDraftState(storage, chatInputStatePersistence);
	assert.deepEqual({ selected: readNewChatDraftState(storage, 'thread-1', chatInputStatePersistence), recovered }, { selected: codeDraft, recovered: [{ draft: chatDraft, key: 'sessions.draftState:thread-1' }] });
	assert.equal(storage.get(recovered[0]!.key, StorageScope.WORKSPACE), JSON.stringify(chatDraft));
	writeNewChatDraftState(storage, recovered[0]!.draft, 'untitled:recovered', chatInputStatePersistence);
	storage.remove(recovered[0]!.key, StorageScope.WORKSPACE);
	assert.deepEqual(migrateNewChatDraftState(storage, chatInputStatePersistence), []);
	await storage.flush();
	using restored = new BrowserStorageService({ ownerWindow, workspaceId: 'sessions', flushInterval: 0 });
	assert.deepEqual([readNewChatDraftState(restored, 'thread-1', chatInputStatePersistence), readNewChatDraftState(restored, 'untitled:recovered', chatInputStatePersistence)], [codeDraft, chatDraft]);
});

import { IAgentCapabilitiesService } from '../../../src/ash/platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IInstructionService } from '../../../src/ash/platform/instructions/common/instructionService.js';
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeaturesService.js';
import { registerCodebaseSymbolsWorkspaceSymbolProvider } from '../../../src/ash/workbench/services/codebaseSymbols/browser/codebaseSymbolsWorkspaceSymbolProvider.js';
import type { ICodebaseSymbolsService } from '../../../src/ash/platform/codebaseSymbols/common/codebaseSymbolsService.js';
import { ITerminalService, type ITerminalInstance } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { TERMINAL_VIEW_ID } from '../../../src/ash/workbench/contrib/terminal/common/terminal.js';
import { SEARCH_VIEW_ID } from '../../../src/ash/workbench/contrib/search/common/constants.js';
import { XtermTerminal } from '../../../src/ash/workbench/contrib/terminal/browser/xterm/xtermTerminal.js';
import { IAccessibilitySignalService } from '../../../src/ash/platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { Disposable } from '../../../src/ash/base/common/lifecycle.js';
import { IFileSearchService } from '../../../src/ash/platform/search/common/fileSearch.js';
import { BrowserFileSearchService } from '../../../src/ash/platform/search/browser/browserFileSearchService.js';
import '../../../src/ash/base/browser/ui/styles.css';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { FileKind, IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { QuickAccessController } from '../../../src/ash/platform/quickinput/browser/quickAccess.js';
import { IQuickAccessController } from '../../../src/ash/platform/quickinput/common/quickAccess.js';
import { IHistoryService } from '../../../src/ash/workbench/services/history/common/history.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import '../../../src/ash/workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { QuickInputController } from '../../../src/ash/platform/quickinput/browser/quickInputController.js';
import { IChatContextPickService } from '../../../src/ash/workbench/services/chat/common/chatContextService.js';
import { ChatContextPickService } from '../../../src/ash/workbench/services/chat/browser/chatContextPickService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { ActionWidgetService, IActionWidgetService } from '../../../src/ash/platform/actionWidget/browser/actionWidget.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../src/ash/workbench/services/chat/common/modelCatalog.js';
import type { ModelRef } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import '../../../src/ash/workbench/contrib/chat/browser/widget/media/chat.css';
import { ChatInputPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputEditors } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import type { ChatInputDelegate, ChatInputState } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInput.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IContextViewService, type IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { IDictationService } from '../../../src/ash/platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { registerTestDictationOnboarding } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { EventType, Gesture } from '../../../src/ash/base/browser/touch.js';
import { addDisposableListener, stopEvent } from '../../../src/ash/base/browser/dom.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { IHostService } from '../../../src/ash/workbench/services/host/browser/host.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IGitHubService } from '../../../src/ash/platform/github/common/githubService.js';
import { IGitService } from '../../../src/ash/workbench/contrib/git/common/gitService.js';

declare global {
	interface Window { ashChatInputIntegration: { refresh(): void; showQuestions(): void; showModels(): void; openModels(): void; setDescription(description: string | null): void; setModelsAvailable(available: boolean): void; modelState(): unknown; setImageCapability(capability: 'text' | 'image' | 'unknown'): void; restoreCapturedDraft(): Promise<void>; setRetirement(retirement: ModelCatalogEntry['retirement']): void; dispose(): void; releaseFileSearch(index: number): void; releaseGitHubSearch(query: string): void; releaseSymbolSearch(query: string): void; releaseInstructions(): void; changeContextSources(): void; }; }
}

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}
const resources = new DisposableStore();
setARIAContainer(document.body);
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindColorTheme(theme, document.body));
if (new URLSearchParams(location.search).has('gestureAncestor')) {
	const main = document.querySelector('main')!;
	resources.add(Gesture.addTarget(main));
	resources.add(addDisposableListener(main, EventType.Tap, event => { stopEvent(event); document.querySelector('output')!.textContent = 'Ancestor tap'; }));
}
const services = resources.add(new InstantiationService());
const destinations = document.createElement('output');
destinations.setAttribute('aria-label', 'Opened sources');
destinations.textContent = '[]';
document.body.append(destinations);
const recordDestination = (value: unknown): void => { destinations.textContent = JSON.stringify([...JSON.parse(destinations.textContent!), value]); };
services.registerInstance(IThemeService, theme);
services.registerInstance(IOpenerService, { open: async (resource, options) => { recordDestination({ resource: resource.toString(), options }); return true; } } as IOpenerService);
services.registerInstance(ICommandService, { executeCommand: async (id: string, resource?: URI | string) => { recordDestination({ command: id, ...(resource !== undefined ? { resource: resource.toString() } : {}) }); } } as unknown as ICommandService);
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));
services.registerInstance(IClipboardService, {
	triggerPaste: () => undefined,
	read: async () => [],
	readFindText: async () => '',
	writeFindText: async () => { },
	readImage: async () => new URLSearchParams(location.search).has('emptyClipboard') ? new Uint8Array() : png,
	readText: async () => '', writeText: async () => { }, readResources: async () => ({ resources: [], operation: 'copy' }), writeResources: async () => { }, hasResources: async () => false,
});
services.registerInstance(IHostService, { hasFocus: true, onDidChangeFocus: Event.None, restart: async () => { }, openWindow: async () => { }, getScreenshot: async () => new URLSearchParams(location.search).has('cancelScreenshot') ? undefined : Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/QAAADggGA8sg/+gAAAABJRU5ErkJggg=='), character => character.charCodeAt(0)) });
services.registerInstance(IAgentCapabilitiesService, {
	isAvailable: !new URLSearchParams(location.search).has('noTools'),
	read: async () => {
		if (new URLSearchParams(location.search).has('toolFailure')) { throw new Error('Tool catalog failed'); }
		return {
			toolSets: [{ id: 'local', source: 'local', sourceId: 'directory', tools: ['read_file', 'write_file'] }, { id: 'mcp:docs', source: 'mcp', sourceId: 'docs-server', tools: ['connector_search'] }],
			tools: [
				{ name: 'read_file', description: 'Read a source document', source: 'local', sourceDetails: ['directory'], exposure: 'direct', authority: 'directoryRead' },
				{ name: 'write_file', description: 'Write a source document', source: 'local', sourceDetails: ['directory'], exposure: 'direct', authority: 'directoryWrite' },
				{ name: 'connector_search', description: 'Search external references', source: 'mcp', sourceDetails: ['docs-server'], exposure: 'deferred', authority: 'providerDefined' },
				{ name: 'internal_broker', description: 'Hidden broker', source: 'host', sourceDetails: [], exposure: 'hidden', authority: 'productService' },
			],
			localProcessSandboxConfigured: false, sandboxBackends: [], sandboxDiagnostics: [], directoryGrantsReadable: false,
		};
	},
});
const instructionWaiters: (() => void)[] = [];
services.registerInstance(IInstructionService, {
	isAvailable: !new URLSearchParams(location.search).has('noInstructions'),
	list: async sessionId => {
		if (sessionId !== 'active-session') { throw new Error('Unexpected instruction session'); }
		if (new URLSearchParams(location.search).has('instructionFailure')) { throw new Error('Instruction catalog failed'); }
		if (new URLSearchParams(location.search).has('deferInstructions')) { await new Promise<void>(resolve => instructionWaiters.push(resolve)); }
		return [
			{ path: '/workspace/.ash/instructions/review.md', name: 'API review', description: 'Check public contracts', scope: 'directory' },
			{ path: '/home/user/.ash/instructions/style.md', name: 'Writing style', description: 'Short paragraphs', scope: 'user' },
		];
	},
});
services.registerInstance(IChatSessionNavigationService, {
	getActiveConversation: () => ({ sessionId: 'active-session', threadId: 'active-thread' }),
	getConversations: () => [{ sessionId: 'active-session', threadId: 'active-thread', title: 'Current session' }, { sessionId: 'previous-session', threadId: 'previous-thread', title: 'Earlier design' }],
	appendToActiveDraft: () => { }, captureActiveDraft: async () => undefined, openConversation: async (sessionId, threadId) => { recordDestination({ sessionId, threadId }); },
});
services.registerInstance(IChatService, {
	readThread: async (sessionId: string, threadId: string) => ({
		transcript: {
			sessionId, threadId, durableSequence: 2, revision: 1, entries: [
				{ type: 'item', transient: false, item: { type: 'userMessage', text: 'Design the attachment picker' } },
				{ type: 'item', transient: false, item: { type: 'agentMessage', text: 'Use one resource search owner' } },
				{ type: 'item', transient: false, item: { type: 'reasoning', text: 'Private reasoning is not attached' } },
			]
		}
	}),
} as unknown as IChatService);
services.registerInstance(IGitService, {
	listRepositories: async () => [{ id: 'repo', label: 'workspace' }],
	graph: async () => ({ remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'alpha' } }] }),
} as unknown as IGitService);
const githubReads = document.createElement('output');
githubReads.setAttribute('aria-label', 'GitHub reads');
githubReads.textContent = '[]';
document.body.append(githubReads);
const recordGitHubRead = (value: unknown): void => { githubReads.textContent = JSON.stringify([...JSON.parse(githubReads.textContent!), value]); };
const gitHubSearchWaiters = new Map<string, () => void>();
const gitHubContextService: Pick<IGitHubService, 'listAccounts' | 'listIssues' | 'readIssue' | 'listPullRequests' | 'readPullRequest' | 'listPullRequestFiles'> = {
	listAccounts: async () => new URLSearchParams(location.search).has('noGitHubAccount') ? [] : [{ id: 'account', login: 'developer', host: 'github.com', status: 'ready', credentialRevision: 1n }, ...(new URLSearchParams(location.search).has('multipleGitHubAccounts') ? [{ id: 'work-account', login: 'work-developer', host: 'github.company.test', status: 'ready' as const, credentialRevision: 2n }] : [])],
	listIssues: async (repository, _state, query, page, token) => {
		recordGitHubRead({ type: 'issues', repository, query, page });
		if (query && new URLSearchParams(location.search).has('deferGitHubSearch')) {
			await new Promise<void>(resolve => gitHubSearchWaiters.set(query, resolve));
			recordGitHubRead({ type: 'completed', repository, query, cancelled: token?.isCancellationRequested });
		}
		return { items: [{ number: page === 1 ? 12 : 13, title: query === 'older' ? 'Old result' : page === 1 ? 'Attachment issue' : 'Follow-up issue', state: 'open', url: '', updatedAt: '', labels: [], assignees: [] }], nextPage: page === 1 ? 2 : null, notice: '' };
	},
	readIssue: async (repository, number) => {
		recordGitHubRead({ type: 'issue', repository, number });
		return { number, title: 'Attachment issue', state: 'open', url: `https://${repository.host}/${repository.owner}/${repository.name}/issues/${number}`, body: 'Issue body', updatedAt: '', labels: [], assignees: [], comments: [{ id: 1, body: 'Issue discussion', url: '', updatedAt: '' }] };
	},
	listPullRequests: async (repository, _state, page) => {
		recordGitHubRead({ type: 'pullRequests', repository, page });
		return { items: [await gitHubContextService.readPullRequest(repository, 24)], nextPage: null };
	},
	readPullRequest: async (repository, number) => {
		recordGitHubRead({ type: 'pullRequest', repository, number });
		return { number, title: 'Picker improvement', state: 'open', url: `https://${repository.host}/${repository.owner}/${repository.name}/pull/${number}`, body: 'PR body', headBranch: 'feature', baseBranch: 'main', headCommit: 'abc123', draft: false, mergedAt: null, mergeable: true, headRepository: null, autoMerge: false };
	},
	listPullRequestFiles: async () => ({ items: [{ status: 'modified', filename: 'picker.ts', patch: '+attach context', additions: 1, deletions: 0, changes: 1, previousFilename: null }], nextPage: null, limitReached: false }),
};
services.registerInstance(IGitHubService, gitHubContextService as unknown as IGitHubService);
services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
const accessibleView = { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService;
services.registerInstance(IAccessibleViewService, accessibleView);
const modelChanged = resources.add(new Emitter<void>());
const preferenceWrites: unknown[] = [];
let selectedReasoningEffort: ModelReasoningEffort | undefined;
const modelOptions = new URLSearchParams(location.search).get('modelOptions');
const multipleAcceleration = new URLSearchParams(location.search).get('acceleration') === 'multiple';
let models: readonly ModelCatalogEntry[] = [{
	model: { provider: 'openai', model: 'test-model' }, displayName: 'Test Model',
	inputModalities: new URLSearchParams(location.search).get('imageCapability') === 'text' ? ['text'] : new URLSearchParams(location.search).get('imageCapability') === 'image' ? ['text', 'image'] : null,
	longContext: false, contextWindow: 272_000, defaultContextWindow: 272_000, maximumContextWindow: 872_000,
	description: 'A model for everyday tasks',
	supportedReasoningEfforts: [{ effort: 'low', description: 'Fast responses with lighter reasoning' }, { effort: 'high', description: 'Greater reasoning depth for complex problems' }],
	defaultReasoningEffort: 'low',
	selectedAcceleration: null, accelerationOptions: [{ id: 'priority', name: 'Fast', description: 'Faster responses, increased usage' }, ...(multipleAcceleration ? [{ id: 'ultrafast', name: 'Ultra Fast', description: 'Priority processing, increased usage' }] : [])],
}];
if (modelOptions === 'effort' || modelOptions === 'none') {
	models = models.map(entry => ({ ...entry, longContext: null }));
}
if (modelOptions === 'context' || modelOptions === 'none') {
	models = models.map(entry => ({ ...entry, supportedReasoningEfforts: [] }));
}
if (new URLSearchParams(location.search).get('modelSet') === 'multiple') {
	models = [...models, { ...models[0], model: { provider: 'openai', model: 'extended-model' }, displayName: 'Extended model with a longer display name for coding' }];
}
let hiddenModels: readonly ModelCatalogEntry[] | undefined;
let selectedModel: ModelRef = models[0].model;
let automatic = false;
services.registerInstance(ILanguageModelsService, {
	readApprovalReviewModel: async () => ({ type: 'automatic' }),
	setApprovalReviewModel: async () => { },
	onDidChangeModels: modelChanged.event,
	setModelPreferences: async (model, update) => {
		preferenceWrites.push({ model, update });
		models = models.map(entry => entry.model.provider === model.provider && entry.model.model === model.model ? {
			...entry,
			selectedAcceleration: update.acceleration !== undefined ? update.acceleration : entry.selectedAcceleration,
			longContext: update.longContext ?? entry.longContext,
			contextWindow: update.longContext === undefined ? entry.contextWindow : update.longContext ? entry.maximumContextWindow : entry.defaultContextWindow,
		} : entry);
		renderModels();
		modelChanged.fire();
	},
	listModels: async () => models,
	getDefaultNewChatModel: () => undefined,
	rememberSelectedModel: () => { },
	listModelCatalog: async () => models,
	listCustomModelProviders: async () => [],
	saveCustomModelProvider: async () => { },
	testProviderModel: async () => ({ type: 'passed' }),
	listModelProviders: async () => [],
	setModelProviderApiKey: async () => { },
	removeModelProviderApiKey: async () => { },
	listAdvisorModels: async () => [],
	refreshModels: async () => [],
	isModelVisible: () => true,
	setModelVisible: async () => { },
	discoverProviderModels: async () => [],
} satisfies ILanguageModelsService);
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IDictationService, undefined);
services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
registerTestDictationOnboarding(services);
const notifications = resources.add(new NotificationService());
services.registerInstance(INotificationService, notifications);
const quickInput = resources.add(new QuickInputController(document.body));
services.registerInstance(IQuickInputService, quickInput);
services.registerInstance(IQuickAccessController, resources.add(services.createInstance(QuickAccessController)));
services.registerInstance(IHistoryService, { getHistory: () => [{ resource: URI.file('/workspace/closed.ts') }], goBack: async () => { }, goForward: async () => { }, reopenLastClosedEditor: async () => { } } satisfies IHistoryService);
const openedEditors = document.createElement('output');
openedEditors.setAttribute('aria-label', 'Opened editor count');
openedEditors.textContent = '0';
document.body.append(openedEditors);
services.registerInstance(IEditorService, { openEditor: async () => { openedEditors.textContent = String(Number(openedEditors.textContent) + 1); } } as unknown as IEditorService);
const contextPicks = new ChatContextPickService();
services.registerInstance(IChatContextPickService, contextPicks);
resources.add(contextPicks.registerPicker({
	id: 'integration.context', label: 'Test source', isEnabled: () => true,
	providePicks: async query => {
		if (query === 'error') { throw new Error('Context source failed'); }
		return [{ label: 'Source context', attachment: { id: 'source', kind: 'source', name: 'Source context', resolve: async () => ({ name: 'Source context', content: 'Registered context content' }) } }];
	},
}));
const hasContextSources = new URLSearchParams(location.search).has('contextSources');
const languageFeatures = resources.add(new LanguageFeaturesService());
services.registerInstance(ILanguageFeaturesService, languageFeatures);
const symbolWaiters = new Map<string, () => void>();
const symbolReads = document.createElement('output');
symbolReads.setAttribute('aria-label', 'Symbol reads');
symbolReads.textContent = '[]';
document.body.append(symbolReads);
let symbolSource = 'before\nfunction attach() {\n  return 42;\n}\nafter';
let terminalSource = 'context terminal ready';
let searchSnapshot: { query: string; content: string; matchCount: number; } | undefined = hasContextSources ? { query: 'needle', content: '# Search: needle\n# File: file:///workspace/main.ts\n  2:1-2:7: needle', matchCount: 1 } : undefined;
const terminalInstance: ITerminalInstance = {
	...Disposable.None, id: 'context-shell', dirId: 'workspace', processId: 1, initialCwd: '/workspace', title: 'Shell',
	profile: { profileId: 'shell', title: 'Shell', isDefault: true }, state: 'running', exitCode: undefined,
	onDidWriteData: Event.None, onDidExit: Event.None, onDidChangeCommandStatus: Event.None, onDidChangeState: Event.None,
	start: () => { }, clearBuffer: () => terminalScreen?.clearBuffer(), reuseTerminal: async () => { throw new Error('Screen-only fixture has no process to reuse'); },
	xterm: undefined, xtermReadyPromise: Promise.resolve(undefined), getContribution: () => null, attachToElement: () => { }, detachFromElement: () => { }, sendText: async () => { }, processBinary: async () => { }, resize: () => { }, close: async () => { },
};
const terminalHost = document.createElement('div');
document.body.append(terminalHost);
services.registerInstance(IAccessibilitySignalService, { playSignal: async () => { }, playSignalLoop: () => Disposable.None });
const terminalScreen = hasContextSources ? resources.add(services.createInstance(XtermTerminal, terminalHost, terminalInstance)) : undefined;
terminalScreen?.write(`\x1b[32m${terminalSource}\x1b[0m\r\n`);
const terminalInstances = hasContextSources ? [terminalInstance] : [];
services.registerInstance(ITerminalService, { instances: terminalInstances } as unknown as ITerminalService);
services.registerInstance(IViewsService, {
	getViewWithId: (id: string) => id === TERMINAL_VIEW_ID && terminalScreen ? { getTerminalOutput: (_instance: ITerminalInstance, limit: number, signal: AbortSignal) => terminalScreen.getBufferText(limit, signal) } : id === SEARCH_VIEW_ID && hasContextSources ? { getSearchResultSnapshot: () => searchSnapshot } : null,
} as unknown as IViewsService);
const root = URI.file('/workspace');
const edited = URI.file('/workspace/edited.ts');
services.registerInstance(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ id: 'workspace', index: 0, uri: root, name: 'workspace' }] }) } as unknown as IWorkspaceContextService);
if (hasContextSources) resources.add(registerCodebaseSymbolsWorkspaceSymbolProvider(languageFeatures, {
	search: async (query: string, _limit: number, signal: AbortSignal) => {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(symbolSource));
		const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
		if (query && new URLSearchParams(location.search).has('deferSymbolSearch')) await new Promise<void>(resolve => symbolWaiters.set(query, resolve));
		symbolReads.textContent = JSON.stringify([...JSON.parse(symbolReads.textContent!), { query, aborted: signal.aborted }]);
		return {
			matches: [{
				name: query || 'attach', kind: 'function', path: 'symbol.ts', language: 'typescript', sourceRevision: new URLSearchParams(location.search).has('staleSymbol') ? 'sha256:stale' : `sha256:${revision}`, score: 1, matchedIndices: [],
				declarationRange: { start: { lineIndex: 1, columnIndex: 0 }, end: { lineIndex: 3, columnIndex: 1 } },
				selectionRange: { start: { lineIndex: 1, columnIndex: 9 }, end: { lineIndex: 1, columnIndex: 15 } },
			}]
		};
	},
} as unknown as ICodebaseSymbolsService, services.get(IWorkspaceContextService)));
services.registerInstance(IEditorGroupsService, { groups: [{ inputs: [{ resource: edited }] }] } as unknown as IEditorGroupsService);
services.registerInstance(IWorkingCopyService, { get: (resource: URI) => resource.path === '/workspace/symbol.ts' ? [{ backupKind: 'text', backup: () => symbolSource }] : resource.path === edited.path ? [{ backupKind: 'text', backup: () => 'Unsaved editor text' }] : [] } as unknown as IWorkingCopyService);
const fileSearchWaiters = new Map<number, () => void>();
let fileSearchReads = 0;
let fileSearchCompleted = 0;
const searchReads = document.createElement('output');
searchReads.setAttribute('aria-label', 'File search reads');
const searchCompleted = document.createElement('output');
searchCompleted.setAttribute('aria-label', 'Completed file search reads');
document.body.append(searchReads, searchCompleted);
services.registerInstance(IFileService, {
	hasProvider: () => true,
	readDirectory: async (resource: URI) => {
		if (resource.path === '/workspace' && new URLSearchParams(location.search).has('deferFileSearch')) {
			searchReads.textContent = String(++fileSearchReads);
			await new Promise<void>(resolve => fileSearchWaiters.set(fileSearchReads, resolve));
			searchCompleted.textContent = String(++fileSearchCompleted);
		}
		return resource.path === '/workspace' ? [
			{ resource: URI.file('/workspace/src'), name: 'src', kind: FileKind.Directory },
			{ resource: URI.file('/workspace/brief.txt'), name: 'brief.txt', kind: FileKind.File },
		] : [{ resource: URI.file('/workspace/src/nested.txt'), name: 'nested.txt', kind: FileKind.File }];
	},
	readFile: async (resource: URI) => ({ resource, content: 'Workspace file content', revision: '1' }),
} as unknown as IFileService);
services.registerInstance(IFileSearchService, services.createInstance(BrowserFileSearchService));
const submission = document.createElement('output');
submission.setAttribute('aria-label', 'Submission');
document.body.append(submission);
const errorOutput = document.createElement('output');
errorOutput.setAttribute('aria-label', 'Context error');
document.body.append(errorOutput);
resources.add(notifications.onDidAdd(item => { errorOutput.textContent = item.message; }));

const delegate: ChatInputDelegate = {
	send: async (_text, _mode, _skills, contexts) => {
		submission.textContent = JSON.stringify(await Promise.all((contexts ?? []).map(context => context.resolve())));
		if (new URLSearchParams(location.search).has('sendFailure')) { throw new Error('Send failed'); }
	}, executeCommand: async () => { }, executeServerCommand: async () => { }, interrupt: async () => { },
	selectModel: async model => {
		selectedModel = model;
		automatic = false;
		renderModels();
	}, selectReasoningEffort: async effort => {
		selectedReasoningEffort = effort;
		renderModels();
	}, selectAutomaticModel: async () => {
		automatic = true;
		renderModels();
	},
	listAgents: async () => [], selectAgent: () => { }, selectMode: () => { }, openModelSettings: async () => { },
	resolveInteraction: async response => { if (response.type === 'approval') document.querySelector('output')!.textContent = response.response.decision; },
};
const cowork = new URLSearchParams(location.search).get('surface') === 'cowork';
const part = resources.add(services.createInstance(ChatInputPart, document.querySelector('main')!, delegate, { showContextMenu: () => { }, hideContextMenu: () => { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None } satisfies IContextMenuService, services.get(IContextViewService), accessibleView, notifications, ChatInputEditors, [], {
	modePicker: cowork ? 'hidden' : 'visible',
	modelPickerPosition: cowork ? 'trailing' : 'leading',
}));
const state: ChatInputState = {
	mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false,
	interaction: {
		requestId: 'approval', request: {
			type: 'approval', request: {
				reason: 'Review the requested actions', capabilities: [
					{ kind: 'fileRead', scope: '/workspace/file with spaces.ts' },
					{ kind: 'fileWrite', scope: String.raw`C:\Users\name\file.ts` },
					{ kind: 'fileWrite', scope: String.raw`\\server\share\file.ts` },
					{ kind: 'processSpawn', scope: 'pnpm test <script>' },
					{ kind: 'network', scope: 'https://api.example.test' },
					{ kind: 'credentialUse', scope: 'provider-key' },
					{ kind: 'externalMutation', scope: 'issue:42' },
					{ kind: 'systemConfiguration', scope: 'git.user.email' },
					{ kind: 'userInterface', scope: 'current window' },
					{ kind: 'fileWrite', scope: `/workspace/${'a'.repeat(160)}.ts` },
				],
			}
		}
	},
};
function renderModels(): void {
	part.render({ ...state, models, selectedModel, isAutomaticModel: automatic, selectedReasoningEffort, interaction: undefined });
}
part.render(state);
window.ashChatInputIntegration = {
	modelState: () => ({ selectedModel, automatic, preferences: models.map(({ model, selectedAcceleration, accelerationOptions, longContext }) => ({ model, selectedAcceleration, accelerationOptions, longContext })), preferenceWrites }),
	setModelsAvailable: available => { if (available) { models = hiddenModels ?? models; hiddenModels = undefined; } else { hiddenModels = models; models = []; } renderModels(); modelChanged.fire(); },
	setDescription: description => { models = models.map(entry => ({ ...entry, description })); renderModels(); modelChanged.fire(); },
	changeContextSources: () => {
		symbolSource = 'changed source';
		terminalSource = 'new terminal output';
		terminalScreen?.write(terminalSource);
		searchSnapshot = undefined;
		terminalInstances.length = 0;
	},
	releaseSymbolSearch: query => { const release = symbolWaiters.get(query)!; symbolWaiters.delete(query); release(); },
	restoreCapturedDraft: async () => { const captured = await part.captureDraft(); if (captured) { captured.clear(); part.restoreDraft(captured.draft); } },
	setImageCapability: capability => { models = models.map(entry => ({ ...entry, inputModalities: capability === 'unknown' ? null : capability === 'text' ? ['text'] : ['text', 'image'] })); renderModels(); modelChanged.fire(); },
	releaseGitHubSearch: query => { const release = gitHubSearchWaiters.get(query)!; gitHubSearchWaiters.delete(query); release(); },
	releaseFileSearch: index => {
		const release = fileSearchWaiters.get(index)!;
		fileSearchWaiters.delete(index);
		release();
	},
	setRetirement: retirement => {
		models = models.map(entry => ({ ...entry, retirement }));
		renderModels();
		modelChanged.fire();
	},
	releaseInstructions: () => { for (const resolve of instructionWaiters.splice(0)) resolve(); },
	showModels: renderModels,
	openModels: () => part.openModelSelector(),
	dispose: () => resources.dispose(),
	refresh: () => part.render({ ...state, queuedMessages: 1 }),
	showQuestions: () => part.render({
		...state, interaction: {
			requestId: 'questions', request: {
				type: 'userInput', request: {
					questions: [
						{ id: 'text', header: 'Answer', question: 'Your answer', allowFreeForm: true },
						{ id: 'choice', header: 'Choice', question: 'Your choice', allowFreeForm: false, options: [{ label: 'First', description: 'First option' }] },
					]
				}
			},
		}
	}),
};
part.setVisible(true);
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

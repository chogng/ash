import { VSBuffer } from '../../../src/ash/base/common/buffer.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { createTestLanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/test/common/tools/testLanguageModelToolsService.js';
import { createDiffEditorInput } from '../../../src/ash/workbench/common/editor/diffEditorInput.js';
import { IPathService } from '../../../src/ash/platform/path/common/pathService.js';
import { BrowserPathService } from '../../../src/ash/workbench/services/path/browser/pathService.js';
import { IRendererHostService } from '../../../src/ash/platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { ISearchService } from '../../../src/ash/workbench/services/search/common/search.js';
import { SearchService } from '../../../src/ash/workbench/services/search/common/searchService.js';
import { IContentSearchService } from '../../../src/ash/platform/search/common/search.js';
import { IFileTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { emptyEditorServiceState } from '../../../src/ash/workbench/test/common/testEditorService.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import '../../../src/ash/workbench/common/theme.js';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/sessions/browser/media/chatViewPane.css';
import { TerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalConfigurationService.js';
import { ITerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { ITerminalLogService } from '../../../src/ash/platform/terminal/common/terminal.js';
import { TerminalLogService } from '../../../src/ash/platform/terminal/common/terminalLogService.js';
import { ILoggerService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { IMenuService, MenusRegistry } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../src/ash/platform/contextkey/common/contextkey.js';
import { extensionMenuId } from '../../../src/ash/workbench/services/extensions/common/extensionMenus.js';
import { Lxicon } from '../../../src/ash/base/common/lxicons.js';
import { IMessageHistoryService, type MessageHistoryEntry, type MessageHistoryQuery } from '../../../src/ash/platform/messageHistory/common/messageHistory.js';
import '../../../src/ash/workbench/contrib/chat/browser/chat.shared.contribution.js';
import { ILanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { IInstructionService } from '../../../src/ash/platform/instructions/common/instructionService.js';
import { IAppServerRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/appServerRemoteAgentService.js';
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeaturesService.js';
import { registerCodebaseSymbolsWorkspaceSymbolProvider } from '../../../src/ash/workbench/services/codebaseSymbols/browser/codebaseSymbolsWorkspaceSymbolProvider.js';
import type { ICodebaseSymbolsService } from '../../../src/ash/platform/codebaseSymbols/common/codebaseSymbolsService.js';
import { ITerminalService, type ITerminalInstance } from '../../../src/ash/workbench/services/terminal/browser/terminal.js';
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
import { ICommandService, CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { FileKind, IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { IHistoryService } from '../../../src/ash/workbench/services/history/common/history.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import '../../../src/ash/workbench/contrib/quickaccess/browser/quickAccess.contribution.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js';
import { IChatContextPickService } from '../../../src/ash/workbench/services/chat/common/chatContextService.js';
import { ChatContextPickService } from '../../../src/ash/workbench/services/chat/browser/chatContextPickService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { ActionWidgetService, IActionWidgetService } from '../../../src/ash/platform/actionWidget/browser/actionWidget.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../src/ash/workbench/services/chat/common/modelCatalog.js';
import type { ChatContextUsage, ModelRef } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import '../../../src/ash/workbench/contrib/chat/browser/widget/media/chat.css';
import { ChatInputPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputEditors } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { ChatInputEditor } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { Selection } from '../../../src/ash/editor/common/core/selection.js';
import { registerChatContextActions } from '../../../src/ash/workbench/contrib/chat/browser/actions/chatContextActions.js';
import { CHAT_VIEW_ID } from '../../../src/ash/workbench/contrib/chat/common/chat.js';
import type { ChatInputDelegate, ChatInputState } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInput.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IContextViewService, type IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { IDictationBackendService } from '../../../src/ash/platform/renderer/common/dictation.js';
import { ISpeechService } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { registerTestDictationOnboarding } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { EventType, Gesture } from '../../../src/ash/base/browser/touch.js';
import { addDisposableListener, stopEvent } from '../../../src/ash/base/browser/dom.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { IHostService } from '../../../src/ash/workbench/services/host/browser/host.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IGitHubService } from '../../../src/ash/platform/github/common/githubService.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { setHoverDelegate } from '../../../src/ash/base/browser/ui/hover/hoverDelegate.js';

declare global {
	interface Window { ashChatInputIntegration: { changeTools(): void; setActiveFile(path?: string): void; setActiveDiff(original: string, modified: string, text?: string): void; setChanges(changes: ChatInputState['changes']): void; setVisible(visible: boolean): void; inputAccessibility(): string | undefined; contextAccessibility(): { help: string | undefined; content: string | undefined; }; setFooterPhase(phase: ChatInputState['phase'], error?: string): void; setContextUsage(available: boolean, capacity?: number, estimatedTokens?: number): void; setFooterStatus(visible: boolean): void; removeFooterStatus(): void; historyState(): unknown; holdNextHistoryRead(): void; releaseHistorySearch(query: string): void; addHistoryContext(): void; setHistorySkill(digest: string): void; refresh(): void; showQuestions(): void; showModels(): void; openModels(): void; setDescription(description: string | null): void; setModelsAvailable(available: boolean): void; modelState(): unknown; setImageCapability(capability: 'text' | 'image' | 'unknown'): void; restoreCapturedDraft(): Promise<string | undefined>; setRetirement(retirement: ModelCatalogEntry['retirement']): void; dispose(): void; releaseFileSearch(index: number): void; releaseGitHubSearch(query: string): void; releaseSymbolSearch(query: string): void; releaseInstructions(): void; changeContextSources(): void; disposeContextTerminal(): void; }; }
}

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}
const resources = new DisposableStore();
setARIAContainer(document.body);
const themes = { dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const themeName = new URLSearchParams(location.search).get('theme') as keyof typeof themes | null;
const theme = resources.add(new TestThemeService(themes[themeName ?? 'dark']));
resources.add(bindColorTheme(theme, document.body));
if (new URLSearchParams(location.search).has('gestureAncestor')) {
	const main = document.querySelector('main')!;
	resources.add(Gesture.addTarget(main));
	resources.add(addDisposableListener(main, EventType.Tap, event => { stopEvent(event); document.querySelector('output')!.textContent = 'Ancestor tap'; }));
}
const services = resources.add(new InstantiationService());
services.registerInstance(IAppServerRemoteAgentService, {
	connection: undefined, connectionState: undefined,
	onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None,
	reconnect: async () => { throw new Error('This fixture has no remote connection'); },
	rollbackRuntime: async () => { throw new Error('This fixture has no remote runtime'); },
});
const historyEnabled = new URLSearchParams(location.search).has('history');
let historyEntries: MessageHistoryEntry[] = [
	{ id: '3', text: 'third input', kind: 'agent', submittedAtMs: 3 },
	{ id: '2', text: 'second input\nsecond line', kind: 'agent', submittedAtMs: 2 },
	{ id: '1', text: 'first input', kind: 'agent', submittedAtMs: 1 },
];
const historyWrites: string[] = [];
const historySubmissions: { text: string; skills: unknown; }[] = [];
const historyReads: MessageHistoryQuery[] = [];
const historyWaits = new Map<string, () => void>();
let holdHistoryRead = false;
const historyData = (query: MessageHistoryQuery) => {
	const matches = historyEntries.filter(entry => (!query.before || Number(entry.id) < Number(query.before)) && entry.text.toLowerCase().includes(query.text.toLowerCase()));
	const entries = matches.slice(0, 2);
	return { entries, nextBefore: matches.length > 2 ? entries.at(-1)!.id : undefined };
};
services.registerInstance(IMessageHistoryService, historyEnabled ? {
	append: async submission => {
		historyWrites.push(submission.text);
		const entry = { ...submission, id: String(Number(historyEntries[0]?.id ?? 0) + 1), submittedAtMs: 4 };
		historyEntries.unshift(entry);
		return entry;
	},
	read: async query => {
		historyReads.push(query);
		if (holdHistoryRead || query.text.startsWith('wait')) {
			holdHistoryRead = false;
			await new Promise<void>(resolve => { historyWaits.set(query.text, resolve); });
		}
		return historyData(query);
	},
	clear: async () => { historyEntries = []; },
} : undefined);
const destinations = document.createElement('output');
destinations.setAttribute('aria-label', 'Opened sources');
destinations.textContent = '[]';
document.body.append(destinations);
const recordDestination = (value: unknown): void => { destinations.textContent = JSON.stringify([...JSON.parse(destinations.textContent!), value]); };
services.registerInstance(IThemeService, theme);
services.registerInstance(IOpenerService, { open: async (resource, options) => { recordDestination({ resource: resource.toString(), options }); return true; } } as IOpenerService);
services.registerInstance(ICommandService, { executeCommand: async (id: string, resource?: unknown) => { if (id === 'git.getRepositoryContexts' || id === 'workbench.action.chat.attachSelection' || id === 'undo' || id === 'redo') { return CommandsRegistry.getCommand(id)!(services); } recordDestination({ command: id, ...(resource !== undefined ? { resource: URI.isUri(resource) ? resource.toString() : resource } : {}) }); } } as unknown as ICommandService);
const contextKeys = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contextKeys);
services.registerSingleton(IMenuService, () => services.createInstance(MenuService));
const footerStatusVisible = contextKeys.createKey<boolean>('test.chat.status.visible', false);
const footerStatus = new URLSearchParams(location.search).has('footerStatus')
	? resources.add(MenusRegistry.appendMenuItem(extensionMenuId('chat/input/status'), {
		command: { id: 'test.chat.status', title: 'Extension status', icon: Lxicon.chat4 },
		when: ContextKeyExpr.has('test.chat.status.visible'), group: 'status',
	})) : undefined;
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));
services.registerInstance(IClipboardService, {
	triggerPaste: () => undefined,
	read: async () => [],
	readFindText: async () => '',
	writeFindText: async () => { },
	readImage: async () => new URLSearchParams(location.search).has('emptyClipboard') ? new Uint8Array() : png,
	readText: async () => '', writeText: async () => { }, readResources: async () => ({ resources: [], operation: 'copy' }), writeResources: async () => { }, hasResources: async () => false,
});
let screenshotCalls = 0;
let screenshotVisibleOverlays: number[] = [];
let releaseScreenshot: (() => void) | undefined;
services.registerInstance(IHostService, {
	hasFocus: true, onDidChangeFocus: Event.None, restart: async () => { }, openWindow: async () => { },
	async getScreenshot() {
		screenshotCalls++;
		screenshotVisibleOverlays.push([...document.querySelectorAll('dialog[open], [role="dialog"]')].filter(element => element.checkVisibility()).length);
		if (new URLSearchParams(location.search).has('holdScreenshot')) await new Promise<void>(resolve => { releaseScreenshot = resolve; });
		if (new URLSearchParams(location.search).has('cancelScreenshot')) return undefined;
		if (new URLSearchParams(location.search).has('screenshotFixture')) {
			const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 480;
			const context = canvas.getContext('2d')!;
			context.fillStyle = screenshotCalls === 1 ? '#ff0000' : '#0000ff'; context.fillRect(0, 0, 800, 480);
			context.fillStyle = '#ffff00'; context.fillRect(400, 240, 400, 240);
			const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
			return VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer()));
		}
		return VSBuffer.wrap(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/QAAADggGA8sg/+gAAAABJRU5ErkJggg=='), character => character.charCodeAt(0)));
	}
});
let toolsChanged = false;
const toolCatalogChanges = resources.add(new Emitter<void>());
services.registerSingleton(ILanguageModelToolsService, () => createTestLanguageModelToolsService({
	isAvailable: !new URLSearchParams(location.search).has('noTools'),
	onDidChangeTools: toolCatalogChanges.event,
	read: async () => {
		if (new URLSearchParams(location.search).has('toolFailure')) { throw new Error('Tool catalog failed'); }
		return {
			sourceGroups: [{ id: 'local', source: 'local', sourceId: 'directory', tools: ['read_file', toolsChanged ? 'added_tool' : 'write_file'] }, { id: 'mcp:docs', source: 'mcp', sourceId: 'docs-server', tools: ['connector_search'] }],
			tools: [
				{ name: 'read_file', description: 'Read a source document', source: 'local', sourceDetails: ['directory'], exposure: 'direct', authority: 'directoryRead' },
				{ name: toolsChanged ? 'added_tool' : 'write_file', description: toolsChanged ? 'Added source document' : 'Write a source document', source: 'local', sourceDetails: ['directory'], exposure: 'direct', authority: 'directoryWrite' },
				{ name: 'connector_search', description: 'Search external references', source: 'mcp', sourceDetails: ['docs-server'], exposure: 'deferred', authority: 'providerDefined' },
				{ name: 'internal_broker', description: 'Hidden broker', source: 'host', sourceDetails: [], exposure: 'hidden', authority: 'productService' },
			],
		};
	},
}));
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
	startVoiceConversation: async () => { throw new Error("Unexpected voice start"); },
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
resources.add(CommandsRegistry.register('git.getRepositoryContexts', () => [{ id: 'repo', label: 'workspace', path: '/workspace', root: 'file:///workspace', head: { type: 'branch', name: 'main', objectId: 'abc' }, remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'alpha' } }] }]));

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
	rememberSelectedModel: async () => { },
	readModelDefaults: async () => ({ revision: 1, model: null, reasoningEffort: null }),
	saveReasoningEffort: async () => { },
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
services.registerInstance(IDictationBackendService, undefined);
services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
if (!services.has(IChatSpeechToTextService)) services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
registerTestDictationOnboarding(services);
const notifications = resources.add(new NotificationService());
services.registerInstance(INotificationService, notifications);
const quickInput = resources.add(new TestQuickInputService({ instantiationService: services, container: document.body }));
services.registerInstance(IQuickInputService, quickInput);
services.registerInstance(IHistoryService, { getHistory: () => [{ resource: URI.file('/workspace/closed.ts') }], goBack: async () => { }, goForward: async () => { }, reopenLastClosedEditor: async () => { } } satisfies IHistoryService);
const openedEditors = document.createElement('output');
openedEditors.setAttribute('aria-label', 'Opened editor count');
openedEditors.textContent = '0';
document.body.append(openedEditors);
const activeEditorChanged = resources.add(new Emitter<void>());
let activeEditor: IResourceEditorInput | undefined;
services.registerInstance(IEditorService, {
	...emptyEditorServiceState,
	onDidActiveEditorChange: activeEditorChanged.event,
	get activeEditor() { return activeEditor; },
	openEditor: async () => { openedEditors.textContent = String(Number(openedEditors.textContent) + 1); },
	focusActiveEditor() { },
} satisfies IEditorService);
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
const reportShellHistory = new URLSearchParams(location.search).has('shellHistory');
const disableCommandStorage = new URLSearchParams(location.search).has('disableCommandStorage');
const terminalInstance: ITerminalInstance = {
	...Disposable.None, id: 'context-shell', instanceId: 1, dirId: 'workspace', processId: 1, initialCwd: '/workspace', cwd: new URLSearchParams(location.search).get('terminalCwd') ?? undefined, title: 'Shell',
	...(reportShellHistory ? {
		shellIntegration: {
			commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: disableCommandStorage,
			commands: disableCommandStorage ? [] : [
				{ commandId: 'first', status: 'succeeded' as const, exitCode: 0, command: 'echo 中文; "quoted"', isTrusted: true, cwd: '/workspace' },
				{ commandId: 'second', status: 'failed' as const, exitCode: 9, command: 'unverified\ncommand', isTrusted: false, cwd: '/workspace/current' },
			],
		}
	} : {}),
	profile: { profileId: 'shell', title: 'Shell', isDefault: true }, state: 'running', exitCode: undefined,
	onDidWriteData: Event.None, onDidExit: Event.None, onDidChangeCommandStatus: Event.None, onDidChangeState: Event.None,
	start: () => { }, clearBuffer: () => terminalScreen?.clearBuffer(), reuseTerminal: async () => { throw new Error('Screen-only fixture has no process to reuse'); },
	xterm: undefined, xtermReadyPromise: Promise.resolve(undefined), getContribution: () => null, attachToElement: () => { }, detachFromElement: () => { }, sendSignal: async () => { }, sendText: async () => { }, processBinary: async () => { }, resize: () => { }, close: async () => { },
};
const root = URI.file('/workspace');
services.registerInstance(IWorkspaceContextService, resources.add(new WorkspaceContextService({ id: 'workspace', folders: [{ id: 'workspace', index: 0, uri: root, name: 'workspace' }] })));
const terminalHost = document.createElement('div');
document.body.append(terminalHost);
services.registerInstance(IAccessibilitySignalService, { playSignal: async () => { }, playSignalLoop: () => Disposable.None });
if (hasContextSources) services.registerInstance(ITerminalConfigurationService, resources.add(services.createInstance(TerminalConfigurationService)));
if (hasContextSources) {
	services.registerInstance(ILoggerService, resources.add(new NullLoggerService()));
	services.registerSingleton(ITerminalLogService, () => services.createInstance(TerminalLogService));
}
if (hasContextSources) services.registerInstance(IHoverService, resources.add(new HoverService(services.get(IConfigurationService), services.get(IContextViewService), { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } })));
const terminalScreen = hasContextSources ? resources.add(services.createInstance(XtermTerminal, terminalHost, terminalInstance)) : undefined;
terminalScreen?.write(`\x1b[32m${terminalSource}\x1b[0m\r\n`);
const terminalInstances = hasContextSources ? [terminalInstance] : [];
services.registerInstance(ITerminalService, { instances: terminalInstances } as unknown as ITerminalService);
services.registerInstance(IViewsService, {
	openView: async (id: string) => id === CHAT_VIEW_ID ? part : undefined,
	getViewWithId: (id: string) => id === TERMINAL_VIEW_ID && terminalScreen ? { getTerminalOutput: (_instance: ITerminalInstance, limit: number, signal: AbortSignal) => terminalScreen.getBufferText(limit, signal) } : id === SEARCH_VIEW_ID && hasContextSources ? { getSearchResultSnapshot: () => searchSnapshot } : null,
} as unknown as IViewsService);
const edited = URI.file('/workspace/edited.ts');
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
// Attachment Quick Access uses the same file-query owner as Search. This fixture
// has no shared file models or content query scenario.
services.registerInstance(IContentSearchService, { search: async () => { throw new Error('Chat context fixture does not run content searches'); } });
services.registerInstance(IFileTextModelService, {
	...Disposable.None,
	onDidChangeEncoding: Event.None, onModelAdded: Event.None, onModelRemoved: Event.None, onModelLanguageChanged: Event.None,
	getEncodingSupport: () => undefined, getModel: () => null, getModels: () => [], hasPendingSaveRecovery: () => false,
	addSaveParticipant: () => Disposable.None, addSaveCompletionParticipant: () => Disposable.None,
	waitForSaveRecovery: async () => { }, refresh: async () => { },
	acquire: async () => { throw new Error('Chat context fixture has no shared file models'); },
});
services.registerInstance(ISearchService, services.createInstance(SearchService));
services.registerInstance(IRendererHostService, createDisconnectedRendererApi());
services.registerInstance(IPathService, services.createInstance(BrowserPathService));

const submission = document.createElement('output');
submission.setAttribute('aria-label', 'Submission');
document.body.append(submission);
const errorOutput = document.createElement('output');
errorOutput.setAttribute('aria-label', 'Context error');
document.body.append(errorOutput);
resources.add(notifications.onDidAdd(item => { errorOutput.textContent = item.message; }));

if (new URLSearchParams(location.search).has('contextHover')) {
	const hover = resources.add(new HoverService(services.get(IConfigurationService), services.get(IContextViewService), {
		contextMenuStyle: 'custom',
		showContextMenu: () => { }, hideContextMenu: () => { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	}));
	resources.add(setHoverDelegate(hover));
}

const delegate: ChatInputDelegate = {
	send: async (_text, _mode, _skills, contexts) => {
		historySubmissions.push({ text: _text, skills: _skills });
		submission.textContent = JSON.stringify(await Promise.all((contexts ?? []).map(context => context.resolve())));
		if (new URLSearchParams(location.search).has('sendFailure')) { throw new Error('Send failed'); }
	}, executeCommand: async invocation => { recordDestination({ command: invocation.commandId }); }, executeServerCommand: async () => { }, interrupt: async () => { },
	openChanges: async () => { recordDestination({ changes: true }); },
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
	listAgents: async () => [], selectAgent: () => { }, selectMode: () => { }, selectApprovalMode: async approvalMode => { state = { ...state, approvalMode, interaction: undefined }; part.render(state); recordDestination({ approvalMode }); },
	openModelSettings: async () => { recordDestination({ settings: 'models' }); },
	resolveInteraction: async response => { if (response.type === 'approval') document.querySelector('output')!.textContent = response.response.decision; else if (response.type === 'permissions') document.querySelector('output')!.textContent = JSON.stringify(response.response); },
};
const cowork = new URLSearchParams(location.search).get('surface') === 'cowork';
const inlineCode = new URLSearchParams(location.search).has('inlineCode');
if (inlineCode) {
	registerCodeEditorServices(services);
	resources.add(registerChatContextActions());
}
const editorProvider = inlineCode ? { create: (options: Parameters<typeof ChatInputEditors.create>[0]) => services.createInstance(ChatInputEditor, options) } : ChatInputEditors;
const part = resources.add(services.createInstance(ChatInputPart, document.querySelector('main')!, delegate, { contextMenuStyle: 'custom', showContextMenu: () => { }, hideContextMenu: () => { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None } satisfies IContextMenuService, services.get(IContextViewService), accessibleView, notifications, editorProvider, [], {
	modePicker: cowork ? 'hidden' : 'visible',
	modelPickerPosition: cowork ? 'trailing' : 'leading',
	renderSecondaryToolbar: !cowork,
}));
if (inlineCode) {
	const source = document.createElement('section');
	source.id = 'code-selection-source';
	source.style.cssText = 'width:600px;height:200px;margin-top:24px';
	document.body.append(source);
	const model = resources.add(new TextModel('first\nsecond\nconst unsaved = 42;\nreturn unsaved;\nlast', { resource: URI.file('/workspace/example.ts'), languageId: 'typescript' }));
	const editor = resources.add(services.createInstance(CodeEditorWidget, { container: source, model }));
	editor.layout({ width: 600, height: 200 });
	const add = document.createElement('button');
	add.id = 'add-code-selection';
	add.textContent = 'Add selected code';
	add.onclick = () => {
		editor.setSelection(new Selection(3, 1, 5, 1));
		editor.focus();
		void services.get(ICommandService).executeCommand('workbench.action.chat.attachSelection');
	};
	document.body.append(add);
}
if (new URLSearchParams(location.search).has('sessionsLayout')) {
	// Exercise the Chat host's production CSS with the real, auto-growing composer.
	const body = document.querySelector('main')!;
	const layout = new URLSearchParams(location.search).get('sessionsLayout');
	const view = document.createElement('section');
	view.className = 'ash-chat-view';
	view.style.cssText = 'width:380px;height:400px';
	body.replaceWith(view);
	view.append(body);
	body.className = `ash-chat-body${layout === 'closed' ? '' : ' sessions-stacked sessions-sidebar-visible'}`;
	const sidebar = document.createElement('aside');
	sidebar.className = 'ash-chat-sessions-sidebar';
	sidebar.hidden = layout === 'closed';
	const sessions = document.createElement('button');
	sessions.textContent = 'Session fixture';
	sidebar.append(sessions);
	const host = document.createElement('div');
	host.className = 'ash-chat-pane-host';
	const chat = document.createElement('div');
	chat.className = new URLSearchParams(location.search).has('newChat') ? 'ash-chat empty' : 'ash-chat has-conversation';
	const transcript = document.createElement('div');
	transcript.className = 'ash-chat-list-widget';
	const message = document.createElement('p');
	message.textContent = 'Retained conversation';
	message.style.height = '1200px';
	transcript.append(message);
	chat.append(transcript, part.element);
	host.append(chat);
	body.append(sidebar, host);
}
function sampleContextCategories(tokens: number): ChatContextUsage['categories'] {
	const systemPrompt = Math.floor(tokens * 0.2);
	const systemTools = Math.floor(tokens * 0.4);
	const memoryFiles = Math.floor(tokens * 0.1);
	const skills = Math.floor(tokens * 0.05);
	return [
		{ category: 'systemPrompt', tokens: systemPrompt },
		{ category: 'systemTools', tokens: systemTools },
		{ category: 'memoryFiles', tokens: memoryFiles },
		{ category: 'skills', tokens: skills },
		{ category: 'conversation', tokens: tokens - systemPrompt - systemTools - memoryFiles - skills },
	];
}

let state: ChatInputState = {
	mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready',
	contextUsage: { estimatedTokens: 200, contextWindow: 1000, autoCompactAt: 800, categories: sampleContextCategories(200), latestRequestTokens: 180 }, canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false,
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
if (new URLSearchParams(location.search).has('permissions')) {
	state = {
		...state, interaction: {
			requestId: 'permissions', request: {
				type: 'permissions', request: {
					environmentId: 'local', duration: 'session', reason: 'Read this project',
					directories: [{ path: '/workspace/<img src=x>', permissions: ['readFiles', 'writeFiles'] }], networkHosts: ['api.example.test'],
				}
			}
		}
	};
}
function renderModels(): void {
	state = { ...state, models, selectedModel, isAutomaticModel: automatic, selectedReasoningEffort };
	part.render({ ...state, interaction: undefined });
}
part.render(state);
window.ashChatInputIntegration = {
	changeTools: () => { toolsChanged = true; toolCatalogChanges.fire(); },
	setActiveDiff: (original, modified, text) => {
		activeEditor = createDiffEditorInput({ resource: URI.parse(original), initialText: 'Original contents', readOnly: true }, { resource: URI.parse(modified), ...(text === undefined ? {} : { initialText: text, readOnly: true }) });
		activeEditorChanged.fire();
	},
	setActiveFile: path => { activeEditor = path ? { resource: URI.parse(path) } : undefined; activeEditorChanged.fire(); },
	setChanges: changes => { state = { ...state, changes, interaction: undefined }; part.render(state); },
	setVisible: visible => part.setVisible(visible),
	inputAccessibility: () => {
		for (const entry of AccessibleViewRegistry.getImplementations()) {
			if (entry.type !== AccessibleViewType.Help || !entry.name.startsWith('chatAttachments-')) continue;
			const provider = entry.getProvider(services);
			if (!provider) continue;
			try { return provider.provideContent(); }
			finally { provider.dispose(); }
		}
		return undefined;
	},
	contextAccessibility: () => {
		const content = (type: AccessibleViewType): string | undefined => {
			for (const entry of AccessibleViewRegistry.getImplementations()) {
				if (entry.type !== type || !entry.name.startsWith(inlineCode ? 'chatAttachments-' : 'chatContextUsage-')) continue;
				const provider = entry.getProvider(services);
				if (!provider) continue;
				try { return provider.provideContent(); }
				finally { provider.dispose(); }
			}
			return undefined;
		};
		return { help: content(AccessibleViewType.Help), content: content(AccessibleViewType.View) };
	},
	setFooterPhase: (phase, error) => { state = { ...state, phase, error, interaction: undefined }; part.render(state); },
	setContextUsage: (available, capacity, estimatedTokens = 200) => { state = { ...state, contextUsage: available ? { estimatedTokens, contextWindow: capacity, categories: sampleContextCategories(estimatedTokens), latestRequestTokens: 180 } : undefined, interaction: undefined }; part.render(state); },
	setFooterStatus: visible => footerStatusVisible.set(visible),
	removeFooterStatus: () => footerStatus?.dispose(),
	historyState: () => ({ writes: historyWrites, submissions: historySubmissions, reads: historyReads }),
	holdNextHistoryRead: () => { holdHistoryRead = true; },
	releaseHistorySearch: query => historyWaits.get(query)?.(),
	addHistoryContext: () => part.addContext({ id: 'history-context', kind: 'file', name: 'draft.txt', resource: URI.parse('file:///workspace/draft.txt'), resolve: async () => ({ name: 'draft.txt', content: 'synthetic context' }) }),
	setHistorySkill: digest => part.render({ ...state, skillSelectors: [{ name: 'commit', description: 'Commit the synthetic change', source: 'user', skill: { id: { source: 'user:skill-source:test', name: 'commit' }, version: { type: 'pinnedDigest', digest } } }] }),
	modelState: () => ({ selectedModel, automatic, preferences: models.map(({ model, selectedAcceleration, accelerationOptions, longContext }) => ({ model, selectedAcceleration, accelerationOptions, longContext })), preferenceWrites }),
	setModelsAvailable: available => { if (available) { models = hiddenModels ?? models; hiddenModels = undefined; } else { hiddenModels = models; models = []; } renderModels(); modelChanged.fire(); },
	setDescription: description => { models = models.map(entry => ({ ...entry, description })); renderModels(); modelChanged.fire(); },
	disposeContextTerminal: () => { terminalScreen?.dispose(); terminalInstances.length = 0; },
	changeContextSources: () => {
		symbolSource = 'changed source';
		terminalSource = 'new terminal output';
		terminalScreen?.write(terminalSource);
		searchSnapshot = undefined;
		terminalInstances.length = 0;
	},
	releaseSymbolSearch: query => { const release = symbolWaiters.get(query)!; symbolWaiters.delete(query); release(); },
	restoreCapturedDraft: async () => { const captured = await part.captureDraft(); if (captured) { captured.clear(); part.restoreDraft(captured.draft); } return captured?.draft.text; },
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


declare global {
	interface Window {
		ashScreenshotIntegration: {
			state(): { calls: number; overlays: number[]; pending: boolean; providers: number; };
			release(): void;
			switchDraft(): void;
			accessibility(type: 'help' | 'view'): string | undefined;
		};
	}
}
window.ashScreenshotIntegration = {
	state: () => ({ calls: screenshotCalls, overlays: screenshotVisibleOverlays, pending: part.attachmentModel.hasPendingContext, providers: AccessibleViewRegistry.getImplementations().filter(entry => entry.name.startsWith('chatScreenshot-')).length }),
	release: () => { releaseScreenshot?.(); releaseScreenshot = undefined; },
	switchDraft: () => { part.invalidatePendingInput(); part.restoreDraft({ mode: state.mode, text: 'Next conversation', contexts: [] }); },
	accessibility: type => {
		const entry = AccessibleViewRegistry.getImplementations().find(entry => entry.name.startsWith('chatScreenshot-') && entry.type === type);
		const provider = entry?.getProvider(services);
		if (!provider) return undefined;
		try { return provider.provideContent(); } finally { provider.dispose(); }
	}
};

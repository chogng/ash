import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import { CustomViewService, ICustomViewService } from '../../../../../sessions/services/customView/browser/customViewService.js';
import { ISessionProviderScopeService, type ISessionProviderScope, type SessionProviderServices } from '../../../../../sessions/browser/agentHost/sessionProviderScopeService.js';
import { ISCMService, ISCMViewService } from '../../../../contrib/scm/common/scm.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { SCMService } from '../../../../contrib/scm/common/scmService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IChangesViewService } from '../../../../../sessions/contrib/changes/common/changesViewService.js';
import { ChangesViewService } from '../../../../../sessions/contrib/changes/browser/changesViewService.js';
import { IChecksOperationService } from '../../../../../sessions/contrib/changes/common/checksOperationService.js';
import { ChecksOperationService } from '../../../../../sessions/contrib/changes/browser/checksOperationService.js';
import type { ISessionChangesService } from '../../../../../sessions/contrib/changes/common/sessionChangesService.js';
import '../../../../../base/browser/ui/styles.css';
import '../../../../browser/media/style.css';
import { Pane, PaneView } from '../../../../../base/browser/ui/splitview/paneview.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { localize, setNlsMessages } from '../../../../../nls.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { type IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { bindTestColorTheme } from '../../../../../../../test/fixtures/browser/themeFixture.js';
import { lightColorTheme, darkColorTheme, highContrastLightColorTheme, highContrastDarkColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { SymphonyTasksView } from '../../../../../sessions/contrib/symphony/browser/symphonyViews.js';
import { type ISymphonyService, type SymphonyViewState } from '../../../../../sessions/contrib/symphony/browser/symphonyService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { TestNotificationService } from '../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ChangesViewPane } from '../../../../../sessions/contrib/changes/browser/changesView.js';
import { ISessionsService } from '../../../../../sessions/services/sessions/browser/sessionsService.js';
import { IChatService, type TurnChangeDetails } from '../../../../services/chat/common/chatService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { Repl } from '../../../../contrib/debug/browser/repl.js';
import { registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IDebugService } from '../../../../contrib/debug/common/debug.js';
import { ViewModel } from '../../../../contrib/debug/common/debugViewModel.js';
import '../../../../contrib/debug/browser/media/debugViewlet.css';
import { ProblemsViewPane } from '../../../../contrib/problems/browser/problemsViewPane.js';
import { BulkEditPane } from '../../../../contrib/bulkEdit/browser/preview/bulkEditPane.js';
import { TunnelPanel } from '../../../../contrib/remote/browser/tunnelView.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { type ITunnelService } from '../../../../../platform/tunnel/common/tunnel.js';
import { type IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import '../../../../contrib/problems/browser/media/problems.css';
import { EmptyView } from '../../../../contrib/files/browser/views/emptyView.js';
import { ScmAgentReviewViewPane } from '../../../../contrib/scm/browser/scmAgentReviewViewPane.js';
import '../../../../contrib/files/browser/media/explorerviewlet.css';
import '../../../../contrib/scm/browser/media/scm.css';
import { IGitHubService as ISessionGitHubService } from '../../../../../sessions/contrib/github/browser/githubService.js';
import { IGitHubService as IGitHubApi } from '../../../../../platform/github/common/githubService.js';
import { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { HoverService, IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../../../platform/accessibility/browser/accessibilityService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ITimelineService, type TimelineChangeEvent } from '../../../../contrib/timeline/common/timeline.js';
import { TimelineService } from '../../../../contrib/timeline/common/timelineService.js';
import { TimelinePane } from '../../../../contrib/timeline/browser/timelinePane.js';
import '../../../../contrib/timeline/browser/timeline.contribution.js';

const params = new URLSearchParams(location.search);
if (params.get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
const resources = new DisposableStore();
const root = document.querySelector<HTMLElement>('#root')!;
resources.add(bindTestColorTheme(resources.add(new TestThemeService(params.has('hc') ? highContrastDarkColorTheme : params.has('hcLight') ? highContrastLightColorTheme : params.has('dark') ? darkColorTheme : lightColorTheme)), root));
const contextKeys = resources.add(new ContextKeyService());
contextKeys.setContext('openFolderWorkspaceSupport', true);
const configuration = resources.add(new InMemoryConfigurationService());
const notifications = resources.add(new TestNotificationService());
const changesServices = resources.add(new InstantiationService());
const scopeHost = createDisconnectedRendererApi();
const providerScope: ISessionProviderScope = { providerId: 'fixture', services: { host: scopeHost } as SessionProviderServices, thread: scopeHost.thread, identity: value => value, backendIdentity: value => value, assertCurrent() { } };
changesServices.registerInstance(ISessionProviderScopeService, {
	onDidChange: Event.None, onDidChangeScopes: Event.None, getScopes: () => [providerScope],
	getScope: () => providerScope, getProviderScope: () => providerScope, createScope: () => changesServices.createChild(),
});
changesServices.registerInstance(IContextKeyService, contextKeys);
changesServices.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({ root, configurationService: configuration, contextKeyService: contextKeys })));
changesServices.registerInstance(ISessionGitHubService, { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as ISessionGitHubService);
changesServices.registerInstance(IGitHubApi, {} as IGitHubApi);
changesServices.registerInstance(IAccountService, { onDidChangeAccounts: Event.None } as unknown as IAccountService);
changesServices.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
changesServices.registerInstance(INotificationService, notifications);
changesServices.registerInstance(ISessionsService, {
	activeSelection: { kind: 'session', active: { threadId: 'fixture-thread', session: { sessionId: 'fixture' } } },
	onDidChange: Event.None,
} as unknown as ISessionsService);
changesServices.registerInstance(IChecksOperationService, resources.add(changesServices.createInstance(ChecksOperationService)));
changesServices.registerInstance(ICommandService, { executeCommand: async () => [] } as unknown as ICommandService);
changesServices.registerInstance(IQuickInputService, {} as IQuickInputService);
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'viewpane-layout', flushInterval: 0 }));
const replServices = resources.add(new InstantiationService());
replServices.registerInstance(IContextKeyService, contextKeys);
registerCodeEditorServices(replServices);
const debugViewModel = resources.add(new ViewModel());
changesServices.registerInstance(IStorageService, storage);
changesServices.registerInstance(ILogService, new NullLoggerService());
changesServices.registerSingleton(ICustomViewService, () => changesServices.createInstance(CustomViewService));
const changesViewState = resources.add(changesServices.createInstance(ChangesViewService));
changesServices.registerInstance(IChangesViewService, changesViewState);
const commands: string[] = [];
const submissions: { title: string; prompt: string; }[] = [];
let watchers = 0;
// Model and controls remain production-owned; this boundary cannot open a live trace or submit a real task.
const symphony: ISymphonyService = {
	state: observableValue<SymphonyViewState>('layout fixture', {
		workflows: [{ id: 'fixture', path: '/fixture/WORKFLOW.md', tracker: 'fixture', enabled: true, error: undefined }],
		conversations: [], selected: undefined, messages: [], loading: false, error: undefined,
	}),
	available: true,
	watch: () => { watchers++; return toDisposable(() => { watchers--; }); },
	refresh: async () => { }, select: () => { }, configure: async () => { },
	submit: async (_id, title, prompt) => { submissions.push({ title, prompt }); },
	control: async () => { }, enable: async () => { },
};
const editors: IEditorService = {
	activeEditor: undefined, visibleEditors: [], activeEditorPane: undefined, visibleEditorPanes: [], onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None,
	openEditor: async () => { throw new Error('Editor opening is outside this fixture'); }, focusActiveEditor: () => { },
	save: async () => { throw new Error('Saving is outside this fixture'); }, saveAll: async () => { throw new Error('Saving is outside this fixture'); },
};
const view = params.get('view');
const changes: TurnChangeDetails = {
	summary: { changeSetId: 'fixture', sessionId: 'fixture', threadId: 'fixture-thread', turnId: 'turn', repositoryId: 'repo', statistics: { files: 30, additions: 30, deletions: 30 }, captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1 },
	files: Array.from({ length: 30 }, (_, index) => ({ path: `file-${index}.ts`, kind: 'modified', binary: false, additions: 1, deletions: 1 })),
};
changesServices.registerInstance(IChatService, {
	onDidUpdateTurnChanges: Event.None,
	onDidBecomeReady: Event.None,
	listTurnChanges: async () => [changes.summary],
	readTurnChange: async () => changes,
} as unknown as IChatService);
const workspace = resources.add(new TestWorkspaceService(params.has('emptyWorkspace') ? { id: 'empty' } : { id: 'fixture', uri: URI.file('/fixture') }));
const contextMenus = resources.add(new BrowserContextMenuService(
	new MenuService(changesServices.get(ICommandService), contextKeys), contextKeys,
	{ lookupKeybinding: () => undefined } as unknown as IKeybindingService,
	resources.add(new BrowserContextViewService(root)), notifications));
const copiedProblems: string[] = [];
const clipboard = { writeText: async (text: string) => { copiedProblems.push(text); } } as IClipboardService;
const markers = resources.add(new MarkerService());
markers.changeAll('fixture', [{ resource: URI.file('/fixture/file.ts'), marker: { severity: MarkerSeverity.Error, message: 'Fixture problem', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 } }]);
if (params.has('noProblems')) markers.changeAll('fixture', []);
const replDebug = {
	onDidChangeSession: Event.None, getSession: () => undefined, getViewModel: () => debugViewModel,
	replModel: {
		...Disposable.None, sessions: [], activeSession: { id: 'fixture', label: 'Fixture', state: 'stopped', elements: [{ id: 1, sessionId: 'fixture', kind: 'output', output: 'Fixture output', category: 'console', parentId: null, collapsed: false, variablesReference: null, source: null, line: null, column: null, data: null }], output: 'Fixture output', canEvaluate: true },
		onDidChange: Event.None, selectSession: () => { }, clear: () => { }, evaluate: async () => { throw new Error('Evaluation failed. '.repeat(12)); },
	}
} as unknown as IDebugService;
const replScope = resources.add(replServices.createChild(new ServiceCollection(
	[IDebugService, replDebug], [IWorkspaceContextService, workspace], [IEditorService, editors],
	[IFileService, resources.add(new FileService())], [IUriIdentityService, new SyncDescriptor(UriIdentityService)],
	[IStorageService, storage], [IAccessibleViewService, { ...Disposable.None, getOpenAriaHint: () => undefined, show: () => false, disableHint: async () => { }, showAccessibleViewHelp() { } }],
)));
const timelineRequests: { cursor: number; uri: string; }[] = [];
const heldTimelineRequests: DeferredPromise<void>[] = [];
const timelineChanges = resources.add(new Emitter<TimelineChangeEvent>());
let timelineMode: 'normal' | 'hold' | 'fail' | 'stall' = 'normal';
let timelineService: TimelineService | undefined;
function createTimelinePane(): TimelinePane {
	void configuration.updateValue('timeline.pageSize', params.has('shortPages') ? 1 : 8);
	const log = resources.add(new NullLoggerService());
	const contextViews = resources.add(new BrowserContextViewService(root));
	const scope = resources.add(changesServices.createChild(new ServiceCollection(
		[IConfigurationService, configuration], [IEditorService, editors],
		[ISCMService, resources.add(new SCMService())], [IContextViewService, contextViews], [IClipboardService, clipboard],
		[IFileService, resources.add(new FileService())], [IContextMenuService, contextMenus],
		[IHoverService, resources.add(new HoverService(configuration, contextViews, contextMenus))],
		[IAccessibleViewService, replScope.get(IAccessibleViewService)], [ILogService, log],
		[ICommandService, { executeCommand: async (id: string) => { commands.push(id); } } as ICommandService],
		[IViewsService, { openView: async () => pane } as unknown as IViewsService],
	)));
	timelineService = resources.add(scope.createInstance(TimelineService));
	scope.registerInstance(ITimelineService, timelineService);
	resources.add(timelineService.registerTimelineProvider({
		...Disposable.None, id: 'fixture', label: 'Fixture History', scheme: 'file',
		onDidChange: timelineChanges.event,
		async provideTimeline(uri, options) {
			const offset = Number(options.cursor ?? 0);
			const mode = timelineMode;
			timelineMode = 'normal';
			timelineRequests.push({ cursor: offset, uri: uri.path });
			if (params.has('emptyTimeline')) return undefined;
			if (mode === 'hold') {
				const pending = new DeferredPromise<void>();
				heldTimelineRequests.push(pending);
				await pending.p;
			}
			if (mode === 'fail') throw new Error('Fixture continuation failed');
			if (mode === 'stall') return { source: 'fixture', items: [], paging: { cursor: options.cursor } };
			const count = Math.min(typeof options.limit === 'number' ? options.limit : 8, 25 - offset);
			return {
				source: 'fixture',
				items: Array.from({ length: count }, (_, index) => ({
					handle: String(offset + index), source: 'fixture', label: `${uri.path} Entry ${offset + index}`,
					timestamp: 1000 - offset - index, icon: Lxicon.gitCommit, command: { id: 'fixture.open', title: 'Open Entry' },
				})),
				paging: { cursor: offset + count < 25 ? String(offset + count) : undefined },
			};
		},
	}));
	resources.add(toDisposable(() => {
		for (const pending of heldTimelineRequests.splice(0)) pending.complete();
	}));
	return scope.createInstance(TimelinePane, root, { id: 'fixture.timeline', title: localize('timeline.title', 'Timeline') });
}
function createReviewPane(): ScmAgentReviewViewPane {
	const scope = resources.add(changesServices.createChild());
	scope.registerInstance(ISCMViewService, { activeRepository: { id: 'fixture', provider: { rootUri: URI.file('/fixture') } }, onDidChangeActiveRepository: Event.None } as unknown as ISCMViewService);
	scope.registerInstance(IContextMenuService, contextMenus);
	scope.registerInstance(IAgentSessionService, scopeHost.session);
	scope.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
	scope.registerInstance(IConfigurationService, configuration);
	return scope.createInstance(ScmAgentReviewViewPane, root, { id: 'fixture.review', title: 'Agent Review' });
}
const pane = resources.add(view === 'timeline' ? createTimelinePane() : view === 'empty'
	? new EmptyView(root, { id: 'fixture.empty', title: 'Files' }, {
		pickFolderAndOpen: async () => { throw new Error('Folder opening failed. '.repeat(12)); },
	} as unknown as import('../../../../../platform/dialogs/common/dialogs.js').IFileDialogService, contextKeys)
	: view === 'review'
		? createReviewPane()
		: view === 'problems'
			? new ProblemsViewPane(root, { id: 'fixture.problems', title: 'Problems' }, markers, editors, workspace, contextMenus, clipboard)
			: view === 'bulk'
				? new BulkEditPane(root, { id: 'fixture.bulk', title: 'Refactor Preview' }, configuration, editors, contextKeys, resources.add(new InstantiationService()))
				: view === 'ports'
					? new TunnelPanel(root, { id: 'fixture.ports', title: 'Ports' }, {
						onTunnelOpened: Event.None, onTunnelClosed: Event.None, tunnels: Promise.reject(new Error('Port discovery failed. '.repeat(12))),
					} as unknown as ITunnelService, {
						connection: { kind: 'ssh', generation: 1, authority: 'ssh+fixture', host: 'fixture' }, connectionState: 'connected',
						onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None,
					} as unknown as IAppServerRemoteAgentService)
					: view === 'changes'
						? new ChangesViewPane(root, { id: 'fixture.changes', title: 'Changes' },
							changesServices.get(ISessionsService), changesServices.get(IChatService),
							editors, configuration, contextKeys, notifications, {} as IQuickInputService,
							{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, changesServices, changesViewState,
							{ openChangesEditor: async () => { throw new Error('Opening review editors is outside this layout fixture'); } } as unknown as ISessionChangesService, storage)
						: view === 'console'
							? replScope.createInstance(Repl, root, { id: 'fixture.console', title: 'Console' })
							: new SymphonyTasksView(root, { id: 'fixture.symphony', title: 'Symphony' }, symphony, configuration, contextKeys,
								{ showOpenDialog: async () => { throw new Error('File picking is outside this fixture'); } } as unknown as IFileDialogService));
const panes = resources.add(new PaneView(root));
panes.addPane(pane, 180);
if (view !== 'symphony') {
	panes.addPane(resources.add(new Pane(root, { id: 'fixture.sibling', title: 'Other view', minimumBodySize: 0 })), 0);
}
panes.layout(180, 280);
pane.setVisible(true);
timelineService?.setUri(URI.file('/fixture/file.txt'));
window.viewpaneLayoutIntegration = {
	commands, submissions, copiedProblems, watchers: () => watchers, dispose: () => resources.dispose(),
	timeline: {
		requests: timelineRequests,
		setMode: mode => { timelineMode = mode; },
		release: () => { for (const pending of heldTimelineRequests.splice(0)) pending.complete(); },
		setFile: path => timelineService!.setUri(URI.file(path)),
		invalidate: path => timelineChanges.fire({ id: 'fixture', uri: URI.file(path), reset: true }),
		content: () => (pane as TimelinePane).getAccessibleContent(),
	},
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';

declare global {
	interface Window {
		viewpaneLayoutIntegration: {
			readonly commands: readonly string[];
			readonly copiedProblems: readonly string[];
			readonly submissions: readonly { title: string; prompt: string; }[];
			watchers(): number;
			dispose(): void;
			readonly timeline: {
				readonly requests: readonly { cursor: number; uri: string; }[];
				setMode(mode: 'normal' | 'hold' | 'fail' | 'stall'): void;
				release(): void;
				setFile(path: string): void;
				invalidate(path: string): void;
				content(): string;
			};
		};
	}
}

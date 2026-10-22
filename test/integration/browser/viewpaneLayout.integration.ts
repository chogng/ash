import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../../src/ash/platform/instantiation/common/descriptors.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { IUriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentityService.js';
import type { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import type { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { IChangesViewService } from '../../../src/ash/sessions/contrib/changes/common/changesViewService.js';
import { ChangesViewService } from '../../../src/ash/sessions/contrib/changes/browser/changesViewService.js';
import { IChecksOperationService } from '../../../src/ash/sessions/contrib/changes/common/checksOperationService.js';
import { ChecksOperationService } from '../../../src/ash/sessions/contrib/changes/browser/checksOperationService.js';
import type { ISessionChangesService } from '../../../src/ash/sessions/contrib/changes/common/sessionChangesService.js';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import { Pane, PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { type IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { bindTestColorTheme } from './themeFixture.js';
import { lightColorTheme, darkColorTheme, highContrastLightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { SymphonyTasksView } from '../../../src/ash/sessions/contrib/symphony/browser/symphonyViews.js';
import { type ISymphonyService, type SymphonyViewState } from '../../../src/ash/sessions/contrib/symphony/browser/symphonyService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { TestNotificationService } from './notificationFixture.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { ChangesViewPane } from '../../../src/ash/sessions/contrib/changes/browser/changesView.js';
import { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import { IChatService, type TurnChangeDetails } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { Repl } from '../../../src/ash/workbench/contrib/debug/browser/repl.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IDebugService } from '../../../src/ash/workbench/contrib/debug/common/debug.js';
import { ViewModel } from '../../../src/ash/workbench/contrib/debug/common/debugViewModel.js';
import '../../../src/ash/workbench/contrib/debug/browser/media/debugViewlet.css';
import { ProblemsViewPane } from '../../../src/ash/workbench/contrib/problems/browser/problemsViewPane.js';
import { BulkEditPane } from '../../../src/ash/workbench/contrib/bulkEdit/browser/preview/bulkEditPane.js';
import { TunnelPanel } from '../../../src/ash/workbench/contrib/remote/browser/tunnelView.js';
import { MarkerSeverity } from '../../../src/ash/platform/markers/common/markers.js';
import { MarkerService } from '../../../src/ash/platform/markers/common/markerService.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { type ITunnelService } from '../../../src/ash/platform/tunnel/common/tunnel.js';
import { type IAppServerRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/appServerRemoteAgentService.js';
import '../../../src/ash/workbench/contrib/problems/browser/media/problems.css';
import { EmptyView } from '../../../src/ash/workbench/contrib/files/browser/views/emptyView.js';
import { ScmAgentReviewViewPane } from '../../../src/ash/workbench/contrib/scm/browser/scmAgentReviewViewPane.js';
import '../../../src/ash/workbench/contrib/files/browser/media/explorerviewlet.css';
import '../../../src/ash/workbench/contrib/scm/browser/media/scm.css';
import { IGitHubService as ISessionGitHubService } from '../../../src/ash/sessions/contrib/github/browser/githubService.js';
import { IGitHubService as IGitHubApi } from '../../../src/ash/platform/github/common/githubService.js';
import { IAccountService } from '../../../src/ash/platform/accounts/common/accountService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';

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
changesServices.registerInstance(IContextKeyService, contextKeys);
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
const pane = resources.add(view === 'empty'
	? new EmptyView(root, { id: 'fixture.empty', title: 'Files' }, {
		pickFolderAndOpen: async () => { throw new Error('Folder opening failed. '.repeat(12)); },
	} as unknown as import('../../../src/ash/platform/dialogs/common/dialogs.js').IFileDialogService, contextKeys)
	: view === 'review'
		? new ScmAgentReviewViewPane(root, { id: 'fixture.review', title: 'Agent Review' })
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
window.viewpaneLayoutIntegration = { commands, submissions, copiedProblems, watchers: () => watchers, dispose: () => resources.dispose() };
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
		};
	}
}

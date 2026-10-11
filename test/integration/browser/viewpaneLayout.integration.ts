import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import { Pane, PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { type IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { lightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { SymphonyTasksView } from '../../../src/ash/sessions/contrib/symphony/browser/symphonyViews.js';
import { type ISymphonyService, type SymphonyViewState } from '../../../src/ash/sessions/contrib/symphony/browser/symphonyService.js';
import { AgentTraceNavigationView } from '../../../src/ash/workbench/contrib/trace/browser/agentTraceNavigation.js';
import { type IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { ChangesViewPane } from '../../../src/ash/sessions/contrib/changes/browser/changesView.js';
import { type ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import { type IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { type IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { type IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { DebugConsoleViewPane } from '../../../src/ash/workbench/contrib/debug/browser/debugConsoleViewPane.js';
import '../../../src/ash/workbench/contrib/debug/browser/media/debug.css';
import { ProblemsViewPane } from '../../../src/ash/workbench/contrib/problems/browser/problemsViewPane.js';
import { TasksViewPane } from '../../../src/ash/workbench/contrib/tasks/browser/tasksViewPane.js';
import { BulkEditPane } from '../../../src/ash/workbench/contrib/bulkEdit/browser/preview/bulkEditPane.js';
import { TunnelPanel } from '../../../src/ash/workbench/contrib/remote/browser/tunnelView.js';
import { MarkerService, MarkerSeverity } from '../../../src/ash/platform/markers/common/markers.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { type ITaskService } from '../../../src/ash/workbench/services/tasks/common/taskService.js';
import { type IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { type ITerminalService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { type ITunnelService } from '../../../src/ash/platform/tunnel/common/tunnel.js';
import { type IAppServerRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/appServerRemoteAgentService.js';
import '../../../src/ash/workbench/contrib/tasks/browser/media/tasks.css';
import '../../../src/ash/workbench/contrib/problems/browser/media/problems.css';

const params = new URLSearchParams(location.search);
if (params.get('locale') === 'zh-CN') {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
const resources = new DisposableStore();
const root = document.querySelector<HTMLElement>('#root')!;
resources.add(bindColorTheme(resources.add(new TestThemeService(params.has('hc') ? highContrastDarkColorTheme : lightColorTheme)), root));
const contextKeys = resources.add(new ContextKeyService());
const configuration = resources.add(new InMemoryConfigurationService());
const notifications = resources.add(new NotificationService());
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'viewpane-layout', flushInterval: 0 }));
const commands: string[] = [];
const submissions: { title: string; prompt: string }[] = [];
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
	activeEditor: undefined, visibleEditors: [], onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None,
	openEditor: async () => { throw new Error('Editor opening is outside this fixture'); }, focusActiveEditor: () => { },
	save: async () => { throw new Error('Saving is outside this fixture'); }, saveAll: async () => { throw new Error('Saving is outside this fixture'); },
};
const view = params.get('view');
const markers = resources.add(new MarkerService());
markers.set('fixture', [{ resource: URI.file('/fixture/file.ts'), severity: MarkerSeverity.Error, message: 'Fixture problem', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } } }]);
const pane = resources.add(view === 'problems'
	? new ProblemsViewPane(root, { id: 'fixture.problems', title: 'Problems' }, markers, editors)
	: view === 'bulk'
		? new BulkEditPane(root, { id: 'fixture.bulk', title: 'Refactor Preview' }, configuration, editors, contextKeys, resources.add(new InstantiationService()))
	: view === 'tasks'
		? new TasksViewPane(root, { id: 'fixture.tasks', title: 'Tasks' }, {
			...Disposable.None, tasks: [{ id: 'fixture', label: 'Fixture task', command: 'fixture', group: 'test', source: 'vscode' }], activeRuns: [], lastRun: undefined,
			onDidChangeTasks: Event.None, onDidStartTask: Event.None, onDidChangeTaskRun: Event.None,
			refresh: async () => { throw new Error('Task discovery failed. '.repeat(12)); },
		} as unknown as ITaskService, {} as IViewsService, {} as ITerminalService)
	: view === 'ports'
		? new TunnelPanel(root, { id: 'fixture.ports', title: 'Ports' }, {
			onTunnelOpened: Event.None, onTunnelClosed: Event.None, tunnels: Promise.reject(new Error('Port discovery failed. '.repeat(12))),
		} as unknown as ITunnelService, {
			connection: { kind: 'ssh', generation: 1, authority: 'ssh+fixture', host: 'fixture' }, connectionState: 'connected',
			onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None,
		} as unknown as IAppServerRemoteAgentService)
	: view === 'changes'
	? new ChangesViewPane(root, { id: 'fixture.changes', title: 'Changes' },
		{ activeSelection: undefined, onDidChange: Event.None } as unknown as ISessionsService,
		{ onDidUpdateTurnChanges: Event.None, onDidBecomeReady: Event.None } as unknown as IChatService,
		editors, configuration, contextKeys, notifications, {} as IQuickInputService,
		{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService)
	: view === 'console'
		? new DebugConsoleViewPane(root, { id: 'fixture.console', title: 'Console' }, {
			...Disposable.None, sessions: [], activeSession: { id: 'fixture', label: 'Fixture', state: 'stopped', output: 'Fixture output', canEvaluate: true },
			onDidChange: Event.None, selectSession: () => { }, clear: () => { }, evaluate: async () => { throw new Error('Evaluation failed. '.repeat(12)); },
		})
	: view === 'symphony'
	? new SymphonyTasksView(root, { id: 'fixture.symphony', title: 'Symphony' }, symphony, configuration, contextKeys,
		{ showOpenDialog: async () => { throw new Error('File picking is outside this fixture'); } } as unknown as IFileDialogService)
	: new AgentTraceNavigationView({ resume: 'fixture.resume', current: 'fixture.current', offline: 'fixture.offline' }, root,
		{ id: 'fixture.trace', title: 'Trace' }, { onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async <T>(id: string) => { commands.push(id); return undefined as T; } }, editors, storage, notifications, contextKeys));
const panes = resources.add(new PaneView(root));
panes.addPane(pane, 180);
if (view !== 'symphony' && view !== null) {
	panes.addPane(resources.add(new Pane(root, { id: 'fixture.sibling', title: 'Other view', minimumBodySize: 0 })), 0);
}
panes.layout(180, 280);
pane.setVisible(true);
window.viewpaneLayoutIntegration = { commands, submissions, watchers: () => watchers, dispose: () => resources.dispose() };
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';

declare global {
	interface Window {
		viewpaneLayoutIntegration: {
			readonly commands: readonly string[];
			readonly submissions: readonly { title: string; prompt: string }[];
			watchers(): number;
			dispose(): void;
		};
	}
}

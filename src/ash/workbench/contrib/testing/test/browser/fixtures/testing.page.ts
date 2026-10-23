import { TestUriIdentityServices } from '../../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { setNlsResolver, formatNlsMessage } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import '../../../../../../base/browser/ui/tree/tree.css';
import '../../../../../../base/browser/ui/list/list.css';
import '../../../../../../base/browser/ui/splitview/paneview.css';
import '../../../../../../base/browser/ui/button/button.css';
import '../../../browser/media/testing.css';
import { Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { OperatingSystem } from '../../../../../../base/common/platform.js';
import { createSshRemoteWorkspaceUri } from '../../../../../../platform/remote/common/remote.js';
import { BrowserPathService } from '../../../../../services/path/browser/pathService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IRendererHostService } from '../../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../../browser/rendererApi.js';
import { NullLoggerService } from '../../../../../../platform/log/common/log.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { type IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { create, createModel } from '../../../../../../editor/standalone/browser/standaloneEditor.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { BrowserWorkingCopyService } from '../../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { TestingService } from '../../../../../services/testing/browser/testingService.js';
import { TestExecutionService, TestDebugService } from '../../../../../services/testing/test/common/testExecutionService.js';
import { type ITaskService } from '../../../../tasks/common/taskService.js';
import { type ITerminalService } from '../../../../terminal/browser/terminal.js';
import { type IViewsService } from '../../../../../services/views/common/viewsService.js';
import { type IEditorService, type EditorOpenOptions } from '../../../../../services/editor/common/editorService.js';
import { TestingViewPane } from '../../../browser/testingViewPane.js';
import { TestingEditorContribution } from '../../../browser/testingEditorContribution.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { Pane, PaneView } from '../../../../../../base/browser/ui/splitview/paneview.js';

if (new URLSearchParams(location.search).get('locale') === 'zh-cn') {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}

const store = new DisposableStore();
const uriIdentityServices = store.add(new TestUriIdentityServices());
const backend = store.add(new TestExecutionService());
const parameters = new URLSearchParams(location.search);
const rootPath = parameters.get('root') ?? '/workspace';
const root = parameters.has('remote') ? createSshRemoteWorkspaceUri(parameters.get('remote')!, rootPath) : URI.parse(parameters.get('rootUri') ?? 'file:///workspace');
const workspace = store.add(new TestWorkspaceService({ id: 'workspace', uri: root }));
const api = createDisconnectedRendererApi();
uriIdentityServices.registerInstance(IWorkspaceContextService, workspace);
uriIdentityServices.registerInstance(IRendererHostService, {
	...api, hasAppServer: true,
	appServer: { ...api.appServer, operatingSystem: parameters.get('os') === 'windows' ? OperatingSystem.Windows : OperatingSystem.Macintosh },
});
const paths = uriIdentityServices.createInstance(BrowserPathService);
backend.failurePath = parameters.get('failure') ?? backend.failurePath;
const copies = store.add(uriIdentityServices.createInstance(BrowserWorkingCopyService));
let scriptRuns = 0;
const tasks: ITaskService = {
	...Disposable.None,
	tasks: [{ id: 'script', label: 'cargo test', group: 'test', command: 'cargo test', source: 'cargo' }], runs: [], activeRuns: [], lastRun: undefined,
	onDidChangeTasks: Event.None, onDidStartTask: Event.None, onDidChangeTaskRun: Event.None,
	registerTaskProvider: () => toDisposable(() => { }),
	registerTaskProviders: () => Object.assign(toDisposable(() => { }), { replace: () => { } }),
	rerun: async () => { throw new Error('Rerunning is outside this fixture'); },
	runProvidedTask: async () => { throw new Error('Extension tasks are outside this fixture'); },
	refresh: async () => tasks.tasks,
	start: () => { throw new Error('Starting task runs is outside this fixture'); },
	describe: async () => { throw new Error('Task descriptions are outside this fixture'); },
	getRun: () => undefined,
	run: async () => { scriptRuns++; throw new Error('Script invoked'); }, terminate: async () => { },
};
const debug = store.add(new TestDebugService());
const service = store.add(new TestingService(tasks, backend, workspace, copies, new NullLoggerService(), debug.service));
const opened: { path: string; line: number | undefined; uri: string; }[] = [];
const editors: IEditorService = {
	save: async () => { throw new Error('Saving is outside this fixture'); },
	saveAll: async () => { throw new Error('Saving is outside this fixture'); },
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], activeEditorPane: undefined, visibleEditorPanes: [],
	openEditor: async (input, options?: EditorOpenOptions) => { opened.push({ path: input.resource.path, line: options?.selection?.startLineNumber, uri: input.resource.toString() }); },
	focusActiveEditor: () => { },
};
const pane = store.add(new TestingViewPane(document.querySelector<HTMLElement>('#testing')!, { id: 'ash.testing.view', title: 'Testing' }, service,
	{ setActiveInstance: () => { } } as unknown as ITerminalService,
	{ focusView: () => true } as unknown as IViewsService,
	editors, store.add(new InMemoryConfigurationService()),
	{ getOpenAriaHint: () => 'Press Alt+F1 for help.' } as unknown as IAccessibleViewService,
	workspace, paths));
pane.setVisible(true);
if (new URLSearchParams(location.search).has('paneLayout')) {
	await import('../../../../../../base/browser/ui/styles.css');
	await import('../../../../../browser/media/style.css');
	const host = document.querySelector<HTMLElement>('#testing')!;
	host.style.height = '300px';
	host.style.width = '320px';
	const panes = store.add(new PaneView(host));
	panes.addPane(pane, 180);
	const sibling = store.add(new Pane(host, { id: 'testing.sibling', title: 'Other view', minimumBodySize: 0 }));
	panes.addPane(sibling, 120);
	panes.layout(300, 320);
}
const model = store.add(createModel('mod checks {\n #[test]\n fn passes() {}\n fn fails() {}\n}', 'rust', URI.file('/workspace/src/lib.rs')) as TextModel);
const editor = store.add(create(document.querySelector<HTMLElement>('#editor')!, { model, glyphMargin: true, automaticLayout: true }));
store.add(new TestingEditorContribution(editor, model, service, copies, store.add(new TestNotificationService())));
window.addEventListener('pagehide', () => store.dispose(), { once: true });
window.ashTestingIntegration = {
	debugLaunches: () => debug.launches,
	opened, runs: () => backend.runs.map(run => run.tests), scriptRuns: () => scriptRuns,
	addCases: async () => {
		backend.items = [...backend.items, { id: 'macro', package: 'fixture', target: 'fixture', targetKind: 'library', name: 'generated_case', source: null, debuggable: true }, { id: 'doc', package: 'fixture', target: 'fixture', targetKind: 'documentation', name: 'src/lib.rs - docs (line 1)', source: { path: 'src/lib.rs', line: 1 }, debuggable: false }];
		await service.refreshTests();
	},
	hold: () => { backend.holdRuns = true; },
	disconnect: () => { backend.disconnected.fire(); },
	edit: () => model.setValue('\n' + model.getValue()),
	refresh: () => service.refreshTests(),
	accessible: () => pane.getAccessibleContent(),
	dispose: () => store.dispose(),
};
declare global {
	interface Window {
		ashTestingIntegration: {
			debugLaunches(): readonly import('../../../../debug/common/debug.js').IDebugConfiguration[];
			readonly opened: readonly { path: string; line: number | undefined; uri: string; }[];
			runs(): readonly (readonly string[])[]; scriptRuns(): number;
			addCases(): Promise<void>; hold(): void; disconnect(): void; edit(): void; refresh(): Promise<void>; accessible(): string; dispose(): void;
		};
	}
}

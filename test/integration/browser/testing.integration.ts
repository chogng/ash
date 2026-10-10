import { TestUriIdentityServices } from '../../../src/ash/platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { setNlsResolver, formatNlsMessage } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import '../../../src/ash/base/browser/ui/tree/tree.css';
import '../../../src/ash/base/browser/ui/list/list.css';
import '../../../src/ash/base/browser/ui/splitview/paneview.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/workbench/contrib/testing/browser/media/testing.css';
import { Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { type IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { create, createModel } from '../../../src/ash/editor/standalone/browser/standaloneEditor.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { BrowserWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { TestingService } from '../../../src/ash/workbench/services/testing/browser/testingService.js';
import { TestExecutionService, TestDebugService } from '../../../src/ash/workbench/services/testing/test/common/testExecutionService.js';
import { type ITaskService } from '../../../src/ash/workbench/services/tasks/common/taskService.js';
import { type ITerminalService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { type IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { type IEditorService, type EditorOpenOptions } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { TestingViewPane } from '../../../src/ash/workbench/contrib/testing/browser/testingViewPane.js';
import { TestingEditorContribution } from '../../../src/ash/workbench/contrib/testing/browser/testingEditorContribution.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';

if (new URLSearchParams(location.search).get('locale') === 'zh-cn') {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}

const store = new DisposableStore();
const uriIdentityServices = store.add(new TestUriIdentityServices());
const backend = store.add(new TestExecutionService());
const workspace = store.add(new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') }));
const copies = store.add(uriIdentityServices.createInstance(BrowserWorkingCopyService));
let scriptRuns = 0;
const tasks: ITaskService = {
	...Disposable.None,
	tasks: [{ id: 'script', label: 'cargo test', group: 'test', command: 'cargo test', source: 'cargo' }], activeRuns: [], lastRun: undefined,
	onDidChangeTasks: Event.None, onDidStartTask: Event.None, onDidChangeTaskRun: Event.None,
	registerTaskProvider: () => toDisposable(() => { }),
	registerTaskProviders: () => Object.assign(toDisposable(() => { }), { replace: () => { } }),
	rerun: async () => { throw new Error('Rerunning is outside this fixture'); },
	runProvidedTask: async () => { throw new Error('Extension tasks are outside this fixture'); },
	refresh: async () => tasks.tasks,
	run: async () => { scriptRuns++; throw new Error('Script invoked'); }, terminate: async () => { },
};
const debug = store.add(new TestDebugService());
const service = store.add(new TestingService(tasks, backend, workspace, copies, new NullLoggerService(), debug.service));
const opened: { path: string; line: number | undefined; }[] = [];
const editors: IEditorService = {
	save: async () => { throw new Error('Saving is outside this fixture'); },
	saveAll: async () => { throw new Error('Saving is outside this fixture'); },
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [],
	openEditor: async (input, options?: EditorOpenOptions) => { opened.push({ path: input.resource.path, line: options?.selection?.startLineNumber }); },
	focusActiveEditor: () => { },
};
const pane = store.add(new TestingViewPane(document.querySelector<HTMLElement>('#testing')!, { id: 'ash.testing.view', title: 'Testing' }, service,
	{ setActiveInstance: () => { } } as unknown as ITerminalService,
	{ focusView: () => true } as unknown as IViewsService,
	editors, store.add(new InMemoryConfigurationService()),
	{ getOpenAriaHint: () => 'Press Alt+F1 for help.' } as unknown as IAccessibleViewService,
	workspace));
pane.setVisible(true);
const model = store.add(createModel('mod checks {\n #[test]\n fn passes() {}\n fn fails() {}\n}', 'rust', URI.file('/workspace/src/lib.rs')) as TextModel);
const editor = store.add(create(document.querySelector<HTMLElement>('#editor')!, { model, glyphMargin: true, automaticLayout: true }));
store.add(new TestingEditorContribution(editor, model, service, copies, store.add(new NotificationService())));
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
			debugLaunches(): readonly import('../../../src/ash/workbench/services/debug/common/debugService.js').IDebugConfiguration[];
			readonly opened: readonly { path: string; line: number | undefined; }[];
			runs(): readonly (readonly string[])[]; scriptRuns(): number;
			addCases(): Promise<void>; hold(): void; disconnect(): void; edit(): void; refresh(): Promise<void>; accessible(): string; dispose(): void;
		};
	}
}

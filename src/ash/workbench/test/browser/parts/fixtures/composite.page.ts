import { Orientation } from '../../../../../base/browser/ui/sash/sash.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { AbstractLifecycleService } from '../../../../services/lifecycle/common/lifecycleService.js';
import { IndexedDBFileSystemProvider } from '../../../../../platform/files/browser/indexedDBFileSystemProvider.js';
import { ILogService, ILoggerService, LogLevel } from '../../../../../platform/log/common/log.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ElectronWorkbenchEnvironmentService } from '../../../../services/environment/electron-browser/environmentService.js';
import { BrowserWorkingCopyService } from '../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { IDefaultLogLevelsService, DefaultLogLevelsService, readDefaultLogLevels, type DefaultLogLevels } from '../../../../services/log/common/defaultLogLevels.js';
import '../../../../browser/parts/activitybar/media/activitybarpart.css';
import '../../../../browser/parts/activitybar/media/activityaction.css';
import { IActivityService } from '../../../../services/activity/common/activity.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../common/testEditorService.js';
import { registerProblemsView } from '../../../../contrib/problems/browser/problems.contribution.js';
import { registerOutputView } from '../../../../contrib/output/browser/output.contribution.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { registerCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AgentTraceOutput } from '../../../../../sessions/contrib/trace/browser/agentTraceOutput.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../../sessions/services/sessions/browser/sessionsService.js';
import { IChatDebugService } from '../../../../contrib/chat/common/chatDebugService.js';
import { observableValue, type IReader } from '../../../../../base/common/observable.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { AuxiliaryBarPart } from '../../../../browser/parts/auxiliarybar/auxiliaryBarPart.js';
import { Grid } from '../../../../../base/browser/ui/grid/grid.js';
import { WorkbenchPartView } from '../../../../browser/workbenchPartView.js';
import { Part } from '../../../../browser/part.js';
import { PaneComposite } from '../../../../browser/panecomposite.js';
import type { PartTitleProjection } from '../../../../browser/parts/views/viewPane.js';
import { ChatViewTitleControl } from '../../../../contrib/chat/browser/widgetHosts/viewPane/chatViewTitleControl.js';
import { CopyChatSessionLinkAction } from '../../../../contrib/chat/browser/actions/chatCopyActions.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../../../platform/accessibility/browser/accessibilityService.js';
import { BrowserContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { TestNotificationService } from '../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { CompositeBar } from '../../../../browser/parts/compositeBar.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { ActivityService } from '../../../../services/activity/browser/activityService.js';
import { NumberBadge } from '../../../../services/activity/common/activity.js';
import { Pane, PaneView } from '../../../../../base/browser/ui/splitview/paneview.js';
import '../../../../../base/browser/ui/actionbar/actionbar.css';
import '../../../../../base/browser/ui/grid/gridview.css';
import '../../../../../base/browser/ui/splitview/splitview.css';
import '../../../../../platform/theme/common/sizes/baseSizes.js';
import { bindTestColorTheme } from '../../../../../../../test/fixtures/browser/themeFixture.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { HoverService, IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import chatMessages from '../../../../../../../extensions/language-pack-zh-cn/translations/chat.json' with { type: 'json' };
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Keybinding, logicalKey, physicalKey, resolveKeybinding } from '../../../../../base/common/keybindings.js';
import { CommandRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ShowAllCommandsCommandId } from '../../../../browser/quickaccess.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IMenuService, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { PaneCompositePartService } from '../../../../browser/parts/paneCompositePartService.js';
import { PanelPart } from '../../../../browser/parts/panel/panelPart.js';
import { ViewPane, type IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import type { IComposite } from '../../../../common/composite.js';
import { IViewDescriptorService, ViewContainerLocation, WorkbenchViewRegistry } from '../../../../common/views.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { ViewsService } from '../../../../services/views/browser/viewsService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { createTestEditorServices, registerTestComponentServices } from '../../../common/testEditorServices.js';
import { EditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { EditorPart, IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { BrowserEditorService } from '../../../../services/editor/browser/browserEditorService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { WorkbenchEditorContextKeysHandler } from '../../../../browser/contextkeys.js';
import { WorkbenchKeybindingService } from '../../../../services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../../services/keybinding/browser/keyboardLayoutService.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../services/userDataProfile/browser/userDataProfileService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Direction } from '../../../../../base/browser/ui/grid/grid.js';
import { CODE_EDITOR_ID, TextResourceEditor, type EditorPaneOptions } from '../../../../browser/parts/editor/textResourceEditor.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import type { ITextResourceStore } from '../../../../services/textmodelResolver/common/textResourceStore.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IEditorPane } from '../../../../common/editor.js';
import '../../../../../sessions/browser/parts/media/sessionsPart.css';
import { SessionGridLayout } from '../../../../../sessions/browser/parts/sessionGridLayout.js';
import type { IView } from '../../../../../base/browser/ui/grid/grid.js';
import { IFileService, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { AgentHostFileSystemProvider } from '../../../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import { createDisconnectedFileApi } from '../../../../../platform/files/browser/fileApi.js';
import { TestWorkspaceService, TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { FileEditorInput } from '../../../../contrib/files/browser/editors/fileEditorInput.js';
import { StandaloneServices } from '../../../../../editor/standalone/browser/standaloneServices.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration, type ModernUIEditorTabStyle } from '../../../../common/configuration.js';
import { EditorTabSizingConfiguration, type EditorTabSizing } from '../../../../services/editor/common/editorConfiguration.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';

interface CompositeState {
	readonly id: string;
	readonly title: string | undefined;
	readonly focused: boolean;
	readonly retained: boolean;
}

declare global {
	interface Window {
		ashEditorTitleIntegration: {
			split(): Promise<void>;
			open(name: string, preview?: boolean): Promise<void>;
			state(): { active: IEditorPart['activeGroup']['id']; groups: { id: IEditorPart['activeGroup']['id']; visible: boolean; locked: boolean; tabs: string[]; previews: boolean[]; }[]; };
			activate(index: number): void;
		};
		ashChatTitleIntegration: {
			select(id: string): void;
			clipboard(): readonly string[];
			dispose(): void;
		};
		ashPartWidthIntegration: {
			setMinimum(width: number): void;
			resize(width: number): void;
			state(): { minimum: number; width: number; frameMinimum: number; };
		};
		ashSessionGridIntegration: {
			show(ids: readonly string[], active: string): Promise<void>;
			replace(id: string): Promise<void>;
			active(): string;
		};
		ashCompositeIntegration: {
			setBadge(count: number): void;
			setBadgeOrientation(orientation: 'horizontal' | 'vertical'): void;
			setBadgeCompact(compact: boolean): void;
			toggleBadge(): void;
			readonly events: readonly string[];
			readonly copiedProblems: readonly string[];
			outputState(): { text: string; filter: string; };
			logDefaultsState(): Promise<{ file: string; defaultLevel: string; recordingLevel: string; }>;
			appendOutput(text: string): void;
			showAgentOutput(): void;
			changeAgentSession(id: string): void;
			appendAgentEvent(): void;
			readonly openedAgentEvents: readonly unknown[];
			state(): readonly CompositeState[];
			open(id: string, focus?: boolean): Promise<void>;
			resize(width: number, height: number): void;
			geometry(): { hostWidth: number; hostHeight: number; paneWidth: number; paneHeight: number; };
			hide(): void;
			openView(id: string): Promise<void>;
			dispose(): void;
			disposePaneTransitions(): void;
			flushPaneState(): Promise<number | undefined>;
			reattachDisposed(): void;
			readonly editorEvents: readonly string[];
			readonly partEvents: readonly { id: string; focus?: boolean; visible: boolean; }[];
			openEditor(name: string): Promise<void>;
			resizeEditor(width: number, height: number): void;
			setWatermarkBinding(command: string, key: string | null): void;
			readonly watermarkCommands: readonly string[];
			configureEditorTabs(style: ModernUIEditorTabStyle, sizing?: EditorTabSizing, breadcrumbs?: boolean): Promise<void>;
			setEditorConfiguration(key: string, value: unknown): Promise<void>;
			setActiveEditorSticky(sticky: boolean): void;
			setEditorTheme(id: string): void;
			closeEditor(name: string): Promise<void>;
			openFileAliases(target?: 'modalGroup'): Promise<{ tabs: number; models: number; retained: boolean; text: string; }>;
			openModalEditor(name: string, size?: { width: number; height: number; }): Promise<void>;
			editorState(): readonly { name: string; focused: boolean; visible: boolean; retained: boolean; }[];
		};
	}
}

class FocusView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		for (const label of ['First input', 'Second input']) {
			const input = h(this.contentElement.ownerDocument, 'input');
			input.setAttribute('aria-label', label);
			this.contentElement.append(input);
		}
	}

	public override focus(): void {
		this.contentElement.querySelector<HTMLInputElement>('input')!.focus();
	}
}

class FixtureLifecycleService extends AbstractLifecycleService { }

const resources = new DisposableStore();
if (new URLSearchParams(location.search).has('editorTabs') || new URLSearchParams(location.search).has('badges') || new URLSearchParams(location.search).has('emptyEditor')) {
	await import('../../../../../base/browser/ui/iconlabel/iconlabel.css');
}
if (new URLSearchParams(location.search).has('badges') || new URLSearchParams(location.search).has('emptyEditor')) {
	await import('../../../../browser/media/style.css');
}
if (new URLSearchParams(location.search).has('badges')) {
	await import('../../../../browser/parts/activitybar/media/activitybarpart.css');
	if (new URLSearchParams(location.search).has('modernBadges')) {
		await import('../../../../contrib/modernUI/browser/media/activityBar.css');
		document.body.classList.add('ash-workbench', 'modern-ui');
	}
}
const uriIdentityServices = resources.add(new TestUriIdentityServices());
const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	const linkMessages = new URLSearchParams(location.search).has('chatLinks') && locale === 'zh-CN'
		? chatMessages.ash
		: {};
	setNlsMessages(catalog.locale, { ...catalog.bundles, ash: { ...catalog.bundles.ash, ...linkMessages } });
}
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const registry = new WorkbenchViewRegistry();
for (const id of ['first', 'second']) {
	resources.add(registry.registerViewContainer({ id, title: `${id} container`, icon: new URLSearchParams(location.search).has('badges') ? Lxicon.gitBranch : undefined, location: ViewContainerLocation.Panel }));
	resources.add(registry.registerViews(id, [{ id: `${id}.view`, title: `${id} view`, ctorDescriptor: new SyncDescriptor(FocusView) }]));
}
if (new URLSearchParams(location.search).has('problems')) {
	registerProblemsView(registry);
	await import('../../../../browser/parts/panel/panelActions.js');
}
const services = resources.add(new InstantiationService());
services.registerSingleton(IConfigurationService, () => new TestConfigurationService());
const contexts = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contexts);
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'composite', backend: window.localStorage, flushInterval: 0 }));
services.registerInstance(IStorageService, storage);
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, source) => source });
services.registerInstance(IViewDescriptorService, resources.add(services.createInstance(ViewDescriptorService, { registry })));
services.registerSingleton(IActivityService, () => services.createInstance(ActivityService));
const commands = resources.add(new CommandService(services));
let logFiles: FileService | undefined;
let windowLogger: LogService | undefined;
const openedAgentEvents: unknown[] = [];
const agentSession = observableValue<SessionsViewSelection | undefined>('agentSession', undefined);
const agentEvents = [{ eventId: 'event-1', sequence: 1, recordedAt: 1, event: { type: 'turnStarted', threadId: 'root', turnId: 'turn' } }];
let agentOutput: AgentTraceOutput | undefined;
services.registerInstance(IMenuService, new MenuService(commands, contexts));
// The content-focus fixtures reject menus; Problems and Output exercise real menus.
if (!new URLSearchParams(location.search).has('problems') && !new URLSearchParams(location.search).has('output')) services.registerInstance(IContextMenuService, {
	contextMenuStyle: 'custom',
	onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu() { },
});
if (new URLSearchParams(location.search).has('output')) {
	await import('../../../../../base/browser/ui/styles.css');
	await import('../../../../browser/parts/panel/panelActions.js');
	registerOutputView(registry);
	if (new URLSearchParams(location.search).has('agentOutput')) {
		// The product entry admits the declared editor features, including link detection.
		await import('../../../../../editor/editor.code.all.js');
		services.registerInstance(ICommandService, {
			onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async <T>(id: string, ...args: unknown[]) => {
				if (id === 'sessions.trace.open') { openedAgentEvents.push(args[0]); return undefined as T; }
				return commands.executeCommand<T>(id, ...args);
			}
		});
		services.registerInstance(ISessionsService, { getSelection: (reader?: IReader) => ({ activeSelection: agentSession.read(reader), visibleSelections: [] }), get activeSelection() { return agentSession.get(); } } as unknown as ISessionsService);
		services.registerInstance(IChatDebugService, {
			readTrace: async (sessionId, after) => ({ trace: { formatVersion: 3, sessionId, historyPrefixes: [], threads: [{ threadId: 'root', events: agentEvents.filter(event => event.sequence > (after.root ?? 0)) }] }, cursors: { root: agentEvents.at(-1)!.sequence }, hasMore: false }),
			readTraceDiagnostics: async () => ({ diagnostics: { formatVersion: 2, captureId: null, recordingStatus: 'disabled', droppedRecords: 0, pendingRecords: 0, events: [] }, cursor: 0, hasMore: false }),
			readTracePayload: async () => { throw new Error('Output must not read model bodies'); },
			readTraceGraph: async () => { throw new Error('Output must not read the execution graph'); },
		});
		agentSession.set({ kind: 'session', active: { session: { sessionId: 'first', title: 'Agent output fixture' }, threadId: 'root' } } as SessionsViewSelection, undefined);
	}
	let initialLogLevels: DefaultLogLevels | undefined;
	if (new URLSearchParams(location.search).has('logDefaults')) {
		services.registerSingleton(IDefaultLogLevelsService, () => services.createInstance(DefaultLogLevelsService, initialLogLevels));
	} else {
		services.registerInstance(IDefaultLogLevelsService, {
			defaultLogLevels: { default: LogLevel.Info, extensions: [] }, onDidChangeDefaultLogLevels: Event.None,
			getDefaultLogLevel: () => LogLevel.Info, setDefaultLogLevel: async () => { throw new Error('Unexpected default log persistence'); },
		});
	}
	if (new URLSearchParams(location.search).has('logDefaults')) {
		const files = logFiles = resources.add(new FileService());
		const environment = new ElectronWorkbenchEnvironmentService();
		const provider = resources.add(await IndexedDBFileSystemProvider.create(indexedDB, environment.argvResource.scheme));
		resources.add(files.registerProvider(environment.argvResource.scheme, provider));
		const logger = windowLogger = resources.add(new LogService());
		services.registerInstance(IFileService, files);
		services.registerInstance(IWorkbenchEnvironmentService, environment);
		services.registerInstance(ILogService, logger);
		services.registerInstance(ILoggerService, logger);
		services.registerInstance(ILifecycleService, resources.add(services.createInstance(FixtureLifecycleService, undefined)));
		services.registerInstance(IUriIdentityService, uriIdentityServices.get(IUriIdentityService));
		services.registerInstance(IWorkingCopyService, resources.add(services.createInstance(BrowserWorkingCopyService)));
		const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, {
			onDidChange: files.onDidChangeFiles,
			resolve: async (request: Parameters<ITextResourceStore['resolve']>[0]) => {
				if (request.bootstrapText !== undefined) return { resource: request.resource, text: request.bootstrapText, revision: undefined };
				const file = await files.readFile(request.resource);
				return { resource: request.resource, text: file.content, revision: file.revision };
			},
			save: async (request: Parameters<ITextResourceStore['save']>[0]) => ({ revision: (await files.writeFile({ resource: request.resource, content: request.text, expectedRevision: request.expectedRevision }, { create: true, overwrite: request.expectedRevision !== undefined })).revision }),
		}, {}));
		services.registerInstance(IFileTextModelService, models);
		const levels = await readDefaultLogLevels(files, environment, logger);
		logger.setLevel(levels.default);
		initialLogLevels = levels;
	}
	registerCodeEditorServices(services);
	if (new URLSearchParams(location.search).has('logDefaults')) {
		await import('../../../../browser/media/style.css');
		resources.add(bindTestColorTheme(services.get(IThemeService), document.documentElement));
	}
	services.registerInstance(IAccessibleViewService, { ...toDisposable(() => { }), show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { } });
	const output = services.get(IOutputService);
	if (windowLogger) services.get(IDefaultLogLevelsService).getDefaultLogLevel();
	const channel = resources.add(output.createChannel({ id: 'window', label: 'Window', kind: 'log', logger: windowLogger ? { label: 'Workbench', control: windowLogger } : undefined }));
	channel.appendLine({ text: 'unavailable', severity: 'error', category: 'application' });
	channel.appendLine({ text: 'Workbench restored', severity: 'information', category: 'lifecycle' });
}
const copiedProblems: string[] = [];
if (new URLSearchParams(location.search).has('problems')) {
	await import('../../../../../base/browser/ui/styles.css');
	const markers = resources.add(new MarkerService());
	markers.changeAll('typescript', [
		{ resource: URI.file('/project/src/main.ts'), marker: { severity: MarkerSeverity.Error, message: "Type 'string' is not assignable to type 'number'.", source: 'ts', startLineNumber: 12, startColumn: 7, endLineNumber: 12, endColumn: 12 } },
		{ resource: URI.file('/project/src/utils.ts'), marker: { severity: MarkerSeverity.Warning, message: "'result' is declared but its value is never read.", source: 'ts', startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 7 } },
	]);
	services.registerInstance(IMarkerService, markers);
	services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'problems', uri: URI.file('/project') })));
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { throw new Error('Editor opening is outside this title scenario'); }, focusActiveEditor() { } });
	services.registerInstance(IClipboardService, { writeText: async (text: string) => { copiedProblems.push(text); } } as IClipboardService);
	services.registerInstance(IContextMenuService, resources.add(new BrowserContextMenuService(
		services.get(IMenuService), contexts,
		{ lookupKeybinding: () => undefined } as unknown as IKeybindingService,
		resources.add(new BrowserContextViewService(document.body)), resources.add(new TestNotificationService()))));
}
const panel = resources.add(registerTestComponentServices(services).createInstance(PanelPart, document.body));
const hostedParts = new Map<ViewContainerLocation, PanelPart | AuxiliaryBarPart>([[ViewContainerLocation.Panel, panel]]);
resources.add(bindTestColorTheme(services.get(IThemeService), panel.domNode));
if (new URLSearchParams(location.search).has('partWidth')) {
	registerCodeEditorServices(services);
	const host = h(document, 'section');
	host.id = 'part-width-host';
	host.style.cssText = 'width:1000px;height:400px';
	document.body.prepend(host);
	resources.add(toDisposable(() => host.remove()));
	resources.add(bindTestColorTheme(services.get(IThemeService), host));
	class WidthView extends FocusView {
		private width = 300;
		override get minimumWidth(): number { return this.width; }
		setMinimum(width: number): void { this.width = width; this.notifyConstraintsChanged(); }
	}
	const descriptor = { id: 'width-chat', title: 'Chat', location: ViewContainerLocation.AuxiliaryBar };
	resources.add(registry.registerViewContainer(descriptor));
	resources.add(registry.registerViews(descriptor.id, [{ id: 'width-chat.view', title: 'Chat', ctorDescriptor: new SyncDescriptor(WidthView) }]));
	const part = resources.add(services.createInstance(AuxiliaryBarPart, host));
	hostedParts.set(ViewContainerLocation.AuxiliaryBar, part);
	const composite = resources.add(services.createInstance(PaneComposite, part.domNode, {
		viewContainer: descriptor,
		model: services.get(IViewDescriptorService).getViewContainerModel(descriptor.id)!,
		paneHeaders: 'hidden', paneLayout: 'fill',
	}));
	part.addComposite(composite);
	part.showComposite(composite.id);
	class EditorStub extends Part {
		constructor() { super(host, 'fixture-editor', services.get(IThemeService), storage); }
		override get minimumWidth(): number { return 200; }
	}
	const editor = resources.add(new EditorStub());
	const editorView = new WorkbenchPartView('editor', editor);
	const auxiliaryView = new WorkbenchPartView('auxiliarybar', part);
	auxiliaryView.setFrameInsets({ left: 8, right: 8, top: 0, bottom: 0 });
	const grid = resources.add(new Grid<WorkbenchPartView>(host, { type: 'branch', orientation: Orientation.HORIZONTAL, size: 1000, children: [{ type: 'leaf', view: editorView, size: 620 }, { type: 'leaf', view: auxiliaryView, size: 380 }] }));
	grid.element.style.cssText = 'width:100%;height:100%';
	grid.layout(1000, 400);
	const pane = composite.getView('width-chat.view') as WidthView;
	window.ashPartWidthIntegration = {
		setMinimum: width => pane.setMinimum(width),
		resize: width => grid.resizeView(auxiliaryView, { width, height: 400 }),
		state: () => ({ minimum: part.minimumWidth, frameMinimum: auxiliaryView.minimumWidth, width: auxiliaryView.element.getBoundingClientRect().width }),
	};
}
let transitionPaneView: PaneView | undefined;
if (new URLSearchParams(location.search).has('paneTransitions')) {
	await import('../../../../../base/browser/ui/sash/sash.css');
	const paneHost = h(document, 'div');
	paneHost.id = 'pane-transitions';
	const height = new URLSearchParams(location.search).has('shortPanes') ? 120 : 600;
	paneHost.style.cssText = `position:fixed;top:0;right:0;width:300px;height:${height}px`;
	document.body.append(paneHost);
	resources.add(toDisposable(() => paneHost.remove()));
	resources.add(bindTestColorTheme(services.get(IThemeService), paneHost));
	const paneView = transitionPaneView = resources.add(new PaneView(paneHost));
	for (const title of ['Changes', 'Agent Review', 'Graph']) {
		const pane = resources.add(new Pane(paneHost, { id: `transition.${title}`, title, collapsed: title !== 'Changes' }));
		paneView.addPane(pane, title === 'Changes' ? 544 : 28);
	}
	paneView.layout(height, 300);
}
panel.domNode.style.cssText = 'position:relative;width:800px;height:160px;overflow:hidden';
panel.layout({ width: 800, height: 160 });
services.registerInstance(IWorkbenchLayoutService, {
	showPart: () => panel.setVisible(true),
	hidePart: () => panel.setVisible(false),
} as unknown as IWorkbenchLayoutService);
const panes = resources.add(services.createInstance(PaneCompositePartService, hostedParts));
services.registerInstance(IPaneCompositePartService, panes);
services.registerInstance(IViewsService, resources.add(services.createInstance(ViewsService)));
if (new URLSearchParams(location.search).has('agentOutput')) agentOutput = resources.add(services.createInstance(AgentTraceOutput));
const views = services.get(IViewsService);
const composites = new Map<string, IComposite>();
const events: string[] = [];
for (const id of ['first', 'second']) {
	const composite = (await views.openViewContainer(id))!;
	composites.set(id, composite);
	resources.add(composite.onDidFocus(() => events.push(`${id}:focus`)));
	resources.add(composite.onDidBlur(() => events.push(`${id}:blur`)));
}
await views.openViewContainer('first');
const firstRoot = panel.getComposite('first')!.getControl().element;

const partEvents: { id: string; focus?: boolean; visible: boolean; }[] = [];
resources.add(panel.onDidCompositeOpen(({ composite, focus }) => partEvents.push({ id: composite.getId(), focus, visible: true })));
resources.add(panel.onDidCompositeClose(composite => partEvents.push({ id: composite.getId(), visible: false })));
const editorHost = h(document, 'div');
editorHost.id = 'editor-tabs-host';
if (new URLSearchParams(location.search).has('editorTabs')) editorHost.className = 'ash-workbench modern-ui';
editorHost.style.cssText = 'position:relative;display:flex;width:800px;height:260px';
document.body.append(editorHost);
resources.add(toDisposable(() => editorHost.remove()));
const resourceStore: ITextResourceStore = {
	onDidChange: Event.None,
	resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }),
	save: async () => ({ revision: undefined }),
};
const modelServices = resources.add(new InstantiationService());
resources.add(uriIdentityServices.get(IFileService).registerProvider('ash-userdata', resources.add(new InMemoryFileSystemProvider())));
modelServices.registerInstance(IFileService, uriIdentityServices.get(IFileService));
modelServices.registerInstance(IUriIdentityService, uriIdentityServices.get(IUriIdentityService));
const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {}));
modelServices.registerInstance(IFileTextModelService, models);
modelServices.registerInstance(ITextModelResourceService, models);
const editorServices = resources.add(createTestEditorServices(undefined, modelServices));
resources.add(bindTestColorTheme(editorServices.get(IThemeService), editorHost));
if (new URLSearchParams(location.search).has('editorTabs')) {
	await import('../../../../contrib/modernUI/browser/media/roundedCorners.css');
	await import('../../../../contrib/modernUI/browser/media/editorBorder.css');
	// Use the same title-slot mounting as the product Auxiliary Bar.
	class ChatTabsPart extends AuxiliaryBarPart {
		setChatTitle(title: PartTitleProjection): void {
			this.setTitleProjection(title);
		}
	}
	const chatHost = h(document, 'div');
	chatHost.id = 'chat-tabs-host';
	chatHost.className = 'ash-workbench modern-ui';
	chatHost.style.cssText = 'display:flex;width:800px;height:120px';
	document.body.append(chatHost);
	resources.add(toDisposable(() => chatHost.remove()));

	let chats = [
		{ id: 'chat-alpha', label: 'Chat alpha', panelId: 'chat-alpha-panel' },
		{ id: 'chat-beta', label: 'Chat beta', panelId: 'chat-beta-panel' },
	];
	let activeChat = chats[0]!.id;
	editorServices.registerInstance(IChatSessionNavigationService, {
		getActiveConversation: () => ({ sessionId: 'session', threadId: activeChat }),
	} as IChatSessionNavigationService);
	const copiedLinks: string[] = [];
	if (new URLSearchParams(location.search).has('chatLinks')) {
		await import('../../../../../base/browser/ui/styles.css');
		const commands = resources.add(new CommandService(editorServices));
		const menus = new MenuService(commands, editorServices.get(IContextKeyService));
		editorServices.registerInstance(IMenuService, menus);
		const views = resources.add(new BrowserContextViewService(document.body));
		const notifications = resources.add(new TestNotificationService());
		const menuKeybindings = { onDidUpdateKeybindings: Event.None, lookupKeybinding: () => undefined } as unknown as IKeybindingService;
		editorServices.registerInstance(IContextMenuService, resources.add(new BrowserContextMenuService(menus, editorServices.get(IContextKeyService), menuKeybindings, views, notifications)));
		editorServices.registerInstance(IAppServerApi, { connectionGeneration: 1, onConnectionState: Event.None, getConnectionState: async () => 'ready', getSlashCommands: async () => [] } as IAppServerApi);
		editorServices.registerInstance(IChatService, { readThread: async (sessionId, threadId) => ({ thread: { sessionId, threadId } }) } as IChatService);
		editorServices.registerInstance(IClipboardService, { writeText: async value => { copiedLinks.push(value); } } as IClipboardService);
		editorServices.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({ root: document.body, contextKeyService: editorServices.get(IContextKeyService), configurationService: editorServices.get(IConfigurationService) })));
		resources.add(registerAction2(CopyChatSessionLinkAction));
	} else {
		editorServices.registerInstance(IMenuService, services.get(IMenuService));
		editorServices.registerInstance(IContextMenuService, services.get(IContextMenuService));
	}
	editorServices.registerInstance(IViewDescriptorService, services.get(IViewDescriptorService));
	editorServices.registerInstance(ILocalizationService, services.get(ILocalizationService));
	const hoverViews = resources.add(new BrowserContextViewService(document.body));
	editorServices.registerInstance(IHoverService, resources.add(new HoverService(editorServices.get(IConfigurationService), hoverViews, editorServices.get(IContextMenuService))));
	const chatPart = resources.add(editorServices.createInstance(ChatTabsPart, chatHost));
	chatPart.domNode.style.cssText = 'box-sizing:border-box;width:100%;height:100%';
	const chat = resources.add(editorServices.createInstance(ChatViewTitleControl, chatPart.domNode, 'chat', () => {
		const pick = editorServices.get(IQuickInputService).createQuickPick<{ label: string; id: string; }>();
		const lifetime = new DisposableStore();
		lifetime.add(pick);
		pick.items = chats;
		lifetime.add(pick.onDidAccept(() => {
			const entry = pick.selectedItems[0];
			if (!entry) return;
			activeChat = entry.id;
			chat.update(entry.label);
			pick.hide();
		}));
		const dismissed = new Promise<void>(resolve => lifetime.add(pick.onDidHide(() => { lifetime.dispose(); resolve(); })));
		pick.show();
		return dismissed;
	}));
	chat.update(chats.find(entry => entry.id === activeChat)!.label);
	chatPart.setChatTitle(chat.partTitleProjection);
	window.ashChatTitleIntegration = {
		select: id => { activeChat = id; chat.update(chats.find(entry => entry.id === id)!.label); },
		clipboard: () => [...copiedLinks],
		dispose: () => chat.dispose(),
	};
}

const badgeBars: CompositeBar[] = [];
const badgeActivities: ActivityService[] = [];
const badgeHandles = resources.add(new MutableDisposable<DisposableStore>());
if (new URLSearchParams(location.search).has('badges')) {
	if (new URLSearchParams(location.search).has('modernBadges')) resources.add(bindTestColorTheme(editorServices.get(IThemeService), document.body));
	for (const presentation of ['icon', 'label'] as const) {
		const host = h(document, 'div');
		host.id = `badge-${presentation}`;
		if (presentation === 'icon' && new URLSearchParams(location.search).has('modernBadges')) host.classList.add('ash-workbench-activitybar');
		host.style.cssText = 'width:240px;height:100px';
		document.body.append(host);
		resources.add(toDisposable(() => host.remove()));
		resources.add(bindTestColorTheme(editorServices.get(IThemeService), host));
		const activity = resources.add(services.createInstance(ActivityService));
		const bar = resources.add(new CompositeBar(host, {
			overflowActionSize: 22,
			presentation,
			location: ViewContainerLocation.Panel,
			viewDescriptorService: services.get(IViewDescriptorService),
			ariaLabel: 'Badge views',
			activityHoverOptions: { position: () => HoverPosition.BELOW },
			openComposite: id => views.openViewContainer(id),
		}, activity));
		if (presentation === 'icon' && new URLSearchParams(location.search).has('modernBadges')) bar.setActiveComposite('first');
		badgeBars.push(bar);
		badgeActivities.push(activity);
	}
}
const editorRegistry = new EditorPaneRegistry();
resources.add(editorRegistry.registerEditorPane({
	id: CODE_EDITOR_ID, name: 'Text editor', canOpen: () => EditorPaneMatch.Default,
	create: () => editorServices.createInstance(TextResourceEditor, resourceStore, { lineNumbers: 'on', createPart: options => StandaloneServices.initialize().createInstance(CodeEditorWidget, options) } satisfies EditorPaneOptions),
}));
const watermarkBindings = new Map([
	['workbench.action.quickOpen', resolveKeybinding(Keybinding.single(logicalKey('p', { primaryKey: true })))],
	['workbench.action.findInFiles', resolveKeybinding(Keybinding.single(logicalKey('f', { primaryKey: true, shiftKey: true })))],
	[ShowAllCommandsCommandId, resolveKeybinding(Keybinding.single(physicalKey('F1')))],
]);
const watermarkBindingChanges = resources.add(new Emitter<void>());
const watermarkCommands: string[] = [];
// The command registry isolates dispatch assertions from file/network services.
const watermarkRegistry = new CommandRegistry();
for (const command of watermarkBindings.keys()) {
	resources.add(watermarkRegistry.register(command, () => { watermarkCommands.push(command); }));
}
const watermarkKeybindings = new URLSearchParams(location.search).has('emptyEditor') ? {
	onDidUpdateKeybindings: watermarkBindingChanges.event,
	lookupKeybinding: (command: string) => watermarkBindings.get(command),
} as IKeybindingService : undefined;
if (watermarkKeybindings) {
	await import('../../../../browser/workbench.contribution.js');
	editorServices.registerInstance(IKeybindingService, watermarkKeybindings);
	editorServices.registerInstance(ICommandService, resources.add(new CommandService(editorServices, watermarkRegistry)));
}
const editorMenu = new URLSearchParams(location.search).has('editorMenu');
let editorTitleActions: { menuService: MenuService; contextMenuProvider: BrowserContextMenuService; } | undefined;
if (editorMenu) {
	await import('../../../../../base/browser/ui/styles.css');
	await import('../../../../browser/media/style.css');
	await import('../../../../browser/parts/editor/editor.contribution.js');
	const commands = resources.add(new CommandService(editorServices));
	editorServices.registerInstance(ICommandService, commands);
	const menus = new MenuService(commands, editorServices.get(IContextKeyService));
	const views = resources.add(new BrowserContextViewService(document.body));
	const notifications = resources.add(new TestNotificationService());
	editorServices.registerInstance(INotificationService, notifications);
	editorServices.registerInstance(IUserDataProfileService, new UserDataProfileService());
	const layouts = resources.add(new BrowserKeyboardLayoutService({ navigator }));
	const keybindings = resources.add(editorServices.createInstance(WorkbenchKeybindingService, {
		ownerDocument: document, commandService: commands, contextKeyService: editorServices.get(IContextKeyService), keyboardLayoutService: layouts,
	}));
	editorServices.registerInstance(IKeybindingService, keybindings);
	editorTitleActions = { menuService: menus, contextMenuProvider: resources.add(new BrowserContextMenuService(menus, editorServices.get(IContextKeyService), keybindings, views, notifications)) };
}
const editor = resources.add(editorServices.createInstance(EditorPart, editorHost, { registry: editorRegistry, configurationService: editorServices.get(IConfigurationService), keybindingService: watermarkKeybindings, ...(editorMenu ? { contextKeyService: editorServices.get(IContextKeyService), titleActions: editorTitleActions } : {}) }));
if (editorMenu) {
	editorServices.registerInstance(IEditorPart, editor);
	const editors = resources.add(new BrowserEditorService(editor));
	editorServices.registerInstance(IEditorGroupsService, editors);
	resources.add(new WorkbenchEditorContextKeysHandler(editorServices.get(IContextKeyService), editors, editors));
	window.ashEditorTitleIntegration = {
		async split() { await editor.splitActiveGroup(Direction.Right); },
		async open(name, preview = false) { await editor.activeGroup.openEditor({ resource: URI.file(`/menu/${name}.ts`), label: `${name}.ts`, initialText: name }, { pinned: !preview }); },
		activate(index) { editor.activateGroup(editor.groups[index]!.id); },
		state() {
			return { active: editor.activeGroup.id, groups: editor.groups.map(group => ({ id: group.id, visible: editor.isGroupVisible(group.id), locked: group.isLocked, tabs: group.inputs.map(input => input.label!), previews: group.inputs.map(input => group.isPreview(input)) })) };
		},
	};
}
editor.layout({ width: 800, height: 260 });
const editorPanes = new Map<string, { pane: IEditorPane; control: unknown; }>();
const editorEvents: string[] = [];
const editorInput = (name: string) => ({ resource: URI.file(`/composite/${name}.ts`), label: `${name}.ts`, initialText: `const ${name} = 1;` });
async function openEditor(name: string): Promise<void> {
	const pane = await editor.openEditor(editorInput(name), { pinned: true, preserveFocus: true });
	if (!editorPanes.has(name)) {
		editorPanes.set(name, { pane, control: pane.getControl() });
		resources.add(pane.onDidFocus(() => editorEvents.push(`${name}:focus`)));
		resources.add(pane.onDidBlur(() => editorEvents.push(`${name}:blur`)));
	}
	pane.focus();
}

window.ashCompositeIntegration = {
	setBadge: count => {
		badgeHandles.value = new DisposableStore();
		for (const activity of badgeActivities) {
			badgeHandles.value.add(activity.showViewContainerActivity('first', { badge: new NumberBadge(count, value => `${value} changes`) }));
		}
	},
	setBadgeOrientation: orientation => {
		badgeBars[0]!.domNode.parentElement!.classList.toggle('ash-activity-bar-content', orientation === 'vertical');
		badgeBars[0]!.domNode.parentElement!.style.width = orientation === 'vertical' ? '48px' : '240px';
		badgeBars[0]!.setOrientation(orientation);
	},
	setBadgeCompact: compact => {
		const host = badgeBars[0]!.domNode.parentElement!;
		host.classList.toggle('compact', compact);
		badgeBars[0]!.setDensity(compact ? 'compact' : 'default');
		host.style.width = compact ? '36px' : '48px';
	},
	toggleBadge: () => { badgeBars[0]!.toggleBadgeEnablement('first'); },
	events,
	copiedProblems,
	outputState: () => {
		const output = services.get(IOutputService);
		return { text: output.activeChannel?.getText() ?? '', filter: output.filters.text };
	},
	logDefaultsState: async () => {
		let file = '';
		try { file = (await logFiles!.readFile(services.get(IWorkbenchEnvironmentService).argvResource)).content; }
		catch (error) { if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error; }
		return { file, defaultLevel: services.get(IDefaultLogLevelsService).getDefaultLogLevel(), recordingLevel: windowLogger!.getLevel() };
	},
	appendOutput: text => services.get(IOutputService).activeChannel?.appendLine({ text }),
	showAgentOutput: () => agentOutput!.showCurrent(),
	changeAgentSession: id => agentSession.set({ kind: 'session', active: { session: { sessionId: id, title: 'Agent output ' + id }, threadId: 'root' } } as SessionsViewSelection, undefined),
	appendAgentEvent: () => { const sequence = agentEvents.length + 1; agentEvents.push({ eventId: 'event-' + sequence, sequence, recordedAt: sequence, event: { type: 'turnCompleted', threadId: 'root', turnId: 'turn' } }); },
	openedAgentEvents,
	editorEvents,
	partEvents,
	resize: (width, height) => {
		panel.domNode.style.width = `${width}px`;
		panel.domNode.style.height = `${height}px`;
		panel.layout({ width, height });
	},
	geometry: () => {
		const host = panel.domNode.querySelector<HTMLElement>('.ash-view-pane-container')!;
		const pane = host.querySelector<HTMLElement>('.ash-split-view-pane')!;
		const bounds = pane.getBoundingClientRect();
		return { hostWidth: host.clientWidth, hostHeight: host.clientHeight, paneWidth: bounds.width, paneHeight: bounds.height };
	},
	openEditor,
	watermarkCommands,
	setWatermarkBinding: (command, key) => {
		if (key === null) watermarkBindings.delete(command);
		else watermarkBindings.set(command, resolveKeybinding(Keybinding.single(physicalKey(key))));
		watermarkBindingChanges.fire();
	},
	resizeEditor: (width, height) => {
		editorHost.style.width = `${width}px`;
		editorHost.style.height = `${height}px`;
		editor.layout({ width, height });
	},
	setActiveEditorSticky: sticky => {
		if (sticky) {
			editor.activeGroup.stickEditor();
		} else {
			editor.activeGroup.unstickEditor();
		}
	},
	setEditorConfiguration: (key, value) => editorServices.get(IConfigurationService).updateValue(key, value),
	configureEditorTabs: async (style, sizing = 'fit', breadcrumbs) => {
		const configuration = editorServices.get(IConfigurationService);
		await configuration.updateValue(WorkbenchConfiguration.modernUIEditorTabStyle, style);
		await configuration.updateValue(EditorTabSizingConfiguration, sizing);
		if (breadcrumbs !== undefined) await configuration.updateValue('breadcrumbs.enabled', breadcrumbs);
	},
	setEditorTheme: id => {
		const theme = [darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme].find(theme => theme.id === id);
		if (!theme) throw new Error(`Unknown editor test theme: ${id}`);
		(services.get(IThemeService) as TestThemeService).setColorTheme(theme);
		(editorServices.get(IThemeService) as TestThemeService).setColorTheme(theme);
	},
	openFileAliases: async target => {
		const workspace = resources.add(new TestWorkspaceService({ id: 'composite', uri: URI.file('/composite') }));
		const unavailable = (): never => { throw new Error('Unexpected file operation in editor identity fixture'); };
		const provider = resources.add(new AgentHostFileSystemProvider({
			directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
			api: {
				...createDisconnectedFileApi(unavailable), readPathCaseSensitivity: async params => {
					if (params.dirId !== 'composite') throw new Error('Wrong directory owner');
					await Promise.resolve();
					return { scopes: [{ path: '.', sensitivity: 'sensitive' }, ...(params.path.includes('/') ? [{ path: params.path.split('/')[0], sensitivity: params.path.startsWith('Original/') ? 'insensitive' as const : 'sensitive' as const }] : [])] };
				}
			}, resourceApi: { connectionGeneration: 0, metadata: unavailable, read: unavailable, release: unavailable },
		}));
		resources.add(uriIdentityServices.get(IFileService).registerProvider('file', provider));
		const lower = { resource: URI.file('/composite/Original/Alias.txt'), initialText: 'original content' };
		const firstPane = await editor.openEditor(lower, { pinned: true }, target);
		const firstModel = models.getModel(lower.resource)!;
		firstModel.setValue('unsaved content');
		const identity = uriIdentityServices.get(IUriIdentityService);
		for (let index = 0; index < 4097; index++) await identity.resolveCanonicalUri(URI.file(`/composite/transient${index}/File`));
		const alias = resources.add(new FileEditorInput(URI.file('/composite/Original/ALIAS.txt')));
		const secondPane = await editor.openEditor(alias, { pinned: true }, target);
		return { tabs: editor.activeGroup.inputs.length, models: models.getModels().length, retained: firstPane === secondPane && firstModel === models.getModel(alias.resource), text: firstModel.getText() };
	},
	openModalEditor: async (name, size) => {
		await import('../../../../../base/browser/ui/styles.css');
		await import('../../../../browser/media/style.css');
		await editor.openEditor(editorInput(name), { pinned: true, modal: { size } }, 'modalGroup');
	},
	closeEditor: async name => { await editor.closeEditor(editorInput(name)); },
	editorState: () => [...editorPanes].map(([name, { pane, control }]) => ({ name, focused: pane.hasFocus(), visible: pane.isVisible(), retained: control === pane.getControl() })),
	state: () => [...composites].map(([id, composite]) => ({
		id: composite.getId(), title: composite.getTitle(), focused: composite.hasFocus(),
		retained: panel.getComposite(id) === composite && composite.getControl() === panel.getComposite(id)!.getControl(),
	})),
	open: async (id, focus) => { await views.openViewContainer(id, focus); },
	hide: () => views.closeViewContainer(panes.getActivePaneComposite(ViewContainerLocation.Panel)!.getId()),
	openView: async id => { await views.openView(id, true); },
	dispose: () => panel.dispose(),
	disposePaneTransitions: () => transitionPaneView?.dispose(),
	flushPaneState: async () => {
		const key = 'workbench.viewContainer.first.first.view.size';
		storage.remove(key, StorageScope.WORKSPACE);
		await storage.flush();
		return storage.getNumber(key, StorageScope.WORKSPACE);
	},
	reattachDisposed: () => {
		const input = h(document, 'input');
		input.setAttribute('aria-label', 'Disposed input');
		firstRoot.hidden = false;
		firstRoot.append(input);
		document.body.append(firstRoot);
		resources.add(toDisposable(() => firstRoot.remove()));
	},
};

// Exercise the conversation grid independently of editor groups and agent backends.
const sessionHost = h(document, 'section');
sessionHost.id = 'session-grid';
sessionHost.style.cssText = 'position:relative;display:flex;width:1000px;height:400px';
document.body.append(sessionHost);
resources.add(toDisposable(() => sessionHost.remove()));
const sessionViews = new Map<string, IView>();
const emptySessionView: IView = {
	element: h(document, 'div'), minimumWidth: 0, maximumWidth: Infinity, minimumHeight: 0, maximumHeight: Infinity,
	layout() { },
};
const sessionServices = resources.add(editorServices.createChild());
sessionServices.registerInstance(IStorageService, storage);
const sessionGrid = resources.add(sessionServices.createInstance(SessionGridLayout, sessionHost, emptySessionView));
sessionGrid.layout(1000, 400);
let sessionIds: readonly string[] = [];
let activeSessionId = '';
async function showSessions(ids: readonly string[], active: string): Promise<void> {
	sessionIds = ids;
	activeSessionId = active;
	sessionGrid.reconcile(ids.map(id => {
		let view = sessionViews.get(id);
		if (!view) {
			const element = h(document, 'div');
			const input = h(document, 'input');
			element.setAttribute('role', 'region');
			element.setAttribute('aria-label', id);
			resources.add(addDisposableListener(element, 'focusin', () => { activeSessionId = id; }));
			input.setAttribute('aria-label', `${id} prompt`);
			element.append(input);
			view = { element, minimumWidth: 100, maximumWidth: Infinity, minimumHeight: 100, maximumHeight: Infinity, layout() { } };
			sessionViews.set(id, view);
		}
		return { id, view };
	}), active);
}
window.ashSessionGridIntegration = {
	show: showSessions,
	active: () => activeSessionId,
	replace: id => showSessions(sessionIds.map(candidate => candidate === activeSessionId ? id : candidate), id),
};

import { StatusbarService } from '../../../../../browser/parts/statusbar/statusbarPart.js';
import { ActivityService } from '../../../../../services/activity/browser/activityService.js';
import { IActivityService } from '../../../../../services/activity/common/activity.js';
import { BrowserAuxiliaryWindowService, IAuxiliaryWindowService } from '../../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { operatingSystem, OperatingSystem } from '../../../../../../base/common/platform.js';
import { BrowserPathService } from '../../../../../services/path/browser/pathService.js';
import { createDisconnectedRendererApi } from '../../../../../browser/rendererApi.js';
import { BrowserFileSearchService } from '../../../../../../platform/search/browser/browserFileSearchService.js';
import { IFileSearchService } from '../../../../../../platform/search/common/fileSearch.js';
import { ISearchService } from '../../../../../services/search/common/search.js';
import { SearchService } from '../../../../../services/search/common/searchService.js';
import { IFileTextModelService } from '../../../../../services/textmodelResolver/common/textModelResourceService.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContentSearchService, type IContentSearchQuery } from '../../../../../../platform/search/common/search.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { ViewContainerLocation, WorkbenchViewContainerId, IViewDescriptorService, WorkbenchViewRegistry } from '../../../../../common/views.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import { registerSearchViews } from '../../../browser/search.contribution.js';
import { SEARCH_VIEW_ID } from '../../../common/constants.js';
import { SearchView } from '../../../browser/searchView.js';
import { localize, setNlsMessages } from '../../../../../../nls.js';
import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from '../../../../../services/editor/common/editorService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import '../../../../accessibility/browser/accessibilityConfiguration.js';
import '../../../../../../base/browser/ui/styles.css';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ITextModelResourceService } from '../../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IBulkEditService } from '../../../../../../editor/browser/services/bulkEditService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { BulkEditTestServices } from '../../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { ISearchHistoryService, SearchHistoryService } from '../../../common/searchHistoryService.js';
import { IReplaceService } from '../../../browser/replace.js';
import { ReplaceService } from '../../../browser/replaceService.js';
import { IWorkingCopyService } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { ViewDescriptorService } from '../../../../../services/views/browser/viewDescriptorService.js';
import { ViewsService } from '../../../../../services/views/browser/viewsService.js';
import { PaneCompositePartService } from '../../../../../browser/parts/paneCompositePartService.js';
import { IPaneCompositePartService } from '../../../../../services/panecomposite/browser/panecomposite.js';
import { SidebarPart } from '../../../../../browser/parts/sidebar/sidebarPart.js';
import { ILocalizationService } from '../../../../../services/localization/common/localizationService.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { WorkbenchLayout } from '../../../../../browser/layout.js';
import { IWorkbenchLayoutService, workbenchPartIds, type WorkbenchPartId } from '../../../../../services/layout/browser/layoutService.js';
import { WorkbenchState } from '../../../../../../platform/workspace/common/workspace.js';
import { Part } from '../../../../../browser/part.js';
import { ViewPane, type IViewPaneOptions } from '../../../../../browser/parts/views/viewPane.js';
import { SyncDescriptor } from '../../../../../../platform/instantiation/common/descriptors.js';
import { Dimension } from '../../../../../../base/browser/dom.js';
import { ActivityBarPosition, WorkbenchConfiguration, type SideBarLocation } from '../../../../../common/configuration.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import '../../../../../browser/media/style.css';
import { SearchCommandIds } from '../../../common/constants.js';
import { SearchAccessibilityHelp } from '../../../browser/searchAccessibilityHelp.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../../../../platform/clipboard/browser/clipboardService.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { LabelService } from '../../../../../services/label/common/labelService.js';
import { BrowserContextMenuService } from '../../../../../../platform/contextview/browser/contextMenuService.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { IMenuService } from '../../../../../../platform/actions/common/actions.js';
import { WorkbenchKeybindingService } from '../../../../../services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../../../services/keybinding/browser/keyboardLayoutService.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../../../../services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../../services/userDataProfile/browser/userDataProfileService.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { ProgressService } from '../../../../../services/progress/browser/progressService.js';
import { TreeView, TreeViewPane } from '../../../../../browser/parts/views/treeView.js';
import { TreeItemCollapsibleState } from '../../../../../common/views.js';
import { IStatusbarService } from '../../../../../services/statusbar/browser/statusbar.js';

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}

const store = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = store.add(new TestThemeService(themes.light));
store.add(bindTestColorTheme(theme, document.body));
const queries: IContentSearchQuery[] = [];
const opened: { resource: string; options: EditorOpenOptions | undefined; target: EditorOpenTarget | undefined; }[] = [];
let finishLateSearch: (() => void) | undefined;
let cancelled = 0;
const clipboardWrites: string[] = [];
let clipboardFailure = false;
const instantiation = store.add(new InstantiationService());
const commands = store.add(new CommandService(instantiation));
instantiation.registerInstance(ICommandService, commands);
const configuration = store.add(new WorkbenchConfigurationService());
instantiation.registerInstance(IConfigurationService, configuration);
instantiation.registerInstance(IContextKeyService, store.add(new ContextKeyService()));
let treeViewAction: IAction | undefined;
let resultMenus: BrowserContextMenuService;
// Existing toolbar scenarios retain their action; result menus exercise the production menu host.
const menus: IContextMenuService = {
	contextMenuStyle: 'custom',
	onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: delegate => {
		const action = delegate.getActions?.().find(action => action.id === 'search.treeView');
		if (action) { treeViewAction = action; return; }
		resultMenus.showContextMenu(delegate);
	},
	hideContextMenu: () => resultMenus.hideContextMenu(),
};
const contextView = store.add(new BrowserContextViewService(document.body));
instantiation.registerInstance(IContextViewService, contextView);
instantiation.registerInstance(INotificationService, store.add(new TestNotificationService()));
instantiation.registerInstance(IUserDataProfileService, new UserDataProfileService());
instantiation.registerInstance(IFileService, {
	onDidChangeFiles: Event.None,
	watch: () => Disposable.None,
	readFile: async (resource: URI) => ({ resource, content: '[]', revision: '1' }),
} as unknown as IFileService);
const keyboardLayout = store.add(new BrowserKeyboardLayoutService({ navigator }));
const keybindings = store.add(instantiation.createInstance(WorkbenchKeybindingService, { ownerDocument: document, commandService: commands, contextKeyService: instantiation.get(IContextKeyService), keyboardLayoutService: keyboardLayout }));
await keybindings.initialize();
instantiation.registerInstance(IKeybindingService, keybindings);
instantiation.registerInstance(IMenuService, instantiation.createInstance(MenuService));
resultMenus = store.add(instantiation.createInstance(BrowserContextMenuService));
instantiation.registerInstance(IContextMenuService, menus);
instantiation.registerInstance(IHoverService, store.add(new HoverService(configuration, contextView, menus)));
const workspace = store.add(new TestWorkspaceService({
	id: 'workspace', folders: [
		{ id: 'first', name: 'workspace', index: 0, uri: new URLSearchParams(location.search).has('windows') ? URI.from({ scheme: 'file', path: '/c:/workspace' }) : URI.file('/workspace') },
		{ id: 'second', name: 'other', index: 1, uri: URI.parse('ssh://host/other') },
	]
}));
instantiation.registerInstance(IWorkspaceContextService, workspace);
instantiation.registerInstance(ILabelService, store.add(createTestLabelService(workspace)));
instantiation.registerInstance(IClipboardService, new BrowserClipboardService({
	writeText: async value => {
		if (clipboardFailure) { throw new Error('Clipboard permission denied'); }
		clipboardWrites.push(value);
	}
} as Clipboard));
instantiation.registerInstance(IStorageService, store.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'search-integration', flushInterval: 0 })));
const editing = store.add(new BulkEditTestServices([[URI.file('/workspace/src/main.ts'), 'const needle = true;']]));
instantiation.registerInstance(ITextModelResourceService, editing.models);
instantiation.registerInstance(IFileTextModelService, editing.models);
instantiation.registerInstance(IBulkEditService, editing.service);
instantiation.registerInstance(IWorkingCopyService, editing.workingCopies);
instantiation.registerInstance(IDialogService, editing.dialogs);
instantiation.registerInstance(ISearchHistoryService, store.add(instantiation.createInstance(SearchHistoryService)));
instantiation.registerInstance(IReplaceService, instantiation.createInstance(ReplaceService));
instantiation.registerInstance(IEditorService, {
	save: async () => { throw new Error('Saving is outside this fixture'); },
	saveAll: async () => { throw new Error('Saving is outside this fixture'); },
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], activeEditorPane: undefined, visibleEditorPanes: [],
	openEditor: async (input, options, target) => { opened.push({ resource: input.resource.toString(), options, target }); },
	focusActiveEditor() { },
});
instantiation.registerInstance(IContentSearchService, {
	search: async (folder, query, options) => {
		if (folder.id === 'first') { queries.push(query); }
		if (folder.id === 'second' && query.text === 'slow') { return { resultCount: 0, limitHit: false, error: undefined }; }
		const progress = options?.onProgress;
		options = { ...options, onProgress: matches => progress?.(matches.filter(match => match.dirId === folder.id)) };
		const first = { dirId: 'first', path: 'src/main.ts', lineNumber: 1, preview: 'const needle = true;', ranges: [{ start: 6, end: 12 }] };
		if (query.text === 'layout') {
			const preview = `${'中文😀 long context '.repeat(36)}layout${' trailing text '.repeat(30)}`;
			const start = preview.indexOf('layout');
			options?.onProgress?.([
				{ ...first, path: 'src/ash/workbench/contrib/search/browser/searchView.ts', lineNumber: 3456, preview, ranges: [{ start, end: start + 6 }] },
				{ ...first, path: 'src/ash/base/browser/ui/inputbox/inputbox.ts', lineNumber: 43, preview: 'before layout\nafter', ranges: [{ start: 7, end: 13 }] },
				{ ...first, dirId: 'second', path: 'src/ash/workbench/contrib/search/browser/searchView.ts', lineNumber: 1000, preview: 'const layout = true;', ranges: [{ start: 6, end: 12 }] },
			]);
			return { resultCount: 3, limitHit: false, error: undefined };
		}
		if (query.text === 'focus') {
			options?.onProgress?.([
				{ ...first, path: 'a/a.ts' },
				{ ...first, path: 'a/a.ts', lineNumber: 2 },
				{ ...first, path: 'b/nested/b.ts', lineNumber: 8 },
				{ ...first, path: 'b/nested/b.ts', lineNumber: 9 },
				{ ...first, path: 'c/c.ts', lineNumber: 10 },
			]);
			return { resultCount: 5, limitHit: false, error: undefined };
		}
		if (query.text === 'windows') {
			options?.onProgress?.([
				{ ...first, path: 'root.ts', lineNumber: 2, preview: 'needle', ranges: [{ start: 0, end: 6 }] },
				{ ...first, lineNumber: 9, preview: 'needle\r\nnext', ranges: [{ start: 0, end: 12 }] },
			]);
			return { resultCount: 2, limitHit: false, error: undefined };
		}
		if (query.text === 'large') {
			options?.onProgress?.(Array.from({ length: 1000 }, (_, index) => ({ ...first, lineNumber: index + 1 })));
			return { resultCount: 1000, limitHit: false, error: undefined };
		}
		if (query.text === '中文') {
			options?.onProgress?.([
				{ ...first, preview: '中文😀 needle needle', ranges: [{ start: 5, end: 11 }, { start: 12, end: 18 }] },
				{ ...first, dirId: 'second', lineNumber: 8 },
			]);
			return { resultCount: 2, limitHit: false, error: undefined };
		}
		options?.onProgress?.([first]);
		if (query.text === 'slow') {
			options?.signal?.addEventListener('abort', () => { cancelled++; }, { once: true });
			await new Promise<void>(resolve => { finishLateSearch = () => { options?.onProgress?.([{ ...first, path: 'late.ts' }]); resolve(); }; });
		}
		return { resultCount: 1, limitHit: false, error: undefined };
	},
});
instantiation.registerInstance(IFileSearchService, new BrowserFileSearchService(editing.files));
instantiation.registerInstance(ISearchService, store.add(instantiation.createInstance(SearchService)));
const registry = store.add(new WorkbenchViewRegistry());
registerSearchViews(registry);
class FixtureView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) { super(container, options); this.contentElement.textContent = options.title; }
}
registry.registerStaticViewContainer({ id: 'fixture.explorer', title: 'Explorer', location: ViewContainerLocation.Sidebar });
instantiation.get(IContextKeyService).setContext('fixture.explorerActive', true);
registry.registerStaticViews('fixture.explorer', [{ id: 'fixture.explorer.view', title: 'Files', when: ContextKeyExpr.has('fixture.explorerActive'), ctorDescriptor: new SyncDescriptor(FixtureView) }]);
const host = document.querySelector<HTMLElement>('#search')!;
instantiation.registerInstance(IThemeService, theme);
instantiation.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (bundle, key, fallback) => localize({ bundle, key }, fallback) });
const descriptors = store.add(instantiation.createInstance(ViewDescriptorService, { registry }));
instantiation.registerInstance(IViewDescriptorService, descriptors);
instantiation.registerSingleton(IActivityService, () => instantiation.createInstance(ActivityService));
instantiation.registerInstance(IAuxiliaryWindowService, store.add(instantiation.createInstance(BrowserAuxiliaryWindowService, window, host)));
const layout = store.add(instantiation.createInstance(WorkbenchLayout, host, {
	initialDimension: new Dimension(1024, 600), workbenchState: WorkbenchState.WORKSPACE,
	defaultLayout: { force: true, parts: { sidebar: true, auxiliarybar: false, agentSidebar: false, panel: false } },
}));
instantiation.registerInstance(IWorkbenchLayoutService, layout);
const sidebar = store.add(instantiation.createInstance(SidebarPart, layout.domNode, {
	viewDescriptorService: descriptors, contextKeyService: instantiation.get(IContextKeyService),
	localizationService: instantiation.get(ILocalizationService),
	compositeBarContextMenuProvider: menus,
	openComposite: (id: string, focus?: boolean) => panes.openPaneComposite(id, ViewContainerLocation.Sidebar, focus).then(composite => composite ?? null),
}));
store.add(configuration.onDidChangeConfiguration(event => {
	if (event.affectsConfiguration(WorkbenchConfiguration.activityBarLocation)) {
		sidebar.setActivityBarLocation(configuration.getValue<ActivityBarPosition>(WorkbenchConfiguration.activityBarLocation));
	}
}));
// Unrelated regions use empty Parts; Search, its Sidebar, construction, visibility, title and geometry use their production owners.
class FixturePart extends Part {
	constructor(id: WorkbenchPartId) { super(layout.domNode, id, theme, instantiation.get(IStorageService)); }
}
const parts = new Map<WorkbenchPartId, Part>(workbenchPartIds.map(id => [id, id === 'sidebar' ? sidebar : store.add(new FixturePart(id))]));
layout.createParts(parts);
layout.layout(new Dimension(1024, 600));
layout.resizePart('sidebar', new Dimension(280, 600));
const panes = store.add(instantiation.createInstance(PaneCompositePartService, new Map([[ViewContainerLocation.Sidebar, sidebar]])));
instantiation.registerInstance(IPaneCompositePartService, panes);
const views = store.add(instantiation.createInstance(ViewsService));
instantiation.registerInstance(IViewsService, views);
instantiation.registerInstance(IStatusbarService, store.add(new StatusbarService()));
const progressService = store.add(instantiation.createInstance(ProgressService));
let heldContainer: DeferredPromise<void> | undefined;
let heldTree: DeferredPromise<void> | undefined;
let customTreeRegistration: import('../../../../../../base/common/lifecycle.js').IDisposable | undefined;
const pane = await views.openView<SearchView>(SEARCH_VIEW_ID);
if (!(pane instanceof SearchView)) { throw new Error('Search registration did not create SearchView'); }
window.addEventListener('pagehide', () => store.dispose(), { once: true });
let secondView: import('../../../../../../base/common/lifecycle.js').IDisposable | undefined;
window.ashSearchIntegration = {
	openCustomTree: () => {
		heldTree = new DeferredPromise<void>();
		const tree = store.add(instantiation.createInstance(TreeView, 'fixture.tree', 'Custom tree'));
		tree.dataProvider = {
			getChildren: async () => {
				await heldTree!.p;
				return [{ handle: 'fixture', label: { label: 'Loaded item' }, collapsibleState: TreeItemCollapsibleState.None }];
			}
		};
		customTreeRegistration = registry.registerViews(WorkbenchViewContainerId.Search, [{ id: tree.id, title: tree.title, ctorDescriptor: new SyncDescriptor(TreeViewPane, [tree]) }]);
	},
	finishCustomTree: () => { void heldTree?.complete(); },
	closeCustomTree: () => customTreeRegistration?.dispose(),
	startContainerProgress: () => {
		heldContainer = new DeferredPromise<void>();
		void progressService.withProgress({ location: WorkbenchViewContainerId.Search, delay: 150 }, () => heldContainer!.p);
	},
	finishContainerProgress: () => { void heldContainer?.complete(); },
	notificationCount: () => (instantiation.get(INotificationService) as TestNotificationService).model.getNotifications().length,
	setLineNumbers: value => configuration.updateValue('search.showLineNumbers', value),
	selectTreeView: async () => {
		if (!treeViewAction) { throw new Error('Search toolbar did not provide View as tree'); }
		await treeViewAction.run();
	},
	setSearchVisible: async value => { if (value) { await views.openView(SEARCH_VIEW_ID); } else { views.closeViewContainer(WorkbenchViewContainerId.Search); } },
	focusedView: () => views.getFocusedView()?.id,
	switchSidebar: id => views.openViewContainer(id === 'search' ? WorkbenchViewContainerId.Search : 'fixture.explorer').then(() => undefined),
	setSecondView: enabled => { if (enabled) { secondView = registry.registerViews(WorkbenchViewContainerId.Search, [{ id: 'fixture.second', title: 'Second', ctorDescriptor: new SyncDescriptor(FixtureView) }]); } else { secondView?.dispose(); secondView = undefined; } },
	closeResultMenu: () => resultMenus.hideContextMenu(),
	replaceResultMenu: () => resultMenus.showContextMenu({ getAnchor: () => host, getActions: () => [{ id: 'fixture.otherMenu', label: 'Other menu action', tooltip: '', enabled: true, run() { } }] }),
	copyAll: () => commands.executeCommand<void>(SearchCommandIds.CopyAllCommandId),
	clipboardWrites: () => [...clipboardWrites],
	setClipboardFailure: value => { clipboardFailure = value; },
	dismiss: () => commands.executeCommand<void>(SearchCommandIds.RemoveActionId),
	help: () => {
		using provider = new SearchAccessibilityHelp().getProvider(instantiation);
		return provider?.provideContent();
	},
	snapshot: () => pane.getSearchResultSnapshot(),
	setFileText: async text => {
		const reference = store.add(await editing.models.acquire({ resource: URI.file('/workspace/src/main.ts') }, new AbortController().signal));
		reference.model.setValue(text);
	},
	setDraftText: async (text, resource = 'untitled:/Untitled-1') => {
		const reference = store.add(await editing.models.acquire({ resource: URI.parse(resource), initialText: text }, new AbortController().signal));
		reference.model.setValue(text);
	},
	diskText: () => editing.store.text(URI.file('/workspace/src/main.ts')),
	queries,
	opened,
	finishLateSearch: () => finishLateSearch?.(),
	cancelled: () => cancelled,
	closeWorkspace: () => workspace.updateWorkspace({ id: 'empty', folders: [] }),
	setTheme: name => theme.setColorTheme(themes[name]),
	setWidth: width => layout.resizePart('sidebar', new Dimension(width, 600)),
	setSidebarPosition: position => configuration.updateValue(WorkbenchConfiguration.sideBarLocation, position),
	setActivityBarLocation: position => configuration.updateValue(WorkbenchConfiguration.activityBarLocation, position),
	setAutoHide: value => configuration.updateValue(WorkbenchConfiguration.activityBarAutoHide, value),
	setExplorerActive: value => instantiation.get(IContextKeyService).setContext('fixture.explorerActive', value),
	moveExplorer: location => descriptors.moveViewContainerToLocation(descriptors.getViewContainerById('fixture.explorer')!, location),
	autoHideSetting: () => {
		const setting = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(WorkbenchConfiguration.activityBarAutoHide)!;
		return { title: setting.setting!.title, description: setting.setting!.description, value: configuration.getValue<boolean>(setting.key) };
	},
	disposeSidebar: () => sidebar.dispose(),
};

declare global {
	interface Window {
		ashSearchIntegration: {
			openCustomTree(): void;
			finishCustomTree(): void;
			closeCustomTree(): void;
			startContainerProgress(): void;
			finishContainerProgress(): void;
			notificationCount(): number;
			setLineNumbers(value: boolean): Promise<void>;
			selectTreeView(): Promise<void>;
			setSearchVisible(value: boolean): Promise<void>;
			focusedView(): string | undefined;
			switchSidebar(id: 'search' | 'explorer'): Promise<void>;
			setSecondView(enabled: boolean): void;
			closeResultMenu(): void;
			replaceResultMenu(): void;
			copyAll(): Promise<void>;
			clipboardWrites(): readonly string[];
			setClipboardFailure(value: boolean): void;
			dismiss(): Promise<void>;
			help(): string | undefined;
			snapshot(): { query: string; content: string; matchCount: number; } | undefined;
			setFileText(text: string): Promise<void>;
			setDraftText(text: string, resource?: string): Promise<void>;
			diskText(): string;
			readonly queries: readonly IContentSearchQuery[];
			readonly opened: readonly { resource: string; options: EditorOpenOptions | undefined; target: EditorOpenTarget | undefined; }[];
			finishLateSearch(): void;
			cancelled(): number;
			closeWorkspace(): void;
			setTheme(name: keyof typeof themes): void;
			setWidth(width: number): void;
			setSidebarPosition(position: SideBarLocation): Promise<void>;
			setActivityBarLocation(position: ActivityBarPosition): Promise<void>;
			setAutoHide(value: boolean): Promise<void>;
			setExplorerActive(value: boolean): void;
			moveExplorer(location: ViewContainerLocation): void;
			autoHideSetting(): { title: string; description: string; value: boolean; };
			disposeSidebar(): void;
		};
	}
}

function createTestLabelService(workspace: ConstructorParameters<typeof LabelService>[0], os: OperatingSystem = operatingSystem): LabelService {
	const api = createDisconnectedRendererApi();
	const host = { ...api, hasAppServer: true, appServer: { ...api.appServer, operatingSystem: os } };
	return new LabelService(workspace, new BrowserPathService(host, workspace), host);
}

import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import type { IAction } from '../../../src/ash/base/common/actions.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IContentSearchService, type IContentSearchQuery } from '../../../src/ash/platform/search/common/search.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/browser/configurationService.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { registerSearchViews } from '../../../src/ash/workbench/contrib/search/browser/search.contribution.js';
import { SEARCH_VIEW_ID } from '../../../src/ash/workbench/contrib/search/common/constants.js';
import { SearchView } from '../../../src/ash/workbench/contrib/search/browser/searchView.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import '../../../src/ash/workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import '../../../src/ash/base/browser/ui/styles.css';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { IBulkEditService } from '../../../src/ash/editor/browser/services/bulkEditService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { BulkEditTestServices } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { ISearchHistoryService, SearchHistoryService } from '../../../src/ash/workbench/contrib/search/common/searchHistoryService.js';
import { IReplaceService } from '../../../src/ash/workbench/contrib/search/browser/replace.js';
import { ReplaceService } from '../../../src/ash/workbench/contrib/search/browser/replaceService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import type { IView } from '../../../src/ash/workbench/common/views.js';
import { SearchCommandIds } from '../../../src/ash/workbench/contrib/search/common/constants.js';
import { SearchAccessibilityHelp } from '../../../src/ash/workbench/contrib/search/browser/searchAccessibilityHelp.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { ILabelService, LabelService } from '../../../src/ash/platform/label/common/labelService.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { WorkbenchKeybindingService } from '../../../src/ash/workbench/services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../src/ash/workbench/services/keybinding/browser/keyboardLayoutService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IUserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/browser/userDataProfileService.js';

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}

const store = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = store.add(new TestThemeService(themes.light));
store.add(bindColorTheme(theme, document.body));
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
instantiation.registerInstance(INotificationService, store.add(new NotificationService()));
instantiation.registerInstance(IUserDataProfileService, new UserDataProfileService());
instantiation.registerInstance(IFileService, { onDidChangeFiles: Event.None, readFile: async resource => ({ resource, content: '[]', revision: '1' }) } as IFileService);
const keyboardLayout = store.add(new BrowserKeyboardLayoutService({ navigator }));
const keybindings = store.add(instantiation.createInstance(WorkbenchKeybindingService, { ownerDocument: document, commandService: commands, contextKeyService: instantiation.get(IContextKeyService), keyboardLayoutService: keyboardLayout }));
await keybindings.initialize();
instantiation.registerInstance(IKeybindingService, keybindings);
instantiation.registerInstance(IMenuService, instantiation.createInstance(MenuService));
resultMenus = store.add(instantiation.createInstance(BrowserContextMenuService));
instantiation.registerInstance(IContextMenuService, menus);
instantiation.registerInstance(IHoverService, store.add(new HoverService(configuration, contextView, menus)));
const workspace = store.add(new WorkspaceContextService({
	id: 'workspace', folders: [
		{ id: 'first', name: 'workspace', index: 0, uri: new URLSearchParams(location.search).has('windows') ? URI.from({ scheme: 'file', path: '/c:/workspace' }) : URI.file('/workspace') },
		{ id: 'second', name: 'other', index: 1, uri: URI.parse('ssh://host/other') },
	]
}));
instantiation.registerInstance(IWorkspaceContextService, workspace);
instantiation.registerInstance(ILabelService, store.add(new LabelService(workspace)));
instantiation.registerInstance(IClipboardService, new BrowserClipboardService({
	writeText: async value => {
		if (clipboardFailure) { throw new Error('Clipboard permission denied'); }
		clipboardWrites.push(value);
	}
} as Clipboard));
instantiation.registerInstance(IStorageService, store.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'search-integration', flushInterval: 0 })));
const editing = store.add(new BulkEditTestServices([[URI.file('/workspace/src/main.ts'), 'const needle = true;']]));
instantiation.registerInstance(ITextModelResourceService, editing.models);
instantiation.registerInstance(IBulkEditService, editing.service);
instantiation.registerInstance(IWorkingCopyService, editing.workingCopies);
instantiation.registerInstance(IDialogService, editing.dialogs);
instantiation.registerInstance(ISearchHistoryService, store.add(instantiation.createInstance(SearchHistoryService)));
instantiation.registerInstance(IReplaceService, instantiation.createInstance(ReplaceService));
instantiation.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [],
	openEditor: async (input, options, target) => { opened.push({ resource: input.resource.toString(), options, target }); },
	focusActiveEditor() { },
});
instantiation.registerInstance(IContentSearchService, {
	search: async (query, options) => {
		queries.push(query);
		const first = { dirId: 'first', path: 'src/main.ts', lineNumber: 1, preview: 'const needle = true;', ranges: [{ start: 6, end: 12 }] };
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
const registry = new WorkbenchViewRegistry();
registerSearchViews(registry);
const host = document.querySelector<HTMLElement>('#search')!;
const pane = instantiation.createInstance(registry.getView(SEARCH_VIEW_ID)!.ctorDescriptor, host, { id: SEARCH_VIEW_ID, title: 'Search' });
if (!(pane instanceof SearchView)) { throw new Error('Search registration did not create SearchView'); }
store.add(pane);
pane.setVisible(true);
pane.layout(600, 0, 280);
instantiation.registerInstance(IViewsService, {
	onDidChangeViewContainerVisibility: Event.None,
	onDidChangeViewVisibility: Event.None,
	onDidChangeFocusedView: Event.None,
	isViewContainerVisible: () => true,
	isViewContainerActive: () => true,
	openViewContainer: async () => null,
	closeViewContainer() { },
	getVisibleViewContainer: () => null,
	getActiveViewPaneContainerWithId: () => null,
	getFocusedView: () => null,
	getFocusedViewName: () => 'Search',
	isViewVisible: id => id === SEARCH_VIEW_ID,
	openView: async <T extends IView>(): Promise<T | null> => pane as unknown as T,
	closeView() { },
	getActiveViewWithId: <T extends IView>(id: string) => id === SEARCH_VIEW_ID && pane.isVisible() ? pane as unknown as T : null,
	getViewWithId: <T extends IView>(id: string) => id === SEARCH_VIEW_ID ? pane as unknown as T : null,
	focusView: async () => { pane.focus(); return true; },
});
window.addEventListener('pagehide', () => store.dispose(), { once: true });
window.ashSearchIntegration = {
	selectTreeView: async () => {
		if (!treeViewAction) { throw new Error('Search toolbar did not provide View as tree'); }
		await treeViewAction.run();
	},
	setSearchVisible: value => pane.setVisible(value),
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
	queries,
	opened,
	finishLateSearch: () => finishLateSearch?.(),
	cancelled: () => cancelled,
	closeWorkspace: () => workspace.updateWorkspace({ id: 'empty', folders: [] }),
	setTheme: name => theme.setColorTheme(themes[name]),
	setWidth: width => { host.style.width = `${width}px`; pane.layout(600, 0, width); },
};

declare global {
	interface Window {
		ashSearchIntegration: {
			selectTreeView(): Promise<void>;
			setSearchVisible(value: boolean): void;
			closeResultMenu(): void;
			replaceResultMenu(): void;
			copyAll(): Promise<void>;
			clipboardWrites(): readonly string[];
			setClipboardFailure(value: boolean): void;
			dismiss(): Promise<void>;
			help(): string | undefined;
			snapshot(): { query: string; content: string; matchCount: number; } | undefined;
			readonly queries: readonly IContentSearchQuery[];
			readonly opened: readonly { resource: string; options: EditorOpenOptions | undefined; target: EditorOpenTarget | undefined; }[];
			finishLateSearch(): void;
			cancelled(): number;
			closeWorkspace(): void;
			setTheme(name: keyof typeof themes): void;
			setWidth(width: number): void;
		};
	}
}

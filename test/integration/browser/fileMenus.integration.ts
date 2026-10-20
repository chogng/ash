import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Pane, PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Lxicon } from '../../../src/ash/base/common/lxicons.js';
import { getKeybindingLabelParts, KeybindingLabelStyle, getKeybindingLabel } from '../../../src/ash/base/common/keybindingLabels.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { IFileService, FileKind, type IFileSystemProvider } from '../../../src/ash/platform/files/common/files.js';
import { MenuId, IMenuService, MenusRegistry } from '../../../src/ash/platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../src/ash/platform/contextkey/common/contextkey.js';
import { BrowserMenubarControl } from '../../../src/ash/workbench/browser/parts/titlebar/menubarControl.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { WorkbenchKeybindingService } from '../../../src/ash/workbench/services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../src/ash/workbench/services/keybinding/browser/keyboardLayoutService.js';
import { createUSKeyboardMapping } from '../../../src/ash/workbench/services/keybinding/common/keyboardMapping.js';
import { IUserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/browser/userDataProfileService.js';
import { createTestEditorServices, createTestFileService } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { MemoryFileService, TestEditorService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IHoverService, HoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { ExplorerView } from '../../../src/ash/workbench/contrib/files/browser/views/explorerView.js';
import { ExplorerService } from '../../../src/ash/workbench/contrib/files/browser/explorerService.js';
import { IExplorerService } from '../../../src/ash/workbench/contrib/files/browser/files.js';
import { VIEW_ID } from '../../../src/ash/workbench/contrib/files/common/files.js';
import { ResourceSchemeContext } from '../../../src/ash/workbench/common/contextkeys.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindTestColorTheme } from './themeFixture.js';
import { localize, setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/contrib/files/browser/media/explorerviewlet.css';
import '../../../src/ash/workbench/browser/media/style.css';

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}
await import('../../../src/ash/workbench/contrib/files/browser/files.contribution.js');
const lifetime = new DisposableStore();
const configuration = lifetime.add(new WorkbenchConfigurationService());
const componentServices = lifetime.add(createTestEditorServices(configuration));
const services = lifetime.add(componentServices.createChild());
const root = URI.file('/workspace');
const resource = URI.file('/workspace/main.ts');
const compactFolders = new URLSearchParams(location.search).has('compactFolders');
const paneLayout = new URLSearchParams(location.search).has('paneLayout');
if (compactFolders) await configuration.updateValue('explorer.compactFolders', true);
const profiles = new UserDataProfileService();
const provider: IFileSystemProvider = new MemoryFileService([[resource, 'const value = 1;'], [profiles.currentProfile.keybindingsResource, '[]']]);
const directoryReads: string[] = [];
const compactDirectories: Record<string, readonly [string, FileKind][]> = {
	'/workspace': [['examples', FileKind.Directory], ['services', FileKind.Directory], ['main.ts', FileKind.File]],
	'/workspace/examples': [['extensions', FileKind.Directory]],
	'/workspace/examples/extensions': [['inspector-with-a-long-folder-name', FileKind.Directory]],
	'/workspace/examples/extensions/inspector-with-a-long-folder-name': [['first.ts', FileKind.File], ['second.ts', FileKind.File]],
	'/workspace/services': [['github-auth', FileKind.Directory]],
	'/workspace/services/github-auth': [['first.ts', FileKind.File], ['second.ts', FileKind.File]],
};
provider.readDirectory = async folder => {
	directoryReads.push(folder.path);
	if (paneLayout) return folder.path === root.path ? Array.from({ length: 100 }, (_, index) => {
		const name = `file-${String(index).padStart(3, '0')}.ts`;
		return { resource: URI.joinPath(root, name), name, kind: FileKind.File };
	}) : [];
	if (compactFolders) return (compactDirectories[folder.path] ?? []).map(([name, kind]) => ({ resource: URI.joinPath(folder, name), name, kind }));
	return folder.path === root.path ? [{ resource, name: 'main.ts', kind: FileKind.File }] : [];
};
services.registerInstance(IFileService, lifetime.add(createTestFileService(provider)));
services.registerInstance(IWorkspaceContextService, lifetime.add(new TestWorkspaceService({ id: 'file-menus-integration', uri: root })));
const contexts = services.get(IContextKeyService);
const commands = lifetime.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(IDialogService, lifetime.add(new DialogService()));
services.registerInstance(INotificationService, lifetime.add(new NotificationService()));
services.registerInstance(IUserDataProfileService, profiles);
// Playwright emits US key events; host layout discovery must not reset a shortcut between its chords.
const keyboardLayout = lifetime.add(new BrowserKeyboardLayoutService({
	navigator,
	layout: { layout: { id: 'fixture-us', label: 'Fixture US', source: 'user', isUSStandard: true }, mapping: createUSKeyboardMapping() },
}));
const keybindings = lifetime.add(services.createInstance(WorkbenchKeybindingService, {
	ownerDocument: document, commandService: commands, contextKeyService: contexts, keyboardLayoutService: keyboardLayout,
}));
await keybindings.initialize();
services.registerInstance(IKeybindingService, keybindings);
services.registerInstance(IMenuService, services.createInstance(MenuService));
const views = lifetime.add(new BrowserContextViewService(document.body));
services.registerInstance(IContextViewService, views);
const menus = lifetime.add(services.createInstance(BrowserContextMenuService));
services.registerInstance(IContextMenuService, menus);
if (new URLSearchParams(location.search).has('applicationMenu')) {
	// Render controlled states through the production titlebar control and menu services.
	// Real command dispatch and Workbench visibility remain covered by application smoke.
	const rootMenu = new MenuId('integration.application');
	const fileMenu = new MenuId('integration.application.file');
	const editMenu = new MenuId('integration.application.edit');
	const titlebarMenu = new MenuId('integration.application.titlebar');
	for (const [title, submenu] of [['File', fileMenu], ['Edit', editMenu]] as const) {
		lifetime.add(MenusRegistry.appendMenuItem(rootMenu, { title, submenu }));
	}
	for (const [id, title, icon, toggled] of [
		['fixture.icon', 'With icon', Lxicon.add, undefined],
		['fixture.plain', 'Without icon', undefined, undefined],
		['fixture.checked', 'Checked', Lxicon.layoutSidebarLeft1, ContextKeyExpr.true()],
		['fixture.unchecked', 'Unchecked', Lxicon.layoutSidebarLeft1, ContextKeyExpr.false()],
	] as const) {
		lifetime.add(MenusRegistry.appendMenuItem(fileMenu, { command: { id, title, icon, toggled } }));
	}
	lifetime.add(MenusRegistry.appendMenuItem(editMenu, { command: { id: 'fixture.edit', title: 'Edit item' } }));
	const host = document.body.insertBefore(document.createElement('div'), document.body.firstChild);
	lifetime.add(new BrowserMenubarControl(host, services.get(IMenuService), menus, undefined, { applicationMenuId: rootMenu, titlebarMenuId: titlebarMenu }));
	lifetime.add(toDisposable(() => host.remove()));
}
services.registerInstance(IHoverService, lifetime.add(new HoverService(services.get(IConfigurationService), views, menus)));
services.registerInstance(IAccessibleViewService, {
	show: () => false, getOpenAriaHint: () => undefined,
	disableHint: async () => { }, showAccessibleViewHelp() { }, dispose() { }, [Symbol.dispose]() { },
});
const clipboard: string[] = [];
services.registerInstance(IClipboardService, new BrowserClipboardService({ writeText: async value => { clipboard.push(value); } } as Clipboard));
const opened: { resource: string; target: EditorOpenTarget | undefined; }[] = [];
class Editors extends TestEditorService {
	public override async openEditor(input: IResourceEditorInput, _options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void> {
		opened.push({ resource: input.resource.toString(), target });
	}
}
services.registerInstance(IEditorService, new Editors());
services.registerInstance(IExplorerService, lifetime.add(services.createInstance(ExplorerService)));
lifetime.add(bindTestColorTheme(services.get(IThemeService), document.body));
const explorer = lifetime.add(services.createInstance(ExplorerView, document.getElementById('explorer')!, { id: VIEW_ID, title: 'Explorer' }));
document.getElementById('explorer')!.append(explorer.element);
explorer.setVisible(true);
explorer.layout(500, 0, 420);
let panes: PaneView | undefined;
if (paneLayout) {
	const host = document.getElementById('explorer')!;
	host.style.display = 'flex';
	host.style.flexDirection = 'column';
	panes = lifetime.add(new PaneView(host));
	panes.addPane(explorer, 444);
	for (const title of ['Outline', 'Timeline']) {
		panes.addPane(lifetime.add(new Pane(host, { id: title, title, collapsed: true })), 28);
	}
	panes.layout(500, 420);
}
const editorButton = document.getElementById('editor-menu')!;
const editorContext = lifetime.add(contexts.createScoped(editorButton));
editorContext.setContext(ResourceSchemeContext.key, 'file');
const openEditorMenu = (event: MouseEvent): void => {
	event.preventDefault();
	menus.showContextMenu({ menuId: MenuId.EditorTitleContext, contextKeyService: editorContext, menuActionOptions: { arg: resource }, getAnchor: () => editorButton });
};
editorButton.addEventListener('contextmenu', openEditorMenu);
lifetime.add(toDisposable(() => editorButton.removeEventListener('contextmenu', openEditorMenu)));

const integration = {
	layoutPanes: (height: number) => {
		document.getElementById('explorer')!.style.height = `${height}px`;
		panes!.layout(height, 420);
	},
	directoryReads: () => [...directoryReads],
	setCompactFolders: (enabled: boolean) => configuration.updateValue('explorer.compactFolders', enabled),
	clipboard: () => [...clipboard], opened: () => [...opened],
	bindings: () => Object.fromEntries(['copyFilePath', 'copyRelativeFilePath', 'explorer.openToSide'].map(command => [command,
		getKeybindingLabel(keybindings.lookupKeybinding(command)!, KeybindingLabelStyle.UserSettings)
			.replace(/\[Key([A-Z])\]/g, (_match, key: string) => key.toLowerCase())
			.replace(/\[([^\]]+)\]/g, (_match, key: string) => key.toLowerCase()),
	])),
	labels: () => [
		['files.cut', 'Cut', 'filesExplorer.cut'], ['files.copy', 'Copy', 'filesExplorer.copy'],
		['files.rename', 'Rename', 'renameFile'], ['files.deletePermanently', 'Delete Permanently', 'deleteFile'],
		['workbench.copyPath', 'Copy Path', 'copyFilePath'], ['workbench.copyRelativePath', 'Copy Relative Path', 'copyRelativeFilePath'],
		['files.openToSide', 'Open to the Side', 'explorer.openToSide'],
	].map(([key, fallback, command]) => ({ title: localize({ bundle: 'ash', key: key! }, fallback!), chords: getKeybindingLabelParts(keybindings.lookupKeybinding(command!)!).map(part => part.label) })),
	dispose: () => lifetime.dispose(),
};
declare global { interface Window { ashFileMenusIntegration: typeof integration; } }
window.ashFileMenusIntegration = integration;

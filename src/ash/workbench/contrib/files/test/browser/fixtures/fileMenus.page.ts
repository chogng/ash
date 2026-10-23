import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Pane, PaneView } from '../../../../../../base/browser/ui/splitview/paneview.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { getKeybindingLabelParts, KeybindingLabelStyle, getKeybindingLabel } from '../../../../../../base/common/keybindingLabels.js';
import { Keybinding, logicalKey } from '../../../../../../base/common/keybindings.js';
import { KeybindingsRegistry, KeybindingSource } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { BrowserContextMenuService } from '../../../../../../platform/contextview/browser/contextMenuService.js';
import { IContextMenuService, IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IFileService, FileKind, type IFileSystemProvider } from '../../../../../../platform/files/common/files.js';
import { MenuId, IMenuService, MenusRegistry } from '../../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { BrowserMenubarControl } from '../../../../../browser/parts/titlebar/menubarControl.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { WorkbenchKeybindingService } from '../../../../../services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../../../services/keybinding/browser/keyboardLayoutService.js';
import { createUSKeyboardMapping } from '../../../../../services/keybinding/common/keyboardMapping.js';
import { IUserDataProfileService } from '../../../../../services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../../services/userDataProfile/browser/userDataProfileService.js';
import { createTestEditorServices, createTestFileService } from '../../../../../test/common/testEditorServices.js';
import { MemoryFileService, TestEditorService } from '../../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from '../../../../../services/editor/common/editorService.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../../../../platform/clipboard/browser/clipboardService.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { IHoverService, HoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ExplorerView } from '../../../browser/views/explorerView.js';
import { ExplorerService } from '../../../browser/explorerService.js';
import { IExplorerService } from '../../../browser/files.js';
import { VIEW_ID } from '../../../common/files.js';
import { ResourceSchemeContext } from '../../../../../common/contextkeys.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { localize, setNlsMessages } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import '../../../../../../base/browser/ui/styles.css';
import '../../../browser/media/explorerviewlet.css';
import '../../../../../browser/media/style.css';

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}
await import('../../../browser/files.contribution.js');
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
services.registerInstance(INotificationService, lifetime.add(new TestNotificationService()));
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
	await import('../../../../../browser/parts/titlebar/titlebarpart.css');
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
	for (const [command, key] of [['fixture.icon', 'n'], ['fixture.plain', 'a']] as const) {
		lifetime.add(KeybindingsRegistry.registerKeybindingRule({ command, source: KeybindingSource.Workbench, keybinding: Keybinding.single(logicalKey(key, { primaryKey: true })) }));
	}
	lifetime.add(MenusRegistry.appendMenuItem(titlebarMenu, { command: { id: 'fixture.sidebar', title: 'Toggle sidebar', icon: Lxicon.layoutSidebarLeft1 }, group: 'navigation' }));
	lifetime.add(MenusRegistry.appendMenuItem(editMenu, { command: { id: 'fixture.edit', title: 'Edit item' } }));
	const host = document.body.insertBefore(document.createElement('div'), document.body.firstChild);
	host.classList.add('ash-workbench-titlebar');
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

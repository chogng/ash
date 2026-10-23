import '../../../../../../base/browser/ui/styles.css';
import '../../../../../browser/media/style.css';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { StatusbarPart, StatusbarService } from '../../../../../browser/parts/statusbar/statusbarPart.js';
import { StatusbarAlignment } from '../../../browser/statusbar.js';
import { BrowserStorageService } from '../../../../storage/browser/storageService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { IStatusbarService } from '../../../browser/statusbar.js';
import { IContextKeyService, ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService, IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../../../../platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { IMenuService } from '../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../commands/common/commandService.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchKeybindingService } from '../../../../keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../../keybinding/browser/keyboardLayoutService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../notification/common/notificationService.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IUserDataProfileService } from '../../../../userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../userDataProfile/browser/userDataProfileService.js';
import { ILayoutService, BrowserLayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import { setNlsMessages } from '../../../../../../nls.js';
import messages from '../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

if (new URLSearchParams(location.search).has('zh')) setNlsMessages('zh-CN', messages);

const resources = new DisposableStore();
const root = document.createElement('main');
root.className = 'ash-workbench';
root.style.height = '100vh';
document.body.append(root);
const services = resources.add(new InstantiationService());
const theme = resources.add(new TestThemeService(lightColorTheme));
services.registerInstance(IThemeService, theme);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'statusbar-integration', flushInterval: 0 })));
resources.add(bindTestColorTheme(theme, root));
const entries = resources.add(new StatusbarService());
services.registerInstance(IStatusbarService, entries);
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
const editor = document.createElement('textarea');
editor.setAttribute('aria-label', 'Editor input');
root.append(editor);
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root, focus: () => editor.focus() })));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(root)));
services.registerInstance(INotificationService, resources.add(services.createInstance(NotificationService)));
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
const profile = new UserDataProfileService();
services.registerInstance(IUserDataProfileService, profile);
const files = resources.add(new FileService());
resources.add(files.registerProvider(profile.currentProfile.keybindingsResource.scheme, resources.add(new InMemoryFileSystemProvider())));
await files.createDirectory(profile.currentProfile.location);
await files.writeFile({ resource: profile.currentProfile.keybindingsResource, content: '[]' }, { create: true, overwrite: true });
services.registerInstance(IFileService, files);
const keyboardLayout = resources.add(new BrowserKeyboardLayoutService({ navigator }));
const keybindings = resources.add(services.createInstance(WorkbenchKeybindingService, {
	ownerDocument: document, commandService: commands, contextKeyService: services.get(IContextKeyService), keyboardLayoutService: keyboardLayout,
}));
await keybindings.initialize();
services.registerInstance(IKeybindingService, keybindings);
services.registerInstance(IMenuService, services.createInstance(MenuService));
services.registerInstance(IContextMenuService, resources.add(services.createInstance(BrowserContextMenuService)));
let activations = 0;
const branch = resources.add(entries.addEntry({ text: 'main', ariaLabel: 'Branch main', run: () => { activations++; } }, { id: 'fixture.branch', alignment: StatusbarAlignment.Left }));
resources.add(entries.addEntry({ text: 'Language', run() { } }, { id: 'fixture.language', alignment: StatusbarAlignment.Right, priority: 80 }));
resources.add(entries.addEntry({ text: 'Cursor', run() { } }, { id: 'fixture.cursor', alignment: StatusbarAlignment.Right, priority: 40 }));
const part = resources.add(services.createInstance(StatusbarPart, root));
part.domNode.style.position = 'absolute';
part.domNode.style.bottom = '0';
const fixture = {
	setVisibility: (id: string, visible: boolean) => part.updateEntryVisibility(id, visible),
	updateBranch: (text: string) => branch.update({ text, ariaLabel: 'Branch main', run: () => { activations++; } }),
	entries: () => entries.getEntries(StatusbarAlignment.Left).map(item => ({ id: item.id, text: item.entry.text })),
	command: (id: string) => commands.executeCommand(id),
	get activations() { return activations; },
	theme: (index: number) => theme.setColorTheme([lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]),
};
declare global { interface Window { ashStatusbarIntegration: typeof fixture; } }
window.ashStatusbarIntegration = fixture;
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { setIconResolver } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { IBrowserViewService, BrowserViewStorageScope, type IBrowserViewInfo } from '../../../src/ash/platform/browserView/common/browserView.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { getIconDefinition } from '../../../src/ash/platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IDialogsModel } from '../../../src/ash/workbench/common/dialogs.js';
import { BrowserEditorInput } from '../../../src/ash/workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserEditor } from '../../../src/ash/workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import '../../../src/ash/base/browser/ui/styles.css';

declare global {
	interface Window {
		ashBrowserViewIntegration: { readonly calls: readonly string[]; dispose(): void; };
	}
}

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const calls: string[] = [];
const contexts = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contexts);
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'browser-view-layout', backend: localStorage, flushInterval: 0 })));
const theme = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindColorTheme(theme, document.body));
setIconResolver(document, getIconDefinition);
const commands = resources.add(new CommandService(services));
services.registerInstance(IMenuService, new MenuService(commands, contexts));
// The fixture has no product keybinding registry; menu activation uses the real menu's keyboard handling.
services.registerInstance(IKeybindingService, { lookupKeybinding: () => undefined } as unknown as IKeybindingService);
services.registerInstance(INotificationService, resources.add(new NotificationService()));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
services.registerInstance(IContextMenuService, resources.add(services.createInstance(BrowserContextMenuService)));
services.registerInstance(IDialogsModel, { dialogs: [], onWillShowDialog: Event.None, onDidCloseDialog: Event.None } as unknown as IDialogsModel);
services.registerInstance(IDialogService, { prompt: async () => { calls.push('share'); return {}; } } as unknown as IDialogService);
services.registerInstance(IChatSessionNavigationService, { getConversations: () => [] } as unknown as IChatSessionNavigationService);
const info: IBrowserViewInfo = {
	id: 'browser_target_00000000-0000-0000-0000-000000000000', host: { windowId: 1 }, owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Ephemeral },
	state: { targetId: 'browser_target_00000000-0000-0000-0000-000000000000', url: 'https://example.com/', title: 'Browser layout', loading: false, canGoBack: true, canGoForward: true, visible: true },
};
// Main-owned page operations stop at the service boundary; renderer, toolbar and context menu remain real.
services.registerInstance(IBrowserViewService, {
	onDidEvent: Event.None, getOrCreateBrowserView: async () => info, getState: async () => info.state,
	layout: async () => { }, setVisible: async () => { }, getSharing: async () => [],
	clearPermissions: async () => { calls.push('permissions'); }, cancelDownloads: async () => { calls.push('downloads'); },
} as unknown as IBrowserViewService);
const editor = resources.add(services.createInstance(BrowserEditor));
const input = resources.add(services.createInstance(BrowserEditorInput, { id: info.id, url: info.state.url, title: info.state.title, session: info.session }));
editor.create(document.querySelector<HTMLElement>('#browser')!);
await editor.setInput(input, new AbortController().signal);
editor.setVisible(true);
window.ashBrowserViewIntegration = { calls, dispose: () => resources.dispose() };
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

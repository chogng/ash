import { localize2 } from '../nls.js';
import '../workbench/electron-browser/desktop.contribution.js';
import '../workbench/contrib/browserView/electron-browser/browserView.contribution.js';
import './sessions.common.main.js';
import './browser/parts/menubar.contribution.js';
import './contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js';
import { registerOpenAgentsWindowCommand } from './contrib/openAgentsWindow/electron-browser/openAgentsWindowCommand.js';
import { MenusRegistry } from '../platform/actions/common/actions.js';
import { Menus } from './browser/menus.js';
import { IHostService } from '../workbench/services/host/browser/host.js';
import { NativeHostService } from '../workbench/services/host/electron-browser/nativeHostService.js';
import { ILanguagePackStore } from '../platform/languagePacks/common/languagePackStore.js';
import { ElectronLanguagePackStore } from '../platform/languagePacks/electron-browser/languagePackStore.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IClipboardService } from '../platform/clipboard/common/clipboardService.js';
import { ElectronRendererClipboardService } from '../platform/clipboard/electron-browser/electronRendererClipboardService.js';

registerSingleton(IHostService, NativeHostService, InstantiationType.Delayed);
registerSingleton(IClipboardService, ElectronRendererClipboardService, InstantiationType.Delayed);
registerSingleton(ILanguagePackStore, ElectronLanguagePackStore, InstantiationType.Delayed);

registerOpenAgentsWindowCommand();

MenusRegistry.appendMenuItem(Menus.MenubarFileMenu, {
	command: { id: 'workbench.action.closeWindow', title: localize2({ bundle: 'ash', key: 'workbench.closeWindow' }, 'Close Window') },
	group: '6_close',
	order: 5,
});

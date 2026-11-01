import '../../../../base/browser/ui/styles.css';
import '../../../../workbench/browser/media/style.css';
import '../../../../workbench/electron-browser/parts/titlebar/titlebarpart.css';
import '../../../browser/media/style.css';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IMenuService, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { CommandService } from '../../../../workbench/services/commands/common/commandService.js';
import { TestConfigurationService } from '../../../../workbench/services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../../workbench/services/storage/browser/storageService.js';
import { bindTestColorTheme } from '../../../../../../test/fixtures/browser/themeFixture.js';
import { Menus } from '../../../browser/menus.js';
import { TitlebarPart } from '../../../browser/parts/titlebarPart.js';

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const root = document.querySelector<HTMLElement>('#app')!;
const query = new URLSearchParams(location.search);
document.body.dataset.os = query.get('os') ?? 'windows';
document.body.dataset.runtime = 'electron';
const services = resources.add(new InstantiationService());
const contexts = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contexts);
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(IMenuService, new MenuService(commands, contexts));
const contextMenus: IContextMenuService = {
	contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu() { }, hideContextMenu() { },
};
services.registerInstance(IContextMenuService, contextMenus);
const views = resources.add(new BrowserContextViewService(root));
services.registerInstance(IHoverService, resources.add(new HoverService(resources.add(new TestConfigurationService()), views, contextMenus)));
const theme = resources.add(new TestThemeService(lightColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindTestColorTheme(theme, root));
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'sessions-titlebar-fixture', flushInterval: 0 })));
let runs = 0;
resources.add(CommandsRegistry.register('test.sessionInformation', () => { runs++; }));
resources.add(MenusRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
	command: { id: 'test.sessionInformation', title: 'Session information', icon: Lxicon.info }, group: 'navigation',
}));
const titlebar = resources.add(services.createInstance(TitlebarPart, root, document.body.dataset.os === 'mac' ? 'actions-only' : 'application-menu'));
titlebar.domNode.classList.add('ash-electron-titlebar');
titlebar.domNode.style.cssText = 'height: 36px; flex: 0 0 auto; --ash-sessions-titlebar-sidebar-width: 260px;';
const nativeGeometry = document.createElement('style');
document.head.append(nativeGeometry);

window.ashSessionsTitlebarFixture = {
	setInsets(left: number, right: number) {
		nativeGeometry.textContent = `.ash-electron-titlebar { --ash-titlebar-controls-leftInset: ${left}px; --ash-titlebar-controls-rightInset: ${right}px; }`;
	},
	setFullscreen(fullscreen: boolean) { root.classList.toggle('ash-sessions-fullscreen', fullscreen); },
	setTheme(index: number) { theme.setColorTheme([lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]!); },
	get runs() { return runs; },
};

declare global {
	interface Window {
		ashSessionsTitlebarFixture: {
			setInsets(left: number, right: number): void;
			setFullscreen(fullscreen: boolean): void;
			setTheme(index: number): void;
			readonly runs: number;
		};
	}
}

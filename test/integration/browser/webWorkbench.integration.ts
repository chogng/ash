import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../src/ash/platform/path/common/pathService.js';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import { ActionRunner } from '../../../src/ash/base/common/actions.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { isStandalone } from '../../../src/ash/base/browser/browser.js';
import { Grid } from '../../../src/ash/base/browser/ui/grid/grid.js';
import { IMenuService, MenuId, MenusRegistry } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IUpdateService } from '../../../src/ash/platform/update/common/updateService.js';
import { createBrowserTitlebarPart } from '../../../src/ash/workbench/browser/parts/titlebar/titlebarPart.js';
import { NotificationsToasts } from '../../../src/ash/workbench/browser/parts/notifications/notificationsToasts.js';
import { Part } from '../../../src/ash/workbench/browser/part.js';
import { WorkbenchPartView } from '../../../src/ash/workbench/browser/workbenchPartView.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { BrowserWorkbenchEnvironmentService, IBrowserWorkbenchEnvironmentService } from '../../../src/ash/workbench/services/environment/browser/environmentService.js';
import { BrowserHostService } from '../../../src/ash/workbench/services/host/browser/browserHostService.js';
import { IHostService } from '../../../src/ash/workbench/services/host/browser/host.js';
import { ILifecycleService, ShutdownVetoError } from '../../../src/ash/workbench/services/lifecycle/common/lifecycle.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { BrowserUpdateService, createWebUpdateProvider } from '../../../src/ash/workbench/services/update/browser/updateService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { bindTestColorTheme } from './themeFixture.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import chinese from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const root = document.querySelector<HTMLElement>('#app')!;
const baseServices = resources.add(createTestEditorServices());
const services = resources.add(baseServices.createChild());
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(IMenuService, new MenuService(commands, services.get(IContextKeyService)));
services.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } });
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
const theme = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindTestColorTheme(theme, root));

// Simulate only the browser/OS boundary; titlebar DOM, constraints and Grid are real.
let displayMode = 'browser';
const originalMatchMedia = window.matchMedia.bind(window);
const displayQueries = new Map<string, MediaQueryList>();
window.matchMedia = query => {
	if (!query.includes('display-mode:')) return originalMatchMedia(query);
	let media = displayQueries.get(query);
	if (!media) {
		media = originalMatchMedia(query);
		Object.defineProperty(media, 'matches', { get: () => query.includes(`display-mode: ${displayMode})`) });
		displayQueries.set(query, media);
	}
	return media;
};
resources.add(toDisposable(() => { window.matchMedia = originalMatchMedia; }));
class WindowControls extends EventTarget {
	visible = false;
	area = new DOMRect();
	listeners = 0;
	getTitlebarAreaRect(): DOMRect { return this.area; }
	override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
		if (type === 'geometrychange') this.listeners++;
		super.addEventListener(type, callback, options);
	}
	override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
		if (type === 'geometrychange') this.listeners--;
		super.removeEventListener(type, callback, options);
	}
}
const controls = new WindowControls();
Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: controls });
resources.add(toDisposable(() => Reflect.deleteProperty(navigator, 'windowControlsOverlay')));
let actionRuns = 0;
resources.add(CommandsRegistry.register('test.webTitlebarAction', () => { actionRuns++; }));
resources.add(MenusRegistry.appendMenuItem(MenuId.TitleBar, { command: { id: 'test.webTitlebarAction', title: 'Titlebar action' }, group: 'navigation' }));
const titlebar = resources.add(createBrowserTitlebarPart(root, {
	windowTitle: { value: 'Ash Web', onDidChange: Event.None, updateProperties() { }, registerVariables() { } },
}, services));
class Content extends Part {
	constructor() { super(root, 'editor', theme, services.get(IStorageService)); }
}
const content = resources.add(new Content());
const grid = resources.add(new Grid<WorkbenchPartView>(root, {
	type: 'branch', orientation: 'vertical', size: innerHeight, children: [
		{ type: 'leaf', view: new WorkbenchPartView('titlebar', titlebar), size: 35 },
		{ type: 'leaf', view: new WorkbenchPartView('editor', content), size: innerHeight - 35 },
	],
}));
grid.element.style.cssText = 'width:100%;height:100%;flex:1 1 auto';
const layout = (): void => grid.layout(innerWidth, innerHeight);
window.addEventListener('resize', layout);
resources.add(toDisposable(() => window.removeEventListener('resize', layout)));
layout();

let response: 'current' | 'available' | 'error' = new URLSearchParams(location.search).has('available') ? 'available' : 'current';
let checks = 0;
const parameters = new URLSearchParams(location.search);
const provider = parameters.has('deployed') ? createWebUpdateProvider(document) : parameters.has('noProvider') ? undefined : {
	async checkForUpdate() {
		checks++;
		if (response === 'error') throw new Error('Fixture network failure');
		return response === 'available' ? { version: 'build-2' } : null;
	},
};
// Exercise the production Web environment and the same service identifier as Desktop.
const updateServices = resources.add(services.createChild());
const updateCommands = resources.add(new CommandService(updateServices));
updateServices.registerInstance(ICommandService, updateCommands);
updateServices.registerInstance(IBrowserWorkbenchEnvironmentService, new BrowserWorkbenchEnvironmentService(location, undefined, { updateProvider: provider }));
let veto = false;
let shutdowns = 0;
updateServices.registerInstance(ILifecycleService, {
	async shutdown(reason) {
		shutdowns++;
		if (veto) throw new ShutdownVetoError();
		sessionStorage.setItem('webUpdateShutdown', reason);
	},
} as ILifecycleService);
updateServices.registerInstance(IDialogService, {} as IDialogService);
updateServices.registerInstance(IPathService, {} as IPathService);
updateServices.registerInstance(IHostService, resources.add(updateServices.createInstance(BrowserHostService, {})));
updateServices.registerInstance(IUpdateService, resources.add(updateServices.createInstance(BrowserUpdateService)));
const notifications = resources.add(new NotificationService());
updateServices.registerInstance(INotificationService, notifications);
resources.add(updateServices.createInstance(NotificationsToasts, root, notifications, resources.add(new ActionRunner())));
if (new URLSearchParams(location.search).has('chinese')) setNlsMessages('zh-CN', chinese);
await import('../../../src/ash/workbench/contrib/update/browser/update.contribution.js');
const contribution = resources.add(WorkbenchContributionsRegistry.createHost(updateServices, error => { throw error; }, ['workbench.contrib.webUpdate']));
contribution.advance(WorkbenchPhase.AfterRestored);

const fixture = {
	setOverlay(x: number, width: number, height: number, visible = true): void {
		controls.visible = visible;
		controls.area = new DOMRect(x, 0, width, height);
		controls.dispatchEvent(new EventConstructor('geometrychange'));
	},
	setMode(mode: string): void {
		displayMode = mode;
		for (const [query, media] of displayQueries) media.dispatchEvent(new MediaQueryListEvent('change', { media: query, matches: media.matches }));
	},
	setTheme(index: number): void { theme.setColorTheme([darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]!); },
	setUpdate(value: typeof response): void { response = value; },
	check: () => updateCommands.executeCommand('update.checkForUpdate'),
	vetoReload: (value: boolean) => { veto = value; },
	state: () => ({ checks, shutdowns, actionRuns, build: document.querySelector<HTMLMetaElement>('meta[name="ash-web-build"]')?.content, supported: updateServices.get(IContextKeyService).getContext().getValue('update.providerAvailable'), installed: isStandalone(window), height: titlebar.minimumHeight, overlayListeners: controls.listeners, notifications: notifications.model.getNotifications().map(item => item.message) }),
	disposeTitlebar: () => titlebar.dispose(),
	disposeUpdate: () => contribution.dispose(),
};
// Avoid shadowing the shared Event namespace imported above.
const EventConstructor = window.Event;
declare global { interface Window { ashWebWorkbenchIntegration: typeof fixture; } }
window.ashWebWorkbenchIntegration = fixture;

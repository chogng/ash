import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import { h } from '../../../src/ash/base/browser/dom.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../src/ash/platform/accessibility/browser/accessibilityService.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { INotificationService, NotificationSeverity } from '../../../src/ash/platform/notification/common/notification.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { NotificationsCenter } from '../../../src/ash/workbench/browser/parts/notifications/notificationsCenter.js';
import { NotificationActionRunner } from '../../../src/ash/workbench/browser/parts/notifications/notificationsCommands.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';

const resources = new DisposableStore();
const root = h(document, 'main');
root.className = 'ash-workbench';
root.style.height = '100vh';
root.style.position = 'relative';
document.body.append(root);
const feedback = h(document, 'div');
feedback.className = 'ash-feedback-host';
feedback.style.setProperty('--ash-feedback-statusbar-height', '28px');
root.append(feedback);
const services = resources.add(new InstantiationService());
const notifications = resources.add(new NotificationService());
services.registerInstance(INotificationService, notifications);
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
services.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({ root, contextKeyService: services.get(IContextKeyService), configurationService: resources.add(new InMemoryConfigurationService(new ConfigurationRegistry())) })));
services.registerInstance(IClipboardService, new BrowserClipboardService(navigator.clipboard));
services.registerInstance(ICommandService, resources.add(new CommandService(services)));
services.registerInstance(IMenuService, services.createInstance(MenuService));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(root)));
services.registerInstance(IKeybindingService, {
	inChordMode: false, onDidUpdateKeybindings: Event.None,
	getKeybindings: () => [], enableKeybindingHoldMode: () => undefined, registerSchemaContribution: () => Disposable.None,
	resolveKeybinding() { throw new Error('No keybinding in this fixture'); },
	resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
});
services.registerInstance(IContextMenuService, resources.add(services.createInstance(BrowserContextMenuService)));
const runner = resources.add(services.createInstance(NotificationActionRunner));
const themes = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindColorTheme(themes, root));
const center = resources.add(services.createInstance(NotificationsCenter, root, feedback, runner, undefined, undefined));
let actionRuns = 0;

const fixture = {
	notify(message: string, severity: NotificationSeverity = NotificationSeverity.Info): number {
		return notifications.notify({ severity, message, source: 'Fixture', actions: [{ id: 'fixture.action', label: 'Run action', run: () => { actionRuns++; } }] }).item.id;
	},
	show: () => center.show(),
	hide: () => center.hide(),
	clear: () => center.clearAll(),
	remove: (id: number) => notifications.remove(id),
	get actionRuns() { return actionRuns; },
	history: () => notifications.getNotifications().map(item => item.id),
	theme(index: number): void { themes.setColorTheme([lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]); },
};

declare global { interface Window { ashNotificationsIntegration: typeof fixture; } }
window.ashNotificationsIntegration = fixture;
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

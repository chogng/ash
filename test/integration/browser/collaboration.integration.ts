import { ChannelServiceFixture } from './channelServiceFixture.js';
import { IChannelService, type ChannelRole } from '../../../src/ash/platform/collaboration/common/channelService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/common/theme.js';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { localize, setNlsMessages } from '../../../src/ash/nls.js';
import translations from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { IAccessibleViewService, AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { ICallService, type CallState, type CallDeployment } from '../../../src/ash/platform/call/common/callService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import type { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { QuickInputService } from '../../../src/ash/platform/quickinput/browser/quickInputService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { CollaborationViewPane } from '../../../src/ash/workbench/contrib/collaboration/browser/collaborationViewPane.js';
import { CHANNELS_VIEW_ID } from '../../../src/ash/workbench/contrib/collaboration/common/collaboration.js';
import { CallViewPane } from '../../../src/ash/workbench/contrib/call/browser/callViewPane.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { emptyEditorServiceState } from '../../../src/ash/workbench/test/common/testEditorService.js';
import { bindTestColorTheme } from './themeFixture.js';

const parameters = new URLSearchParams(location.search);
if (parameters.get('locale') === 'zh-CN') { setNlsMessages('zh-CN', translations); document.documentElement.lang = 'zh-CN'; }
const { registerCollaborationViews } = await import('../../../src/ash/workbench/contrib/collaboration/browser/collaboration.contribution.js');
const { registerCallView } = await import('../../../src/ash/workbench/contrib/call/browser/call.contribution.js');
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const root = document.querySelector<HTMLElement>('#app')!;
setARIAContainer(root);
document.querySelector('#title')!.textContent = localize('collaboration.title', 'Collaboration');
const configuration = resources.add(new InMemoryConfigurationService());
services.registerInstance(IConfigurationService, configuration);
const context = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, context);
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root })));
const theme = resources.add(new TestThemeService(({ dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme } as const)[parameters.get('theme') as 'dark'] ?? lightColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindTestColorTheme(theme, root));
const commands = resources.add(new CommandService(services));
const contextView = resources.add(new BrowserContextViewService(root));
const notifications = resources.add(new NotificationService());
const menus = resources.add(new BrowserContextMenuService(new MenuService(commands, context), context,
	{ lookupKeybinding: () => undefined } as unknown as IKeybindingService, contextView, notifications));
services.registerInstance(IContextMenuService, menus);
services.registerInstance(IHoverService, resources.add(new HoverService(configuration, contextView, menus)));
services.registerInstance(IQuickInputService, resources.add(services.createInstance(QuickInputService)));
services.registerInstance(IAccessibleViewService, {
	getOpenAriaHint: key => configuration.getValue<boolean>(key) ? 'Alt+F1' : undefined,
} as IAccessibleViewService);
const channelService = resources.add(new ChannelServiceFixture());
if (!parameters.has('noChannels')) services.registerInstance(IChannelService, channelService);
let clipboard = '';
services.registerInstance(IClipboardService, { writeText: async value => { clipboard = value; } } as IClipboardService);
const changed = resources.add(new Emitter<void>());
let callState: CallState | undefined;
const operations: string[] = [];
if (!parameters.has('noCalls')) services.registerInstance(ICallService, {
	get state() { return callState; }, screens: [], screenError: undefined, onDidChange: changed.event, onDidChangeScreens: Event.None,
	start: async (deployment: CallDeployment) => {
		operations.push(deployment.type);
		callState = { connection: 'connected', muted: true, deafened: false, microphoneAllowed: true, canManage: true, screenSharing: false, screenAllowed: false, participants: [{ id: 'one', muted: true }, { id: 'two', muted: false }], documents: [], error: null };
		changed.fire();
	},
	mute: async muted => { if (callState) callState = { ...callState, muted }; changed.fire(); },
	deafen: async deafened => { if (callState) callState = { ...callState, deafened }; changed.fire(); },
	leave: async () => { operations.push('leave'); callState = undefined; changed.fire(); },
	end: async () => { operations.push('end'); callState = undefined; changed.fire(); },
	selectDevice: async () => { }, screenSources: async () => [], shareScreen: async () => { }, stopScreenShare: async () => { },
	invite: async () => ({ url: 'https://fixture.invalid', credential: 'fixture-secret' }), shareDocument: async () => { }, unshareDocument: async () => { },
});
services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None } as unknown as IEditorService);
const registry = new WorkbenchViewRegistry();
registerCollaborationViews(registry);
registerCallView(registry);
const contributions = resources.add(WorkbenchContributionsRegistry.createHost(services, undefined, ['workbench.contrib.call']));
contributions.advance(WorkbenchPhase.BlockStartup);
const paneHost = document.querySelector<HTMLElement>('#panes')!;
const panes = resources.add(new PaneView(paneHost));
const channels = resources.add(services.createInstance(CollaborationViewPane, paneHost, { id: CHANNELS_VIEW_ID, title: localize('collaboration.channels', 'Channels') }));
panes.addPane(channels, 540); channels.setVisible(true);
const call = services.getOptional(ICallService) ? resources.add(services.createInstance(CallViewPane, paneHost, { id: 'ash.call.view', title: localize('collaboration.calls', 'Calls') })) : undefined;
if (call) { panes.addPane(call, 260); call.setVisible(true); }
services.registerInstance(IViewsService, {
	getViewWithId: id => id === CHANNELS_VIEW_ID ? channels : call,
	focusView: async id => { (id === CHANNELS_VIEW_ID ? channels : call)?.focus(); return true; },
} as IViewsService);
const resize = new ResizeObserver(() => panes.layout(paneHost.clientHeight, paneHost.clientWidth));
resize.observe(paneHost);
window.addEventListener('pagehide', () => { resize.disconnect(); resources.dispose(); }, { once: true });
declare global {
	interface Window {
		ashCollaboration: { setRole(role: ChannelRole): void; revoke(): void; clipboard(): string; operations(): readonly string[]; notifications(): readonly string[]; accessible(type: 'help' | 'view'): string; verbosity(value: boolean): Promise<void>; };
	}
}
window.ashCollaboration = {
	setRole: role => channelService.setRole(role), revoke: () => channelService.revoke(), clipboard: () => clipboard,
	operations: () => operations,
	notifications: () => notifications.getNotifications().map(notification => notification.message),
	accessible: type => AccessibleViewRegistry.getImplementations().find(provider => provider.name === `collaboration${type}` && provider.type === (type === 'help' ? AccessibleViewType.Help : AccessibleViewType.View))!.getProvider(services)!.provideContent(),
	verbosity: value => configuration.updateValue('accessibility.verbosity.collaboration', value),
};

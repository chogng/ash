import { ChannelServiceFixture } from '../../../../../../../../test/fixtures/browser/channelServiceFixture.js';
import { IChannelService, type ChannelRole } from '../../../../../../platform/collab/common/channelService.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import '../../../../../../base/browser/ui/styles.css';
import '../../../../../browser/media/style.css';
import '../../../../../common/theme.js';
import '../../../../../../platform/theme/common/sizes/baseSizes.js';
import { PaneView } from '../../../../../../base/browser/ui/splitview/paneview.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize, setNlsMessages } from '../../../../../../nls.js';
import translations from '../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { IAccessibleViewService, AccessibleViewType } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { ICallService, type CallState, type CallDeployment } from '../../../../../../platform/call/common/callService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { BrowserContextMenuService } from '../../../../../../platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { HoverService, IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import type { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { BrowserLayoutService, ILayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import { QuickInputService } from '../../../../../../platform/quickinput/browser/quickInputService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../common/contributions.js';
import { WorkbenchViewRegistry } from '../../../../../common/views.js';
import { CollabViewPane } from '../../../browser/collabViewPane.js';
import { CHANNELS_VIEW_ID } from '../../../common/collab.js';
import { CallViewPane } from '../../../../call/browser/callViewPane.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { emptyEditorServiceState } from '../../../../../test/common/testEditorService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';

const parameters = new URLSearchParams(location.search);
if (parameters.get('locale') === 'zh-CN') { setNlsMessages('zh-CN', translations); document.documentElement.lang = 'zh-CN'; }
const { registerCollabViews } = await import('../../../browser/collab.contribution.js');
const { registerCallView } = await import('../../../../call/browser/call.contribution.js');
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const root = document.querySelector<HTMLElement>('#app')!;
setARIAContainer(root);
document.querySelector('#title')!.textContent = localize('collaboration.title', 'Collab');
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
const notifications = resources.add(new TestNotificationService());
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
registerCollabViews(registry);
registerCallView(registry);
const contributions = resources.add(WorkbenchContributionsRegistry.createHost(services, undefined, ['workbench.contrib.call']));
contributions.advance(WorkbenchPhase.BlockStartup);
const paneHost = document.querySelector<HTMLElement>('#panes')!;
const panes = resources.add(new PaneView(paneHost));
const channels = resources.add(services.createInstance(CollabViewPane, paneHost, { id: CHANNELS_VIEW_ID, title: localize('collaboration.channels', 'Channels') }));
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
	notifications: () => notifications.model.getNotifications().map(notification => notification.message),
	accessible: type => AccessibleViewRegistry.getImplementations().find(provider => provider.name === `collaboration${type}` && provider.type === (type === 'help' ? AccessibleViewType.Help : AccessibleViewType.View))!.getProvider(services)!.provideContent(),
	verbosity: value => configuration.updateValue('accessibility.verbosity.collaboration', value),
};

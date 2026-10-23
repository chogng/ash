import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/common/configuration.js';
import { ILayoutService, BrowserLayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import partStyles from '../../../src/ash/workbench/browser/media/part.css?inline';
import { h } from '../../../src/ash/base/browser/dom.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import messages from '../../../extensions/language-pack-zh-cn/translations/editor.json' with { type: 'json' };
import { Event, Emitter } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../src/ash/platform/accessibility/browser/accessibilityService.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { IMenuService, MenuId } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuWorkbenchToolBar } from '../../../src/ash/platform/actions/browser/toolbar.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IExtensionApi } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../src/ash/platform/extensionManagement/common/extensionManagementService.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { INotificationService, NotificationPriority, NotificationsFilter, Severity } from '../../../src/ash/platform/notification/common/notification.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { QuickInputService } from '../../../src/ash/platform/quickinput/browser/quickInputService.js';
import { NotificationsPosition, NotificationsSettings } from '../../../src/ash/workbench/common/notifications.js';
import { ProgressLocation, type IProgress, type IProgressStep } from '../../../src/ash/platform/progress/common/progress.js';
import { ProgressService } from '../../../src/ash/workbench/services/progress/browser/progressService.js';
import { IViewDescriptorService, WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { ViewsService } from '../../../src/ash/workbench/services/views/browser/viewsService.js';
import { IPaneCompositePartService } from '../../../src/ash/workbench/services/panecomposite/browser/panecomposite.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { bindTestColorTheme } from './themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { INotificationsCenter, NotificationsCenter } from '../../../src/ash/workbench/browser/parts/notifications/notificationsCenter.js';
import { NotificationActionRunner } from '../../../src/ash/workbench/browser/parts/notifications/notificationsCommands.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { StatusbarPart, StatusbarService } from '../../../src/ash/workbench/browser/parts/statusbar/statusbarPart.js';
import { IStatusbarService, StatusbarAlignment } from '../../../src/ash/workbench/services/statusbar/browser/statusbar.js';
import { MainThreadMessageService } from '../../../src/ash/workbench/api/browser/mainThreadMessageService.js';
import chatMessages from '../../../extensions/language-pack-zh-cn/translations/chat.json' with { type: 'json' };
import { AgentsWindowInvitationContribution } from '../../../src/ash/workbench/contrib/chat/electron-browser/agentSessions/agentsWindowInvitation.js';
import { AgentsWindowInvitationState } from '../../../src/ash/platform/chat/common/agentsWindowInvitation.js';
import { ChatAIDisabledSettingId } from '../../../src/ash/platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { INativeHostService } from '../../../src/ash/workbench/common/services.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IHostService } from '../../../src/ash/workbench/services/host/browser/host.js';
import { IAppServerApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import type { INativeHostApi } from '../../../src/ash/platform/native/common/nativeHost.js';

if (new URL(location.href).searchParams.has('zh')) setNlsMessages('zh-CN', { ...messages, ...chatMessages, ash: { ...messages.ash, ...chatMessages.ash } });

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
const configuration = resources.add(new InMemoryConfigurationService());
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root, getContainerOffset: () => ({ top: 35, quickInputTop: 0 }) })));
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'notifications-integration', flushInterval: 0 })));
const focusChanges = resources.add(new Emitter<boolean>());
let focused = true;
services.registerInstance(IHostService, {
	get hasFocus() { return focused; }, onDidChangeFocus: focusChanges.event,
	openWindow: async () => { throw new Error('Unexpected window open'); },
	restart: async () => { throw new Error('Unexpected restart'); }, reload: async () => { throw new Error('Unexpected reload'); }, getScreenshot: async () => undefined,
});
const notifications = resources.add(services.createInstance(NotificationService));
services.registerInstance(INotificationService, notifications);
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
services.registerInstance(IQuickInputService, resources.add(services.createInstance(QuickInputService)));
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
services.registerInstance(IThemeService, themes);
resources.add(bindTestColorTheme(themes, root));
const statusbar = resources.add(new StatusbarService());
services.registerInstance(IStatusbarService, statusbar);
const viewRegistry = resources.add(new WorkbenchViewRegistry());
services.registerInstance(IViewDescriptorService, resources.add(services.createInstance(ViewDescriptorService, { registry: viewRegistry })));
// This host exercises notification progress and owns no pane composite Parts.
const unexpectedPaneOperation = (): never => { throw new Error('Unexpected pane operation in the notification fixture'); };
services.registerInstance(IPaneCompositePartService, {
	onDidPaneCompositeOpen: Event.None,
	onDidPaneCompositeClose: Event.None,
	openPaneComposite: unexpectedPaneOperation,
	getActivePaneComposite: unexpectedPaneOperation,
	getProgressIndicator: unexpectedPaneOperation,
	getPartId: unexpectedPaneOperation,
	hideActivePaneComposite: unexpectedPaneOperation,
	getLastActivePaneCompositeId: unexpectedPaneOperation,
});
services.registerInstance(IViewsService, resources.add(services.createInstance(ViewsService)));
const progressService = resources.add(services.createInstance(ProgressService));
resources.add(statusbar.addEntry({ text: 'main' }, { id: 'fixture.branch', alignment: StatusbarAlignment.Left }));
const createStatusbarPart = (): void => {
	const part = resources.add(services.createInstance(StatusbarPart, root));
	part.domNode.style.position = 'absolute';
	part.domNode.style.bottom = '0';
};
const registerAfterPart = new URL(location.href).searchParams.has('registerAfterPart');
if (registerAfterPart) { createStatusbarPart(); }
const center = resources.add(services.createInstance(NotificationsCenter, root, notifications.model, feedback, runner, statusbar, undefined));
services.registerInstance(INotificationsCenter, center);
const titlebar = h(document, 'div');
titlebar.style.cssText = 'position: absolute; top: 0; right: 12px; height: 35px; display: flex; align-items: center';
root.append(titlebar);
resources.add(new MenuWorkbenchToolBar(titlebar, services.get(IMenuService), services.get(IContextMenuService), MenuId.TitleBar));
if (!registerAfterPart) { createStatusbarPart(); }
services.registerInstance(IExtensionApi, { list: async () => ({ generation: 1, diagnostics: [], extensions: [{ id: 'fixture.git', displayName: 'Git' }] }) } as unknown as import('../../../src/ash/platform/extensions/common/extensionApi.js').IExtensionApi);
const extensionMessages = resources.add(services.createInstance(MainThreadMessageService));
let managed: unknown;
resources.add(CommandsRegistry.register(OPEN_EXTENSIONS_COMMAND_ID, (_accessor, options) => { managed = options; }));
let selection: number | null | undefined;
let actionRuns = 0;
const invitationScope = resources.add(services.createChild());
const invitationState = resources.add(new AgentsWindowInvitationState(Date.now, { editorSessionCount: 0, lastShown: undefined, agentsWindowSessionCount: 0, lastAgentsWindowSessionCreated: undefined }));
const submissions = resources.add(new Emitter<{ sessionId: string; threadId: string; isNewSession: boolean; requestSequence: number; }>());
const invitationRegistry = new ConfigurationRegistry();
invitationRegistry.registerConfiguration({ key: ChatAIDisabledSettingId, defaultValue: false, parse: value => { if (typeof value !== 'boolean') throw new TypeError('Invalid fixture preference'); return value; } });
invitationScope.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService(invitationRegistry)));
invitationScope.registerInstance(IChatService, {
	onDidSubmitRequest: submissions.event, onDidUpdateThread: Event.None, onDidChangeSession: Event.None,
	readThread: async (sessionId: string, threadId: string) => ({ thread: { sessionId, threadId, status: 'active', turns: [{ status: 'running' }] } }),
} as unknown as IChatService);
let draftCleared = 0;
let openRequests = 0;
let acknowledgeHandoff: (() => void) | undefined;
invitationScope.registerInstance(IChatSessionNavigationService, {
	getActiveConversation: () => ({ sessionId: 'invitation-session', threadId: 'invitation-thread' }),
	captureActiveDraft: async () => ({ draft: { mode: 'agent', text: 'Synthetic unsent draft', contexts: [] }, clear: () => { draftCleared++; } }),
} as unknown as IChatSessionNavigationService);
invitationScope.registerInstance(IHostService, { hasFocus: true, onDidChangeFocus: Event.None } as IHostService);
invitationScope.registerInstance(IAppServerApi, { onConnectionState: () => Disposable.None } as unknown as IAppServerApi);
const invitationHost: Pick<INativeHostApi, 'getAgentHostEditorState' | 'onDidChangeAgentHostEditorState' | 'updateAgentHostEditorState' | 'claimAgentsWindowInvitation' | 'markAgentsWindowInvitationShown' | 'releaseAgentsWindowInvitation' | 'openAgentsWindow'> = {
	getAgentHostEditorState: async () => invitationState.getState(),
	onDidChangeAgentHostEditorState: listener => invitationState.onDidChange(listener),
	updateAgentHostEditorState: async update => invitationState.update(1, update),
	claimAgentsWindowInvitation: async resource => invitationState.claim(1, URI.revive(resource)),
	markAgentsWindowInvitationShown: async id => invitationState.markShown(1, id),
	releaseAgentsWindowInvitation: async id => invitationState.release(1, id),
	openAgentsWindow: async () => { openRequests++; await new Promise<void>(resolve => { acknowledgeHandoff = resolve; }); },
};
invitationScope.registerInstance(INativeHostService, invitationHost as INativeHostApi);
resources.add(invitationScope.createInstance(AgentsWindowInvitationContribution));
const presented: string[] = [];
let activeProgress: { finish: DeferredPromise<void>; report: IProgress<IProgressStep>; pending: Promise<void>; } | undefined;
resources.add(toDisposable(() => { void activeProgress?.finish.complete(undefined); }));


const fixture = {
	setHostFocus(value: boolean): void { focused = value; focusChanges.fire(value); },
	notifyOptions(message: string, severity: Severity = Severity.Info, priority: NotificationPriority = NotificationPriority.DEFAULT, sticky = false): number {
		notifications.notify({ message, severity, priority, sticky });
		return notifications.model.getNotifications().at(-1)!.id;
	},
	configure: (key: string, value: unknown) => configuration.updateValue(key, value),
	command: (id: string) => services.get(ICommandService).executeCommand(id),
	filters: () => notifications.getFilters(),
	sourceNotify(message: string, id: string, label = id, severity: Severity = Severity.Info): void {
		notifications.notify({ severity, message, source: { id, label } });
	},
	startProgress(priority: NotificationPriority = NotificationPriority.DEFAULT): void {
		const finish = new DeferredPromise<void>();
		let report!: IProgress<IProgressStep>;
		const pending = progressService.withProgress({ location: ProgressLocation.Notification, title: 'Indexing fixture', source: { id: 'fixture.indexer', label: 'Indexer' }, priority, cancellable: true }, value => { report = value; return finish.p; }, () => { void finish.complete(undefined); });
		activeProgress = { finish, report, pending };
	},
	reportProgress: () => activeProgress?.report.report({ total: 4, increment: 1, message: 'Reading files' }),
	async finishProgress(): Promise<void> { await activeProgress?.finish.complete(undefined); await activeProgress?.pending; activeProgress = undefined; },
	status: (message: string, showAfter = 0, hideAfter?: number) => { const handle = notifications.status(message, { showAfter, hideAfter }); resources.add(toDisposable(() => handle.close())); },
	setPosition: (position: NotificationsPosition) => configuration.updateValue(NotificationsSettings.NOTIFICATIONS_POSITION, position),
	loadBasePartStylesLast(): void {
		const style = document.createElement('style');
		style.textContent = partStyles;
		document.head.append(style);
		resources.add(toDisposable(() => style.remove()));
	},
	invite: () => submissions.fire({ sessionId: 'invitation-session', threadId: 'invitation-thread', isNewSession: true, requestSequence: 1 }),
	invitation: () => invitationState.getState(),
	get draftCleared() { return draftCleared; },
	get openRequests() { return openRequests; },
	acknowledgeHandoff: () => acknowledgeHandoff?.(),
	presented: () => [...presented],
	notify(message: string, severity: Severity = Severity.Info, trackPresentation = false): number {
		const handle = notifications.notify({ severity, message, source: 'Fixture', actions: { primary: [{ id: 'fixture.action', label: 'Run action', tooltip: '', enabled: true, run: () => { actionRuns++; } }] } });
		if (trackPresentation) {
			resources.add(handle.onDidChangeVisibility(visible => { if (visible) presented.push(message); }));
			if (handle.visible) presented.push(message);
		}
		return notifications.model.getNotifications().at(-1)!.id;
	},
	extensionMessage(items: readonly string[]): void {
		selection = undefined;
		void extensionMessages.handle({ operation: 'showMessage', severity: 'error', message: 'Git operation failed. Open the current comparison from Source Control before selecting lines.', items }, 'fixture.git', new AbortController().signal).then(result => {
			if (result.result === 'selection') selection = result.index;
		});
	},
	get selection() { return selection; },
	get managed() { return managed; },
	show: () => center.show(),
	hide: () => center.hide(),
	clear: () => center.clearAll(),
	remove: (id: number) => notifications.model.remove(id),
	get actionRuns() { return actionRuns; },
	history: () => notifications.model.getNotifications().map(item => item.id),
	setDoNotDisturb: (enabled: boolean) => notifications.setFilter(enabled ? NotificationsFilter.ERROR : NotificationsFilter.OFF),
	theme(index: number): void { themes.setColorTheme([lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]); },
};

declare global { interface Window { ashNotificationsIntegration: typeof fixture; } }
window.ashNotificationsIntegration = fixture;
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

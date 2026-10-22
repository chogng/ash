import '../../../src/ash/workbench/contrib/browserView/electron-browser/browserView.contribution.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { setIconResolver } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { IBrowserViewService, BrowserViewStorageScope, type IBrowserViewInfo, type BrowserViewEvent } from '../../../src/ash/platform/browserView/common/browserView.js';
import { IMenuService, MenuId } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService, ConfigurationTarget } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { TestNotificationService } from './notificationFixture.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { bindTestColorTheme } from './themeFixture.js';
import { darkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { getIconDefinition } from '../../../src/ash/platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IDialogsModel } from '../../../src/ash/workbench/common/dialogs.js';
import { BrowserEditorInput } from '../../../src/ash/workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserEditor } from '../../../src/ash/workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IEditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { IBrowserViewWorkbenchService } from '../../../src/ash/workbench/contrib/browserView/common/browserView.js';
import { BrowserZoomService, IBrowserZoomService } from '../../../src/ash/workbench/contrib/browserView/common/browserZoomService.js';
import { IBrowserAutoReloadService } from '../../../src/ash/workbench/contrib/browserView/electron-browser/features/browserAutoReloadFeatures.js';
import { IChatContextPickService } from '../../../src/ash/workbench/services/chat/common/chatContextService.js';
import { ChatContextPickService } from '../../../src/ash/workbench/services/chat/browser/chatContextPickService.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js';
import workbenchTranslations from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { IExternalUriOpenerService } from '../../../src/ash/workbench/contrib/externalUriOpener/common/externalUriOpenerService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { BrowserViewEditorId } from '../../../src/ash/workbench/contrib/browserView/common/browserView.js';
import { BrowserSearchEngineSettingId } from '../../../src/ash/workbench/contrib/browserView/common/browserSearch.js';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import '../../../src/ash/base/browser/ui/styles.css';

declare global {
	interface Window {
		ashBrowserViewIntegration: {
			readonly calls: readonly string[];
			setSearch(engine: string): Promise<void>;
			history(back: boolean, forward: boolean): void;
			commands(): readonly string[];
			attach(page: 'first' | 'second'): Promise<void>;
			oldPageStatus(): void;
			detach(): void;
			dispose(): void;
		};
	}
}

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsMessages(catalog.locale, locale === 'zh-CN'
		? { ...catalog.bundles, 'ash.workbench': { ...catalog.bundles['ash.workbench'], ...workbenchTranslations['ash.workbench'] } }
		: catalog.bundles);
}
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
services.registerInstance(ILogService, new NullLoggerService());
const calls: string[] = [];
const contexts = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contexts);
services.registerInstance(IQuickInputService, resources.add(new TestQuickInputService({ container: document.body, contextKeyService: contexts })));
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'browser-view-layout', backend: localStorage, flushInterval: 0 })));
services.registerInstance(IBrowserZoomService, resources.add(services.createInstance(BrowserZoomService)));
const theme = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindTestColorTheme(theme, document.body));
setIconResolver(document, getIconDefinition);
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(IMenuService, new MenuService(commands, contexts));
// The fixture has no product keybinding registry; menu activation uses the real menu's keyboard handling.
services.registerInstance(IKeybindingService, { lookupKeybinding: () => undefined } as unknown as IKeybindingService);
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
services.registerInstance(IContextMenuService, resources.add(services.createInstance(BrowserContextMenuService)));
services.registerInstance(IDialogsModel, { dialogs: [], onWillShowDialog: Event.None, onDidCloseDialog: Event.None } as unknown as IDialogsModel);
services.registerInstance(IDialogService, { prompt: async () => { calls.push('share'); return {}; } } as unknown as IDialogService);
services.registerInstance(IChatSessionNavigationService, { getConversations: () => [] } as unknown as IChatSessionNavigationService);
services.registerInstance(IChatContextPickService, new ChatContextPickService());
// This component fixture has one pane and no workspace file watchers.
const editorChanges = resources.add(new Emitter<import('../../../src/ash/workbench/services/editor/common/editorState.js').EditorPartChangeEvent>());
services.registerInstance(IEditorPart, { groups: [], get activePane() { return editor; }, onDidChangeEditors: editorChanges.event } as unknown as IEditorPart);
services.registerInstance(IEditorService, { get activeEditor() { return editor.input; } } as IEditorService);
services.registerInstance(IExternalUriOpenerService, { _serviceBrand: undefined, registerExternalOpenerProvider: () => toDisposable(() => { }), getOpener: async () => undefined });
services.registerInstance(IBrowserViewWorkbenchService, {
	onDidChangeBrowserViews: Event.None,
	initialize: async () => { },
	getKnownBrowserViews: () => new Map(),
	getContextualBrowserViews: () => new Map(),
	registerContextualFilter: () => toDisposable(() => { }),
	registerOpenHandler: () => toDisposable(() => { }),
	getOrCreateLazy: () => { throw new Error('This fixture owns one browser input'); },
	createBrowserView: async () => { throw new Error('This fixture owns one browser input'); },
});
services.registerInstance(IBrowserAutoReloadService, {
	onDidChangeState: Event.None,
	isEnabled: () => false,
	canReload: () => false,
	toggle: () => { throw new Error('Auto reload requires a workspace in this fixture'); },
});
const info: IBrowserViewInfo = {
	id: 'browser_target_00000000-0000-0000-0000-000000000000', host: { windowId: 1 }, owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace },
	state: { targetId: 'browser_target_00000000-0000-0000-0000-000000000000', url: 'https://example.com/', title: 'Browser layout', loading: false, canGoBack: true, canGoForward: true, visible: true },
};
const pageEvents = resources.add(new Emitter<BrowserViewEvent>());
// Main-owned page operations stop at the service boundary; renderer, toolbar and context menu remain real.
services.registerInstance(IBrowserViewService, {
	getBrowserHistory: async () => ({ items: [{ id: 1, url: 'https://example.com/visited', title: 'Visited page', time: 1 }] }),
	deleteBrowserHistory: async () => { calls.push('clearHistory'); },
	loadURL: async (_id: string, url: string) => { calls.push(url); },
	onDidEvent: pageEvents.event, getOrCreateBrowserView: async (id: string) => ({ ...info, id, state: { ...info.state, targetId: id } }), getState: async (id: string) => ({ ...info.state, targetId: id }),
	goBack: async () => { calls.push('back'); }, goForward: async () => { calls.push('forward'); },
	toggleElementSelection: async () => { }, toggleAreaSelection: async () => { }, stopFindInPage: async () => { },
	layout: async () => { }, setVisible: async () => { }, getSharing: async () => [],
	updateWindowConfiguration: async () => { }, focus: async () => { },
	clearPermissions: async () => { calls.push('permissions'); }, cancelDownloads: async () => { calls.push('downloads'); },
} as unknown as IBrowserViewService);
const editor = resources.add(services.createInstance(BrowserEditor));
const input = resources.add(services.createInstance(BrowserEditorInput, { id: info.id, url: info.state.url, title: info.state.title, session: info.session }));
editor.create(document.querySelector<HTMLElement>('#browser')!);
await editor.setInput(input, new AbortController().signal);
editor.setVisible(true);
contexts.setContext('activeEditor', BrowserViewEditorId);
const contributions = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.browserView']));
contributions.advance(WorkbenchPhase.BlockRestore);
const second = resources.add(services.createInstance(BrowserEditorInput, { id: 'browser_target_00000000-0000-0000-0000-000000000001', url: info.state.url, title: info.state.title, session: info.session }));
window.ashBrowserViewIntegration = {
	calls,
	setSearch: engine => services.get(IConfigurationService).updateValue(BrowserSearchEngineSettingId, engine, ConfigurationTarget.MEMORY),
	history: (canGoBack, canGoForward) => { pageEvents.fire({ type: 'stateChanged', state: { ...editor.model!.state, canGoBack, canGoForward } }); },
	commands: () => services.get(IMenuService).getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions).filter(action => action.enabled && ['workbench.action.browser.goBack', 'workbench.action.browser.goForward'].includes(action.id)).map(action => action.id),
	attach: async page => { await editor.setInput(page === 'first' ? input : second, new AbortController().signal); },
	oldPageStatus: () => { pageEvents.fire({ type: 'stateChanged', state: { ...info.state, title: 'Retired page', loading: true } }); },
	detach: () => editor.clearInput(),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

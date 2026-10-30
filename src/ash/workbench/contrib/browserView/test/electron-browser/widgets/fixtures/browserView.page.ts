import { IChatContextPickService } from '../../../../../chat/browser/attachments/chatContextPickService.js';
import '../../../../electron-browser/browserView.contribution.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { setIconResolver } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
import { setNlsMessages } from '../../../../../../../nls.js';
import { IBrowserViewService, BrowserViewStorageScope, type IBrowserViewInfo, type BrowserViewEvent } from '../../../../../../../platform/browserView/common/browserView.js';
import { IMenuService, MenuId } from '../../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../../platform/actions/common/menuService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextMenuService, IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../../../../../platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../../../../platform/contextview/browser/contextViewService.js';
import { IDialogService } from '../../../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../../../platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../../../../../platform/keybinding/common/keybinding.js';
import { ILogService, NullLoggerService } from '../../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IStorageService } from '../../../../../../../platform/storage/common/storage.js';
import { bindTestColorTheme } from '../../../../../../../../../test/fixtures/browser/themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../../platform/theme/common/colorTheme.js';
import { getIconDefinition } from '../../../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../../../platform/theme/test/common/testThemeService.js';
import { IDialogsModel } from '../../../../../../common/dialogs.js';
import { BrowserEditorInput } from '../../../../common/browserEditorInput.js';
import { BrowserEditor } from '../../../../electron-browser/browserEditor.js';
import { IChatSessionNavigationService } from '../../../../../../services/chat/common/chatSessionNavigationService.js';
import { CommandService } from '../../../../../../services/commands/common/commandService.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IEditorPart } from '../../../../../../browser/parts/editor/editorPart.js';
import { IBrowserViewWorkbenchService } from '../../../../common/browserView.js';
import { BrowserZoomService, IBrowserZoomService } from '../../../../common/browserZoomService.js';
import { IBrowserAutoReloadService } from '../../../../electron-browser/features/browserAutoReloadFeatures.js';

import { ChatContextPickService } from '../../../../../../contrib/chat/browser/attachments/chatContextPickService.js';
import { productLanguagePackCatalogs } from '../../../../../../services/localization/common/localizationCatalogs.js';
import { BrowserStorageService } from '../../../../../../services/storage/browser/storageService.js';
import { IQuickInputService } from '../../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import workbenchTranslations from '../../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { IExternalUriOpenerService } from '../../../../../externalUriOpener/common/externalUriOpenerService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../../common/contributions.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import { BrowserViewEditorId } from '../../../../common/browserView.js';
import { BrowserSearchEngineSettingId } from '../../../../common/browserSearch.js';
import '../../../../../../../platform/theme/common/sizes/baseSizes.js';
import '../../../../../../../base/browser/ui/styles.css';

declare global {
	interface Window {
		ashBrowserViewIntegration: {
			readonly calls: readonly string[];
			setSearch(engine: string): Promise<void>;
			history(back: boolean, forward: boolean): void;
			loading(value: boolean): void;
			devTools(open: boolean): void;
			loadError(message?: string): void;
			theme(id: string): void;
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
const editorChanges = resources.add(new Emitter<import('../../../../../../services/editor/common/editorState.js').EditorPartChangeEvent>());
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
const autoReloadChanged = resources.add(new Emitter<void>());
let autoReloadEnabled = false;
services.registerInstance(IBrowserAutoReloadService, {
	onDidChangeState: autoReloadChanged.event,
	isEnabled: () => autoReloadEnabled,
	canReload: () => true,
	toggle: () => { autoReloadEnabled = !autoReloadEnabled; calls.push('autoReload'); autoReloadChanged.fire(); },
});
const info: IBrowserViewInfo = {
	id: 'browser_target_00000000-0000-0000-0000-000000000000', host: { windowId: 1 }, owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace },
	state: { isDevToolsOpen: false, targetId: 'browser_target_00000000-0000-0000-0000-000000000000', url: 'https://example.com/', title: 'Browser layout', loading: false, canGoBack: true, canGoForward: true, visible: true },
};
const pageEvents = resources.add(new Emitter<BrowserViewEvent>());
// Main-owned page operations stop at the service boundary; renderer, toolbar and context menu remain real.
services.registerInstance(IBrowserViewService, {
	getBrowserHistory: async () => ({ items: [{ id: 1, url: 'https://example.com/visited', title: 'Visited page', time: 1 }] }),
	deleteBrowserHistory: async () => { calls.push('clearHistory'); },
	loadURL: async (_id: string, url: string) => { calls.push(url); },
	onDidEvent: pageEvents.event, getOrCreateBrowserView: async (id: string) => ({ ...info, id, state: { ...info.state, targetId: id } }), getState: async (id: string) => ({ ...info.state, targetId: id }),
	goBack: async () => { calls.push('back'); }, goForward: async () => { calls.push('forward'); },
	reload: async (_id: string, hard?: boolean) => { calls.push(hard ? 'hardReload' : 'reload'); },
	stop: async () => { calls.push('stop'); },
	toggleDevTools: async () => { calls.push('devTools'); },
	toggleElementSelection: async () => { }, toggleAreaSelection: async () => { }, stopFindInPage: async () => { },
	setElementComments: async () => { },
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
	loading: loading => { pageEvents.fire({ type: 'stateChanged', state: { ...editor.model!.state, loading } }); },
	devTools: isDevToolsOpen => { pageEvents.fire({ type: 'stateChanged', state: { ...editor.model!.state, isDevToolsOpen } }); },
	loadError: errorDescription => { pageEvents.fire({ type: 'stateChanged', state: { ...editor.model!.state, errorDescription } }); },
	theme: id => { theme.setColorTheme([darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme].find(theme => theme.id === id)!); },
	commands: () => services.get(IMenuService).getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions).filter(action => action.enabled && ['workbench.action.browser.goBack', 'workbench.action.browser.goForward'].includes(action.id)).map(action => action.id),
	attach: async page => { await editor.setInput(page === 'first' ? input : second, new AbortController().signal); },
	oldPageStatus: () => { pageEvents.fire({ type: 'stateChanged', state: { ...info.state, title: 'Retired page', loading: true } }); },
	detach: () => editor.clearInput(),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

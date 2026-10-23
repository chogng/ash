import '../../../../../../base/browser/ui/styles.css';
import '../../../../../browser/media/style.css';
import '../../../../../common/theme.js';
import { AICustomizationManagementEditor } from '../../../browser/aiCustomization/aiCustomizationManagementEditor.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { formatNlsMessage, setNlsMessages } from '../../../../../../nls.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { IAppServerHookApi, IAppServerSkillApi, type HookSource } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { createDisconnectedRendererApi } from '../../../../../browser/rendererApi.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { darkColorTheme, highContrastDarkColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILocalizationService } from '../../../../../services/localization/common/localizationService.js';
import { IAppServerRemoteAgentService } from '../../../../../services/remote/common/appServerRemoteAgentService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IWorkbenchHostService } from '../../../../../services/host/common/workbenchHostService.js';
import { IPromptsService } from '../../../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../common/promptSyntax/service/promptsServiceImpl.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import type { ITextFileSaveEvent } from '../../../../../services/textfile/common/textFileService.js';
import settings from '../../../../../../../../extensions/language-pack-zh-cn/translations/settings.json' with { type: 'json' };
import chat from '../../../../../../../../extensions/language-pack-zh-cn/translations/chat.json' with { type: 'json' };

const locale = new URLSearchParams(location.search).get('locale') ?? 'en';
const catalogs: Readonly<Record<string, Readonly<Record<string, string>>>> = locale === 'zh-CN' ? { ...settings, ...chat } : {};
setNlsMessages(locale, catalogs);
document.documentElement.lang = locale;
const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const services = resources.add(new InstantiationService());
const keys = resources.add(new ContextKeyService());
const views = resources.add(new BrowserContextViewService(document.body));
const theme = resources.add(new TestThemeService(new URLSearchParams(location.search).has('hc') ? highContrastDarkColorTheme : darkColorTheme));
resources.add(bindTestColorTheme(theme, document.documentElement));
const workspace = resources.add(new TestWorkspaceService({ id: 'fixture', folders: [{ id: 'folder', name: 'fixture', index: 0, uri: URI.file('/fixture') }] }));
const saved = resources.add(new Emitter<ITextFileSaveEvent>());
let reads = 0;
let opened = 0;
let readFailure = false;
let editOutcome: 'success' | 'failure' | 'cancelled' = 'success';
let pending: DeferredPromise<readonly HookSource[]> | undefined;
let sources: readonly HookSource[] = [{ namespace: 'directory:fixture', configPath: '/fixture/.ash/config.toml', hooks: [{ id: 'directory:fixture:hook:review', event: 'preToolUse', enabled: true, program: '/synthetic/review', args: ['<img src=x onerror="throw 1">'], toolNames: ['shell-command'] }] }];
services.registerInstance(IAppServerHookApi, {
	onDidChangeHooks: Event.None,
	list: async () => { reads++; if (pending) return pending.p; if (readFailure) throw new Error('fixture catalog failed'); return sources; },
});
services.registerInstance(IAppServerSkillApi, createDisconnectedRendererApi().skills);
services.registerInstance(IWorkbenchHostService, { downloadText: () => { throw new Error('Unexpected download'); } });
services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
services.registerInstance(IWorkspaceContextService, workspace);
services.registerInstance(IAppServerRemoteAgentService, { connection: { kind: 'local', generation: 1 }, connectionState: 'connected', onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None, reconnect: async () => ({ kind: 'alreadyConnected' }), rollbackRuntime: async () => ({ kind: 'cancelled' }) });
services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => undefined } as IChatSessionNavigationService);
services.registerInstance(ILocalizationService, {
	whenReady: Promise.resolve(), translate: (bundle, key, fallback, parameters) => formatNlsMessage(catalogs[bundle]?.[key] ?? fallback, parameters),
});
services.registerInstance(IContextViewService, views);
services.registerInstance(IContextKeyService, keys);
services.registerInstance(IAccessibleViewService, { ...toDisposable(() => { }), getOpenAriaHint: () => undefined, show: () => false, disableHint: async () => { }, showAccessibleViewHelp: () => { } });
services.registerInstance(IThemeService, theme);
services.registerInstance(IStorageService, { onWillSaveState: Event.None } as IStorageService);
services.registerInstance(ITextFileService, { onDidSave: saved.event, onDidChangeFiles: Event.None, resolve: async () => { throw new Error('Unexpected text resolve'); }, save: async () => { throw new Error('Unexpected persistence'); } });
services.registerInstance(IFileService, { createDirectory: async () => { }, createFile: async () => { } } as unknown as IFileService);
services.registerInstance(IEditorService, { openEditor: async () => { opened++; if (editOutcome === 'failure') throw new Error('fixture editor failed'); if (editOutcome === 'cancelled') throw new CancellationError(); } } as unknown as IEditorService);
const pane = resources.add(services.createInstance(AICustomizationManagementEditor));
pane.create(document.body);
pane.layout({ width: 960, height: 800 });
pane.setVisible(true);

declare global {
	interface Window {
		ashHookManagementIntegration: {
			readonly reads: number;
			readonly opened: number;
			save(): void;
			setEditOutcome(outcome: 'success' | 'failure' | 'cancelled'): void;
			reopen(): void;
			beginDelayedRead(): void;
			switchWorkspace(): void;
			completeDelayedRead(): Promise<void>;
		};
	}
}
window.ashHookManagementIntegration = {
	get reads() { return reads; }, get opened() { return opened; },
	save() { sources = sources.map(source => ({ ...source, hooks: source.hooks.map(hook => ({ ...hook, enabled: false })) })); saved.fire({ resource: URI.file('/fixture/.ash/config.toml'), content: '', revision: 'fixture-2' }); },
	setEditOutcome(outcome) { editOutcome = outcome; },
	reopen() { pane.setVisible(false); pane.setVisible(true); },
	beginDelayedRead() { pending = new DeferredPromise<readonly HookSource[]>(); },
	switchWorkspace() { const previous = pending; pending = undefined; readFailure = true; workspace.updateWorkspace({ id: 'next', folders: [] }); pending = previous; },
	async completeDelayedRead() { await pending?.complete(sources); pending = undefined; },
};

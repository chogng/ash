import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/common/theme.js';
import { AICustomizationManagementEditor } from '../../../src/ash/workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditor.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { CancellationError } from '../../../src/ash/base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { formatNlsMessage, setNlsMessages } from '../../../src/ash/nls.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IAppServerHookApi, IAppServerSkillApi, type HookSource } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { darkColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { bindTestColorTheme } from './themeFixture.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IAppServerRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/appServerRemoteAgentService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IWorkbenchHostService } from '../../../src/ash/workbench/services/host/common/workbenchHostService.js';
import { IPromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { ITextFileService } from '../../../src/ash/workbench/services/textfile/common/textfiles.js';
import type { ITextFileSaveEvent } from '../../../src/ash/workbench/services/textfile/common/textFileService.js';
import settings from '../../../extensions/language-pack-zh-cn/translations/settings.json' with { type: 'json' };
import chat from '../../../extensions/language-pack-zh-cn/translations/chat.json' with { type: 'json' };

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

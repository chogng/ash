import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/iconlabel/iconlabel.css';
import { Button } from '../../../src/ash/base/browser/ui/button/button.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { LanguageService } from '../../../src/ash/editor/common/services/languageService.js';
import { ILanguageService } from '../../../src/ash/editor/common/languages/language.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { createBrowserExtensionApi } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { AgentTraceEditor } from '../../../src/ash/workbench/contrib/trace/browser/agentTraceEditor.js';
import { IChatService } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { ExtensionColorThemeService } from '../../../src/ash/workbench/services/extensions/browser/extensionColorThemeService.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { BrowserHostColorSchemeService } from '../../../src/ash/workbench/services/themes/browser/browserHostColorSchemeService.js';
import { WorkbenchThemeService } from '../../../src/ash/workbench/services/themes/browser/workbenchThemeService.js';
import { IHostColorSchemeService } from '../../../src/ash/workbench/services/themes/common/hostColorSchemeService.js';

declare global {
	interface Window {
		agentTraceIntegration: {
			setTheme(id: string): Promise<void>;
			dispose(): void;
		};
	}
}

const resources = new DisposableStore();
const extensionThemes = resources.add(new ExtensionColorThemeService(createBrowserExtensionApi(), { subscribe: () => ({ dispose() { } }) }));
await extensionThemes.start();
const root = document.querySelector<HTMLElement>('#root')!;
const services = resources.add(new InstantiationService());
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
services.registerInstance(ILanguageService, resources.add(new LanguageService()));
services.registerInstance(IHostColorSchemeService, resources.add(new BrowserHostColorSchemeService(window)));
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'agent-trace-theme', flushInterval: 0 })));
services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
// This fixture imports a test-owned capture; any accidental live read must fail.
services.registerInstance(IChatService, {
	onDidChangeSession: Event.None,
	onDidUpdateThread: Event.None,
	onDidBecomeReady: Event.None,
} as unknown as IChatService);
const themes = resources.add(services.createInstance(WorkbenchThemeService, root));
themes.initialize();
services.registerInstance(IThemeService, themes);
const editor = resources.add(services.createInstance(AgentTraceEditor));
editor.create(root);
editor.layout({ width: 900, height: 650 });
await editor.setInput({ resource: URI.parse('ash-agent-trace:/import') }, new AbortController().signal);
resources.add(new Button(root, { label: 'Reference secondary button', presentation: 'secondary' }));
window.agentTraceIntegration = {
	async setTheme(id: string): Promise<void> { await themes.setColorTheme(id); },
	dispose(): void { resources.dispose(); },
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';

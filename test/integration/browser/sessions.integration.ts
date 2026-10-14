import { errorHandler } from '../../../src/ash/base/common/errors.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { createDisconnectedRendererApi } from '../../../src/ash/platform/agentHost/browser/rendererApi.js';
import type { } from '../../../src/ash/workbench/browser/web.api.js';
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { WorkbenchThemesRegistry } from '../../../src/ash/workbench/common/theme.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';

if (new URL(location.href).searchParams.get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}
await import('../../../src/ash/sessions/sessions.web.main.js');
const { SessionsBrowserMain } = await import('../../../src/ash/sessions/browser/web.main.js');

// Mount the renderer's real Parts, settings and canvas without a product process or backend.
// A disconnected host that advertises automation still owns its saved management entry.
if (new URL(location.href).searchParams.has('automations')) {
	globalThis.ashWebWorkbenchHost = {
		api: {
			...createDisconnectedRendererApi(), automation: {
				onDidChange: Event.None, list: async () => [], runs: async () => [],
				save: async () => { throw new Error('Unexpected automation save'); },
				delete: async () => { throw new Error('Unexpected automation delete'); },
				run: async () => { throw new Error('Window restoration must not run automations'); },
				stop: async () => { throw new Error('Window disposal must not stop automations'); },
			}
		}
	};
}
const themes = WorkbenchThemesRegistry.registerColorThemes([darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme]);
window.addEventListener('pagehide', () => themes.dispose(), { once: true });
const initialErrorHandler = errorHandler.getUnexpectedErrorHandler();
let main = new SessionsBrowserMain(document.querySelector<HTMLElement>('#app')!, codeSessionsProfile);
window.addEventListener('pagehide', () => main.dispose(), { once: true });
let workbench = await main.open();
const errors: string[] = [];
const errorDetails: string[] = [];
const stopObservingErrors = errorHandler.addListener(error => { errors.push(String(error)); errorDetails.push(error instanceof Error ? error.stack ?? String(error) : String(error)); });
window.addEventListener('pagehide', stopObservingErrors, { once: true });

declare global {
	interface Window {
		ashSessionsIntegration: {
			readonly errors: readonly string[];
			readonly errorDetails: readonly string[];
			takeErrors(): string[];
			disposeAndCheckErrorHandler(): Promise<boolean>;
			remountAfterDirectDispose(): Promise<void>;
			setTheme(id: string): Promise<void>;
			updateConfiguration(key: string, value: unknown): Promise<void>;
		};
	}
}

window.ashSessionsIntegration = {
	errors, errorDetails,
	takeErrors: () => { errorDetails.splice(0); return errors.splice(0); },
	disposeAndCheckErrorHandler: async () => {
		await workbench.shutdown('windowClose');
		main.dispose();
		return errorHandler.getUnexpectedErrorHandler() === initialErrorHandler;
	},
	remountAfterDirectDispose: async () => {
		main.dispose();
		main = new SessionsBrowserMain(document.querySelector<HTMLElement>('#app')!, codeSessionsProfile);
		workbench = await main.open();
	},
	setTheme: id => workbench.configurationService.updateValue('workbench.colorTheme', id),
	updateConfiguration: (key, value) => workbench.configurationService.updateValue(key, value),
};
document.body.dataset.ready = 'true';

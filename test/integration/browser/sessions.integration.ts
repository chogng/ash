import { errorHandler } from '../../../src/ash/base/common/errors.js';
import '../../../src/ash/sessions/sessions.web.main.js';
import type { } from '../../../src/ash/workbench/browser/web.api.js';
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { SessionsBrowserMain } from '../../../src/ash/sessions/browser/web.main.js';
import { WorkbenchThemesRegistry } from '../../../src/ash/workbench/common/theme.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';

// Mount the renderer's real Parts, settings and canvas without a product process or backend.
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

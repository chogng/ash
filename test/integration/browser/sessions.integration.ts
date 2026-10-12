import { errorHandler } from '../../../src/ash/base/common/errors.js';
import '../../../src/ash/sessions/sessions.web.main.js';
import type { } from '../../../src/ash/workbench/browser/web.api.js';
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { SessionsBrowserMain } from '../../../src/ash/sessions/browser/web.main.js';

// Mount the renderer's real Parts, settings and canvas without a product process or backend.
const initialErrorHandler = errorHandler.getUnexpectedErrorHandler();
const main = new SessionsBrowserMain(document.querySelector<HTMLElement>('#app')!, codeSessionsProfile);
window.addEventListener('pagehide', () => main.dispose(), { once: true });
const workbench = await main.open();
const errors: string[] = [];
const stopObservingErrors = errorHandler.addListener(error => errors.push(String(error)));
window.addEventListener('pagehide', stopObservingErrors, { once: true });

declare global {
	interface Window {
		ashSessionsIntegration: {
			readonly errors: readonly string[];
			takeErrors(): string[];
			disposeAndCheckErrorHandler(): Promise<boolean>;
			setTheme(id: string): Promise<void>;
			updateConfiguration(key: string, value: unknown): Promise<void>;
		};
	}
}

window.ashSessionsIntegration = {
	errors,
	takeErrors: () => errors.splice(0),
	disposeAndCheckErrorHandler: async () => {
		await workbench.shutdown('windowClose');
		main.dispose();
		return errorHandler.getUnexpectedErrorHandler() === initialErrorHandler;
	},
	setTheme: id => workbench.configurationService.updateValue('workbench.colorTheme', id),
	updateConfiguration: (key, value) => workbench.configurationService.updateValue(key, value),
};
document.body.dataset.ready = 'true';

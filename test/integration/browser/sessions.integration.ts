import { setUnexpectedErrorHandler } from '../../../src/ash/base/common/errors.js';
import '../../../src/ash/sessions/sessions.web.main.js';
import type { } from '../../../src/ash/workbench/browser/web.api.js';
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { SessionsBrowserMain } from '../../../src/ash/sessions/browser/web.main.js';

// Mount the renderer's real Parts, settings and canvas without a product process or backend.
const main = new SessionsBrowserMain(document.querySelector<HTMLElement>('#app')!, codeSessionsProfile);
window.addEventListener('pagehide', () => main.dispose(), { once: true });
const workbench = await main.open();
const errors: string[] = [];
setUnexpectedErrorHandler(error => errors.push(String(error)));

declare global {
	interface Window {
		ashSessionsIntegration: {
			readonly errors: readonly string[];
			setTheme(id: string): Promise<void>;
			updateConfiguration(key: string, value: unknown): Promise<void>;
		};
	}
}

window.ashSessionsIntegration = {
	errors,
	setTheme: id => workbench.configurationService.updateValue('workbench.colorTheme', id),
	updateConfiguration: (key, value) => workbench.configurationService.updateValue(key, value),
};
document.body.dataset.ready = 'true';

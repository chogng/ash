import '../../../src/ash/sessions/sessions.web.main.js';
import type { } from '../../../src/ash/workbench/browser/web.api.js';
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { SessionsBrowserMain } from '../../../src/ash/sessions/browser/web.main.js';

// Mount the renderer's real Parts, settings and canvas without a product process or backend.
const main = new SessionsBrowserMain(document.querySelector<HTMLElement>('#app')!, codeSessionsProfile);
window.addEventListener('pagehide', () => main.dispose(), { once: true });
const workbench = await main.open();

declare global {
	interface Window {
		ashSessionsIntegration: {
			setTheme(id: string): Promise<void>;
		};
	}
}

window.ashSessionsIntegration = {
	setTheme: id => workbench.configurationService.updateValue('workbench.colorTheme', id),
};
document.body.dataset.ready = 'true';

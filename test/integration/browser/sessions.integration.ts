import { Event } from '../../../src/ash/base/common/event.js';
import { Disposable } from '../../../src/ash/base/common/lifecycle.js';
import { setUnexpectedErrorHandler } from '../../../src/ash/base/common/errors.js';
import { registerSingleton, InstantiationType } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { IPluginManagementService } from '../../../src/ash/platform/extensionManagement/common/pluginManagementService.js';
import '../../../src/ash/sessions/sessions.web.main.js';
import type { } from '../../../src/ash/workbench/browser/web.api.js';
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { SessionsBrowserMain } from '../../../src/ash/sessions/browser/web.main.js';

// Settings search also renders the extension category; package mutations stay in host tests.
class FixturePluginService extends Disposable implements IPluginManagementService {
	readonly onDidChange = Event.None;
	async list() { return { revision: 0, activationGeneration: 0, packages: [] }; }
	private readonly mutate = async (): Promise<never> => { throw new Error('Plugin mutation is outside this component fixture'); };
	readonly installLocal = this.mutate;
	readonly enable = this.mutate;
	readonly disable = this.mutate;
	readonly grant = this.mutate;
	readonly revokeGrant = this.mutate;
	readonly uninstall = this.mutate;
}
registerSingleton(IPluginManagementService, FixturePluginService, InstantiationType.Delayed);

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

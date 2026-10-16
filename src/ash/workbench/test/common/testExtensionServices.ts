import { createEmptyTestLanguagePacks } from '../../services/localization/test/common/localizationTestUtils.js';
import type { DisposableStore } from '../../../base/common/lifecycle.js';
import { ExtensionResourceLoaderService } from '../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import type { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import type { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { AppServerExtensionService } from '../../services/extensions/browser/appServerExtensionService.js';
import type { IAdapterManager } from '../../contrib/debug/common/debug.js';
import { AdapterManager } from '../../contrib/debug/browser/debugAdapterManager.js';

/** Production extension activation with an isolated API and language-pack source. */
export class TestExtensionService extends AppServerExtensionService {
	constructor(api: IExtensionApi = { list: async () => ({ generation: 1, extensions: [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('No extension resources in service fixture'); }) }, adapters?: IAdapterManager) {
		const manager = adapters ?? new AdapterManager();
		super({ api }, createEmptyTestLanguagePacks(), manager);
		if (!adapters) this._register(manager);
	}
}

export function registerTestExtensionService(owner: DisposableStore, services: InstantiationService, api?: IExtensionApi): TestExtensionService {
	const extensions = owner.add(new TestExtensionService(api));
	services.registerInstance(IExtensionService, extensions);
	return extensions;
}

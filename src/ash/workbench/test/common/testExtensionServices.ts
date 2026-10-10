import type { DisposableStore } from '../../../base/common/lifecycle.js';
import { ExtensionResourceLoaderService } from '../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import type { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import type { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { AppServerExtensionService } from '../../services/extensions/browser/appServerExtensionService.js';
import { TextMateGrammarRegistry, type TextMateGrammarDefinition, type TextMateGrammarRegistration } from '../../services/textMate/common/textMateGrammarRegistry.js';
import type { ITextMateService } from '../../services/textMate/common/textMateService.js';

// Only the worker boundary is substituted; catalogs and activation registrations
// retain their production owner and disposal rules in these service tests.
export class TestExtensionService extends AppServerExtensionService {
	constructor(api: IExtensionApi = { list: async () => ({ generation: 1, extensions: [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('No extension resources in service fixture'); }) }) {
		const registry = new TextMateGrammarRegistry();
		super({
			api, textMateService: {
				grammars: {
					registerGrammars: (definitions: readonly TextMateGrammarDefinition[]) => registry.registerMany(definitions),
					prepareGrammars: async (registration: TextMateGrammarRegistration, definitions: readonly TextMateGrammarDefinition[]) => {
						const prepared = registration.prepare(definitions);
						return { commit: () => { prepared.commit(); return {}; } };
					},
					whenReady: async () => ({}),
				},
			} as unknown as ITextMateService
		});
		this._register(registry);
	}
}

export function registerTestExtensionService(owner: DisposableStore, services: InstantiationService, api?: IExtensionApi): TestExtensionService {
	const extensions = owner.add(new TestExtensionService(api));
	services.registerInstance(IExtensionService, extensions);
	return extensions;
}

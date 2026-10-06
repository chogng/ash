import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { ModelService } from '../../../editor/common/services/modelService.js';
import { ILanguageService } from '../../../editor/common/languages/language.js';
import { LanguageService } from '../../../editor/common/services/languageService.js';
import { ILanguageFeaturesService } from '../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../editor/common/services/languageFeaturesService.js';
import { createTestLanguageConfigurationService } from '../../../editor/test/common/modes/testLanguageConfigurationService.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { WorkbenchConfigurationService } from '../../services/configuration/browser/configurationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { BrowserStorageService } from '../../services/storage/browser/storageService.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';
import { TextResourcePropertiesService } from '../../services/textresourceProperties/common/textResourcePropertiesService.js';
import { TextModelResolverService } from '../../services/textmodelResolver/common/textModelResolverService.js';
import { ITextModelResourceService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { IOutputService } from '../../services/output/common/output.js';
import { OutputService } from '../../contrib/output/browser/outputServices.js';

/** Real Output and resolver assembly; filesystem acquisition is an explicit scenario boundary. */
class TestWorkbenchServices extends InstantiationService {
	public readonly resources = this._register(new DisposableStore());
}

export function workbenchInstantiationService(owner?: Pick<DisposableStore, 'add'>, storage?: IStorageService, overrides: { readonly languageFeatures?: ILanguageFeaturesService; readonly output?: IOutputService; } = {}): InstantiationService {
	const services = new TestWorkbenchServices();
	owner?.add(services);
	const resources = services.resources;
	const configuration = resources.add(new WorkbenchConfigurationService());
	const languages = resources.add(new LanguageService());
	const features = overrides.languageFeatures ?? resources.add(new LanguageFeaturesService());
	const languageConfiguration = resources.add(createTestLanguageConfigurationService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILanguageService, languages);
	services.registerInstance(ILanguageFeaturesService, features);
	services.registerInstance(IModelService, resources.add(new ModelService(configuration, services.createInstance(TextResourcePropertiesService), languages, features, languageConfiguration)));
	services.registerInstance(IWorkspaceContextService, resources.add(new WorkspaceContextService({ id: 'test', uri: URI.file('/workspace') })));
	if (!storage) {
		const browser = new JSDOM('', { url: 'https://ash.test' });
		resources.add(toDisposable(() => browser.window.close()));
		storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', backend: browser.window.localStorage, flushInterval: 0 }));
	}
	services.registerInstance(IStorageService, storage);
	services.registerInstance(ITextModelResourceService, {
		...toDisposable(() => { }),
		acquire: async () => { throw new Error('Filesystem acquisition is outside this Output scenario'); },
	});
	services.registerInstance(ITextModelService, services.createInstance(TextModelResolverService));
	if (overrides.output) {
		services.registerInstance(IOutputService, overrides.output);
	} else {
		services.registerSingleton(IOutputService, () => services.createInstance(OutputService));
	}
	return services;
}

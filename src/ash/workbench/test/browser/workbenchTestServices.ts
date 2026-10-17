import { IProgressService } from '../../../platform/progress/common/progress.js';
import { BrowserProgressService } from '../../../platform/progress/browser/progressService.js';
import type { ITextResourceStore } from '../../services/textmodelResolver/common/textResourceStore.js';
import { TestUriIdentityServices } from '../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { JSDOM } from 'jsdom';
import { Event } from '../../../base/common/event.js';
import { BrowserTextModelService } from '../../services/textmodelResolver/browser/browserTextModelService.js';
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
import { TestConfigurationService as WorkbenchConfigurationService } from '../../services/configuration/test/common/testServices.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { BrowserStorageService } from '../../services/storage/browser/storageService.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';
import { TextResourcePropertiesService } from '../../services/textresourceProperties/common/textResourcePropertiesService.js';
import { TextModelResolverService } from '../../services/textmodelResolver/common/textModelResolverService.js';
import { IFileTextModelService, ITextModelResourceService } from '../../services/textmodelResolver/common/textModelResourceService.js';
import { IOutputService } from '../../services/output/common/output.js';
import { OutputService } from '../../contrib/output/browser/outputServices.js';
import { IStatusbarService, StatusbarService } from '../../services/statusbar/browser/statusbar.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { TestQuickInputService } from '../../../platform/quickinput/test/browser/testQuickInputService.js';
import { NotificationService } from '../../services/notification/common/notificationService.js';
import { ViewsService } from '../../services/views/browser/viewsService.js';
import { IViewsService } from '../../services/views/common/viewsService.js';
import { WorkbenchViewRegistry } from '../../common/views.js';
import { ViewDescriptorService } from '../../services/views/browser/viewDescriptorService.js';
import { IFileSearchService } from '../../../platform/search/common/fileSearch.js';
import { BrowserFileSearchService } from '../../../platform/search/browser/browserFileSearchService.js';
import { ISecretStorageService, BaseSecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../services/dialogs/common/dialogService.js';

/** Explicit window dependencies for fixtures that construct the real terminal owner. */
export function registerTestTerminalLifecycleServices(services: InstantiationService): void {
	if (!services.has(IConfigurationService)) services.registerSingleton(IConfigurationService, () => new WorkbenchConfigurationService());
	if (!services.has(IDialogService)) services.registerSingleton(IDialogService, () => services.createInstance(DialogService));
	if (!services.has(ISecretStorageService)) services.registerSingleton(ISecretStorageService, () => new BaseSecretStorageService());
	if (!services.has(IStorageService)) services.registerSingleton(IStorageService, () => new TerminalTestStorage());
}

class TerminalTestStorage extends BrowserStorageService {
	private readonly browser: JSDOM;
	constructor() {
		const browser = new JSDOM('', { url: 'https://terminal.test' });
		super({ ownerWindow: browser.window as unknown as Window, workspaceId: 'terminal', flushInterval: 0 });
		this.browser = browser;
	}
	protected override disposeCore(): void { super.disposeCore(); this.browser.window.close(); }
}

/** Real Output and resolver assembly; filesystem acquisition is an explicit scenario boundary. */
class TestWorkbenchServices extends InstantiationService {
	public readonly resources = this._register(new DisposableStore());
}

export function workbenchInstantiationService(owner?: Pick<DisposableStore, 'add'>, storage?: IStorageService, overrides: { readonly languageFeatures?: ILanguageFeaturesService; readonly output?: IOutputService; readonly fileResources?: ITextResourceStore; } = {}): TestWorkbenchServices {
	const services = new TestWorkbenchServices();
	owner?.add(services);
	const resources = services.resources;
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	services.registerSingleton(IProgressService, () => new BrowserProgressService(document.createElement('div')));
	const uriIdentityServices = resources.add(new TestUriIdentityServices());
	services.registerInstance(IUriIdentityService, uriIdentityServices.get(IUriIdentityService));
	const configuration = resources.add(new WorkbenchConfigurationService());
	const languages = resources.add(new LanguageService());
	const features = overrides.languageFeatures ?? resources.add(new LanguageFeaturesService());
	const languageConfiguration = resources.add(createTestLanguageConfigurationService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStatusbarService, resources.add(new StatusbarService()));
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
	registerTestTerminalLifecycleServices(services);
	const fileModels = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, overrides.fileResources ?? {
		onDidChange: Event.None,
		resolve: async () => { throw new Error('Filesystem acquisition is outside this Output scenario'); },
		save: async () => { throw new Error('Filesystem acquisition is outside this Output scenario'); },
	} satisfies ITextResourceStore, { languageService: languages, languageFeaturesService: features, languageConfigurationService: languageConfiguration }));
	services.registerInstance(ITextModelResourceService, fileModels);
	services.registerInstance(IFileTextModelService, fileModels);
	services.registerInstance(ITextModelService, services.createInstance(TextModelResolverService));
	if (overrides.output) {
		services.registerInstance(IOutputService, overrides.output);
	} else {
		services.registerSingleton(IOutputService, () => services.createInstance(OutputService));
	}
	return services;
}


/** Registers the real window owners used by interactive workflow services. */
export function registerTestWorkbenchInteractionServices(owner: DisposableStore, services: InstantiationService): void {
	services.registerSingleton(IFileSearchService, () => services.createInstance(BrowserFileSearchService));
	const viewContext = owner.add(new ContextKeyService());
	const descriptors = owner.add(new ViewDescriptorService({ registry: owner.add(new WorkbenchViewRegistry()) }, viewContext));
	// Service scenarios have no UI Parts. The real view owner returns null for
	// unregistered views; Web/Electron scenarios exercise their actual containers.
	services.registerInstance(IViewsService, owner.add(new ViewsService(descriptors, {
		onDidPaneCompositeOpen: Event.None, onDidPaneCompositeClose: Event.None,
		getActivePaneComposite: () => undefined, getLastActivePaneCompositeId: () => undefined,
		getPartId: () => { throw new Error('UI Parts are not registered in this service scenario'); },
		openPaneComposite: async () => { throw new Error('UI Parts are not registered in this service scenario'); },
		hideActivePaneComposite: () => { throw new Error('UI Parts are not registered in this service scenario'); },
	}, viewContext)));

	const window = new JSDOM('', { url: 'https://ash.test' });
	owner.add(toDisposable(() => window.window.close()));
	services.registerInstance(IQuickInputService, owner.add(new TestQuickInputService({ container: window.window.document.body, contextKeyService: owner.add(new ContextKeyService()) })));
	services.registerInstance(INotificationService, owner.add(new NotificationService()));
}

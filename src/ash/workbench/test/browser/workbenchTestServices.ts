import { IWorkbenchLayoutService, Position } from '../../services/layout/browser/layoutService.js';
import { IDefaultLogLevelsService } from '../../services/log/common/defaultLogLevels.js';
import { DEFAULT_LOG_LEVEL, ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { emptyEditorServiceState } from '../common/testEditorService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { CommandService } from '../../services/commands/common/commandService.js';
import { IProgressService } from '../../../platform/progress/common/progress.js';
import { ProgressService } from '../../services/progress/browser/progressService.js';
import type { ITextResourceStore } from '../../services/textmodelResolver/common/textResourceStore.js';
import { TestUriIdentityServices } from '../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { JSDOM } from 'jsdom';
import { Event } from '../../../base/common/event.js';
import { BrowserTextModelService } from '../../services/textmodelResolver/browser/browserTextModelService.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
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
import { TestWorkspaceService } from '../../services/configuration/test/common/testServices.js';
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
import { InstantiationType } from '../../../platform/instantiation/common/extensions.js';
import { ITerminalProfileService, ITerminalProfileResolverService } from '../../contrib/terminal/common/terminal.js';
import { ITerminalGroupService, ITerminalEditorService } from '../../contrib/terminal/browser/terminal.js';
import { TerminalProfileService } from '../../contrib/terminal/browser/terminalProfileService.js';
import { BrowserTerminalProfileResolverService } from '../../contrib/terminal/browser/terminalProfileResolverService.js';
import { TerminalGroupService } from '../../contrib/terminal/browser/terminalGroupService.js';
import { TerminalEditorService } from '../../contrib/terminal/browser/terminalEditorService.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IPathService } from '../../../platform/path/common/pathService.js';
import { ISearchService } from '../../services/search/common/search.js';
import { IHostService } from '../../services/host/browser/host.js';
import { TestHostService } from '../../services/host/test/browser/testHostService.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { BrowserPathService } from '../../services/path/browser/pathService.js';
import { ITerminalProcessService } from '../../../platform/terminal/common/terminal.js';
import type { IRendererHost } from '../../../platform/renderer/common/rendererHost.js';

/** Explicit window dependencies for fixtures that construct the real terminal owner. */
export function registerTestTerminalLifecycleServices(services: InstantiationService): void {
	if (!services.has(IContextKeyService)) services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	if (!services.has(IConfigurationService)) services.registerSingleton(IConfigurationService, () => new WorkbenchConfigurationService());
	if (!services.has(IDialogService)) services.registerSingleton(IDialogService, () => services.createInstance(DialogService));
	if (!services.has(ISecretStorageService)) services.registerSingleton(ISecretStorageService, () => new BaseSecretStorageService());
	if (!services.has(IStorageService)) services.registerSingleton(IStorageService, () => new TerminalTestStorage());

}

/** Explicit dependencies for fixtures that instantiate the real terminal creation owner. */
export function registerTestTerminalCreationServices(services: InstantiationService): void {
	if (!services.has(ILogService)) services.registerInstance(ILogService, new NullLoggerService());
	if (!services.has(IExtensionService)) services.registerInstance(IExtensionService, {
		...Disposable.None, getExtensionPointContributions: () => [], currentCatalog: { generation: 0, extensions: [], diagnostics: [] }, onDidChange: Event.None, activateByEvent: async () => { },
	} as unknown as IExtensionService);
	if (!services.has(IHostService)) services.registerInstance(IHostService, new TestHostService());
	if (!services.has(ISearchService)) services.registerInstance(ISearchService, {
		fileSearch: async () => ({ results: [], messages: [] }),
		textSearch: async () => { throw new Error('Terminal creation fixture does not search file contents'); },
	});
	registerTestTerminalLifecycleServices(services);
	if (!services.has(IWorkbenchLayoutService)) services.registerInstance(IWorkbenchLayoutService, {
		getPanelPosition: () => Position.BOTTOM, onDidChangePanelPosition: Event.None,
	} as unknown as IWorkbenchLayoutService);
	if (!services.has(IPathService)) services.registerSingleton(IPathService, () => new BrowserPathService({ hasAppServer: true, appServer: { operatingSystem: services.get(ITerminalProcessService).operatingSystem } } as IRendererHost, services.get(IWorkspaceContextService)));
	if (!services.has(ICommandService)) services.registerSingleton(ICommandService, () => new CommandService(services));
	if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { }, save: async () => ({ success: true, editors: [] }), saveAll: async () => ({ success: true, editors: [] }) });
	// Low-level lifecycle fixtures do not open UI. Keep the real creation services
	// delayed, so scenarios that exercise them must supply their actual dependencies.
	if (!services.has(ITerminalProfileService)) services.registerSingleton(ITerminalProfileService, () => services.createInstance(TerminalProfileService), { instantiation: InstantiationType.Delayed });
	if (!services.has(ITerminalProfileResolverService)) services.registerSingleton(ITerminalProfileResolverService, () => services.createInstance(BrowserTerminalProfileResolverService), { instantiation: InstantiationType.Delayed });
	if (!services.has(ITerminalGroupService)) services.registerSingleton(ITerminalGroupService, () => services.createInstance(TerminalGroupService), { instantiation: InstantiationType.Delayed });
	if (!services.has(ITerminalEditorService)) services.registerSingleton(ITerminalEditorService, () => services.createInstance(TerminalEditorService), { instantiation: InstantiationType.Delayed });
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

export function workbenchInstantiationService(owner?: Pick<DisposableStore, 'add'>, storage?: IStorageService, overrides: { readonly languageFeatures?: ILanguageFeaturesService; readonly output?: IOutputService; readonly fileResources?: ITextResourceStore; readonly dialogService?: IDialogService; } = {}): TestWorkbenchServices {
	const services = new TestWorkbenchServices();
	owner?.add(services);
	const resources = services.resources;
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerSingleton(INotificationService, () => new NotificationService());
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	services.registerSingleton(IProgressService, () => services.createInstance(ProgressService));
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
	services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'test', uri: URI.file('/workspace') })));
	if (!storage) {
		const browser = new JSDOM('', { url: 'https://ash.test' });
		resources.add(toDisposable(() => browser.window.close()));
		storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', backend: browser.window.localStorage, flushInterval: 0 }));
	}
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IDefaultLogLevelsService, {
		defaultLogLevels: { default: DEFAULT_LOG_LEVEL, extensions: [] }, onDidChangeDefaultLogLevels: Event.None,
		getDefaultLogLevel: () => DEFAULT_LOG_LEVEL,
		setDefaultLogLevel: async () => { throw new Error('Default log persistence is outside this fixture'); },
	});
	if (overrides.dialogService) services.registerInstance(IDialogService, overrides.dialogService);
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
	if (!services.has(INotificationService)) services.registerInstance(INotificationService, owner.add(new NotificationService()));
}

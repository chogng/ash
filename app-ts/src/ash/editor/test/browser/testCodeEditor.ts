import { ILanguageFeatureDebounceService, LanguageFeatureDebounceService } from '../../common/services/languageFeatureDebounce.js';
import '../../browser/services/contribution.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IMarkerService, MarkerService } from '../../../platform/markers/common/markers.js';
import { IMarkerDecorationsService } from '../../common/services/markerDecorations.js';
import { MarkerDecorationsService } from '../../common/services/markerDecorationsService.js';
import { StandaloneCodeEditorService } from '../../standalone/browser/standaloneCodeEditorService.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../browser/services/inlineCompletionsService.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IInstantiationService, ServiceContainer, ServiceConstructionDescriptor } from '../../../platform/instantiation/common/instantiation.js';
import { darkColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../browser/widget/codeEditor/codeEditorWidget.js';
import { ICodeEditorService } from '../../browser/services/codeEditorService.js';
import { createTestLanguageConfigurationService } from '../common/modes/testLanguageConfigurationService.js';
import { ILanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';
import { StandaloneBulkEditService, StandaloneCommandService, StandaloneKeybindingService, StandaloneNotificationService, StandaloneWorkspaceContextService } from '../../standalone/browser/standaloneServices.js';
import { IBulkEditService } from '../../browser/services/bulkEditService.js';
import { DefaultDropProvidersFeature, DefaultPasteProvidersFeature } from '../../contrib/dropOrPasteInto/browser/defaultProviders.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IMenuService, MenuService } from '../../../platform/actions/common/menuService.js';
import { IContextMenuService, IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { HoverService, IHoverService } from '../../../platform/hover/browser/hoverService.js';
import { BrowserContextViewService } from '../../../platform/contextview/browser/contextViewService.js';
import { BrowserContextMenuService } from '../../../platform/contextview/browser/contextMenuService.js';
import { IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../platform/accessibility/browser/accessibilityService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { QuickInputController } from '../../../platform/quickinput/browser/quickInputController.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';

interface TestCodeEditorOptions extends CodeEditorWidgetOptions {
	readonly instantiationService?: IInstantiationService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly accessibilityService?: IAccessibilityService;
}

export function createCodeEditorServices(disposables: Pick<DisposableStore, 'add'>, parent?: IInstantiationService): ServiceContainer {
	const services = disposables.add(parent ? parent.createChild() : new ServiceContainer());
	registerCodeEditorServices(services);
	return services;
}

/** Completes an existing test scope without replacing its explicit service overrides. */
export function registerCodeEditorServices(services: ServiceContainer): void {
	if (!services.has(ILogService)) {
		services.registerInstance(ILogService, new NullLoggerService());
	}
	if (!services.has(IContextKeyService)) {
		services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	}
	if (!services.has(IConfigurationService)) {
		services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	}
	if (!services.has(IAccessibilityService)) {
		services.registerSingleton(IAccessibilityService, accessor => new AccessibilityService({
			root: document.body,
			contextKeyService: accessor.get(IContextKeyService),
			configurationService: accessor.get(IConfigurationService),
		}));
	}
	if (!services.has(IMarkerService)) {
		services.registerSingleton(IMarkerService, () => services.createInstance(MarkerService));
	}
	if (!services.has(IMarkerDecorationsService)) {
		services.registerSingleton(IMarkerDecorationsService, () => services.createInstance(MarkerDecorationsService));
	}
	if (!services.has(ICodeEditorService)) {
		services.registerSingleton(ICodeEditorService, () => services.createInstance(StandaloneCodeEditorService));
	}
	if (!services.has(ICommandService)) {
		services.registerSingleton(ICommandService, () => services.createInstance(StandaloneCommandService));
	}
	if (!services.has(IKeybindingService)) {
		services.registerSingleton(IKeybindingService, () => services.createInstance(StandaloneKeybindingService));
	}
	if (!services.has(INotificationService)) {
		services.registerSingleton(INotificationService, () => services.createInstance(StandaloneNotificationService));
	}
	if (!services.has(IQuickInputService)) {
		services.registerSingleton(IQuickInputService, () => new QuickInputController(document.body));
	}
	if (!services.has(IMenuService)) {
		services.registerSingleton(IMenuService, () => services.createInstance(new ServiceConstructionDescriptor(MenuService, {
			serviceDependencies: [ICommandService, IContextKeyService],
		})));
	}
	if (!services.has(IContextViewService)) {
		services.registerSingleton(IContextViewService, () => services.createInstance(BrowserContextViewService, document.body));
	}
	if (!services.has(IContextMenuService)) {
		services.registerSingleton(IContextMenuService, () => services.createInstance(new ServiceConstructionDescriptor(BrowserContextMenuService, {
			serviceDependencies: [IMenuService, IContextKeyService, IKeybindingService, IContextViewService, INotificationService],
		})));
	}
	if (!services.has(IHoverService)) {
		services.registerSingleton(IHoverService, accessor => new HoverService(
			accessor.get(IConfigurationService),
			accessor.get(IContextViewService),
			accessor.get(IContextMenuService),
		));
	}
	if (!services.has(ILanguageFeatureDebounceService)) {
		services.registerSingleton(ILanguageFeatureDebounceService, () => services.createInstance(LanguageFeatureDebounceService));
	}
	if (!services.has(IInlineCompletionsService)) {
		services.registerSingleton(IInlineCompletionsService, () => services.createInstance(InlineCompletionsService));
	}
	if (!services.has(IThemeService)) {
		services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	}
	if (!services.has(ILanguageConfigurationService)) {
		services.registerSingleton(ILanguageConfigurationService, () => createTestLanguageConfigurationService());
	}
	if (!services.has(ILanguageFeaturesService)) {
		services.registerSingleton(ILanguageFeaturesService, () => new LanguageFeaturesService());
	}
	if (!services.has(IBulkEditService)) {
		services.registerSingleton(IBulkEditService, () => services.createInstance(StandaloneBulkEditService));
	}
	if (!services.has(IWorkspaceContextService)) {
		services.registerInstance(IWorkspaceContextService, new StandaloneWorkspaceContextService());
	}
}

export function createTestCodeEditor(options: TestCodeEditorOptions): CodeEditorWidget {
	const resources = new DisposableStore();
	try {
		const { instantiationService, languageConfigurationService, languageFeaturesService, accessibilityService, ...widgetOptions } = options;
		const overrides = resources.add(instantiationService ? instantiationService.createChild() : new ServiceContainer());
		if (!overrides.has(IQuickInputService)) {
			overrides.registerSingleton(IQuickInputService, () => new QuickInputController(widgetOptions.container.ownerDocument.body));
		}
		if (languageConfigurationService) {
			overrides.registerInstance(ILanguageConfigurationService, languageConfigurationService);
		}
		if (languageFeaturesService) {
			overrides.registerInstance(ILanguageFeaturesService, languageFeaturesService);
		}
		if (accessibilityService) {
			overrides.registerInstance(IAccessibilityService, accessibilityService);
		}
		const services = createCodeEditorServices(resources, overrides);
		resources.add(new DefaultPasteProvidersFeature(services.get(ILanguageFeaturesService), services.get(IWorkspaceContextService)));
		resources.add(new DefaultDropProvidersFeature(services.get(ILanguageFeaturesService), services.get(IWorkspaceContextService)));
		return services.createInstance(TestCodeEditor, widgetOptions, resources);
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

class TestCodeEditor extends CodeEditorWidget {
	constructor(
		options: CodeEditorWidgetOptions,
		resources: DisposableStore,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@ILanguageConfigurationService languageConfigurationService: ILanguageConfigurationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
	) {
		super(options, instantiationService, themeService, languageConfigurationService, languageFeaturesService, contextKeyService, codeEditorService);
		this._register(resources);
		this.registerWithService();
	}
}

import '../../browser/services/contribution.js';
import { IMarkerService, MarkerService } from '../../../platform/markers/common/markers.js';
import { IMarkerDecorationsService } from '../../common/services/markerDecorations.js';
import { MarkerDecorationsService } from '../../common/services/markerDecorationsService.js';
import { StandaloneCodeEditorService } from '../../standalone/browser/standaloneCodeEditorService.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../browser/services/inlineCompletionsService.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IInstantiationService, ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { darkColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../platform/theme/test/common/testThemeService.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../browser/widget/codeEditor/codeEditorWidget.js';
import { ICodeEditorService } from '../../browser/services/codeEditorService.js';
import { createBuiltinLanguageConfigurationService } from '../../common/languages/languageBuiltinConfigurations.js';
import { ILanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';

interface TestCodeEditorOptions extends CodeEditorWidgetOptions {
	readonly instantiationService?: IInstantiationService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
}

export function createCodeEditorServices(disposables: Pick<DisposableStore, 'add'>, parent?: IInstantiationService): ServiceContainer {
	const services = disposables.add(parent ? parent.createChild() : new ServiceContainer());
	if (!services.has(IMarkerService)) {
		services.registerSingleton(IMarkerService, () => services.createInstance(MarkerService));
	}
	if (!services.has(IMarkerDecorationsService)) {
		services.registerSingleton(IMarkerDecorationsService, () => services.createInstance(MarkerDecorationsService));
	}
	if (!services.has(ICodeEditorService)) {
		services.registerSingleton(ICodeEditorService, () => services.createInstance(StandaloneCodeEditorService));
	}
	if (!services.has(IInlineCompletionsService)) {
		services.registerSingleton(IInlineCompletionsService, () => services.createInstance(InlineCompletionsService));
	}
	if (!services.has(IThemeService)) {
		services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	}
	if (!services.has(ILanguageConfigurationService)) {
		services.registerSingleton(ILanguageConfigurationService, () => createBuiltinLanguageConfigurationService());
	}
	if (!services.has(ILanguageFeaturesService)) {
		services.registerSingleton(ILanguageFeaturesService, () => new LanguageFeaturesService());
	}
	return services;
}

export function createTestCodeEditor(options: TestCodeEditorOptions): CodeEditorWidget {
	const resources = new DisposableStore();
	try {
		const { instantiationService, languageConfigurationService, languageFeaturesService, ...widgetOptions } = options;
		const overrides = resources.add(instantiationService ? instantiationService.createChild() : new ServiceContainer());
		if (languageConfigurationService) {
			overrides.registerInstance(ILanguageConfigurationService, languageConfigurationService);
		}
		if (languageFeaturesService) {
			overrides.registerInstance(ILanguageFeaturesService, languageFeaturesService);
		}
		const services = createCodeEditorServices(resources, overrides);
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
	) {
		super(options, instantiationService, themeService, languageConfigurationService, languageFeaturesService);
		this._register(resources);
	}
}

import { ILanguageFeatureDebounceService, LanguageFeatureDebounceService } from '../../common/services/languageFeatureDebounce.js';
import { StandaloneCodeEditorService } from './standaloneCodeEditorService.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../browser/services/inlineCompletionsService.js';
import { MarkerService, IMarkerService } from '../../../platform/markers/common/markers.js';
import { MarkerDecorationsService } from '../../common/services/markerDecorationsService.js';
import { IMarkerDecorationsService } from '../../common/services/markerDecorations.js';
import { Disposable } from "../../../base/common/lifecycle.js";
import { ServiceContainer } from "../../../platform/instantiation/common/instantiation.js";
import { IThemeService } from "../../../platform/theme/common/themeService.js";
import { ConfigurationTarget, IConfigurationService, isConfigurationUpdateOverrides, type IConfigurationChangeEvent, type IConfigurationData, type IConfigurationOverrides, type IConfigurationUpdateOptions, type IConfigurationUpdateOverrides, type IConfigurationValue } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ICodeEditorService, type ICodeEditorService as ICodeEditorServiceContract } from '../../browser/services/codeEditorService.js';
import { type LanguageCompletionWorkerFactory, type SyntaxWorkerFactory } from '../../common/languages.js';
import { VersionedEditorWorkerClient, type VersionedEditorWorkerFactory } from "../../browser/services/editorWorkerService.js";
import { registerBuiltinLanguageConfigurations, registerBuiltinLanguageDescriptions } from '../common/builtinLanguages.js';
import { ILanguageFeaturesService } from '../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';
import { ILanguageService, type IAshLanguageService } from '../../common/languages/language.js';
import { LanguageService } from '../../common/services/languageService.js';
import { ILanguageConfigurationService, LanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { IModelService } from '../../common/services/model.js';
import { ModelService } from '../../common/services/modelService.js';
import { ITextResourcePropertiesService, type ITextResourcePropertiesService as ITextResourcePropertiesServiceContract } from '../../common/services/textResourceConfiguration.js';
import { isLinux, isMacintosh } from '../../../base/common/platform.js';
import type { URI } from '../../../base/common/uri.js';
import { type INamedEditorThemeService } from "../common/namedEditorTheme.js";
import { NamedEditorThemeService } from "./namedEditorThemeService.js";
import { type Event } from '../../../base/common/event.js';
import { type IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { BrowserClipboardService } from '../../../platform/clipboard/browser/browserClipboardService.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { FormattingConflicts } from '../../contrib/format/browser/format.js';

export interface StandaloneServiceOverrides {
	readonly languageService?: IAshLanguageService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly editorWorkerFactory?: VersionedEditorWorkerFactory;
	readonly syntaxWorkerFactory?: SyntaxWorkerFactory;
	/** Explicit Worker authority that replaces the local completion provider registry. */
	readonly completionWorkerFactory?: LanguageCompletionWorkerFactory;
}

export class StandaloneServiceCollection extends Disposable {
	readonly instantiationService: ServiceContainer;
	readonly modelService: ModelService;
	readonly languageService: IAshLanguageService;
	readonly languageConfigurationService: ILanguageConfigurationService;
	readonly languageFeaturesService: ILanguageFeaturesService;
	readonly themeService: INamedEditorThemeService;
	readonly syntaxWorkerFactory: SyntaxWorkerFactory | undefined;
	readonly editorWorkerFactory: VersionedEditorWorkerFactory;
	readonly completionWorkerFactory: LanguageCompletionWorkerFactory | undefined;
	readonly codeEditorService: ICodeEditorServiceContract;

	constructor(overrides: StandaloneServiceOverrides) {
		super();
		const instantiationService = this.instantiationService = this._register(new ServiceContainer());
		instantiationService.registerInstance(ILogService, new NullLoggerService());
		instantiationService.registerSingleton(IInlineCompletionsService, () => instantiationService.createInstance(InlineCompletionsService));
		instantiationService.registerSingleton(ILanguageFeatureDebounceService, () => instantiationService.createInstance(LanguageFeatureDebounceService));
		instantiationService.registerSingleton(IContextKeyService, () => new ContextKeyService());
		instantiationService.registerSingleton(IMarkerService, () => new MarkerService());
		instantiationService.registerSingleton(IMarkerDecorationsService, () => instantiationService.createInstance(MarkerDecorationsService));
		instantiationService.registerInstance(IClipboardService, new BrowserClipboardService(window.navigator.clipboard));
		instantiationService.registerSingleton(ICodeEditorService, () => instantiationService.createInstance(StandaloneCodeEditorService));
		this.codeEditorService = instantiationService.get(ICodeEditorService);
		this.editorWorkerFactory = overrides.editorWorkerFactory ?? (model => new VersionedEditorWorkerClient(model));
		this.syntaxWorkerFactory = overrides.syntaxWorkerFactory;
		this.completionWorkerFactory = overrides.completionWorkerFactory;
		const configurationService = this._register(new StandaloneConfigurationService());
		instantiationService.registerInstance(IConfigurationService, configurationService);
		instantiationService.registerSingleton(ITextResourcePropertiesService, accessor => new StandaloneResourcePropertiesService(accessor.get(IConfigurationService)));
		if (overrides.languageFeaturesService && !overrides.languageConfigurationService) throw new TypeError("Standalone language feature overrides require a language configuration service");
		if (overrides.languageService) instantiationService.registerInstance(ILanguageService, overrides.languageService);
		else instantiationService.registerSingleton(ILanguageService, () => new LanguageService());
		if (overrides.languageConfigurationService) instantiationService.registerInstance(ILanguageConfigurationService, overrides.languageConfigurationService);
		else instantiationService.registerSingleton(ILanguageConfigurationService, accessor => new LanguageConfigurationService(
			accessor.get(IConfigurationService),
			accessor.get(ILanguageService),
		));
		if (overrides.languageFeaturesService) instantiationService.registerInstance(ILanguageFeaturesService, overrides.languageFeaturesService);
		else instantiationService.registerSingleton(ILanguageFeaturesService, () => new LanguageFeaturesService());
		instantiationService.registerSingleton(IThemeService, () => new NamedEditorThemeService(window));
		this.themeService = instantiationService.get(IThemeService) as INamedEditorThemeService;
		instantiationService.registerSingleton(IModelService, accessor => new ModelService(
			accessor.get(IConfigurationService),
			accessor.get(ITextResourcePropertiesService),
			accessor.get(ILanguageService),
			accessor.get(ILanguageFeaturesService),
			accessor.get(ILanguageConfigurationService),
			{ syntaxService: { workerFactory: this.syntaxWorkerFactory } },
		));
		this.modelService = instantiationService.get(IModelService) as ModelService;
		this.languageService = instantiationService.get(ILanguageService);
		this.languageConfigurationService = instantiationService.get(ILanguageConfigurationService);
		this.languageFeaturesService = instantiationService.get(ILanguageFeaturesService);
		if (!overrides.languageService) this._register(registerBuiltinLanguageDescriptions(this.languageService.languages));
		if (!overrides.languageConfigurationService) this._register(registerBuiltinLanguageConfigurations(this.languageConfigurationService));
		this._register(FormattingConflicts.setFormatterSelector(async formatters => formatters[0]));
	}
}

class StandaloneConfigurationService extends Disposable implements IConfigurationService {
	readonly _serviceBrand = undefined;
	private readonly source = this._register(new InMemoryConfigurationService());
	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = (listener, thisArgs, disposables) => this.source.onDidChangeConfiguration(event => listener.call(thisArgs, {
		...event,
		affectsConfiguration: (section, overrides) => event.affectsConfiguration(section, withoutResource(overrides)),
	}), undefined, disposables);

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue<T>(arg1?: string | IConfigurationOverrides, arg2?: IConfigurationOverrides): T {
		if (typeof arg1 === 'string') return arg2 ? this.source.getValue<T>(arg1, withoutResource(arg2)) : this.source.getValue<T>(arg1);
		return arg1 ? this.source.getValue<T>(withoutResource(arg1)) : this.source.getValue<T>();
	}

	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	updateValue(key: string, value: unknown, arg3?: ConfigurationTarget | IConfigurationOverrides | IConfigurationUpdateOverrides, arg4?: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void> {
		if (typeof arg3 === 'number') return this.source.updateValue(key, value, arg3);
		if (!arg3) return this.source.updateValue(key, value);
		const overrides = withoutResource(arg3);
		return arg4 === undefined
			? this.source.updateValue(key, value, overrides)
			: this.source.updateValue(key, value, overrides, arg4, options);
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<Readonly<T>> {
		return this.source.inspect<T>(key, withoutResource(overrides));
	}

	reloadConfiguration(target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> { return this.source.reloadConfiguration(target); }
	keys(): ReturnType<IConfigurationService['keys']> { return this.source.keys(); }
	getConfigurationData(): IConfigurationData { return this.source.getConfigurationData(); }
}

function withoutResource(overrides: IConfigurationOverrides): IConfigurationOverrides;
function withoutResource(overrides: IConfigurationUpdateOverrides): IConfigurationUpdateOverrides;
function withoutResource(overrides: IConfigurationOverrides | undefined): IConfigurationOverrides | undefined;
function withoutResource(overrides: IConfigurationOverrides | IConfigurationUpdateOverrides | undefined): IConfigurationOverrides | IConfigurationUpdateOverrides | undefined {
	if (!overrides) return undefined;
	return isConfigurationUpdateOverrides(overrides)
		? { overrideIdentifiers: overrides.overrideIdentifiers }
		: { overrideIdentifier: overrides.overrideIdentifier };
}

class StandaloneResourcePropertiesService implements ITextResourcePropertiesServiceContract {
	readonly _serviceBrand: undefined;

	constructor(private readonly configurationService: IConfigurationService) {}

	getEOL(resource: URI, language?: string): string {
		const eol = this.configurationService.getValue<'auto' | '\n' | '\r\n'>('files.eol', { overrideIdentifier: language, resource });
		return eol === 'auto' ? (isLinux || isMacintosh ? '\n' : '\r\n') : eol;
	}
}

let services: StandaloneServiceCollection | undefined;

/** One browser-window service scope. The first editor may provide service overrides. */
export namespace StandaloneServices {
	export function initialize(overrides: StandaloneServiceOverrides = {}): StandaloneServiceCollection {
		if (services) {
			if (Object.keys(overrides).length > 0) throw new Error("Standalone services are already initialized");
			return services;
		}
		services = new StandaloneServiceCollection(overrides);
		return services;
	}

	export function get(): StandaloneServiceCollection {
		return initialize();
	}
}

import { URI } from "../../../../base/common/uri.js";
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IConfigurationNode } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerProblemMatcherContributions, type ProblemMatcherContributions } from '../../../contrib/tasks/common/problemMatcher.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { ColorExtensionPoint } from '../../themes/common/colorExtensionPoint.js';
import { IconExtensionPoint } from '../../themes/common/iconExtensionPoint.js';
import { TokenClassificationExtensionPoint, type SemanticTokenScopeContribution } from '../../themes/common/tokenClassificationExtensionPoint.js';
import type { ColorContribution } from '../../../../platform/theme/common/colorRegistry.js';
import type { IconContribution, IconFontDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import type { TokenTypeOrModifierContribution } from '../../../../platform/theme/common/tokenClassificationRegistry.js';
import { WorkbenchFileIconThemesRegistry, WorkbenchProductIconThemesRegistry } from '../../themes/common/themeExtensionPoints.js';
import type { IWorkbenchFileIconTheme, IWorkbenchProductIconTheme } from '../../themes/common/workbenchThemeService.js';
import { FileIconThemeData } from '../../themes/browser/fileIconThemeData.js';
import { ProductIconThemeData, loadExtensionFontIcon } from '../../themes/browser/productIconThemeData.js';
import { Emitter, runWithBufferedEvents, type Event } from "../../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { type LanguageCompletionProvider, type LanguageCompletionProviderRegistration } from '../../../../editor/common/languages.js';
import type { LanguageConfiguration } from '../../../../editor/common/languages/languageConfiguration.js';
import type { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { parseLanguageConfiguration } from "./languageConfigurationParser.js";
import type { LanguageDescriptionContribution, LanguageDescriptionRegistration } from "../../../../editor/common/services/languagesRegistry.js";
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { IAshLanguageService } from '../../../../editor/common/languages/language.js';
import type { IExtensionApi, ExtensionCatalog as TransportExtensionCatalog, ExtensionDescriptor as TransportExtensionDescriptor } from "../../../../platform/extensions/common/extensionApi.js";
import type { IServerEventApi } from "../../../../platform/agentHost/common/appServerApi.js";
import { ColorScheme } from "../../../../platform/theme/common/theme.js";
import { DebugAdapterFactoriesRegistry, createStaticDebugAdapterFactory, type DebugAdapterFactory, type DebugAdapterFactoryRegistration } from "../../debug/common/debugAdapterFactory.js";
import type { ITextMateService } from "../../textMate/common/textMateService.js";
import type { TextMateGrammarDefinition } from "../../textMate/common/textMateGrammarRegistry.js";
import type { TextMateGrammarRegistration } from "../../textMate/common/textMateGrammarRegistry.js";
import { normalizeTextMateScopeTheme } from "../../textMate/common/textMateScopeTheme.js";
import { projectExtensionTokenTheme } from "../../textMate/common/textMateThemeProjection.js";
import { parseJsonc } from "../common/jsonc.js";
import { parseExtensionManifest, verifyExtensionManifestDigest } from '../common/extensionManifest.js';
import { getNLSLanguage } from '../../../../nls.js';
import { match } from '../../../../base/common/glob.js';
import { basename } from '../../../../base/common/resources.js';
import { EditorPanes, getBuiltinEditorPaneFactory, type IEditorPaneDescriptor } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../../common/editor.js';
import { ExtensionFileTemplateRegistry, type ExtensionFileTemplateDefinition, type ExtensionFileTemplateSource } from "../common/extensionFileTemplate.js";
import { createExtensionSnippetProvider, materializeExtensionFileTemplate, parseExtensionSnippetFile, type ExtensionSnippetDefinition } from "../common/extensionSnippetProvider.js";
import { ExtensionThemeRegistry, loadExtensionTheme, type ExtensionThemeDefinition, type ExtensionThemeSource } from "../common/extensionTheme.js";
import type { ExtensionCatalog, ExtensionDescriptor, ExtensionServiceFailure, IExtensionService } from "../common/extensionService.js";
import { ExtensionDebugAdapterRegistry, validateExtensionDebugAdapterDefinitions, type ExtensionDebugAdapterDefinition, type ExtensionDebugAdapterSource } from "../common/extensionDebugAdapter.js";

export interface AppServerExtensionServiceOptions {
	readonly api: IExtensionApi;
	readonly eventApi?: IServerEventApi;
	readonly textMateService: ITextMateService;
	readonly languageService?: IAshLanguageService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
}

interface LanguageConfigurationContribution {
	readonly languageId: string;
	readonly configuration: LanguageConfiguration;
	readonly priority?: number;
}

/** Loads Rust-discovered declarative extensions and projects their grammar contributions into TextMate. */
export class AppServerExtensionService extends Disposable implements IExtensionService {
	private readonly colorContributions = this._register(new ColorExtensionPoint());
	private readonly iconContributions = this._register(new IconExtensionPoint());
	private readonly tokenContributions = this._register(new TokenClassificationExtensionPoint());
	private activeThemeContributions: ThemeContributions = { colors: [], icons: [], fonts: [], types: [], modifiers: [], scopes: [] };
	private readonly changeEmitter = this._register(new Emitter<ExtensionCatalog>());
	private readonly failureEmitter = this._register(new Emitter<ExtensionServiceFailure>());
	private readonly editorPaneRegistration = this._register(EditorPanes.registerEditorPanes([]));
	private activeEditorPanes: readonly IEditorPaneDescriptor[] = [];
	private catalog: ExtensionCatalog = Object.freeze({
		generation: 0,
		extensions: Object.freeze([]),
		diagnostics: Object.freeze([]),
	});
	private loading: Promise<void> | undefined;
	private activeCatalogSignature: string | undefined;
	private activationHandler: ((event: string, signal?: AbortSignal) => Promise<void>) | undefined;
	private reloadQueued = false;
	private readonly grammarRegistration: TextMateGrammarRegistration;
	private readonly languageRegistration: LanguageDescriptionRegistration | undefined;
	private languageConfigurationRegistrations = new DisposableStore();
	private readonly completionRegistration: LanguageCompletionProviderRegistration | undefined;
	private readonly problemMatcherRegistration = this._register(registerProblemMatcherContributions({ matchers: [], patterns: [] }));
	private readonly debugAdapterFactoryRegistration: DebugAdapterFactoryRegistration;
	private readonly themeRegistry: ExtensionThemeRegistry;
	private readonly fileTemplateRegistry: ExtensionFileTemplateRegistry;
	private readonly debugAdapterRegistry: ExtensionDebugAdapterRegistry;
	private activeGrammars: readonly TextMateGrammarDefinition[] = Object.freeze([]);
	private activeConfigurations: IConfigurationNode[] = [];
	private activeLanguages: readonly LanguageDescriptionContribution[] = Object.freeze([]);
	private activeLanguageConfigurations: readonly LanguageConfigurationContribution[] = Object.freeze([]);
	private activeCompletionProviders: readonly LanguageCompletionProvider[] = Object.freeze([]);
	private readonly fileIconRegistration = this._register(WorkbenchFileIconThemesRegistry.registerThemes());
	private activeFileIconThemes: readonly IWorkbenchFileIconTheme[] = [];
	private readonly productIconRegistration = this._register(WorkbenchProductIconThemesRegistry.registerThemes());
	private activeProductIconThemes: readonly IWorkbenchProductIconTheme[] = [];
	private activeDebugAdapterFactories: readonly DebugAdapterFactory[] = Object.freeze([]);
	readonly themes: ExtensionThemeSource;
	readonly fileTemplates: ExtensionFileTemplateSource;
	readonly debugAdapters: ExtensionDebugAdapterSource;

	readonly onDidChange: Event<ExtensionCatalog> = this.changeEmitter.event;
	readonly onDidFail: Event<ExtensionServiceFailure> = this.failureEmitter.event;

	constructor(private readonly options: AppServerExtensionServiceOptions) {
		super();
		this._register(toDisposable(() => { this.reloadQueued = false; this.activationHandler = undefined; }));
		this._register(toDisposable(() => {
			Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).updateConfigurations({ add: [], remove: this.activeConfigurations });
			this.activeConfigurations = [];
		}));
		this._register(toDisposable(() => this.languageConfigurationRegistrations.dispose()));
		this.themeRegistry = this._register(new ExtensionThemeRegistry());
		this.fileTemplateRegistry = this._register(new ExtensionFileTemplateRegistry());
		this.debugAdapterRegistry = this._register(new ExtensionDebugAdapterRegistry());
		const themeRegistry = this.themeRegistry;
		const fileTemplateRegistry = this.fileTemplateRegistry;
		const debugAdapterRegistry = this.debugAdapterRegistry;
		this.themes = Object.freeze({ get currentCatalog() { return themeRegistry.currentCatalog; }, onDidChange: themeRegistry.onDidChange });
		this.fileTemplates = Object.freeze({ get currentCatalog() { return fileTemplateRegistry.currentCatalog; }, onDidChange: fileTemplateRegistry.onDidChange });
		this.debugAdapters = Object.freeze({ get definitions() { return debugAdapterRegistry.definitions; }, onDidChange: debugAdapterRegistry.onDidChange, get: (type: string) => debugAdapterRegistry.get(type) });
		if (!options || typeof options !== "object") {
			this.dispose();
			throw new TypeError("App Server extension service options are required");
		}
		if (!options.api || typeof options.api.list !== "function" || typeof options.api.resources?.readExtensionResourceBytes !== "function") {
			this.dispose();
			throw new TypeError("App Server extension service requires an extension API");
		}
		const grammarService = options.textMateService?.grammars;
		if (!grammarService || typeof grammarService.registerGrammars !== "function" || typeof grammarService.prepareGrammars !== "function" || typeof grammarService.whenReady !== "function") {
			this.dispose();
			throw new TypeError("App Server extension service requires a TextMate service");
		}
		this.grammarRegistration = options.textMateService.grammars.registerGrammars([]);
		this._register(toDisposable(() => this.grammarRegistration.dispose()));
		const hasLanguageServices = options.languageService !== undefined || options.languageConfigurationService !== undefined || options.languageFeaturesService !== undefined;
		if (hasLanguageServices && (!options.languageService || !options.languageConfigurationService || !options.languageFeaturesService)) {
			this.dispose();
			throw new TypeError('App Server extension language contributions require language, configuration, and feature services');
		}
		this.languageRegistration = options.languageService ? this._register(options.languageService.registerLanguages([])) : undefined;
		this.completionRegistration = options.languageFeaturesService ? this._register(options.languageFeaturesService.completionProvider.registerGroup([])) : undefined;
		this.debugAdapterFactoryRegistration = this._register(DebugAdapterFactoriesRegistry.registerFactories([]));
		if (options.eventApi) {
			let activationGeneration: number | undefined;
			let marketplaceRevision: { readonly instanceId: string; readonly generation: number; } | undefined;
			const subscription = options.eventApi.subscribe(event => {
				if (event.method === 'plugin/changed') {
					if (event.params.activationGeneration === activationGeneration) return;
					activationGeneration = event.params.activationGeneration;
				} else if (event.method === 'marketplace/changed') {
					if (marketplaceRevision?.instanceId === event.params.instanceId && event.params.generation <= marketplaceRevision.generation) return;
					marketplaceRevision = event.params;
				} else {
					return;
				}
				void this.reload().catch(error => console.error("Declarative extension refresh failed", error));
			});
			this._register(toDisposable(() => subscription.dispose()));
		}
	}

	get currentCatalog(): ExtensionCatalog {
		this.assertNotDisposed();
		return this.catalog;
	}

	start(): Promise<void> {
		this.assertNotDisposed();
		return this.reload();
	}

	reload(): Promise<void> {
		this.assertNotDisposed();
		this.reloadQueued = true;
		if (this.loading) return this.loading;
		const operation = this.drainReloads();
		this.loading = operation;
		void operation.then(() => {
			if (this.loading === operation) this.loading = undefined;
		}, () => {
			if (this.loading === operation) this.loading = undefined;
		});
		return operation;
	}

	public async getExtension(id: string): Promise<ExtensionDescriptor | undefined> {
		this.assertNotDisposed();
		// Await the catalog owner, without rescanning packages for every variable.
		if (this.loading) await this.loading;
		else if (this.activeCatalogSignature === undefined) await this.reload();
		this.assertNotDisposed();
		return this.catalog.extensions.find(extension => extension.id.toLowerCase() === id.toLowerCase());
	}

	async activateByEvent(event: string, signal?: AbortSignal): Promise<void> {
		this.assertNotDisposed();
		if (signal) throwIfCancelled(signal);
		const activation = this.activationHandler?.(event, signal);
		if (activation) await (signal ? raceCancellationError(activation, signal) : activation);
	}

	registerActivationHandler(handler: (event: string, signal?: AbortSignal) => Promise<void>): IDisposable {
		this.assertNotDisposed();
		if (this.activationHandler) throw new Error('An executable extension activation owner is already registered');
		this.activationHandler = handler;
		return toDisposable(() => { if (this.activationHandler === handler) this.activationHandler = undefined; });
	}

	private async drainReloads(): Promise<void> {
		let failure: ExtensionServiceFailure | undefined;
		while (!this.isDisposed && this.reloadQueued) {
			this.reloadQueued = false;
			// A source may change while generation-bound resources are loading. Callers
			// await the final queued catalog, including its successful atomic commit.
			failure = await this.loadAndRegister();
		}
		if (!this.isDisposed && failure) {
			this.failureEmitter.fire(failure);
			throw failure.error;
		}
	}

	private async loadAndRegister(): Promise<ExtensionServiceFailure | undefined> {
		const themeContributions: ThemeContributions = { colors: [], icons: [], fonts: [], types: [], modifiers: [], scopes: [] };
		const languages: LanguageDescriptionContribution[] = [];
		const languageConfigurations: LanguageConfigurationContribution[] = [];
		const completionProviders: LanguageCompletionProvider[] = [];
		const grammars: TextMateGrammarDefinition[] = [];
		const resources = new Map<string, Promise<Uint8Array>>();
		const languageConfigurationResources = new Map<string, Promise<ReturnType<typeof parseLanguageConfiguration>>>();
		const snippetFiles = new Map<string, Promise<readonly ExtensionSnippetDefinition[]>>();
		const themes: ExtensionThemeDefinition[] = [];
		const fileIconThemes: IWorkbenchFileIconTheme[] = [];
		const productIconThemes: IWorkbenchProductIconTheme[] = [];
		const fileTemplates: ExtensionFileTemplateDefinition[] = [];
		const debugAdapters: ExtensionDebugAdapterDefinition[] = [];
		const problemMatchers: unknown[] = [];
		const configurations: IConfigurationNode[] = [];
		const problemPatterns: unknown[] = [];
		const editorPanes: IEditorPaneDescriptor[] = [];
		let activeExtension: ExtensionDescriptor | undefined;
		try {
			const transportCatalog = await this.options.api.list("refresh");
			if (this.isDisposed) return;
			// Frozen package digests identify every resource in this snapshot. An
			// unchanged scan must preserve factory identities and pending Debug launches.
			const signature = getNLSLanguage() + '\0' + JSON.stringify(transportCatalog);
			if (signature === this.activeCatalogSignature) return;
			const catalog = projectExtensionCatalog(transportCatalog);
			for (const extension of transportCatalog.extensions) {
				activeExtension = projectExtensionDescriptor(extension);
				await verifyExtensionManifestDigest(extension);
				if (this.isDisposed) return;
				const manifest = parseExtensionManifest(extension.manifestJson, extension);
				configurations.push(...manifest.contributes.configuration);
				if (extension.sourceKind === 'builtIn') {
					for (const editor of manifest.contributes.customEditors) {
						const create = getBuiltinEditorPaneFactory(extension.id, editor.viewType);
						if (!create) { continue; }
						let name = editor.displayName;
						const key = /^%(.+)%$/.exec(name)?.[1];
						if (key) {
							const locale = getNLSLanguage() === 'zh-CN' ? '.zh-CN' : '';
							const messages = parseJsonc(new TextDecoder().decode(await this.loadResource(resources, catalog.generation, extension.id, `package.nls${locale}.json`)), 'Editor labels') as Record<string, unknown>;
							if (typeof messages[key] !== 'string') { throw new TypeError(`Missing editor label '${key}' in '${extension.id}'`); }
							name = messages[key];
						}
						editorPanes.push({
							id: editor.viewType, name, create: options => create(options, name),
							canOpen: input => {
								if (isResourceDiffEditorInput(input)) { return EditorPaneMatch.None; }
								const mediaType = input.contentType?.split(';', 1)[0].trim().toLowerCase();
								const supported = editor.selector.some(selector => match(selector.filenamePattern.toLowerCase(), (selector.filenamePattern.includes('/') ? input.resource.path : basename(input.resource)).toLowerCase()) || mediaType !== undefined && selector.mimeType === mediaType);
								if (!supported) { return EditorPaneMatch.None; }
								return editor.priority === 'default' ? EditorPaneMatch.Default : EditorPaneMatch.Optional;
							},
						});
					}
				}
				themeContributions.colors.push(...manifest.contributes.colors);
				themeContributions.types.push(...manifest.contributes.semanticTokenTypes);
				themeContributions.modifiers.push(...manifest.contributes.semanticTokenModifiers);
				themeContributions.scopes.push(...manifest.contributes.semanticTokenScopes);
				for (const icon of manifest.contributes.icons) {
					if (typeof icon.defaults === 'string') { themeContributions.icons.push({ id: icon.id, description: icon.description, defaults: { id: icon.defaults } }); }
					else {
						const loaded = await loadExtensionFontIcon(extension.id + '.' + icon.id, icon.defaults.fontPath, icon.defaults.fontCharacter, path => this.loadResource(resources, catalog.generation, extension.id, path));
						if (this.isDisposed) { return; }
						themeContributions.icons.push({ id: icon.id, description: icon.description, defaults: loaded.icon });
						themeContributions.fonts.push(loaded.font);
					}
				}
				if ((manifest.contributes.languages.length > 0 || manifest.contributes.snippets.length > 0) && !this.options.languageService) {
					throw new Error(`Extension '${extension.id}' contributes language features but no editor language service is available`);
				}
				for (const language of manifest.contributes.languages) {
					languages.push({
						description: {
							id: language.id,
							aliases: language.aliases,
							extensions: language.extensions,
							filenames: language.filenames,
							filenamePatterns: language.filenamePatterns,
							mimetypes: language.mimetypes,
							...(language.firstLine === undefined ? {} : { firstLine: language.firstLine }),
						}, options: { priority: 100 }
					});
					if (language.configuration !== undefined) {
						const key = `${extension.id}\0${language.configuration}`;
						const configuration = languageConfigurationResources.get(key) ?? this.loadLanguageConfiguration(resources, catalog.generation, extension.id, language.configuration);
						languageConfigurationResources.set(key, configuration);
						const resolvedConfiguration = await configuration;
						if (this.isDisposed) return;
						languageConfigurations.push({ languageId: language.id, configuration: resolvedConfiguration, priority: 100 });
					}
				}
				for (const [snippetIndex, snippet] of manifest.contributes.snippets.entries()) {
					const key = `${extension.id}\0${snippet.path}`;
					const definitions = snippetFiles.get(key) ?? this.loadSnippetFile(resources, catalog.generation, extension.id, snippet.path);
					snippetFiles.set(key, definitions);
					const parsed = await definitions;
					if (this.isDisposed) return;
					for (const languageId of snippet.language) {
						const providerSnippets = parsed.filter(candidate => candidate.prefixes.length > 0 && (!candidate.scopes || candidate.scopes.includes(languageId)));
						if (providerSnippets.length > 0) completionProviders.push(createExtensionSnippetProvider(`${extension.id}.snippet.${snippetIndex}.${languageId}`, languageId, providerSnippets));
						const templates = parsed.filter(candidate => candidate.isFileTemplate && (!candidate.scopes || candidate.scopes.includes(languageId)));
						for (const [templateIndex, template] of templates.entries()) fileTemplates.push(Object.freeze({
							id: `${extension.id}.template.${snippetIndex}.${languageId}.${templateIndex}`,
							extensionId: extension.id,
							label: template.name,
							languageId,
							body: materializeExtensionFileTemplate(template),
							...(template.description === undefined ? {} : { description: template.description }),
						}));
					}
				}
				for (const [themeIndex, theme] of manifest.contributes.themes.entries()) {
					const definition = await loadExtensionTheme(path => this.loadResource(resources, catalog.generation, extension.id, path), extension.id, theme, themeIndex);
					themes.push(definition);
					if (this.isDisposed) return;
				}
				for (const theme of manifest.contributes.iconThemes) {
					if (!theme.id) { throw new Error('File icon themes require an ID'); }
					const bytes = await this.loadResource(resources, catalog.generation, extension.id, theme.path);
					const directory = theme.path.slice(0, theme.path.lastIndexOf('/') + 1);
					fileIconThemes.push(await FileIconThemeData.load(theme.id, theme.label, parseJsonc(new TextDecoder().decode(bytes), 'File icon theme ' + theme.id),
						path => this.loadResource(resources, catalog.generation, extension.id, directory + path)));
					if (this.isDisposed) { return; }
				}
				for (const theme of manifest.contributes.productIconThemes) {
					if (!theme.id || theme.id === 'default') throw new Error('Product icon themes require a non-default ID');
					const bytes = await this.loadResource(resources, catalog.generation, extension.id, theme.path);
					const directory = theme.path.slice(0, theme.path.lastIndexOf('/') + 1);
					productIconThemes.push(await ProductIconThemeData.load(theme.id, theme.label, parseJsonc(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'Product icon theme ' + theme.id),
						path => this.loadResource(resources, catalog.generation, extension.id, directory + path), document));
					if (this.isDisposed) return;
				}
				problemMatchers.push(...manifest.contributes.problemMatchers);
				problemPatterns.push(...manifest.contributes.problemPatterns);
				for (const debuggerContribution of manifest.contributes.debuggers) debugAdapters.push(Object.freeze({ extensionId: extension.id, ...debuggerContribution }));
				for (const grammar of manifest.contributes.grammars) {
					const content = await this.loadGrammar(resources, catalog.generation, extension.id, grammar.path);
					if (this.isDisposed) return;
					const definition: TextMateGrammarDefinition = {
						scopeName: grammar.scopeName,
						...(grammar.language === undefined ? {} : { languageId: grammar.language }),
						injectTo: grammar.injectTo,
						...(grammar.embeddedLanguages === undefined ? {} : { embeddedLanguages: grammar.embeddedLanguages }),
						...(grammar.tokenTypes === undefined ? {} : { tokenTypes: grammar.tokenTypes }),
						...(grammar.balancedBracketScopes === undefined ? {} : { balancedBracketScopes: grammar.balancedBracketScopes }),
						...(grammar.unbalancedBracketScopes === undefined ? {} : { unbalancedBracketScopes: grammar.unbalancedBracketScopes }),
						filePath: grammar.path,
						loadGrammar: () => content,
					};
					grammars.push(definition);
				}
			}
			this.validateContributions(themes, fileTemplates, debugAdapters);
			const debugAdapterFactories = debugAdapters.flatMap(definition => {
				if (definition.program === undefined) return [];
				const previousDefinition = this.debugAdapterRegistry.get(definition.type);
				const previousExtension = this.catalog.extensions.find(extension => extension.id === definition.extensionId);
				const nextExtension = catalog.extensions.find(extension => extension.id === definition.extensionId);
				const retained = this.activeDebugAdapterFactories.find(factory => factory.type === definition.type);
				// Scan revisions may change while a launch waits for an installation path.
				// Preserve executable identity only while both package and declaration match.
				if (retained && previousExtension && nextExtension
					&& JSON.stringify(previousExtension) === JSON.stringify(nextExtension)
					&& JSON.stringify(previousDefinition) === JSON.stringify(definition)) return [retained];
				return [createStaticDebugAdapterFactory(definition.type, definition.label, `declarative:${definition.extensionId}`, { program: definition.program, arguments: definition.arguments })];
			});
			const previousGrammars = this.activeGrammars;
			const preparedGrammars = await this.options.textMateService.grammars.prepareGrammars(this.grammarRegistration, grammars);
			if (this.isDisposed) return;
			try {
				runWithBufferedEvents(() => {
					preparedGrammars.commit();
					this.editorPaneRegistration.replace(editorPanes);
					this.replaceContributions(languages, languageConfigurations, completionProviders, themes, fileTemplates, debugAdapters, debugAdapterFactories, fileIconThemes, productIconThemes, themeContributions, { matchers: problemMatchers, patterns: problemPatterns }, configurations);
					this.activeThemeContributions = themeContributions;
					this.activeGrammars = Object.freeze([...grammars]);
					this.activeLanguages = Object.freeze([...languages]);
					this.activeLanguageConfigurations = Object.freeze([...languageConfigurations]);
					this.activeCompletionProviders = Object.freeze([...completionProviders]);
					this.activeFileIconThemes = Object.freeze([...fileIconThemes]);
					this.activeProductIconThemes = Object.freeze([...productIconThemes]);
					this.activeDebugAdapterFactories = Object.freeze([...debugAdapterFactories]);
					this.catalog = catalog;
					this.activeCatalogSignature = signature;
					this.changeEmitter.fire(catalog);
				});
			} catch (error) {
				this.editorPaneRegistration.replace(this.activeEditorPanes);
				if (!this.isDisposed) await this.restoreActivation(previousGrammars, error);
				throw error;
			}
			this.activeEditorPanes = editorPanes;
		} catch (error) {
			if (this.isDisposed) return;
			return Object.freeze({ extension: activeExtension, error });
		}
	}

	private replaceContributions(languages: readonly LanguageDescriptionContribution[], languageConfigurations: readonly LanguageConfigurationContribution[], completionProviders: readonly LanguageCompletionProvider[], themes: readonly ExtensionThemeDefinition[], fileTemplates: readonly ExtensionFileTemplateDefinition[], debugAdapters: readonly ExtensionDebugAdapterDefinition[], debugAdapterFactories: readonly DebugAdapterFactory[], fileIconThemes: readonly IWorkbenchFileIconTheme[], productIconThemes: readonly IWorkbenchProductIconTheme[], themeContributions: ThemeContributions, problemContributions: ProblemMatcherContributions, configurations: IConfigurationNode[]): void {
		const previousThemes = this.themeRegistry.currentCatalog.themes;
		const previousFileTemplates = this.fileTemplateRegistry.currentCatalog.templates;
		const previousDebugAdapters = this.debugAdapterRegistry.definitions;
		const previousProblemContributions = this.problemMatcherRegistration.contributions;
		try {
			this.replaceThemeContributions(themeContributions);
			this.languageRegistration?.replace(languages);
			this.replaceLanguageConfigurations(languageConfigurations);
			this.completionRegistration?.replace(completionProviders);
			this.themeRegistry.replace(themes);
			this.fileTemplateRegistry.replace(fileTemplates);
			this.debugAdapterRegistry.replace(debugAdapters);
			this.debugAdapterFactoryRegistration.replace(debugAdapterFactories);
			this.fileIconRegistration.replace(fileIconThemes);
			this.productIconRegistration.replace(productIconThemes);
			this.problemMatcherRegistration.replace(problemContributions);
			Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).updateConfigurations({ add: configurations, remove: this.activeConfigurations });
			this.activeConfigurations = configurations;
		} catch (error) {
			try {
				this.replaceThemeContributions(this.activeThemeContributions);
				this.languageRegistration?.replace(this.activeLanguages);
				this.replaceLanguageConfigurations(this.activeLanguageConfigurations);
				this.completionRegistration?.replace(this.activeCompletionProviders);
				this.themeRegistry.replace(previousThemes);
				this.fileTemplateRegistry.replace(previousFileTemplates);
				this.debugAdapterRegistry.replace(previousDebugAdapters);
				this.debugAdapterFactoryRegistration.replace(this.activeDebugAdapterFactories);
				this.fileIconRegistration.replace(this.activeFileIconThemes);
				this.productIconRegistration.replace(this.activeProductIconThemes);
				this.problemMatcherRegistration.replace(previousProblemContributions);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Extension contribution activation and rollback both failed");
			}
			throw error;
		}
	}

	private replaceThemeContributions(contributions: ThemeContributions): void {
		this.colorContributions.replace(contributions.colors);
		this.tokenContributions.replace(contributions.types, contributions.modifiers, contributions.scopes);
		this.iconContributions.replace(contributions.icons, contributions.fonts);
	}

	private replaceLanguageConfigurations(contributions: readonly LanguageConfigurationContribution[]): void {
		const service = this.options.languageConfigurationService;
		if (!service) {
			if (contributions.length > 0) throw new Error('Extension language configurations require a language configuration service');
			return;
		}
		const next = new DisposableStore();
		try {
			for (const contribution of contributions) {
				next.add(service.register(contribution.languageId, contribution.configuration, contribution.priority));
			}
		} catch (error) {
			next.dispose();
			throw error;
		}
		const previous = this.languageConfigurationRegistrations;
		this.languageConfigurationRegistrations = next;
		previous.dispose();
	}

	private validateContributions(themes: readonly ExtensionThemeDefinition[], fileTemplates: readonly ExtensionFileTemplateDefinition[], debugAdapters: readonly ExtensionDebugAdapterDefinition[]): void {
		const validationThemes = new ExtensionThemeRegistry();
		try { validationThemes.replace(themes); }
		finally { validationThemes.dispose(); }
		const validationTemplates = new ExtensionFileTemplateRegistry();
		try { validationTemplates.replace(fileTemplates); }
		finally { validationTemplates.dispose(); }
		validateExtensionDebugAdapterDefinitions(debugAdapters);
		const themeCatalog = Object.freeze({ revision: 1, themes: Object.freeze([...themes]) });
		for (const theme of themes) normalizeTextMateScopeTheme(projectExtensionTokenTheme(themeCatalog, ColorScheme.Dark, 1, theme.id));
	}

	private async restoreActivation(previous: readonly TextMateGrammarDefinition[], activationError: unknown): Promise<void> {
		try {
			this.grammarRegistration.replace(previous);
			await this.options.textMateService.grammars.whenReady();
		} catch (rollbackError) {
			throw new AggregateError([activationError, rollbackError], "Extension activation and TextMate grammar rollback both failed");
		}
	}

	private async loadGrammar(resources: Map<string, Promise<Uint8Array>>, generation: number, extensionId: string, path: string): Promise<string> {
		const bytes = await this.loadResource(resources, generation, extensionId, path);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new TypeError(`Extension '${extensionId}' grammar '${path}' is not valid UTF-8`);
		}
	}

	private async loadLanguageConfiguration(resources: Map<string, Promise<Uint8Array>>, generation: number, extensionId: string, path: string): Promise<ReturnType<typeof parseLanguageConfiguration>> {
		const bytes = await this.loadResource(resources, generation, extensionId, path);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return parseLanguageConfiguration(parseJsonc(text, `Extension '${extensionId}' language configuration '${path}'`), `Extension '${extensionId}' language configuration '${path}'`);
	}

	private async loadSnippetFile(resources: Map<string, Promise<Uint8Array>>, generation: number, extensionId: string, path: string): Promise<readonly ExtensionSnippetDefinition[]> {
		const bytes = await this.loadResource(resources, generation, extensionId, path);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return parseExtensionSnippetFile(parseJsonc(text, `Extension '${extensionId}' snippet file '${path}'`), `Extension '${extensionId}' snippet file '${path}'`);
	}

	private loadResource(resources: Map<string, Promise<Uint8Array>>, generation: number, extensionId: string, path: string): Promise<Uint8Array> {
		const key = `${extensionId}\0${path}`;
		const cached = resources.get(key);
		if (cached) return cached;
		const loading = this.options.api.resources.readExtensionResourceBytes({ generation, extensionId, path });
		resources.set(key, loading);
		return loading;
	}

}

function projectExtensionCatalog(catalog: TransportExtensionCatalog): ExtensionCatalog {
	return Object.freeze({
		generation: catalog.generation,
		extensions: Object.freeze(catalog.extensions.map(projectExtensionDescriptor)),
		diagnostics: Object.freeze(catalog.diagnostics.map(diagnostic => Object.freeze({
			source: diagnostic.source,
			subject: diagnostic.subject,
			code: diagnostic.code,
			message: diagnostic.message,
		}))),
	});
}

function projectExtensionDescriptor(extension: TransportExtensionDescriptor): ExtensionDescriptor {
	return Object.freeze({
		id: extension.id,
		name: extension.name,
		publisher: extension.publisher,
		version: extension.version,
		displayName: extension.displayName,
		sourceKind: extension.sourceKind,
		...(extension.extensionLocation === undefined ? {} : { extensionLocation: URI.parse(extension.extensionLocation) }),
		manifestSha256: extension.manifestSha256,
		packageSha256: extension.packageSha256,
	});
}

interface ThemeContributions {
	readonly colors: ColorContribution[];
	readonly icons: IconContribution[];
	readonly fonts: IconFontDefinition[];
	readonly types: TokenTypeOrModifierContribution[];
	readonly modifiers: TokenTypeOrModifierContribution[];
	readonly scopes: SemanticTokenScopeContribution[];
}

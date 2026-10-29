import {
	IAdapterManager,
	createStaticDebugAdapterFactory,
	type DebugAdapterFactory,
	type DebugAdapterFactoryRegistration,
} from '../../../contrib/debug/common/debug.js';
import type { IExtensionPointUser } from '../common/extensionsRegistry.js';
import type { ExtensionManifest } from '../common/extensionManifest.js';
import { localizeManifest } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import { MenusRegistry, type ISubmenuItem } from '../../../../platform/actions/common/actions.js';
import { extensionMenuId } from '../common/extensionMenus.js';
import { ViewsRegistry } from '../../../common/views.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import {
	KeybindingsRegistry,
	KeybindingSource,
	KeybindingWeight,
	type IKeybindingRule,
} from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { URI } from '../../../../base/common/uri.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
	type IConfigurationNode,
	type IConfigurationDefaults,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import {
	registerProblemMatcherContributions,
	type ProblemMatcherContributions,
} from '../../../contrib/tasks/common/problemMatcher.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { ColorExtensionPoint } from '../../themes/common/colorExtensionPoint.js';
import { IconExtensionPoint } from '../../themes/common/iconExtensionPoint.js';
import { TokenClassificationExtensionPoint } from '../../themes/common/tokenClassificationExtensionPoint.js';
import type { ColorContribution } from '../../../../platform/theme/common/colorRegistry.js';
import type { IconContribution, IconFontDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import type { TokenTypeOrModifierContribution } from '../../../../platform/theme/common/tokenClassificationRegistry.js';
import {
	WorkbenchFileIconThemesRegistry,
	WorkbenchProductIconThemesRegistry,
} from '../../themes/common/themeExtensionPoints.js';
import type { IWorkbenchFileIconTheme, IWorkbenchProductIconTheme } from '../../themes/common/workbenchThemeService.js';
import { FileIconThemeData } from '../../themes/browser/fileIconThemeData.js';
import { ProductIconThemeData, loadExtensionFontIcon } from '../../themes/browser/productIconThemeData.js';
import { Emitter, runWithBufferedEvents, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { LanguageConfiguration } from '../../../../editor/common/languages/languageConfiguration.js';
import type { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import { parseLanguageConfiguration } from './languageConfigurationParser.js';
import type {
	LanguageDescriptionContribution,
	LanguageDescriptionRegistration,
} from '../../../../editor/common/services/languagesRegistry.js';
import type { IAshLanguageService } from '../../../../editor/common/languages/language.js';
import type {
	IExtensionApi,
	ExtensionCatalogReload,
	ExtensionCatalog as TransportExtensionCatalog,
	ExtensionDescriptor as TransportExtensionDescriptor,
} from '../../../../platform/extensions/common/extensionApi.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { parseJsonc } from '../common/jsonc.js';
import { parseExtensionManifest, verifyExtensionManifestDigest } from '../common/extensionManifest.js';
import { getNLSLanguage } from '../../../../nls.js';
import { match } from '../../../../base/common/glob.js';
import { basename } from '../../../../base/common/resources.js';
import { EditorPanes, getBuiltinEditorPaneFactory, type IEditorPaneDescriptor } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../../common/editor.js';
import {
	ExtensionFileTemplateRegistry,
	type ExtensionFileTemplateDefinition,
	type ExtensionFileTemplateSource,
} from '../common/extensionFileTemplate.js';
import { toExtensionResourceURI } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import {
	ExtensionThemeRegistry,
	loadExtensionTheme,
	type ExtensionThemeDefinition,
	type ExtensionThemeSource,
} from '../common/extensionTheme.js';
import type {
	ExtensionCatalog,
	ExtensionDescriptor,
	ExtensionServiceFailure,
	ExtensionSnippetActivation,
	ExtensionSnippetFile,
	IExtensionService,
} from '../common/extensionService.js';
import {
	ExtensionDebugAdapterRegistry,
	validateExtensionDebugAdapterDefinitions,
	type ExtensionDebugAdapterDefinition,
	type ExtensionDebugAdapterSource,
} from '../common/extensionDebugAdapter.js';

export interface AppServerExtensionServiceOptions {
	readonly api: IExtensionApi;
	readonly eventApi?: IServerEventApi;
	readonly languageService?: IAshLanguageService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
}

interface LanguageConfigurationContribution {
	readonly languageId: string;
	readonly configuration: LanguageConfiguration;
	readonly priority?: number;
}

// External declarative assets can remap text editing, but cannot invoke general
// Workbench commands or supply arguments that carry process or terminal actions.
const declarativeEditingCommands = new Set([
	'editor.action.addSelectionToNextFindMatch',
	'editor.action.selectHighlights',
	'editor.action.insertCursorAbove',
	'editor.action.insertCursorBelow',
	'editor.action.copyLinesDownAction',
	'editor.action.deleteLines',
	'editor.action.insertLineAfter',
	'editor.action.insertLineBefore',
]);

/** Activates Rust-discovered declarative extensions without materializing legacy grammar resources. */
export class AppServerExtensionService extends Disposable implements IExtensionService {
	private readonly colorContributions = this._register(new ColorExtensionPoint());
	private readonly iconContributions = this._register(new IconExtensionPoint());
	private readonly tokenContributions = this._register(new TokenClassificationExtensionPoint());
	private activeThemeContributions: ThemeContributions = {
		colors: [],
		icons: [],
		fonts: [],
		types: [],
		modifiers: [],
	};
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
	private reloadQueued: ExtensionCatalogReload | undefined;
	private readonly languageRegistration: LanguageDescriptionRegistration | undefined;
	private languageConfigurationRegistrations = new DisposableStore();
	private snippetHandler: ((files: readonly ExtensionSnippetFile[]) => ExtensionSnippetActivation) | undefined;
	private snippetOwnerRevision = 0;
	private activeSnippetOwnerRevision = 0;
	private readonly problemMatcherRegistration = this._register(
		registerProblemMatcherContributions({ matchers: [], patterns: [] }),
	);
	private readonly debugAdapterFactoryRegistration: DebugAdapterFactoryRegistration;
	private readonly themeRegistry: ExtensionThemeRegistry;
	private readonly fileTemplateRegistry: ExtensionFileTemplateRegistry;
	private readonly debugAdapterRegistry: ExtensionDebugAdapterRegistry;
	private activeConfigurations: IConfigurationNode[] = [];
	private activeConfigurationDefaults: IConfigurationDefaults[] = [];
	private readonly submenuRegistrations = this._register(new DisposableStore());
	private readonly welcomeRegistrations = this._register(new DisposableStore());
	private readonly keybindingRegistrations = this._register(new DisposableStore());
	private activeLanguages: readonly LanguageDescriptionContribution[] = Object.freeze([]);
	private activeLanguageConfigurations: readonly LanguageConfigurationContribution[] = Object.freeze([]);
	private readonly fileIconRegistration = this._register(WorkbenchFileIconThemesRegistry.registerThemes());
	private activeFileIconThemes: readonly IWorkbenchFileIconTheme[] = [];
	private readonly productIconRegistration = this._register(WorkbenchProductIconThemesRegistry.registerThemes());
	private activeProductIconThemes: readonly IWorkbenchProductIconTheme[] = [];
	private activeDebugAdapterFactories: readonly DebugAdapterFactory[] = Object.freeze([]);
	readonly themes: ExtensionThemeSource;
	readonly fileTemplates: ExtensionFileTemplateSource;
	readonly debugAdapters: ExtensionDebugAdapterSource;
	private manifests: readonly { readonly description: ExtensionDescriptor; readonly manifest: ExtensionManifest }[] =
		[];

	getExtensionPointContributions<T>(name: string): readonly IExtensionPointUser<T>[] {
		return this.manifests.flatMap(entry => {
			const value = (entry.manifest.contributes as unknown as Readonly<Record<string, unknown>>)[name];
			return value === undefined ? [] : [{ description: entry.description, value: value as T }];
		});
	}

	readonly onDidChange: Event<ExtensionCatalog> = this.changeEmitter.event;
	readonly onDidFail: Event<ExtensionServiceFailure> = this.failureEmitter.event;

	constructor(
		private readonly options: AppServerExtensionServiceOptions,
		@ILanguagePackService private readonly languagePacks: ILanguagePackService,
		@IAdapterManager adapters: IAdapterManager,
	) {
		super();
		if (options.api.onDidChange) {
			this._register(
				options.api.onDidChange(() => {
					void this.requestReload('cached').catch(error =>
						console.error('Extension enablement refresh failed', error),
					);
				}),
			);
		}
		this._register(
			toDisposable(() => {
				this.reloadQueued = undefined;
				this.activationHandler = undefined;
				this.snippetHandler?.([]).commit();
				this.snippetHandler = undefined;
			}),
		);
		this._register(
			toDisposable(() => {
				Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).deltaConfiguration({
					removedConfigurations: this.activeConfigurations,
					removedDefaults: this.activeConfigurationDefaults,
				});
				this.activeConfigurations = [];
				this.activeConfigurationDefaults = [];
				this.manifests = [];
			}),
		);
		this._register(toDisposable(() => this.languageConfigurationRegistrations.dispose()));
		this.themeRegistry = this._register(new ExtensionThemeRegistry());
		this.fileTemplateRegistry = this._register(new ExtensionFileTemplateRegistry());
		this.debugAdapterRegistry = this._register(new ExtensionDebugAdapterRegistry());
		const themeRegistry = this.themeRegistry;
		const fileTemplateRegistry = this.fileTemplateRegistry;
		const debugAdapterRegistry = this.debugAdapterRegistry;
		this.themes = Object.freeze({
			get currentCatalog() {
				return themeRegistry.currentCatalog;
			},
			onDidChange: themeRegistry.onDidChange,
		});
		this.fileTemplates = Object.freeze({
			get currentCatalog() {
				return fileTemplateRegistry.currentCatalog;
			},
			onDidChange: fileTemplateRegistry.onDidChange,
		});
		this.debugAdapters = Object.freeze({
			get definitions() {
				return debugAdapterRegistry.definitions;
			},
			onDidChange: debugAdapterRegistry.onDidChange,
			get: (type: string) => debugAdapterRegistry.get(type),
		});
		if (!options || typeof options !== 'object') {
			this.dispose();
			throw new TypeError('App Server extension service options are required');
		}
		if (
			!options.api ||
			typeof options.api.list !== 'function' ||
			typeof options.api.resources?.readExtensionResourceBytes !== 'function'
		) {
			this.dispose();
			throw new TypeError('App Server extension service requires an extension API');
		}
		const hasLanguageServices =
			options.languageService !== undefined || options.languageConfigurationService !== undefined;
		if (hasLanguageServices && (!options.languageService || !options.languageConfigurationService)) {
			this.dispose();
			throw new TypeError(
				'App Server extension language contributions require language and configuration services',
			);
		}
		this.languageRegistration = options.languageService
			? this._register(options.languageService.registerLanguages([]))
			: undefined;
		this.debugAdapterFactoryRegistration = this._register(adapters.registerFactories([]));
		if (options.eventApi) {
			let activationGeneration: number | undefined;
			let extensionManagementRevision: { readonly instanceId: string; readonly generation: number } | undefined;
			const subscription = options.eventApi.subscribe(event => {
				if (event.method === 'plugin/changed') {
					if (event.params.activationGeneration === activationGeneration) return;
					activationGeneration = event.params.activationGeneration;
				} else if (event.method === 'extensions/changed') {
					if (
						extensionManagementRevision?.instanceId === event.params.instanceId &&
						event.params.generation <= extensionManagementRevision.generation
					)
						return;
					extensionManagementRevision = event.params;
				} else {
					return;
				}
				void this.requestReload('cached').catch(error =>
					console.error('Declarative extension refresh failed', error),
				);
			});
			this._register(toDisposable(() => subscription.dispose()));
		}
	}

	get currentCatalog(): ExtensionCatalog {
		this.assertNotDisposed();
		return this.catalog;
	}

	start(): Promise<void> {
		// Theme startup already requested a source scan. Read the backend's current
		// snapshot; Cached still checks managed package generations and scans if absent.
		this.assertNotDisposed();
		return this.loading ?? this.requestReload('cached');
	}

	reload(): Promise<void> {
		return this.requestReload('refresh');
	}

	private requestReload(reload: ExtensionCatalogReload): Promise<void> {
		this.assertNotDisposed();
		if (this.reloadQueued !== 'refresh') this.reloadQueued = reload;
		if (this.loading) return this.loading;
		const operation = this.drainReloads();
		this.loading = operation;
		void operation.then(
			() => {
				if (this.loading === operation) this.loading = undefined;
			},
			() => {
				if (this.loading === operation) this.loading = undefined;
			},
		);
		return operation;
	}

	public async getExtension(id: string): Promise<ExtensionDescriptor | undefined> {
		this.assertNotDisposed();
		// Await the catalog owner, without rescanning packages for every variable.
		if (this.loading) await this.loading;
		else if (this.activeCatalogSignature === undefined) await this.start();
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
		return toDisposable(() => {
			if (this.activationHandler === handler) this.activationHandler = undefined;
		});
	}

	public registerSnippetHandler(
		handler: (files: readonly ExtensionSnippetFile[]) => ExtensionSnippetActivation,
	): IDisposable {
		this.assertNotDisposed();
		if (this.snippetHandler) throw new Error('A snippet contribution owner is already registered');
		this.snippetHandler = handler;
		this.snippetOwnerRevision++;
		if (this.loading) this.reloadQueued ??= 'cached';
		return toDisposable(() => {
			if (this.snippetHandler !== handler) return;
			this.snippetHandler = undefined;
			this.snippetOwnerRevision++;
			if (!this.isDisposed) {
				if (this.loading) this.reloadQueued ??= 'cached';
				this.fileTemplateRegistry.replace([]);
			}
		});
	}

	private async drainReloads(): Promise<void> {
		let failure: ExtensionServiceFailure | undefined;
		while (!this.isDisposed && this.reloadQueued) {
			const reload = this.reloadQueued;
			this.reloadQueued = undefined;
			// A source may change while generation-bound resources are loading. Callers
			// await the final queued catalog, including its successful atomic commit.
			failure = await this.loadAndRegister(reload);
		}
		if (!this.isDisposed && failure) {
			this.failureEmitter.fire(failure);
			throw failure.error;
		}
	}

	private async loadAndRegister(reload: ExtensionCatalogReload): Promise<ExtensionServiceFailure | undefined> {
		const themeContributions: ThemeContributions = { colors: [], icons: [], fonts: [], types: [], modifiers: [] };
		const languages: LanguageDescriptionContribution[] = [];
		const languageConfigurations: LanguageConfigurationContribution[] = [];
		const snippetResources: ExtensionSnippetFile[] = [];
		const resources = new Map<string, Promise<Uint8Array>>();
		const languageConfigurationResources = new Map<
			string,
			Promise<ReturnType<typeof parseLanguageConfiguration>>
		>();
		const snippetFiles = new Map<string, Promise<string>>();
		const themes: ExtensionThemeDefinition[] = [];
		const fileIconThemes: IWorkbenchFileIconTheme[] = [];
		const productIconThemes: IWorkbenchProductIconTheme[] = [];
		let snippetActivation: ExtensionSnippetActivation | undefined;
		const debugAdapters: ExtensionDebugAdapterDefinition[] = [];
		const manifests: { readonly description: ExtensionDescriptor; readonly manifest: ExtensionManifest }[] = [];
		const problemMatchers: unknown[] = [];
		const configurations: IConfigurationNode[] = [];
		const configurationDefaults: IConfigurationDefaults[] = [];
		const submenus: { menu: string; item: ISubmenuItem }[] = [];
		const welcome: Parameters<typeof ViewsRegistry.registerViewWelcomeContent>[] = [];
		const problemPatterns: unknown[] = [];
		const editorPanes: IEditorPaneDescriptor[] = [];
		let activeExtension: ExtensionDescriptor | undefined;
		try {
			const transportCatalog = await this.options.api.list(reload);
			if (this.isDisposed) return;
			const snippetOwnerRevision = this.snippetOwnerRevision;
			// Frozen package digests identify every resource in this snapshot. An
			// unchanged scan must preserve factory identities and pending Debug launches.
			const signature = getNLSLanguage() + '\0' + JSON.stringify(transportCatalog);
			if (signature === this.activeCatalogSignature && snippetOwnerRevision === this.activeSnippetOwnerRevision)
				return;
			const catalog = projectExtensionCatalog(transportCatalog);
			const preparedManifests = new Map<string, ExtensionManifest>();
			const keybindings: IKeybindingRule[] = [];
			let nextExtension = 0;
			const preparationFailures = new Map<number, ExtensionServiceFailure>();
			// Package resources are independent, but publishing contributions is one
			// ordered transaction. Bound I/O here instead of serializing every small
			// file's open/read/release round trips on the startup critical path.
			await Promise.all(
				Array.from({ length: Math.min(8, transportCatalog.extensions.length) }, async () => {
					while (
						!this.isDisposed &&
						preparationFailures.size === 0 &&
						nextExtension < transportCatalog.extensions.length
					) {
						const index = nextExtension++;
						const extension = transportCatalog.extensions[index]!;
						try {
							await verifyExtensionManifestDigest(extension);
							if (this.isDisposed) return;
							const manifestJson = await this.localizeManifest(extension, catalog.generation, resources);
							if (this.isDisposed) return;
							const manifest = parseExtensionManifest(manifestJson, extension);
							preparedManifests.set(extension.id, manifest);
							const paths = new Set([
								...(this.options.languageService
									? manifest.contributes.languages.flatMap(language =>
											language.configuration ? [language.configuration] : [],
										)
									: []),
								...(this.options.languageService
									? manifest.contributes.snippets.map(snippet => snippet.path)
									: []),
								...manifest.contributes.themes.map(theme => theme.path),
								...manifest.contributes.iconThemes.map(theme => theme.path),
								...manifest.contributes.productIconThemes.map(theme => theme.path),
								...manifest.contributes.icons.flatMap(icon =>
									typeof icon.defaults === 'string' ? [] : [icon.defaults.fontPath],
								),
							]);
							for (const path of paths) {
								if (this.isDisposed || preparationFailures.size > 0) return;
								await this.loadResource(resources, catalog.generation, extension.id, path);
							}
						} catch (error) {
							preparationFailures.set(
								index,
								Object.freeze({ extension: projectExtensionDescriptor(extension), error }),
							);
						}
					}
				}),
			);
			if (this.isDisposed) return;
			if (preparationFailures.size > 0) return preparationFailures.get(Math.min(...preparationFailures.keys()));
			// Resolve independent include chains before ordered materialization and
			// atomic publication; one theme must not serialize the remaining themes.
			const preparedThemes = new Map<string, ExtensionThemeDefinition>();
			const themeLoads = transportCatalog.extensions.flatMap(extension =>
				preparedManifests
					.get(extension.id)!
					.contributes.themes.map((theme, index) => ({ extension, theme, index })),
			);
			let nextTheme = 0;
			await Promise.all(
				Array.from({ length: Math.min(8, themeLoads.length) }, async () => {
					while (!this.isDisposed && preparationFailures.size === 0 && nextTheme < themeLoads.length) {
						const position = nextTheme++;
						const { extension, theme, index } = themeLoads[position]!;
						try {
							const definition = await loadExtensionTheme(
								path => this.loadResource(resources, catalog.generation, extension.id, path),
								extension.id,
								theme,
								index,
							);
							preparedThemes.set(`${extension.id}\0${index}`, definition);
						} catch (error) {
							preparationFailures.set(
								position,
								Object.freeze({ extension: projectExtensionDescriptor(extension), error }),
							);
						}
					}
				}),
			);
			if (this.isDisposed) return;
			if (preparationFailures.size > 0) return preparationFailures.get(Math.min(...preparationFailures.keys()));
			for (const extension of transportCatalog.extensions) {
				activeExtension = projectExtensionDescriptor(extension);
				const manifest = preparedManifests.get(extension.id)!;
				keybindings.push(
					...manifest.contributes.keybindings
						.filter(
							rule =>
								extension.sourceKind === 'builtIn' ||
								(rule.args === undefined && declarativeEditingCommands.has(rule.command)),
						)
						.map(rule => ({
							...rule,
							source: KeybindingSource.Workbench,
							priority:
								extension.sourceKind === 'builtIn'
									? KeybindingWeight.BuiltinExtension
									: KeybindingWeight.ExternalExtension,
						})),
				);
				manifests.push({ description: activeExtension, manifest });
				welcome.push(
					...manifest.contributes.viewsWelcome.map(
						entry =>
							[
								entry.view,
								{
									content: entry.contents,
									when: entry.when ? ContextKeyExpr.deserialize(entry.when) : undefined,
									precondition: entry.precondition
										? ContextKeyExpr.deserialize(entry.precondition)
										: undefined,
									group: entry.group,
									order: entry.order,
								},
							] as Parameters<typeof ViewsRegistry.registerViewWelcomeContent>,
					),
				);
				configurations.push(...manifest.contributes.configuration);
				configurationDefaults.push(...manifest.contributes.configurationDefaults);
				for (const submenu of manifest.contributes.submenus) {
					for (const placement of submenu.placements) {
						const [group, orderText] = (placement.group ?? '').split('@');
						const order = orderText === undefined ? undefined : Number(orderText);
						if (order !== undefined && !Number.isFinite(order))
							throw new TypeError('Invalid submenu order');
						submenus.push({
							menu: placement.menu,
							item: {
								submenu: extensionMenuId(submenu.id),
								title: submenu.label,
								group,
								order,
								when: placement.when ? ContextKeyExpr.deserialize(placement.when) : undefined,
							},
						});
					}
				}
				if (extension.sourceKind === 'builtIn') {
					for (const editor of manifest.contributes.customEditors) {
						const factory = getBuiltinEditorPaneFactory(extension.id, editor.viewType);
						if (!factory) {
							continue;
						}
						let name = editor.displayName;
						const key = /^%(.+)%$/.exec(name)?.[1];
						if (key) {
							const locale = getNLSLanguage() === 'en' ? '' : '.' + getNLSLanguage();
							const messages = parseJsonc(
								new TextDecoder().decode(
									await this.loadResource(
										resources,
										catalog.generation,
										extension.id,
										`package.nls${locale}.json`,
									),
								),
								'Editor labels',
							) as Record<string, unknown>;
							if (typeof messages[key] !== 'string') {
								throw new TypeError(`Missing editor label '${key}' in '${extension.id}'`);
							}
							name = messages[key];
						}
						editorPanes.push({
							id: editor.viewType,
							name,
							create: options => factory.create(options, name),
							...(factory.documentType
								? {
										documentType: {
											...factory.documentType,
											extensions: editor.selector
												.map(selector => selector.filenamePattern)
												.filter(
													(pattern): pattern is string =>
														pattern !== undefined && /^\*\.[A-Za-z0-9-]+$/.test(pattern),
												)
												.map(pattern => pattern.slice(1).toLowerCase()),
										},
									}
								: {}),
							canOpen: input => {
								if (isResourceDiffEditorInput(input)) {
									return EditorPaneMatch.None;
								}
								const mediaType = input.contentType?.split(';', 1)[0].trim().toLowerCase();
								const supported = editor.selector.some(
									selector =>
										(selector.filenamePattern !== undefined &&
											match(
												selector.filenamePattern.toLowerCase(),
												(selector.filenamePattern.includes('/')
													? input.resource.path
													: basename(input.resource)
												).toLowerCase(),
											)) ||
										(mediaType !== undefined && selector.mimeType === mediaType),
								);
								if (!supported) {
									return EditorPaneMatch.None;
								}
								return editor.priority === 'default'
									? EditorPaneMatch.Default
									: EditorPaneMatch.Optional;
							},
						});
					}
				}
				themeContributions.colors.push(...manifest.contributes.colors);
				themeContributions.types.push(...manifest.contributes.semanticTokenTypes);
				themeContributions.modifiers.push(...manifest.contributes.semanticTokenModifiers);

				for (const icon of manifest.contributes.icons) {
					if (typeof icon.defaults === 'string') {
						themeContributions.icons.push({
							id: icon.id,
							description: icon.description,
							defaults: { id: icon.defaults },
						});
					} else {
						const loaded = await loadExtensionFontIcon(
							extension.id + '.' + icon.id,
							icon.defaults.fontPath,
							icon.defaults.fontCharacter,
							path => this.loadResource(resources, catalog.generation, extension.id, path),
						);
						if (this.isDisposed) {
							return;
						}
						themeContributions.icons.push({
							id: icon.id,
							description: icon.description,
							defaults: loaded.icon,
						});
						themeContributions.fonts.push(loaded.font);
					}
				}
				if (
					(manifest.contributes.languages.length > 0 || manifest.contributes.snippets.length > 0) &&
					!this.options.languageService
				) {
					throw new Error(
						`Extension '${extension.id}' contributes language features but no editor language service is available`,
					);
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
						},
						options: { priority: 100 },
					});
					if (language.configuration !== undefined) {
						const key = `${extension.id}\0${language.configuration}`;
						const configuration =
							languageConfigurationResources.get(key) ??
							this.loadLanguageConfiguration(
								resources,
								catalog.generation,
								extension.id,
								language.configuration,
							);
						languageConfigurationResources.set(key, configuration);
						const resolvedConfiguration = await configuration;
						if (this.isDisposed) return;
						languageConfigurations.push({
							languageId: language.id,
							configuration: resolvedConfiguration,
							priority: 100,
						});
					}
				}
				for (const snippet of manifest.contributes.snippets) {
					const key = `${extension.id}\0${snippet.path}`;
					const definitions =
						snippetFiles.get(key) ??
						this.loadSnippetFile(resources, catalog.generation, extension.id, snippet.path);
					snippetFiles.set(key, definitions);
					const content = await definitions;
					if (this.isDisposed) return;
					snippetResources.push(
						Object.freeze({
							extensionId: extension.id,
							location: toExtensionResourceURI({
								generation: catalog.generation,
								extensionId: extension.id,
								path: snippet.path,
							}),
							languageIds: snippet.language,
							content,
						}),
					);
				}
				for (const themeIndex of manifest.contributes.themes.keys()) {
					themes.push(preparedThemes.get(`${extension.id}\0${themeIndex}`)!);
					if (this.isDisposed) return;
				}
				for (const theme of manifest.contributes.iconThemes) {
					if (!theme.id) {
						throw new Error('File icon themes require an ID');
					}
					const bytes = await this.loadResource(resources, catalog.generation, extension.id, theme.path);
					const directory = theme.path.slice(0, theme.path.lastIndexOf('/') + 1);
					fileIconThemes.push(
						await FileIconThemeData.load(
							theme.id,
							theme.label,
							parseJsonc(new TextDecoder().decode(bytes), 'File icon theme ' + theme.id),
							path => this.loadResource(resources, catalog.generation, extension.id, directory + path),
						),
					);
					if (this.isDisposed) {
						return;
					}
				}
				for (const theme of manifest.contributes.productIconThemes) {
					if (!theme.id || theme.id === 'default')
						throw new Error('Product icon themes require a non-default ID');
					const bytes = await this.loadResource(resources, catalog.generation, extension.id, theme.path);
					const directory = theme.path.slice(0, theme.path.lastIndexOf('/') + 1);
					productIconThemes.push(
						await ProductIconThemeData.load(
							theme.id,
							theme.label,
							parseJsonc(
								new TextDecoder('utf-8', { fatal: true }).decode(bytes),
								'Product icon theme ' + theme.id,
							),
							path => this.loadResource(resources, catalog.generation, extension.id, directory + path),
						),
					);
					if (this.isDisposed) return;
				}
				problemMatchers.push(...manifest.contributes.problemMatchers);
				problemPatterns.push(...manifest.contributes.problemPatterns);
				for (const debuggerContribution of manifest.contributes.debuggers)
					debugAdapters.push(Object.freeze({ extensionId: extension.id, ...debuggerContribution }));
			}
			if (snippetOwnerRevision !== this.snippetOwnerRevision) {
				this.reloadQueued ??= 'cached';
				return;
			}
			if (snippetResources.length > 0 && !this.snippetHandler) {
				throw new Error('Extension snippets require a registered snippet contribution owner');
			}
			snippetActivation = this.snippetHandler?.(snippetResources);
			const fileTemplates = snippetActivation?.fileTemplates ?? [];
			this.validateContributions(themes, fileTemplates, debugAdapters);
			const debugAdapterFactories = debugAdapters.flatMap(definition => {
				if (definition.program === undefined) return [];
				const previousDefinition = this.debugAdapterRegistry.get(definition.type);
				const previousExtension = this.catalog.extensions.find(
					extension => extension.id === definition.extensionId,
				);
				const nextExtension = catalog.extensions.find(extension => extension.id === definition.extensionId);
				const retained = this.activeDebugAdapterFactories.find(factory => factory.type === definition.type);
				// Scan revisions may change while a launch waits for an installation path.
				// Preserve executable identity only while both package and declaration match.
				if (
					retained &&
					previousExtension &&
					nextExtension &&
					JSON.stringify(previousExtension) === JSON.stringify(nextExtension) &&
					JSON.stringify(previousDefinition) === JSON.stringify(definition)
				)
					return [retained];
				return [
					createStaticDebugAdapterFactory(
						definition.type,
						definition.label,
						`declarative:${definition.extensionId}`,
						{ program: definition.program, arguments: definition.arguments },
					),
				];
			});
			// A synchronous contribution owner can replace itself or dispose this service.
			if (this.isDisposed) return;
			if (snippetOwnerRevision !== this.snippetOwnerRevision) {
				this.reloadQueued ??= 'cached';
				return;
			}
			try {
				runWithBufferedEvents(() => {
					this.editorPaneRegistration.replace(editorPanes);
					this.submenuRegistrations.clear();
					for (const submenu of submenus)
						this.submenuRegistrations.add(
							MenusRegistry.appendMenuItem(extensionMenuId(submenu.menu), submenu.item),
						);
					this.welcomeRegistrations.clear();
					for (const args of welcome)
						this.welcomeRegistrations.add(ViewsRegistry.registerViewWelcomeContent(...args));
					this.replaceContributions(
						languages,
						languageConfigurations,
						themes,
						fileTemplates,
						debugAdapters,
						debugAdapterFactories,
						fileIconThemes,
						productIconThemes,
						themeContributions,
						{ matchers: problemMatchers, patterns: problemPatterns },
						configurations,
						configurationDefaults,
					);
					snippetActivation?.commit();
					this.keybindingRegistrations.clear();
					for (const rule of keybindings) {
						this.keybindingRegistrations.add(KeybindingsRegistry.registerKeybindingRule(rule));
					}
					this.activeThemeContributions = themeContributions;
					this.activeLanguages = Object.freeze([...languages]);
					this.activeLanguageConfigurations = Object.freeze([...languageConfigurations]);
					this.activeFileIconThemes = Object.freeze([...fileIconThemes]);
					this.activeProductIconThemes = Object.freeze([...productIconThemes]);
					this.activeDebugAdapterFactories = Object.freeze([...debugAdapterFactories]);
					this.manifests = Object.freeze(manifests);
					this.catalog = catalog;
					this.activeCatalogSignature = signature;
					this.activeSnippetOwnerRevision = snippetOwnerRevision;
					this.changeEmitter.fire(catalog);
				});
			} catch (error) {
				snippetActivation?.rollback();
				this.editorPaneRegistration.replace(this.activeEditorPanes);
				throw error;
			}
			this.activeEditorPanes = editorPanes;
		} catch (error) {
			if (this.isDisposed) return;
			return Object.freeze({ extension: activeExtension, error });
		}
	}

	private async localizeManifest(
		extension: TransportExtensionDescriptor,
		generation: number,
		resources: Map<string, Promise<Uint8Array>>,
	): Promise<string> {
		if (!extension.manifestJson.includes('%')) {
			return extension.manifestJson;
		}
		const messages: Record<string, unknown> = {};
		const language = getNLSLanguage();
		for (const suffix of ['', ...(language !== 'en' ? ['.' + language.split('-')[0], '.' + language] : [])]) {
			let bytes: Uint8Array;
			try {
				bytes = await this.loadResource(resources, generation, extension.id, 'package.nls' + suffix + '.json');
			} catch {
				// Static language packages may omit message files; locale bundles are optional too.
				continue;
			}
			Object.assign(messages, parseJsonc(new TextDecoder().decode(bytes), 'Extension messages'));
		}
		const translationUri = await this.languagePacks.getBuiltInExtensionTranslationsUri(extension.id, language);
		if (translationUri) {
			const translation = JSON.parse(translationUri.path.slice('application/json,'.length));
			Object.assign(messages, translation.contents.package);
		}
		return JSON.stringify(localizeManifest(JSON.parse(extension.manifestJson), messages));
	}

	private replaceContributions(
		languages: readonly LanguageDescriptionContribution[],
		languageConfigurations: readonly LanguageConfigurationContribution[],
		themes: readonly ExtensionThemeDefinition[],
		fileTemplates: readonly ExtensionFileTemplateDefinition[],
		debugAdapters: readonly ExtensionDebugAdapterDefinition[],
		debugAdapterFactories: readonly DebugAdapterFactory[],
		fileIconThemes: readonly IWorkbenchFileIconTheme[],
		productIconThemes: readonly IWorkbenchProductIconTheme[],
		themeContributions: ThemeContributions,
		problemContributions: ProblemMatcherContributions,
		configurations: IConfigurationNode[],
		configurationDefaults: IConfigurationDefaults[],
	): void {
		const previousThemes = this.themeRegistry.currentCatalog.themes;
		const previousFileTemplates = this.fileTemplateRegistry.currentCatalog.templates;
		const previousDebugAdapters = this.debugAdapterRegistry.definitions;
		const previousProblemContributions = this.problemMatcherRegistration.contributions;
		try {
			this.replaceThemeContributions(themeContributions);
			this.languageRegistration?.replace(languages);
			this.replaceLanguageConfigurations(languageConfigurations);
			this.themeRegistry.replace(themes);
			this.fileTemplateRegistry.replace(fileTemplates);
			this.debugAdapterRegistry.replace(debugAdapters);
			this.debugAdapterFactoryRegistration.replace(debugAdapterFactories);
			this.fileIconRegistration.replace(fileIconThemes);
			this.productIconRegistration.replace(productIconThemes);
			this.problemMatcherRegistration.replace(problemContributions);
			Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).deltaConfiguration({
				addedConfigurations: configurations,
				removedConfigurations: this.activeConfigurations,
				addedDefaults: configurationDefaults,
				removedDefaults: this.activeConfigurationDefaults,
			});
			this.activeConfigurations = configurations;
			this.activeConfigurationDefaults = configurationDefaults;
		} catch (error) {
			try {
				this.replaceThemeContributions(this.activeThemeContributions);
				this.languageRegistration?.replace(this.activeLanguages);
				this.replaceLanguageConfigurations(this.activeLanguageConfigurations);
				this.themeRegistry.replace(previousThemes);
				this.fileTemplateRegistry.replace(previousFileTemplates);
				this.debugAdapterRegistry.replace(previousDebugAdapters);
				this.debugAdapterFactoryRegistration.replace(this.activeDebugAdapterFactories);
				this.fileIconRegistration.replace(this.activeFileIconThemes);
				this.productIconRegistration.replace(this.activeProductIconThemes);
				this.problemMatcherRegistration.replace(previousProblemContributions);
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					'Extension contribution activation and rollback both failed',
				);
			}
			throw error;
		}
	}

	private replaceThemeContributions(contributions: ThemeContributions): void {
		this.colorContributions.replace(contributions.colors);
		this.tokenContributions.replace(contributions.types, contributions.modifiers);
		this.iconContributions.replace(contributions.icons, contributions.fonts);
	}

	private replaceLanguageConfigurations(contributions: readonly LanguageConfigurationContribution[]): void {
		const service = this.options.languageConfigurationService;
		if (!service) {
			if (contributions.length > 0)
				throw new Error('Extension language configurations require a language configuration service');
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

	private validateContributions(
		themes: readonly ExtensionThemeDefinition[],
		fileTemplates: readonly ExtensionFileTemplateDefinition[],
		debugAdapters: readonly ExtensionDebugAdapterDefinition[],
	): void {
		const validationThemes = new ExtensionThemeRegistry();
		try {
			validationThemes.replace(themes);
		} finally {
			validationThemes.dispose();
		}
		const validationTemplates = new ExtensionFileTemplateRegistry();
		try {
			validationTemplates.replace(fileTemplates);
		} finally {
			validationTemplates.dispose();
		}
		validateExtensionDebugAdapterDefinitions(debugAdapters);
	}

	private async loadLanguageConfiguration(
		resources: Map<string, Promise<Uint8Array>>,
		generation: number,
		extensionId: string,
		path: string,
	): Promise<ReturnType<typeof parseLanguageConfiguration>> {
		const bytes = await this.loadResource(resources, generation, extensionId, path);
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return parseLanguageConfiguration(
			parseJsonc(text, `Extension '${extensionId}' language configuration '${path}'`),
			`Extension '${extensionId}' language configuration '${path}'`,
		);
	}

	private async loadSnippetFile(
		resources: Map<string, Promise<Uint8Array>>,
		generation: number,
		extensionId: string,
		path: string,
	): Promise<string> {
		const bytes = await this.loadResource(resources, generation, extensionId, path);
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return text;
	}

	private loadResource(
		resources: Map<string, Promise<Uint8Array>>,
		generation: number,
		extensionId: string,
		path: string,
	): Promise<Uint8Array> {
		this.assertNotDisposed();
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
		diagnostics: Object.freeze(
			catalog.diagnostics.map(diagnostic =>
				Object.freeze({
					source: diagnostic.source,
					subject: diagnostic.subject,
					code: diagnostic.code,
					message: diagnostic.message,
				}),
			),
		),
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
		...(extension.extensionLocation === undefined
			? {}
			: { extensionLocation: URI.parse(extension.extensionLocation) }),
		manifestSha256: extension.manifestSha256,
		packageSha256: extension.packageSha256,
		...(extension.runtimeBinding === undefined
			? {}
			: { runtimeBinding: Object.freeze({ ...extension.runtimeBinding }) }),
	});
}

interface ThemeContributions {
	readonly colors: ColorContribution[];
	readonly icons: IconContribution[];
	readonly fonts: IconFontDefinition[];
	readonly types: TokenTypeOrModifierContribution[];
	readonly modifiers: TokenTypeOrModifierContribution[];
}

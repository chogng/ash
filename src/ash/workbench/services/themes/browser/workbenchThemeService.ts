import { IconsStyleSheet } from '../../../../platform/theme/browser/iconsStyleSheet.js';
import { IHostColorSchemeService } from '../common/hostColorSchemeService.js';
import { WorkbenchFileIconThemesRegistry, WorkbenchProductIconThemesRegistry } from '../common/themeExtensionPoints.js';
import type { ColorThemeChangeSource, IWorkbenchFileIconTheme, IWorkbenchThemeService } from '../common/workbenchThemeService.js';
import { Emitter } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { equals } from '../../../../base/common/objects.js';
import { setIconResolver } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { EditorSemanticHighlightingConfiguration } from '../../../../editor/common/config/editorConfigurationSchema.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITelemetryService, TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, IFileService, type IFileContent } from '../../../../platform/files/common/files.js';
import { type IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { getTokenClassificationRegistry } from '../../../../platform/theme/common/tokenClassificationRegistry.js';
import { Colors } from '../../../../platform/theme/common/colorRegistry.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { applyThemeCustomizations, ThemeConfigurationSettings } from '../common/themeConfiguration.js';
import { noFileIconTheme, defaultProductIconTheme, type IFileIconTheme, type IColorTheme, type IProductIconTheme, type IThemeService } from '../../../../platform/theme/common/themeService.js';
import { getIconDefinition, getIconRegistry } from '../../../../platform/theme/common/iconRegistry.js';
import { ManagedStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { generateColorThemeCSS } from './colorThemeCss.js';
import type { IResourceIconRenderer } from '../../../browser/labels.js';
import { ColorScheme, isDarkColorScheme } from '../../../../platform/theme/common/theme.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import { SystemColorThemePreference, WorkbenchThemesRegistry } from '../../../common/theme.js';
import type { IUserThemeDeleteResult, IUserThemeLoadIssue, IUserThemeSaveResult, IUserThemeService, IUserThemeSource } from '../../../common/userThemes.js';
import { loadUserColorTheme, parseUserColorTheme, userThemeId } from '../common/colorThemeData.js';
import { migrateUserTheme } from '../common/themeMigration.js';
import { registerColorThemeSchemas } from '../common/colorThemeSchema.js';

type ColorThemeChangedEvent = {
	source: ColorThemeChangeSource | 'settings' | 'system' | 'themeRegistry';
	change: 'selection' | 'content';
	colorScheme: ColorScheme;
};

type ColorThemeChangedClassification = {
	owner: 'chogng';
	comment: 'Changes of the committed color theme; excludes previews and all theme identifiers or content.';
	source: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Product entry point, settings, system appearance or theme registry that changed the committed theme, to distinguish how themes are applied.'; };
	change: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the selected theme changed or its resolved appearance changed, to distinguish selection from customization.'; };
	colorScheme: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Light, dark or either high contrast scheme after the change, to measure appearance usage.'; };
};

type ReportedColorTheme = Pick<IColorTheme, 'id' | 'colorScheme' | 'colors' | 'semanticHighlighting' | 'semanticTokenRules'>;

/** Owns active theme selection and its window-scoped visual resources. */
export class WorkbenchThemeService extends Disposable implements IWorkbenchThemeService, IResourceIconRenderer {
	private readonly colorThemeChange = this._register(new Emitter<IColorTheme>());
	private colorTheme: IColorTheme;
	private deferredColorTheme: IColorTheme | undefined;
	private readonly previews = new Map<object, IColorTheme>();
	private colorThemeWrites: Promise<void> = Promise.resolve();
	private pendingSelection: { readonly setting: string; readonly themeId: string; readonly source: ColorThemeChangeSource; } | undefined;
	/** Diagnostic baseline only; previews never replace the committed configuration being compared. */
	private reportedColorTheme: ReportedColorTheme | undefined;
	private initialized = false;
	public readonly onDidColorThemeChange = this.colorThemeChange.event;
	private readonly resourceIconChange = this._register(new Emitter<void>());
	public readonly onDidChangeResourceIcons = this.resourceIconChange.event;
	private fileIconTheme: IWorkbenchFileIconTheme | undefined;
	private readonly fileIconThemeChange = this._register(new Emitter<IFileIconTheme>());
	public readonly onDidFileIconThemeChange = this.fileIconThemeChange.event;
	private productIconTheme: IProductIconTheme = defaultProductIconTheme;
	private readonly productIconThemeChange = this._register(new Emitter<IProductIconTheme>());
	public readonly onDidProductIconThemeChange = this.productIconThemeChange.event;
	private iconStyles: HTMLStyleElement | undefined;
	private colorStyles: ManagedStyleSheet | undefined;

	constructor(
		private readonly container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IHostColorSchemeService private readonly hostColorScheme: IHostColorSchemeService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
		this.colorTheme = this.resolveColorTheme();
		this._register(toDisposable(() => this.previews.clear()));
	}

	public initialize(): void {
		this.assertNotDisposed();
		if (this.initialized) {
			throw new Error('Workbench themes are already initialized');
		}
		this.initialized = true;
		this.colorStyles = this._register(new ManagedStyleSheet(this.container.ownerDocument));
		// The document scope also covers popups mounted outside the workbench container.
		const root = this.container.ownerDocument.documentElement;
		for (const target of new Set([root, this.container])) {
			const attributes = ['data-color-theme', 'data-color-scheme'].map(name => [name, target.getAttribute(name)] as const);
			const classes = ['hc-black', 'hc-light', 'ash-high-contrast'].map(name => [name, target.classList.contains(name)] as const);
			this._register(toDisposable(() => {
				for (const [name, value] of attributes) {
					if (value === null) target.removeAttribute(name);
					else target.setAttribute(name, value);
				}
				for (const [name, present] of classes) target.classList.toggle(name, present);
			}));
		}
		this._register(this.onDidColorThemeChange(() => this.applyColorTheme()));
		this._register(new IconsStyleSheet(this.container.ownerDocument, this));
		const iconStyles = this.container.ownerDocument.createElement('style');
		this.container.ownerDocument.head.append(iconStyles);
		this.iconStyles = iconStyles;
		this._register(toDisposable(() => iconStyles.remove()));
		this._register(registerColorThemeSchemas());
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if ([ThemeConfigurationSettings.colorTheme, ThemeConfigurationSettings.preferredDarkColorTheme, ThemeConfigurationSettings.preferredLightColorTheme, ThemeConfigurationSettings.preferredHighContrastColorTheme, ThemeConfigurationSettings.preferredHighContrastLightColorTheme].some(key => event.affectsConfiguration(key))) {
				this.deferredColorTheme = undefined;
			}
			if (Object.values(ThemeConfigurationSettings).some(key => event.affectsConfiguration(key))) {
				const selection = this.pendingSelection;
				const source = selection && event.affectsConfiguration(selection.setting) && this.configurationService.getValue(selection.setting) === selection.themeId
					? selection.source : 'settings';
				this.updateColorTheme(source);
			}
			if (event.affectsConfiguration(EditorSemanticHighlightingConfiguration)) { this.colorThemeChange.fire(this.colorTheme); }
			if (event.affectsConfiguration(WorkbenchConfiguration.iconTheme)) { this.updateFileIconTheme(); }
			if (event.affectsConfiguration(WorkbenchConfiguration.productIconTheme)) { this.updateProductIconTheme(); }
		}));
		this._register(WorkbenchFileIconThemesRegistry.onDidChange(() => this.updateFileIconTheme()));
		this._register(this.languageService.onDidChange(() => this.resourceIconChange.fire()));
		this._register(getIconRegistry().onDidChange(() => setIconResolver(this.container.ownerDocument, icon => getIconDefinition(icon, this.productIconTheme.icons))));
		this._register(WorkbenchProductIconThemesRegistry.onDidChange(() => this.updateProductIconTheme()));
		setIconResolver(this.container.ownerDocument, icon => getIconDefinition(icon, defaultProductIconTheme.icons));
		this._register(toDisposable(() => setIconResolver(this.container.ownerDocument, icon => getIconDefinition(icon, defaultProductIconTheme.icons))));
		this._register(WorkbenchThemesRegistry.onDidChange(() => {
			if (this.deferredColorTheme && !WorkbenchThemesRegistry.getColorTheme(this.deferredColorTheme.id)) this.deferredColorTheme = undefined;
			this.updateColorTheme('themeRegistry');
		}));
		this._register(Colors.onDidChange(() => {
			const previous = this.colorTheme;
			this.updateColorTheme();
			if (previous === this.colorTheme) this.colorThemeChange.fire(this.colorTheme);
		}));
		this._register(getTokenClassificationRegistry().onDidChange(() => this.colorThemeChange.fire(this.colorTheme)));
		this._register(this.hostColorScheme.onDidChangeColorScheme(() => this.updateColorTheme('system')));
		this.updateColorTheme();
		this.applyColorTheme();
		this.updateFileIconTheme();
		this.updateProductIconTheme();
	}

	public getColorTheme(): IColorTheme {
		return this.colorTheme;
	}

	public getProductIconTheme(): IProductIconTheme { return this.productIconTheme; }
	public getFileIconTheme(): IFileIconTheme { return this.fileIconTheme ?? noFileIconTheme; }

	public setColorTheme(themeId: string, source: ColorThemeChangeSource): Promise<IColorTheme> {
		this.assertNotDisposed();
		const settings = ThemeConfigurationSettings;
		let key = settings.colorTheme;
		if (themeId !== SystemColorThemePreference) {
			if (this.hostColorScheme.highContrast && this.configurationService.getValue<boolean>(settings.autoDetectHighContrast)) {
				key = this.hostColorScheme.dark ? settings.preferredHighContrastColorTheme : settings.preferredHighContrastLightColorTheme;
			} else if (this.configurationService.getValue<boolean>(settings.autoDetectColorScheme)) {
				key = this.hostColorScheme.dark ? settings.preferredDarkColorTheme : settings.preferredLightColorTheme;
			}
		}
		// Capture the target before queueing: an OS appearance change must not retarget a selection.
		const operation = this.colorThemeWrites.then(async () => {
			this.assertNotDisposed();
			this.pendingSelection = { setting: key, themeId, source };
			try {
				// Configuration events can arrive before this promise resolves. Serializing the
				// whole selection keeps their attribution and same-ID reapplication together.
				await this.configurationService.updateValue(key, themeId);
				if (!this.isDisposed) {
					this.deferredColorTheme = undefined;
					this.updateColorTheme(source);
				}
				return this.colorTheme;
			} finally {
				this.pendingSelection = undefined;
			}
		});
		// A failed write rejects its caller without blocking later selections.
		this.colorThemeWrites = operation.then(() => { }, () => { });
		return operation;
	}

	public deferColorThemeApplication(themeId: string): void {
		if (this.colorTheme.id === themeId && !this.deferredColorTheme) {
			this.deferredColorTheme = WorkbenchThemesRegistry.getColorTheme(themeId);
		}
	}

	public previewColorTheme(theme: IColorTheme): IDisposable & { update(theme: IColorTheme): void; } {
		this.assertNotDisposed();
		const owner = {};
		this.previews.set(owner, theme);
		this.updateColorTheme();
		const lifetime = toDisposable(() => {
			if (this.previews.delete(owner) && !this.isDisposed) this.updateColorTheme();
		});
		return Object.assign(lifetime, {
			update: (candidate: IColorTheme): void => {
				if (!this.previews.has(owner) || this.isDisposed) return;
				this.previews.set(owner, candidate);
				this.updateColorTheme();
			},
		});
	}

	private resolveColorTheme(): IColorTheme {
		let preference = this.configurationService.getValue<string>(WorkbenchConfiguration.colorTheme);
		const settings = ThemeConfigurationSettings;
		if (this.hostColorScheme.highContrast && this.configurationService.getValue<boolean>(settings.autoDetectHighContrast)) {
			preference = this.configurationService.getValue(this.hostColorScheme.dark ? settings.preferredHighContrastColorTheme : settings.preferredHighContrastLightColorTheme);
		} else if (this.configurationService.getValue<boolean>(settings.autoDetectColorScheme) || preference === SystemColorThemePreference) {
			preference = this.configurationService.getValue(this.hostColorScheme.dark ? settings.preferredDarkColorTheme : settings.preferredLightColorTheme);
		}
		const registeredTheme = WorkbenchThemesRegistry.getColorTheme(preference);
		// These base colors keep a disconnected window usable; extension themes still come from
		// the Rust catalog and replace this bootstrap view when their registration arrives.
		let bootstrap = this.hostColorScheme.dark ? darkColorTheme : lightColorTheme;
		if (this.hostColorScheme.highContrast && this.configurationService.getValue<boolean>(settings.autoDetectHighContrast)) {
			bootstrap = this.hostColorScheme.dark ? highContrastDarkColorTheme : highContrastLightColorTheme;
		}
		// The registry owns the available version; this service owns the version actually applied.
		const theme = registeredTheme && this.deferredColorTheme?.id === registeredTheme.id
			? this.deferredColorTheme
			: registeredTheme ?? WorkbenchThemesRegistry.getColorTheme(bootstrap.id) ?? bootstrap;
		return applyThemeCustomizations(theme, this.configurationService);
	}

	private applyColorTheme(): void {
		const theme = this.colorTheme;
		this.colorStyles?.setText(generateColorThemeCSS(theme, ':root, .ash-workbench').code);
		for (const target of new Set([this.container.ownerDocument.documentElement, this.container])) {
			target.setAttribute('data-color-theme', theme.id);
			target.setAttribute('data-color-scheme', theme.colorScheme);
			target.classList.toggle('hc-black', theme.colorScheme === ColorScheme.HighContrastDark);
			target.classList.toggle('hc-light', theme.colorScheme === ColorScheme.HighContrastLight);
			target.classList.toggle('ash-high-contrast', theme.colorScheme === ColorScheme.HighContrastDark || theme.colorScheme === ColorScheme.HighContrastLight);
		}
	}

	private updateColorTheme(source?: ColorThemeChangedEvent['source']): void {
		const committedTheme = this.resolveColorTheme();
		// Auxiliary windows share previews; their lifetime changes presentation, never configuration.
		const preview = [...this.previews.values()].at(-1);
		const theme = preview ? applyThemeCustomizations(preview, this.configurationService) : committedTheme;
		const previous = this.reportedColorTheme;
		// Capture values rather than getters or lazy token-color caches, which can change on reads.
		const current: ReportedColorTheme = {
			id: committedTheme.id, colorScheme: committedTheme.colorScheme, colors: committedTheme.colors,
			semanticHighlighting: committedTheme.semanticHighlighting, semanticTokenRules: committedTheme.semanticTokenRules,
		};
		// Advance before notifying consumers: a listener may open or close a preview synchronously.
		this.reportedColorTheme = current;
		if (theme !== this.colorTheme) {
			this.colorTheme = theme;
			this.colorThemeChange.fire(theme);
			this.resourceIconChange.fire();
		}
		if (source && previous && !this.isDisposed && !equals(previous, current) && this.telemetryService.telemetryLevel === TelemetryLevel.USAGE) {
			this.telemetryService.publicLog2<ColorThemeChangedEvent, ColorThemeChangedClassification>('workbenchColorThemeChanged', {
				source,
				change: previous.id === committedTheme.id ? 'content' : 'selection',
				colorScheme: committedTheme.colorScheme,
			});
		}
	}

	private updateFileIconTheme(): void {
		const id = this.configurationService.getValue<string | null>(WorkbenchConfiguration.iconTheme);
		const theme = WorkbenchFileIconThemesRegistry.getThemes().find(theme => theme.id === id);
		if (theme === this.fileIconTheme) { return; }
		this.fileIconTheme = theme;
		if (this.iconStyles) {
			// Font advances can exceed the reserved icon width; keep their origin at the slot's left edge.
			this.iconStyles.textContent = theme ? theme.styleSheetContent + '\n.ash-file-icon{display:block;font-style:normal;font-weight:normal;line-height:16px;}' : '';
		}
		this.fileIconThemeChange.fire(this.getFileIconTheme());
		this.resourceIconChange.fire();
	}

	private updateProductIconTheme(): void {
		const id = this.configurationService.getValue<string>(WorkbenchConfiguration.productIconTheme);
		const theme = WorkbenchProductIconThemesRegistry.getThemes().find(theme => theme.id === id) ?? defaultProductIconTheme;
		if (theme === this.productIconTheme) return;
		this.productIconTheme = theme;
		setIconResolver(this.container.ownerDocument, icon => getIconDefinition(icon, theme.icons));
		this.productIconThemeChange.fire(theme);
	}

	public renderFileIcon(resource: URI, container: HTMLElement, classes: readonly string[] = getIconClasses(undefined, this.languageService, resource, FileKind.File)): void {
		const icon = this.fileIconTheme?.resolveFileIcon(classes, this.colorTheme.colorScheme);
		container.classList.add(...classes);
		container.classList.toggle('ash-file-icon', icon !== undefined);
		container.textContent = icon?.character ?? '';
		container.style.color = icon?.color ?? '';
		container.style.fontFamily = icon?.fontFamily ?? '';
		container.style.fontSize = icon?.fontSize ?? '';
		container.style.fontWeight = icon?.fontWeight ?? '';
		container.style.fontStyle = icon?.fontStyle ?? '';
		container.style.backgroundImage = icon?.image ? `url("${icon.image}")` : '';
		container.style.backgroundSize = icon?.image ? 'contain' : '';
		container.style.backgroundRepeat = icon?.image ? 'no-repeat' : '';
	}
}

interface ThemeSource extends IUserThemeSource {
	readonly fileContent: IFileContent;
	readonly theme: IColorTheme;
}

/** Owns user theme resources and registration independently of the filesystem host. */
class UserThemeResources extends Disposable implements IUserThemeService {
	public readonly available = true;
	private readonly registration = this._register(WorkbenchThemesRegistry.registerColorThemes([]));
	private sources = new Map<string, ThemeSource>();
	private loadIssues: readonly IUserThemeLoadIssue[] = [];
	private reloadQueue: Promise<void> = Promise.resolve();
	private readonly refresh: RunOnceScheduler;

	constructor(private readonly resource: URI, @IFileService private readonly files: IFileService) {
		super();
		this.refresh = this._register(new RunOnceScheduler(() => {
			void this.reload().catch(error => console.error('Failed to reload user themes', error));
		}, 75));
		this._register(files.onDidChangeFiles(event => {
			if (event.resources === undefined || event.resources.some(resource => extUriBiasedIgnorePathCase.isEqualOrParent(resource, this.resource))) {
				this.refresh.schedule();
			}
		}));
	}

	public get directory(): URI { return this.resource; }
	public get issues(): readonly IUserThemeLoadIssue[] { return this.loadIssues; }
	public sourceFor(id: string): IUserThemeSource | undefined { return this.sources.get(id); }
	public getSource(id: string): string | undefined { return this.sources.get(id)?.fileContent.content; }
	public async resolve(source: string, id?: string): Promise<IColorTheme> {
		const existing = id ? this.sources.get(id) : undefined;
		return existing ? this.compileTheme(existing.file, source, id) : parseUserColorTheme(source, id);
	}

	public reload(): Promise<void> {
		// An explicit save refresh consumes the same invalidation as the pending
		// file watcher. Events arriving during this read can still schedule another.
		this.refresh.cancel();
		const operation = this.reloadQueue.then(() => this.reloadResources());
		this.reloadQueue = operation.then(() => { }, () => { });
		return operation;
	}

	private async reloadResources(): Promise<void> {
		const sources = new Map<string, ThemeSource>();
		const issues: IUserThemeLoadIssue[] = [];
		try {
			const entries = (await this.files.readDirectory(this.resource)).filter(entry => entry.kind === FileKind.File && entry.name.toLowerCase().endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 128);
			for (const entry of entries) {
				try {
					let content = await this.read(entry.resource);
					const migration = migrateUserTheme(content.content);
					if (migration) {
						const target = this.child(migration.id + '.json');
						parseUserColorTheme(migration.content, migration.id);
						if (target.toString() === entry.resource.toString()) {
							await this.files.writeFile({ resource: target, content: migration.content, expectedRevision: content.revision });
						} else {
							let existing: IFileContent | undefined;
							try { existing = await this.read(target); } catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
							if (existing && existing.content !== migration.content) throw new Error('Theme migration conflicts with ' + migration.id + '.json');
							if (!existing) await this.create(target, migration.content);
							await this.deleteSource(content);
						}
						content = await this.read(target);
					}
					const encodedPath = content.resource.toEncodedComponents().path;
					const file = decodeURIComponent(encodedPath.slice(encodedPath.lastIndexOf('/') + 1));
					const id = userThemeId(file.slice(0, -5));
					const theme = await this.compileTheme(file, content.content, id);
					const existing = WorkbenchThemesRegistry.getColorTheme(id);
					if (existing && !this.sources.has(id)) throw new Error('Theme id is already in use: ' + id);
					if (sources.has(id) && sources.get(id)!.file !== file) throw new Error('Duplicate user theme id: ' + id);
					sources.set(id, { id, file, fileContent: content, theme });
				} catch (error) {
					const previous = [...this.sources.values()].find(source => source.file === entry.name);
					if (previous && !sources.has(previous.id)) sources.set(previous.id, previous);
					issues.push({ file: entry.name, message: errorMessage(error) });
				}
			}
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) {
				this.loadIssues = [{ file: 'themes', message: errorMessage(error) }];
				return;
			}
		}
		this.registration.replace([...sources.values()].map(source => source.theme));
		this.sources = sources;
		this.loadIssues = issues;
	}

	public async save(id: string, source: string): Promise<IUserThemeSaveResult> {
		const existing = this.sources.get(id);
		if (!existing) throw new Error('User theme is not loaded: ' + id);
		await this.compileTheme(existing.file, source, id);
		await this.files.writeFile({ resource: existing.fileContent.resource, content: source, expectedRevision: existing.fileContent.revision });
		await this.reload();
		return this.saved(id);
	}

	public async saveAs(source: string): Promise<IUserThemeSaveResult> {
		const theme = await this.compileTheme('draft.json', source);
		if (WorkbenchThemesRegistry.getColorTheme(theme.id)) throw new Error('Theme id is already in use: ' + theme.id);
		await this.create(this.child(theme.id + '.json'), source);
		await this.reload();
		return this.saved(theme.id);
	}

	public async delete(id: string): Promise<IUserThemeDeleteResult> {
		const existing = this.sources.get(id);
		if (!existing) throw new Error('User theme is not loaded: ' + id);
		await this.deleteSource(existing.fileContent);
		await this.reload();
		return { file: existing.file, colorScheme: existing.theme.colorScheme };
	}

	private async read(resource: URI): Promise<IFileContent> {
		const stat = await this.files.stat(resource);
		if (stat.kind !== FileKind.File || stat.sizeBytes > 1_048_576) throw new Error('Theme must be a regular file of at most 1 MiB');
		return this.files.readFile(resource);
	}

	private compileTheme(path: string, source: string, id?: string): Promise<IColorTheme> {
		return loadUserColorTheme(path, async resource => resource === path ? source : (await this.read(this.child(resource))).content, id);
	}

	private async create(resource: URI, content: string): Promise<void> {
		const temporary = URI.parse(resource.toString() + '.' + crypto.randomUUID() + '.tmp');
		try {
			await this.files.createFile(temporary, 'error');
			await this.files.writeFile({ resource: temporary, content });
			await this.files.rename(temporary, resource, 'error');
		} finally { await this.files.delete(temporary, 'ignore', 'fileOrEmptyDirectory'); }
	}

	private async deleteSource(content: IFileContent): Promise<void> {
		if ((await this.files.readFile(content.resource)).revision !== content.revision) throw new FileRevisionConflictError(content.resource);
		await this.files.delete(content.resource, 'error', 'fileOrEmptyDirectory');
	}

	private child(name: string): URI {
		return URI.parse(this.resource.toString().replace(/\/$/u, '') + '/' + name.split('/').map(encodeURIComponent).join('/'));
	}

	private saved(id: string): IUserThemeSaveResult {
		const source = this.sources.get(id);
		if (!source) throw new Error('Saved theme could not be reloaded: ' + id);
		return { file: source.file, theme: source.theme };
	}
}

export async function loadUserThemes(services: IInstantiationService, directory: URI): Promise<IUserThemeService & IDisposable> {
	const service = services.createInstance(UserThemeResources, directory);
	try { await service.reload(); return service; }
	catch (error) { service.dispose(); throw error; }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

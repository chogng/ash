import { ManagedStyleSheet } from '../../../base/browser/domStylesheets.js';
import { colorCssVariable } from '../../../platform/theme/common/colorUtils.js';
import { asCssVariableName, sizeValueToCss } from '../../../platform/theme/common/sizeUtils.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { setIconResolver } from '../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { noFileIconTheme, defaultProductIconTheme, type IColorTheme } from '../../../platform/theme/common/themeService.js';
import { ColorScheme, isDarkColorScheme } from '../../../platform/theme/common/theme.js';
import { Colors } from '../../../platform/theme/common/colorRegistry.js';
import { getIconDefinition } from '../../../platform/theme/common/iconRegistry.js';
import type { Color } from '../../../base/common/color.js';
import { TokenizationRegistry } from '../../common/languages.js';
import { TokenTheme } from '../../common/languages/supports/tokenization.js';
import type { BuiltinTheme, IStandaloneTheme, IStandaloneThemeData, IStandaloneThemeService, NamedEditorThemeData } from '../common/standaloneTheme.js';
import { hc_black, hc_light, vs, vs_dark } from '../common/themes.js';

const ForcedColorsQuery = '(forced-colors: active)';
const builtinDefinitions = new Map<BuiltinTheme, IStandaloneThemeData>([
	['vs', vs], ['vs-dark', vs_dark], ['hc-black', hc_black], ['hc-light', hc_light],
]);

/** Owns named themes and the active theme for one standalone browser window. */
export class StandaloneThemeService extends Disposable implements IStandaloneThemeService {
	private readonly changed = this._register(new Emitter<IColorTheme>());
	private colorTheme: IStandaloneTheme = withTokenTheme(lightColorTheme, vs);
	public readonly onDidColorThemeChange = this.changed.event;
	public readonly onDidProductIconThemeChange = Event.None;
	public readonly onDidFileIconThemeChange = Event.None;
	private readonly themes = new Map<string, IStandaloneTheme>();
	private readonly definitions = new Map<string, IStandaloneThemeData>();
	private colorMapOverride: Color[] | null = null;
	private readonly forcedColors: MediaQueryList;
	private selectedThemeId = lightColorTheme.id;
	private autoDetectHighContrast = true;
	private readonly documentStyles = new Map<Document, {
		readonly styles: ManagedStyleSheet;
		readonly metadata: IDisposable;
		references: number;
	}>();

	constructor(ownerWindow: Window) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this.documentStyles.values()) {
				entry.styles.dispose();
				entry.metadata.dispose();
			}
			this.documentStyles.clear();
		}));
		// Host-level menus outlive individual editors; other documents follow their container lifetimes.
		this._register(this.registerEditorContainer(ownerWindow.document.documentElement));
		setIconResolver(ownerWindow.document, icon => getIconDefinition(icon));
		for (const theme of [lightColorTheme, darkColorTheme, highContrastLightColorTheme, highContrastDarkColorTheme]) {
			this.themes.set(theme.id, theme === lightColorTheme ? this.colorTheme : withTokenTheme(theme, definitionForScheme(theme.colorScheme)));
		}
		for (const [name, data] of builtinDefinitions) {
			this.definitions.set(name, data);
			this.themes.set(name, compileTheme(name, data, this.definitions));
		}
		this.forcedColors = ownerWindow.matchMedia(ForcedColorsQuery);
		const handleForcedColorsChange = (): void => this.applySelectedTheme();
		this.forcedColors.addEventListener('change', handleForcedColorsChange);
		this._register(toDisposable(() => this.forcedColors.removeEventListener('change', handleForcedColorsChange)));
		this.applySelectedTheme();
		this.updateColorMap();
		this.updateThemeStyles();
		this._register(Colors.onDidChange(() => {
			this.updateThemeStyles();
			this.changed.fire(this.colorTheme);
		}));
	}

	/** One stylesheet per registered document also themes its overflow widgets and menus. */
	public registerEditorContainer(domNode: HTMLElement): IDisposable {
		const document = domNode.ownerDocument;
		let entry = this.documentStyles.get(document);
		if (!entry) {
			entry = {
				styles: new ManagedStyleSheet(document),
				metadata: this.registerThemeClasses(document.documentElement),
				references: 0,
			};
			this.documentStyles.set(document, entry);
			this.updateThemeStyles();
		}
		entry.references++;
		const metadata = domNode === document.documentElement ? undefined : this.registerThemeClasses(domNode);
		return toDisposable(() => {
			metadata?.dispose();
			if (this.documentStyles.get(document) !== entry || --entry.references !== 0) return;
			this.documentStyles.delete(document);
			entry.styles.dispose();
			entry.metadata.dispose();
		});
	}

	private registerThemeClasses(domNode: HTMLElement): IDisposable {
		const attributes = ['data-color-theme', 'data-color-scheme'].map(name => [name, domNode.getAttribute(name)] as const);
		const classes = ['hc-black', 'hc-light', 'ash-high-contrast'].map(name => [name, domNode.classList.contains(name)] as const);
		const update = (): void => {
			const theme = this.colorTheme;
			domNode.setAttribute('data-color-theme', theme.id);
			domNode.setAttribute('data-color-scheme', theme.colorScheme);
			domNode.classList.toggle('hc-black', theme.colorScheme === ColorScheme.HighContrastDark);
			domNode.classList.toggle('hc-light', theme.colorScheme === ColorScheme.HighContrastLight);
			domNode.classList.toggle('ash-high-contrast', isHighContrast(theme.colorScheme));
		};
		update();
		const listener = this.onDidColorThemeChange(update);
		return toDisposable(() => {
			listener.dispose();
			for (const [name, value] of attributes) {
				if (value === null) domNode.removeAttribute(name);
				else domNode.setAttribute(name, value);
			}
			for (const [name, present] of classes) domNode.classList.toggle(name, present);
		});
	}

	private updateThemeStyles(): void {
		const theme = this.colorTheme;
		const declarations = theme.colorEntries.map(({ id, value }) => `${colorCssVariable(id)}: ${value?.toString() ?? 'initial'};`);
		for (const { id, value } of theme.sizeEntries) {
			declarations.push(`${asCssVariableName(id)}: ${sizeValueToCss(value)};`);
		}
		declarations.push(
			`color-scheme: ${isDarkColorScheme(theme.colorScheme) ? 'dark' : 'light'};`,
			`forced-color-adjust: ${isHighContrast(theme.colorScheme) ? 'none' : 'auto'};`,
			`--ash-shadow-lg: ${isHighContrast(theme.colorScheme) ? 'none' : '0 0 12px rgba(0, 0, 0, 0.14)'};`,
		);
		for (const entry of this.documentStyles.values()) {
			entry.styles.setText(`:root {\n${declarations.join('\n')}\n}`);
		}
	}

	public defineTheme(themeName: string, themeData: IStandaloneThemeData): void {
		if (!builtinDefinitions.has(themeData.base)) {
			throw new TypeError(`Unknown base theme: ${themeData.base}`);
		}
		if (builtinDefinitions.has(themeName as BuiltinTheme) && themeName !== themeData.base) {
			throw new TypeError('A built-in theme must retain its base');
		}
		const data: IStandaloneThemeData = {
			...themeData,
			colors: { ...themeData.colors },
			rules: themeData.rules.map(rule => ({ ...rule })),
			encodedTokensColors: themeData.encodedTokensColors?.slice(),
		};
		const definitions = new Map(this.definitions);
		definitions.set(themeName, data);
		const compiled = new Map<string, IStandaloneTheme>();
		for (const [name, definition] of definitions) {
			if (name === themeName || (definition.inherit && definition.base === themeName)) {
				compiled.set(name, compileTheme(name, definition, definitions));
			}
		}
		this.definitions.set(themeName, data);
		for (const [name, theme] of compiled) {
			this.themes.set(name, theme);
		}
		this.applySelectedTheme();
	}

	public setColorMapOverride(colorMapOverride: Color[] | null): void {
		this.colorMapOverride = colorMapOverride?.slice() ?? null;
		this.updateColorMap();
	}

	public defineNamedTheme(themeId: string, themeData: NamedEditorThemeData): void {
		const theme = createColorTheme({
			id: themeId,
			label: themeData.label,
			colorScheme: themeData.colorScheme,
			colorOverrides: themeData.colors,
		});
		this.registerColorTheme(theme);
		this.applySelectedTheme();
	}

	public setTheme(themeId: string): void {
		if (!this.themes.has(themeId)) {
			throw new Error(`Unknown standalone color theme: ${themeId}`);
		}
		this.selectedThemeId = themeId;
		this.applySelectedTheme();
	}

	public getColorTheme(): IStandaloneTheme {
		return this.colorTheme;
	}

	public getProductIconTheme() { return defaultProductIconTheme; }
	public getFileIconTheme() { return noFileIconTheme; }

	public setColorTheme(theme: IColorTheme): void {
		this.registerColorTheme(theme);
		this.selectedThemeId = theme.id;
		this.applySelectedTheme();
	}

	public setAutoDetectHighContrast(autoDetectHighContrast: boolean): void {
		if (this.autoDetectHighContrast === autoDetectHighContrast) {
			return;
		}
		this.autoDetectHighContrast = autoDetectHighContrast;
		this.applySelectedTheme();
	}

	private registerColorTheme(theme: IColorTheme): void {
		const defaults = definitionForScheme(theme.colorScheme);
		const registered = withTokenTheme(theme, defaults);
		if (builtinDefinitions.has(theme.id as BuiltinTheme)) {
			if (theme.id !== defaults.base) {
				throw new TypeError('A built-in theme must retain its color scheme');
			}
			this.definitions.set(theme.id, { ...defaults, colors: { ...theme.colors } });
			for (const [name, data] of this.definitions) {
				if (name !== theme.id && data.inherit && data.base === theme.id) {
					this.themes.set(name, compileTheme(name, data, this.definitions));
				}
			}
		} else {
			this.definitions.delete(theme.id);
		}
		this.themes.set(theme.id, registered);
	}

	private applySelectedTheme(): void {
		const selectedTheme = this.themes.get(this.selectedThemeId);
		if (!selectedTheme) {
			throw new Error(`Unknown standalone color theme: ${this.selectedThemeId}`);
		}
		if (!this.autoDetectHighContrast || !this.forcedColors.matches || isHighContrast(selectedTheme.colorScheme)) {
			this.updateColorTheme(selectedTheme);
			return;
		}
		const dark = isDarkColorScheme(selectedTheme.colorScheme);
		const highContrastId = this.definitions.has(selectedTheme.id)
			? (dark ? 'hc-black' : 'hc-light')
			: (dark ? highContrastDarkColorTheme.id : highContrastLightColorTheme.id);
		const registeredHighContrastTheme = this.themes.get(highContrastId);
		if (!registeredHighContrastTheme) {
			throw new Error(`Unknown standalone color theme: ${highContrastId}`);
		}
		this.updateColorTheme(registeredHighContrastTheme);
	}

	private updateColorTheme(theme: IStandaloneTheme): void {
		if (theme === this.colorTheme) {
			return;
		}
		this.colorTheme = theme;
		this.updateColorMap();
		this.updateThemeStyles();
		this.changed.fire(theme);
	}

	private updateColorMap(): void {
		TokenizationRegistry.setColorMap(this.colorMapOverride ?? this.colorTheme.tokenTheme.getColorMap());
	}
}

function definitionForScheme(scheme: ColorScheme): IStandaloneThemeData {
	switch (scheme) {
		case ColorScheme.Light: return vs;
		case ColorScheme.Dark: return vs_dark;
		case ColorScheme.HighContrastLight: return hc_light;
		case ColorScheme.HighContrastDark: return hc_black;
	}
}

function compileTheme(name: string, data: IStandaloneThemeData, definitions: ReadonlyMap<string, IStandaloneThemeData>): IStandaloneTheme {
	const builtin = builtinDefinitions.get(data.base)!;
	const base = name === data.base ? builtin : definitions.get(data.base)!;
	const inheritedRules = base.inherit ? [...builtin.rules, ...base.rules] : base.rules;
	const rules = data.inherit ? [...inheritedRules, ...data.rules] : data.rules;
	const defaults: { foreground?: string; background?: string; } = {};
	for (const rule of rules) {
		if (rule.token === '') {
			if (rule.foreground !== undefined) {
				defaults.foreground = rule.foreground;
			}
			if (rule.background !== undefined) {
				defaults.background = rule.background;
			}
		}
	}
	const colorScheme = data.base === 'vs' ? ColorScheme.Light
		: data.base === 'vs-dark' ? ColorScheme.Dark
			: data.base === 'hc-black' ? ColorScheme.HighContrastDark : ColorScheme.HighContrastLight;
	const theme = createColorTheme({
		id: name,
		label: name,
		colorScheme,
		colorOverrides: {
			...(defaults.foreground ? { 'editor.foreground': tokenColor(defaults.foreground) } : {}),
			...(defaults.background ? { 'editor.background': tokenColor(defaults.background) } : {}),
			...(data.inherit ? base.colors : {}),
			...data.colors,
		},
	});
	return withTokenTheme(theme, { ...data, rules });
}

function withTokenTheme(theme: IColorTheme, data: IStandaloneThemeData): IStandaloneTheme {
	const rules = [
		...data.rules,
		{ token: '', foreground: theme.getColorCss('editor.foreground'), background: theme.getColorCss('editor.background') },
	];
	return Object.freeze({
		...theme,
		get colors() { return theme.colors; },
		get colorEntries() { return theme.colorEntries; },
		themeName: theme.id,
		tokenTheme: TokenTheme.createFromRawTokenTheme(rules, data.encodedTokensColors ?? []),
	});
}

function tokenColor(value: string): string {
	return value.startsWith('#') ? value : `#${value}`;
}

function isHighContrast(colorScheme: ColorScheme): boolean {
	return colorScheme === ColorScheme.HighContrastDark || colorScheme === ColorScheme.HighContrastLight;
}

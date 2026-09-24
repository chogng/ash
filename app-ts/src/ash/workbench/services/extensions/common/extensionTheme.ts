import { Emitter, type Event } from "../../../../base/common/event.js";
import { Color } from "../../../../base/common/color.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type IColorTheme } from "../../../../platform/theme/common/colorTheme.js";
import { createDocumentColorTheme, parseColorThemeDocument } from "../../themes/common/colorThemeData.js";
import { ColorScheme } from "../../../../platform/theme/common/theme.js";

export interface ExtensionThemeTokenColorSettings {
	readonly foreground?: string;
	readonly background?: string;
	readonly fontStyle?: string;
}

export interface ExtensionThemeTokenColorRule {
	readonly scopes: readonly string[];
	readonly settings: ExtensionThemeTokenColorSettings;
}

export interface ExtensionThemeDefinition {
	readonly id: string;
	readonly extensionId: string;
	readonly label: string;
	readonly uiTheme?: string;
	readonly colors: Readonly<Record<string, string>>;
	readonly tokenColors: readonly ExtensionThemeTokenColorRule[];
}

export interface ExtensionThemeCatalog {
	readonly revision: number;
	readonly themes: readonly ExtensionThemeDefinition[];
}

/** Read-only extension-theme catalog exposed to Workbench consumers. */
export interface ExtensionThemeSource {
	readonly currentCatalog: ExtensionThemeCatalog;
	readonly onDidChange: Event<ExtensionThemeCatalog>;
}

/** Owns validated extension theme documents without executing theme or extension code. */
export class ExtensionThemeRegistry extends Disposable implements ExtensionThemeSource {
	private readonly changeEmitter = this._register(new Emitter<ExtensionThemeCatalog>());
	private catalog: ExtensionThemeCatalog = Object.freeze({ revision: 0, themes: Object.freeze([]) });

	readonly onDidChange: Event<ExtensionThemeCatalog> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.catalog = Object.freeze({ revision: this.catalog.revision, themes: Object.freeze([]) });
		}));
	}

	get currentCatalog(): ExtensionThemeCatalog {
		this.assertNotDisposed();
		return this.catalog;
	}

	replace(themes: readonly ExtensionThemeDefinition[]): void {
		this.assertNotDisposed();
		if (!Array.isArray(themes)) throw new TypeError("Extension theme replacement must be an array");
		const normalized = themes.map(normalizeTheme);
		const ids = new Set<string>();
		for (const theme of normalized) {
			if (ids.has(theme.id)) throw new RangeError(`Duplicate extension theme '${theme.id}'`);
			ids.add(theme.id);
		}
		this.catalog = Object.freeze({ revision: this.catalog.revision + 1, themes: Object.freeze(normalized) });
		this.changeEmitter.fire(this.catalog);
	}

}

/** Parses the declarative subset of a VS Code color-theme document. */
export function parseExtensionTheme(value: unknown, id: string, extensionId: string, label: string, uiTheme: string | undefined, owner: string): ExtensionThemeDefinition {
	const document = parseColorThemeDocument(value);
	const tokenColors = document.tokenColors === undefined ? Object.freeze([]) : parseTokenColors(document.tokenColors, `${owner}.tokenColors`);
	const colors = document.colors === undefined ? Object.freeze({}) : parseColors(document.colors, `${owner}.colors`);
	const documentName = document.name === undefined ? undefined : boundedText(document.name, `${owner}.name`, 256);
	const resolvedLabel = /^%[^%]+%$/u.test(label) && documentName !== undefined ? documentName : label;
	return Object.freeze({
		id,
		extensionId,
		label: resolvedLabel,
		...(uiTheme === undefined ? {} : { uiTheme }),
		colors,
		tokenColors,
	});
}

/** Produces the stable Workbench theme identity owned by one manifest contribution. */
export function extensionWorkbenchThemeId(extensionId: string, contributionId: string | undefined, index: number): string {
	const extension = themeIdSegment(extensionId, "Extension theme extension ID");
	const contribution = themeIdSegment(contributionId ?? String(index + 1), "Extension theme contribution ID");
	return `extension-${extension}-${contribution}`;
}

/** Compiles supported VS Code color keys over Ash's complete theme defaults. */
export function createExtensionWorkbenchColorTheme(theme: ExtensionThemeDefinition): IColorTheme {
	return createDocumentColorTheme({ colors: theme.colors, tokenColors: theme.tokenColors.map(rule => ({ scope: rule.scopes, settings: rule.settings })) }, theme.id, theme.label, extensionColorScheme(theme.uiTheme));
}

function normalizeTheme(theme: ExtensionThemeDefinition): ExtensionThemeDefinition {
	if (typeof theme !== "object" || theme === null) throw new TypeError("Extension theme must be an object");
	const uiTheme = theme.uiTheme === undefined ? undefined : boundedText(theme.uiTheme, "Extension theme UI theme", 128);
	if (uiTheme !== undefined) extensionColorScheme(uiTheme);
	return Object.freeze({
		id: boundedText(theme.id, "Extension theme ID", 256),
		extensionId: boundedText(theme.extensionId, "Extension theme extension ID", 256),
		label: boundedText(theme.label, "Extension theme label", 256),
		...(uiTheme === undefined ? {} : { uiTheme }),
		colors: normalizeColors(theme.colors),
		tokenColors: normalizeTokenColors(theme.tokenColors),
	});
}

function parseTokenColors(value: unknown, owner: string): readonly ExtensionThemeTokenColorRule[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return Object.freeze(value.map((candidate, index) => {
		const rule = record(candidate, `${owner}[${index}]`);
		const scopes = rule.scope === undefined ? Object.freeze([]) : parseScopes(rule.scope, `${owner}[${index}].scope`);
		return Object.freeze({ scopes, settings: parseTokenColorSettings(rule.settings, `${owner}[${index}].settings`) });
	}));
}

function parseTokenColorSettings(value: unknown, owner: string): ExtensionThemeTokenColorSettings {
	const settings = record(value, owner);
	const keys = new Set(["foreground", "background", "fontStyle"]);
	if (Object.keys(settings).some(key => !keys.has(key))) throw new TypeError(`${owner} contains unsupported fields`);
	return Object.freeze({
		...(settings.foreground === undefined ? {} : { foreground: colorValue(settings.foreground, `${owner}.foreground`) }),
		...(settings.background === undefined ? {} : { background: colorValue(settings.background, `${owner}.background`) }),
		...(settings.fontStyle === undefined ? {} : { fontStyle: fontStyleValue(settings.fontStyle, `${owner}.fontStyle`) }),
	});
}

function parseScopes(value: unknown, owner: string): readonly string[] {
	const scopes = typeof value === "string" ? [value] : value;
	if (!Array.isArray(scopes)) throw new TypeError(`${owner} must be a string or string array`);
	return Object.freeze(scopes.map(scope => boundedText(scope, owner, 512)));
}

function parseColors(value: unknown, owner: string): Readonly<Record<string, string>> {
	const colors = record(value, owner);
	return normalizeColors(Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, colorValue(color, `${owner}.${key}`)])));
}

function normalizeColors(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const colors = record(value, "Extension theme colors");
	return Object.freeze(Object.fromEntries(Object.entries(colors).map(([key, color]) => [
		boundedText(key, "Extension theme color key", 256),
		colorValue(color, `Extension theme color '${key}'`),
	])));
}

function normalizeTokenColors(value: readonly ExtensionThemeTokenColorRule[]): readonly ExtensionThemeTokenColorRule[] {
	if (!Array.isArray(value)) throw new TypeError("Extension theme token colors must be an array");
	let projectedRuleCount = 0;
	const normalized = value.map((candidate, index) => {
		const rule = record(candidate, `Extension theme token color ${index}`);
		const scopes = parseScopes(rule.scopes, `Extension theme token color ${index} scopes`);
		projectedRuleCount += scopes.length;
		if (projectedRuleCount > 1_024) throw new RangeError("Extension theme cannot project more than 1024 TextMate rules");
		return Object.freeze({
			scopes,
			settings: parseTokenColorSettings(rule.settings, `Extension theme token color ${index} settings`),
		});
	});
	return Object.freeze(normalized);
}

function colorValue(value: unknown, owner: string): string {
	const color = boundedText(value, owner, 128);
	if (!color.startsWith("#")) throw new TypeError(`${owner} must be a hexadecimal color`);
	Color.fromHex(color);
	return color;
}

function fontStyleValue(value: unknown, owner: string): string {
	if (typeof value !== "string" || value.length > 128 || /[\r\n]/u.test(value)) throw new TypeError(`${owner} is invalid`);
	for (const style of value.trim().split(/\s+/u)) {
		if (style.length > 0 && style !== "italic" && style !== "bold" && style !== "underline" && style !== "strikethrough") throw new TypeError(`${owner} contains unsupported style '${style}'`);
	}
	return value;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\r\n]/u.test(value)) throw new TypeError(`${owner} is invalid`);
	return value;
}

function extensionColorScheme(uiTheme: string | undefined): ColorScheme {
	switch (uiTheme) {
		case "vs": return ColorScheme.Light;
		case "vs-dark": return ColorScheme.Dark;
		case "hc-black": return ColorScheme.HighContrastDark;
		case "hc-light": return ColorScheme.HighContrastLight;
		default: throw new TypeError("Selectable extension themes must declare a supported uiTheme");
	}
}

function themeIdSegment(value: string, owner: string): string {
	const normalized = boundedText(value, owner, 256).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
	if (normalized.length === 0) throw new TypeError(`${owner} cannot produce a stable theme ID`);
	return normalized;
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

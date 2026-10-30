import { localize } from '../../../../nls.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { createDocumentColorTheme, parseColorThemeDocument, parseSemanticTokenRules } from '../../themes/common/colorThemeData.js';
import type { ColorThemeDocument } from '../../themes/common/colorThemeData.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { loadColorThemeDocument } from '../../themes/common/colorThemeData.js';
import { parseJsonc } from './jsonc.js';
import type { ExtensionThemeContribution } from './extensionManifest.js';
import { colorThemeSchema } from '../../themes/common/colorThemeSchema.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import type { ExtensionSourceKind } from './extensionService.js';

/** Only the development host publishes checkout locations, independently of installed packages. */
export function getDevelopmentThemeLocation(
	extensionId: string,
	sourceKind: ExtensionSourceKind,
	locations: Readonly<Record<string, string>> | undefined,
): URI | undefined {
	const location = sourceKind === 'builtIn' ? locations?.[extensionId] : undefined;
	return location ? URI.parse(location) : undefined;
}

export interface ExtensionThemeDefinition {
	readonly id: string;
	readonly extensionId: string;
	readonly label: string;
	readonly uiTheme?: string;
	readonly colors: Readonly<Record<string, string>>;
	readonly semanticHighlighting?: boolean;
	readonly semanticTokenColors?: ColorThemeDocument['semanticTokenColors'];
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
		if (!Array.isArray(themes)) throw new TypeError('Extension theme replacement must be an array');
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
	const document = parseColorThemeDocument(extensionThemeDocument(value));
	return themeFromDocument(document, id, extensionId, label, uiTheme, owner);
}

function themeFromDocument(document: ColorThemeDocument, id: string, extensionId: string, label: string, uiTheme: string | undefined, owner: string): ExtensionThemeDefinition {
	const colors = document.colors === undefined ? Object.freeze({}) : parseColors(document.colors, `${owner}.colors`);
	const documentName = document.name === undefined ? undefined : boundedText(document.name, `${owner}.name`, 256);
	const resolvedLabel = /^%[^%]+%$/u.test(label) && documentName !== undefined ? documentName : label;
	return Object.freeze({
		id,
		extensionId,
		label: resolvedLabel,
		...(uiTheme === undefined ? {} : { uiTheme }),
		colors,
		...(document.semanticHighlighting === undefined ? {} : { semanticHighlighting: document.semanticHighlighting }),
		...(document.semanticTokenColors === undefined ? {} : { semanticTokenColors: document.semanticTokenColors }),
	});
}

/** Reads one manifest theme and its package-relative resources through the caller's extension resource owner. */
export async function loadExtensionTheme(
	read: (path: string) => Promise<Uint8Array>,
	extensionId: string,
	contribution: ExtensionThemeContribution,
	index: number,
): Promise<ExtensionThemeDefinition> {
	const document = await loadColorThemeDocument(contribution.path, async resource => {
		const bytes = await read(resource);
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return extensionThemeDocument(parseJsonc(text, `Extension '${extensionId}' theme '${resource}'`));
	});
	// Includes can compose individually valid documents beyond the single-theme
	// budget. Check that aggregate bound without reparsing its validated fields.
	if (JSON.stringify(document).length > 1_048_576) throw new Error(localize('theme.documentTooLarge', 'Theme exceeds the 1 MiB document limit'));
	return themeFromDocument(document, extensionWorkbenchThemeId(extensionId, contribution.id, index), extensionId, contribution.label, contribution.uiTheme, `Extension '${extensionId}' theme '${contribution.path}'`);
}

/** Ignore publisher metadata before the resource owner validates the external document.
 * Includes are each validated there; the merged typed document needs no second schema pass. */
function extensionThemeDocument(value: unknown): unknown {
	if (!isRecord(value)) { throw new TypeError('Invalid color theme: expected an object'); }
	if (Object.hasOwn(value, 'tokenColors')) return value;
	const document = Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(colorThemeSchema.properties!, key)));
	return document;
}

/** Produces the stable Workbench theme identity owned by one manifest contribution. */
export function extensionWorkbenchThemeId(extensionId: string, contributionId: string | undefined, index: number): string {
	// Product themes retain the IDs already persisted in settings; their resources use ordinary contributions.
	if (extensionId === 'vscode.theme-defaults' && contributionId?.startsWith('ash-')) return contributionId;
	const extension = themeIdSegment(extensionId, 'Extension theme extension ID');
	const contribution = themeIdSegment(contributionId ?? String(index + 1), 'Extension theme contribution ID');
	return `extension-${extension}-${contribution}`;
}

/** Compiles supported VS Code color keys over Ash's complete theme defaults. */
export function createExtensionWorkbenchColorTheme(theme: ExtensionThemeDefinition): IColorTheme {
	return createDocumentColorTheme({
		colors: theme.colors,
		semanticHighlighting: theme.semanticHighlighting,
		semanticTokenColors: theme.semanticTokenColors,
	}, theme.id, theme.label, extensionColorScheme(theme.uiTheme));
}

function normalizeTheme(theme: ExtensionThemeDefinition): ExtensionThemeDefinition {
	if (typeof theme !== 'object' || theme === null) throw new TypeError('Extension theme must be an object');
	const uiTheme = theme.uiTheme === undefined ? undefined : boundedText(theme.uiTheme, 'Extension theme UI theme', 128);
	if (uiTheme !== undefined) extensionColorScheme(uiTheme);
	return Object.freeze({
		id: boundedText(theme.id, 'Extension theme ID', 256),
		extensionId: boundedText(theme.extensionId, 'Extension theme extension ID', 256),
		label: boundedText(theme.label, 'Extension theme label', 256),
		...(uiTheme === undefined ? {} : { uiTheme }),
		colors: normalizeColors(theme.colors),
		...(theme.semanticHighlighting === undefined ? {} : { semanticHighlighting: theme.semanticHighlighting }),
		...(theme.semanticTokenColors === undefined ? {} : { semanticTokenColors: normalizeSemanticTokenColors(theme.semanticTokenColors) }),
	});
}

function normalizeSemanticTokenColors(value: NonNullable<ExtensionThemeDefinition['semanticTokenColors']>): NonNullable<ExtensionThemeDefinition['semanticTokenColors']> {
	parseColorThemeDocument({ semanticTokenColors: value });
	parseSemanticTokenRules(value);
	return Object.freeze(Object.fromEntries(Object.entries(value).map(([selector, style]) => [
		selector, typeof style === 'string' ? style : Object.freeze({ ...style }),
	])));
}

function parseColors(value: unknown, owner: string): Readonly<Record<string, string>> {
	const colors = record(value, owner);
	return normalizeColors(Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, colorValue(color, `${owner}.${key}`)])));
}

function normalizeColors(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const colors = record(value, 'Extension theme colors');
	return Object.freeze(Object.fromEntries(Object.entries(colors).map(([key, color]) => [
		boundedText(key, 'Extension theme color key', 256),
		colorValue(color, `Extension theme color '${key}'`),
	])));
}

function colorValue(value: unknown, owner: string): string {
	const color = boundedText(value, owner, 128);
	if (!color.startsWith('#')) throw new TypeError(`${owner} must be a hexadecimal color`);
	Color.fromHex(color);
	return color;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\r\n]/u.test(value)) throw new TypeError(`${owner} is invalid`);
	return value;
}

function extensionColorScheme(uiTheme: string | undefined): ColorScheme {
	switch (uiTheme) {
		case 'vs': return ColorScheme.Light;
		case 'vs-dark': return ColorScheme.Dark;
		case 'hc-black': return ColorScheme.HighContrastDark;
		case 'hc-light': return ColorScheme.HighContrastLight;
		default: throw new TypeError('Selectable extension themes must declare a supported uiTheme');
	}
}

function themeIdSegment(value: string, owner: string): string {
	const normalized = boundedText(value, owner, 256).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
	if (normalized.length === 0) throw new TypeError(`${owner} cannot produce a stable theme ID`);
	return normalized;
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

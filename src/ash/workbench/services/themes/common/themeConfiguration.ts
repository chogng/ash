import { colorThemeSchema } from './colorThemeSchema.js';
import { Colors, validateTokenId } from '../../../../platform/theme/common/colorRegistry.js';
import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, ConfigurationScope, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { JsonSchema } from '../../../../base/common/jsonSchema.js';
import { createColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { defaultWorkbenchColorThemePreference, SystemColorThemePreference, WorkbenchThemesRegistry } from '../../../common/theme.js';
import { WorkbenchFileIconThemesRegistry, WorkbenchProductIconThemesRegistry } from './themeExtensionPoints.js';
import { parseColorThemeDocument, parseSemanticTokenRules } from './colorThemeData.js';
import type { IColorCustomizations } from './workbenchThemeService.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
const defaultFileIconThemeId = 'vs-seti';
const colorSchema: JsonSchema = { type: 'string', pattern: '^(?:default|#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))$' };
const colorMapSchema: JsonSchema = {
	type: 'object',
	get properties() { return Object.fromEntries(Colors.getColors().map(color => [color.id, { ...colorSchema, description: color.description }])); },
	additionalProperties: colorSchema,
};
const groups: Readonly<Record<string, readonly string[]>> = {
	comments: ['comment'], strings: ['string'], numbers: ['constant.numeric'], keywords: ['keyword'],
	types: ['entity.name.type', 'support.type'], functions: ['entity.name.function', 'support.function'], variables: ['variable'],
};

export const ThemeConfigurationSettings = Object.freeze({
	iconTheme: configurationRegistry.registerConfiguration<string>({
		key: 'workbench.iconTheme', scope: ConfigurationScope.WINDOW, schema: { type: ['string', 'null'] },
		defaultValue: defaultFileIconThemeId,
		parse(value: unknown): string {
			if (value === null || value === '') { return ''; }
			if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,256}$/.test(value)) { return value; }
			throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', 'workbench.iconTheme'));
		},
		serialize: value => value === '' ? null : value,
		setting: {
			valueType: 'select', get title() { return localize('theme.fileIcons.title', 'File Icon Theme'); }, get description() { return localize('theme.fileIcons.description', 'Choose file icons contributed by installed extensions.'); },
			get options() {
				return [
					{ value: '', label: localize('theme.none', 'None') },
					{ value: defaultFileIconThemeId, label: 'Seti' },
					...WorkbenchFileIconThemesRegistry.getThemes()
						.filter(theme => theme.id !== defaultFileIconThemeId)
						.map(theme => ({ value: theme.id, label: theme.label })),
				];
			},
		},
	}),
	productIconTheme: configurationRegistry.registerConfiguration<string>({
		key: 'workbench.productIconTheme', scope: ConfigurationScope.WINDOW, schema: { type: 'string' },
		defaultValue: 'default',
		parse(value: unknown): string {
			if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,256}$/u.test(value)) return value;
			throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', 'workbench.productIconTheme'));
		},
		setting: {
			valueType: 'select', get title() { return localize('theme.productIcons.title', 'Product Icon Theme'); }, get description() { return localize('theme.productIcons.description', 'Choose artwork for controls and other product icons.'); },
			get options() { return [{ value: 'default', label: localize('theme.default', 'Default') }, ...WorkbenchProductIconThemesRegistry.getThemes().map(theme => ({ value: theme.id, label: theme.label }))]; },
		},
	}),
	colorCustomizations: configurationRegistry.registerConfiguration<IColorCustomizations>({
		key: 'workbench.colorCustomizations', defaultValue: {}, scope: ConfigurationScope.WINDOW,
		schema: { ...colorMapSchema, get properties() { return colorMapSchema.properties; }, patternProperties: { '^(?:\\[[^\\[\\]]+\\])+$': colorMapSchema } },
		parse: value => parseScopedCustomizations(value, parseColors),
		setting: {
			valueType: 'stringMap', structuredValues: true,
			get title() { return localize('workbench.colorCustomizations.title', 'Color Customizations'); },
			get description() { return localize('workbench.colorCustomizations.description', 'Override theme colors with hex values or default. Type a color name or description, use arrow keys to choose a suggestion, and press Enter to accept. For a theme name in brackets, enter its colors as a JSON object.'); },
			get keyLabel() { return localize('workbench.colorCustomizations.key', 'Theme Color or [Theme Name]'); },
			get valueLabel() { return localize('workbench.colorCustomizations.value', 'Color or JSON Colors'); },
			get addLabel() { return localize('workbench.colorCustomizations.add', 'Add Color'); },
			get removeLabel() { return localize('workbench.colorCustomizations.remove', 'Remove Color'); },
			get incompleteMessage() { return localize('workbench.colorCustomizations.incomplete', 'Enter a color name and value, or a theme name in brackets and a JSON color object.'); },
			get duplicateMessage() { return localize('workbench.colorCustomizations.duplicate', 'Each theme color name must be unique.'); },
		},
	}),
	colorTheme: configurationRegistry.registerConfiguration<string>({
		key: "workbench.colorTheme", scope: ConfigurationScope.WINDOW, schema: { type: 'string' },
		defaultValue: defaultWorkbenchColorThemePreference,
		parse(value: unknown): string {
			if (typeof value !== "string" || !isColorThemePreference(value)) throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', 'workbench.colorTheme'));
			return value;
		},
		setting: {
			valueType: "select",
			get title() { return localize('theme.color.title', 'Color Theme'); },
			get description() { return localize('theme.color.description', 'Choose a theme or follow the system appearance.'); },
			get options() {
				return [
					{ value: SystemColorThemePreference, label: localize('theme.system', 'System') },
					...WorkbenchThemesRegistry.getColorThemes().map(theme => ({ value: theme.id, label: theme.label })),
				];
			},
		},
	}),
	tokenColorCustomizations: registerRuleSetting('editor.tokenColorCustomizations', 'Token Colors', 'Override syntax colors and TextMate rules.', parseTokenColors, tokenCustomizationSchema()),
	semanticTokenColorCustomizations: registerRuleSetting('editor.semanticTokenColorCustomizations', 'Semantic Token Colors', 'Override semantic token colors and styles.', parseSemanticColors, semanticCustomizationSchema()),
	autoDetectColorScheme: registerBoolean('window.autoDetectColorScheme', false, 'Follow System Appearance', 'Select your preferred light or dark theme when the system appearance changes.'),
	autoDetectHighContrast: registerBoolean('window.autoDetectHighContrast', true, 'Follow System High Contrast', 'Select your preferred high contrast theme when the system enables high contrast.'),
	preferredDarkColorTheme: registerPreferred('workbench.preferredDarkColorTheme', 'ash-dark', 'Preferred Dark Theme'),
	preferredLightColorTheme: registerPreferred('workbench.preferredLightColorTheme', 'ash-light', 'Preferred Light Theme'),
	preferredHighContrastColorTheme: registerPreferred('workbench.preferredHighContrastColorTheme', 'ash-high-contrast-dark', 'Preferred High Contrast Dark Theme'),
	preferredHighContrastLightColorTheme: registerPreferred('workbench.preferredHighContrastLightColorTheme', 'ash-high-contrast-light', 'Preferred High Contrast Light Theme'),
});

function registerBoolean(key: string, defaultValue: boolean, title: string, description: string): string {
	return configurationRegistry.registerConfiguration({
		key, defaultValue, scope: ConfigurationScope.APPLICATION, schema: { type: 'boolean' },
		parse(value: unknown): boolean {
			if (typeof value !== 'boolean') { throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', key)); }
			return value;
		}, setting: { valueType: 'boolean', get title() { return localize(`theme.${key}.title`, title); }, get description() { return localize(`theme.${key}.description`, description); } },
	});
}

function registerPreferred(key: string, defaultValue: string, title: string): string {
	return configurationRegistry.registerConfiguration({
		key, defaultValue, scope: ConfigurationScope.WINDOW, schema: { type: 'string' },
		parse(value: unknown): string {
			if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,256}$/u.test(value)) { throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', key)); }
			return value;
		}, setting: {
			valueType: 'select', get title() { return localize(`theme.${key}.title`, title); }, get description() { return localize('theme.preferredDescription', 'Choose the theme used for this system appearance.'); },
			get options() { return WorkbenchThemesRegistry.getColorThemes().map(theme => ({ value: theme.id, label: theme.label })); },
		},
	});
}

function registerRuleSetting(key: string, title: string, description: string, parse: (value: unknown) => Record<string, unknown>, schema: JsonSchema): string {
	return configurationRegistry.registerConfiguration<Record<string, unknown>>({
		key, defaultValue: {}, scope: ConfigurationScope.WINDOW, schema: { ...schema, patternProperties: { '^(?:\\[[^\\[\\]]+\\])+$': schema } },
		parse: value => parseScopedCustomizations(value, parse),
		setting: {
			valueType: 'stringMap', structuredValues: true,
			get title() { return localize(`theme.${key}.title`, title); }, get description() { return localize(`theme.${key}.description`, description); },
			get keyLabel() { return localize('theme.ruleName', 'Rule'); }, get valueLabel() { return localize('theme.ruleValue', 'Color or JSON Style'); },
			get addLabel() { return localize('theme.addRule', 'Add Rule'); }, get removeLabel() { return localize('theme.removeRule', 'Remove Rule'); },
			get incompleteMessage() { return localize('theme.incompleteRule', 'Enter a rule name and value.'); }, get duplicateMessage() { return localize('theme.duplicateRule', 'Each rule name must be unique.'); },
		},
	});
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError(localize('workbench.colorCustomizations.invalidObject', 'Color customizations must be an object.')); }
	return value as Record<string, unknown>;
}

function parseScopedCustomizations<T extends Record<string, unknown>>(value: unknown, parse: (value: unknown) => T): Record<string, T[keyof T] | T> {
	const source = record(value);
	const general: Record<string, unknown> = {};
	const scoped: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(source)) {
		if (key.startsWith('[')) {
			if (!/^(?:\[[^\[\]]+\])+$/u.test(key)) { throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', key)); }
			scoped[key] = parse(entry);
		} else { general[key] = entry; }
	}
	return { ...parse(general), ...scoped } as Record<string, T[keyof T] | T>;
}

function parseColors(value: unknown): Record<string, string> {
	const colors: Record<string, string> = {};
	for (const [id, color] of Object.entries(record(value))) {
		validateTokenId(id, 'color');
		if (typeof color !== 'string' || !/^(?:default|#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8}))$/iu.test(color)) {
			throw new TypeError(localize('workbench.colorCustomizations.invalidColor', 'Invalid theme color or hex value: {0}', id));
		}
		colors[id] = color;
	}
	return colors;
}

function parseTokenColors(value: unknown): Record<string, unknown> {
	const result = record(value);
	for (const [key, entry] of Object.entries(result)) {
		if (key === 'textMateRules') { parseColorThemeDocument({ tokenColors: entry }); }
		else if (key === 'semanticHighlighting') {
			if (typeof entry !== 'boolean') { throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', key)); }
		} else if (groups[key]) { parseColorThemeDocument({ tokenColors: [{ scope: groups[key], settings: typeof entry === 'string' ? { foreground: entry } : entry }] }); }
		else { throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', key)); }
	}
	return { ...result };
}

function parseSemanticColors(value: unknown): Record<string, unknown> {
	const result = record(value);
	for (const [key, entry] of Object.entries(result)) {
		if (key === 'enabled' && typeof entry === 'boolean') { continue; }
		if (key === 'rules') { parseColorThemeDocument({ semanticTokenColors: entry }); parseSemanticTokenRules(entry as Parameters<typeof parseSemanticTokenRules>[0]); }
		else { throw new TypeError(localize('theme.invalidSetting', 'Invalid theme setting: {0}', key)); }
	}
	return { ...result };
}

/** Theme name blocks override global rules in document order; wildcard blocks also match IDs. */
function themeSpecificValues(theme: IColorTheme, value: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) { if (!key.startsWith('[')) { result[key] = entry; } }
	for (const [key, entry] of Object.entries(value)) {
		const names = [...key.matchAll(/\[([^\]]+)\]/gu)].map(match => match[1]!);
		if (names.some(name => {
			const pattern = '^' + name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*') + '$';
			return new RegExp(pattern, 'u').test(theme.label) || new RegExp(pattern, 'u').test(theme.id);
		})) {
			for (const [property, value] of Object.entries(entry as Record<string, unknown>)) {
				if (groups[property] && (typeof value === 'object' || typeof result[property] === 'object')) {
					const previous = typeof result[property] === 'string' ? { foreground: result[property] } : result[property] as Record<string, unknown>;
					const next = typeof value === 'string' ? { foreground: value } : value as Record<string, unknown>;
					result[property] = { ...previous, ...next };
				} else if (Array.isArray(value) && Array.isArray(result[property])) { result[property] = [...result[property] as unknown[], ...value]; }
				else if (value && typeof value === 'object' && result[property] && typeof result[property] === 'object') {
					const previous = result[property] as Record<string, unknown>;
					const merged = { ...previous };
					for (const [name, style] of Object.entries(value)) {
						const original = previous[name];
						if (property === 'rules') {
							const prior = typeof original === 'string' ? { foreground: original } : original as Record<string, unknown>;
							const next = typeof style === 'string' ? { foreground: style } : style as Record<string, unknown>;
							merged[name] = { ...prior, ...next };
						} else { merged[name] = style; }
					}
					result[property] = merged;
				} else { result[property] = value; }
			}
		}
	}
	return result;
}

export function applyThemeCustomizations(theme: IColorTheme, configuration: IConfigurationService): IColorTheme {
	const colors = themeSpecificValues(theme, configuration.getValue(ThemeConfigurationSettings.colorCustomizations));
	const tokens = themeSpecificValues(theme, configuration.getValue(ThemeConfigurationSettings.tokenColorCustomizations));
	const semantic = themeSpecificValues(theme, configuration.getValue(ThemeConfigurationSettings.semanticTokenColorCustomizations));
	if (![colors, tokens, semantic].some(value => Object.keys(value).length)) { return theme; }
	const overrides: Record<string, string> = {};
	const reset: string[] = [];
	for (const [id, value] of Object.entries(colors)) {
		if (value === 'default') { reset.push(id); } else { overrides[id] = value as string; }
	}
	const tokenColors = [...theme.tokenColors ?? []];
	for (const [key, value] of Object.entries(tokens)) {
		if (groups[key]) { tokenColors.push({ scopes: groups[key]!, settings: typeof value === 'string' ? { foreground: value } : value as NonNullable<IColorTheme['tokenColors']>[number]['settings'] }); }
	}
	if (tokens.textMateRules) {
		const document = parseColorThemeDocument({ tokenColors: tokens.textMateRules });
		for (const rule of document.tokenColors as Exclude<typeof document.tokenColors, string | undefined>) {
			tokenColors.push({ scopes: (typeof rule.scope === 'string' ? [rule.scope] : rule.scope ?? []).map(scope => scope.trim()), settings: rule.settings });
		}
	}
	return createColorTheme({
		...theme, baseTheme: theme, colorOverrides: overrides, resetColorOverrides: reset, tokenColors,
		allowUnregisteredColorOverrides: true,
		semanticHighlighting: (semantic.enabled as boolean | undefined) ?? (tokens.semanticHighlighting as boolean | undefined) ?? theme.semanticHighlighting,
		semanticTokenRules: [...theme.semanticTokenRules ?? [], ...parseSemanticTokenRules(semantic.rules as Parameters<typeof parseSemanticTokenRules>[0])],
	});
}

function isColorThemePreference(value: string): boolean {
	return value === SystemColorThemePreference || /^[a-zA-Z0-9._-]{1,256}$/u.test(value);
}

function tokenCustomizationSchema(): JsonSchema {
	const tokenArray = colorThemeSchema.properties!.tokenColors!.anyOf![1]!;
	const style = (tokenArray.items as JsonSchema).properties!.settings!;
	return {
		type: 'object', additionalProperties: false, properties: {
			...Object.fromEntries(Object.keys(groups).map(group => [group, { anyOf: [colorThemeSchema.properties!.colors!.additionalProperties as JsonSchema, style] }])),
			textMateRules: tokenArray,
			semanticHighlighting: { type: 'boolean' },
		}
	};
}

function semanticCustomizationSchema(): JsonSchema {
	return {
		type: 'object', additionalProperties: false, properties: {
			enabled: { type: 'boolean' }, rules: colorThemeSchema.properties!.semanticTokenColors!,
		}
	};
}

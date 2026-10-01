import { WorkbenchFileIconThemesRegistry, WorkbenchProductIconThemesRegistry } from '../services/themes/common/themeExtensionPoints.js';
import { localize } from '../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../platform/configuration/common/configurationRegistry.js";
import { AccessibilityConfiguration } from "../../platform/accessibility/common/accessibility.js";
import { Registry } from "../../platform/registry/common/platform.js";
import { isMacintosh, isWeb } from "../../base/common/platform.js";
import { MenuSettings, TitleBarSetting, parseMenuStyle, parseTitleBarStyle, type MenuStyleConfiguration, type TitleBarStyleConfiguration } from "../../platform/window/common/window.js";
import { WorkbenchModeConfigurationKey, WorkbenchModeRegistry } from "./workbenchMode.js";
import { defaultWorkbenchColorThemePreference, SystemColorThemePreference, WorkbenchThemesRegistry } from "./theme.js";
import { validateTokenId } from '../../platform/theme/common/colorRegistry.js';

export type WorkbenchLayoutStyle = "modern" | "flat";
export const enum ActivityBarPosition {
	DEFAULT = 'default',
	TOP = 'top',
	BOTTOM = 'bottom',
	HIDDEN = 'hidden',
}
export type SideBarLocation = 'left' | 'right';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
const defaultFileIconThemeId = 'vs-seti';

/** Typed configuration keys owned by the workbench layer. */
export const WorkbenchConfiguration = Object.freeze({
	...AccessibilityConfiguration,
	...(!isWeb ? {
		menuStyle: configurationRegistry.registerConfiguration<MenuStyleConfiguration>({
			key: MenuSettings.MenuStyle,
			defaultValue: isMacintosh ? 'system' : 'inherit',
			parse: parseMenuStyle,
			setting: {
				valueType: 'select',
				get title() { return localize('window.menuStyle.title', 'Menu Style'); },
				get description() { return localize('window.menuStyle.description', 'Choose the context menu style. On Windows and Linux, system menus require a system title bar and changes take effect after restart.'); },
				get options() {
					return [
						{ value: 'custom', label: localize('window.menuStyle.custom', 'Custom') },
						{ value: 'system', label: localize('window.menuStyle.system', 'System') },
						{ value: 'inherit', label: localize('window.menuStyle.inherit', 'Follow title bar') },
					] as const;
				},
			},
		}),
		titleBarStyle: configurationRegistry.registerConfiguration<TitleBarStyleConfiguration>({
			key: TitleBarSetting.TitleBarStyle,
			defaultValue: 'custom',
			parse: parseTitleBarStyle,
			setting: {
				valueType: 'select',
				get title() { return localize('window.titleBarStyle.title', 'Title Bar Style'); },
				get description() { return localize('window.titleBarStyle.description', 'Choose the window frame style. Changes take effect after restart. The compact application menu remains in Ash’s command bar.'); },
				get options() {
					return [
						{ value: 'custom', label: localize('window.titleBarStyle.custom', 'Custom') },
						{ value: 'system', label: localize('window.titleBarStyle.system', 'System') },
					] as const;
				},
			},
		}),
	} : {}),
	mode: configurationRegistry.registerConfiguration({
		key: WorkbenchModeConfigurationKey,
		defaultValue: WorkbenchModeRegistry.defaultModeId,
		parse(value: unknown) {
			if (typeof value !== "string") throw new TypeError(`Unknown Workbench mode: ${String(value)}`);
			return WorkbenchModeRegistry.resolveModeId(value);
		},
	}),
	iconTheme: configurationRegistry.registerConfiguration<string>({
		key: 'workbench.iconTheme',
		defaultValue: defaultFileIconThemeId,
		parse(value: unknown): string {
			if (value === null || value === '') { return ''; }
			if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,256}$/.test(value)) { return value; }
			throw new TypeError('Invalid file icon theme ID');
		},
		serialize: value => value === '' ? null : value,
		setting: {
			valueType: 'select', title: 'File icon theme', description: 'Choose the file icons contributed by an installed extension.',
			get options() {
				return [
					{ value: '', label: 'None' },
					{ value: defaultFileIconThemeId, label: 'Seti' },
					...WorkbenchFileIconThemesRegistry.getThemes()
						.filter(theme => theme.id !== defaultFileIconThemeId)
						.map(theme => ({ value: theme.id, label: theme.label })),
				];
			},
		},
	}),
	productIconTheme: configurationRegistry.registerConfiguration<string>({
		key: 'workbench.productIconTheme',
		defaultValue: 'default',
		parse(value: unknown): string {
			if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,256}$/u.test(value)) return value;
			throw new TypeError('Invalid product icon theme ID');
		},
		setting: {
			valueType: 'select', title: 'Product icon theme', description: 'Choose the SVG artwork for controls and other product icons.',
			get options() { return [{ value: 'default', label: 'Default' }, ...WorkbenchProductIconThemesRegistry.getThemes().map(theme => ({ value: theme.id, label: theme.label }))]; },
		},
	}),
	colorCustomizations: configurationRegistry.registerConfiguration<Record<string, string>>({
		key: 'workbench.colorCustomizations',
		defaultValue: {},
		parse(value: unknown): Record<string, string> {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				throw new TypeError(localize('workbench.colorCustomizations.invalidObject', 'Color customizations must be an object.'));
			}
			const colors: Record<string, string> = {};
			for (const [id, color] of Object.entries(value)) {
				try {
					validateTokenId(id, 'color');
				} catch {
					throw new TypeError(localize('workbench.colorCustomizations.invalidColor', 'Invalid theme color or hex value: {0}', id));
				}
				if (typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(color)) {
					throw new TypeError(localize('workbench.colorCustomizations.invalidColor', 'Invalid theme color or hex value: {0}', id));
				}
				colors[id] = color;
			}
			return colors;
		},
		setting: {
			valueType: 'stringMap',
			get title() { return localize('workbench.colorCustomizations.title', 'Color Customizations'); },
			get description() { return localize('workbench.colorCustomizations.description', 'Override colors from the current theme, including editor selections. Use #RGB, #RGBA, #RRGGBB, or #RRGGBBAA.'); },
			get keyLabel() { return localize('workbench.colorCustomizations.key', 'Theme Color'); },
			get valueLabel() { return localize('workbench.colorCustomizations.value', 'Hex Color'); },
			get addLabel() { return localize('workbench.colorCustomizations.add', 'Add Color'); },
			get removeLabel() { return localize('workbench.colorCustomizations.remove', 'Remove Color'); },
			get incompleteMessage() { return localize('workbench.colorCustomizations.incomplete', 'Enter a theme color name and a hex color.'); },
			get duplicateMessage() { return localize('workbench.colorCustomizations.duplicate', 'Each theme color name must be unique.'); },
		},
	}),
	colorTheme: configurationRegistry.registerConfiguration<string>({
		key: "workbench.colorTheme",
		defaultValue: defaultWorkbenchColorThemePreference,
		parse(value: unknown): string {
			if (typeof value !== "string" || !isColorThemePreference(value)) throw new TypeError(`Unknown workbench color theme preference: ${String(value)}`);
			return value;
		},
		setting: {
			valueType: "select",
			title: "Color theme",
			description: "Choose a built-in theme or follow the operating-system appearance.",
			get options() {
				return [
					{ value: SystemColorThemePreference, label: "System" },
					...WorkbenchThemesRegistry.getColorThemes().map(theme => ({ value: theme.id, label: theme.label })),
				];
			},
		},
	}),
	layoutStyle: configurationRegistry.registerConfiguration<WorkbenchLayoutStyle>({
		key: "workbench.layoutStyle",
		defaultValue: "modern",
		parse(value: unknown): WorkbenchLayoutStyle {
			if (value === "modern" || value === "flat") return value;
			throw new TypeError(`Unknown Workbench layout style: ${String(value)}`);
		},
		setting: {
			valueType: "select",
			title: "Layout style",
			description: "Choose floating Modern surfaces or edge-to-edge Flat Workbench regions.",
			options: [
				{ value: "modern", label: "Modern" },
				{ value: "flat", label: "Flat" },
			],
		},
	}),
	activityBarLocation: configurationRegistry.registerConfiguration<ActivityBarPosition>({
		key: 'workbench.activityBar.location',
		defaultValue: ActivityBarPosition.DEFAULT,
		parse(value: unknown): ActivityBarPosition {
			if (value === ActivityBarPosition.DEFAULT) return ActivityBarPosition.DEFAULT;
			if (value === ActivityBarPosition.TOP) return ActivityBarPosition.TOP;
			if (value === ActivityBarPosition.BOTTOM) return ActivityBarPosition.BOTTOM;
			if (value === ActivityBarPosition.HIDDEN) return ActivityBarPosition.HIDDEN;
			throw new TypeError(`Unknown Activity Bar location: ${String(value)}`);
		},
		setting: {
			valueType: 'select',
			get title() { return localize('workbench.activityBar.location.title', 'Activity Bar Position'); },
			get description() { return localize('workbench.activityBar.location.description', 'Choose where the Activity Bar appears.'); },
			get options() {
				return [
					{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
					{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
					{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
					{ value: ActivityBarPosition.HIDDEN, label: localize('workbench.activityBar.location.hidden', 'Hidden') },
				] as const;
			},
		},
	}),
	activityBarCompact: configurationRegistry.registerConfiguration<boolean>({
		key: 'workbench.activityBar.compact',
		defaultValue: false,
		parse(value: unknown): boolean {
			if (typeof value === 'boolean') return value;
			throw new TypeError(`Invalid Activity Bar compact value: ${String(value)}`);
		},
		setting: {
			valueType: 'boolean',
			get title() { return localize('workbench.activityBar.compact.title', 'Compact Activity Bar'); },
			get description() { return localize('workbench.activityBar.compact.description', 'Use smaller Activity Bar items when the bar is on the side.'); },
		},
	}),
	sideBarLocation: configurationRegistry.registerConfiguration<SideBarLocation>({
		key: 'workbench.sideBar.location',
		defaultValue: 'left',
		parse(value: unknown): SideBarLocation {
			if (value === 'left' || value === 'right') return value;
			throw new TypeError(`Unknown primary side bar location: ${String(value)}`);
		},
		setting: {
			valueType: 'select',
			get title() { return localize('workbench.sideBar.location.title', 'Primary Side Bar Position'); },
			get description() { return localize('workbench.sideBar.location.description', 'Choose which side contains the primary side bar.'); },
			get options() {
				return [
					{ value: 'left', label: localize('workbench.sideBar.location.left', 'Left') },
					{ value: 'right', label: localize('workbench.sideBar.location.right', 'Right') },
				] as const;
			},
		},
	}),
});

function isColorThemePreference(value: string): boolean {
	return value === SystemColorThemePreference || WorkbenchThemesRegistry.getColorTheme(value) !== undefined || /^extension-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

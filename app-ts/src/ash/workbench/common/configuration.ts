import { WorkbenchFileIconThemesRegistry, WorkbenchProductIconThemesRegistry } from '../services/themes/common/themeExtensionPoints.js';
import { localize } from '../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../platform/configuration/common/configurationRegistry.js";
import { AccessibilityConfiguration } from "../../platform/accessibility/common/accessibility.js";
import { Registry } from "../../platform/registry/common/platform.js";
import { WorkbenchModeConfigurationKey, WorkbenchModeRegistry } from "./workbenchMode.js";
import { defaultWorkbenchColorThemePreference, SystemColorThemePreference, WorkbenchThemesRegistry } from "./theme.js";

export type WorkbenchLayoutStyle = "modern" | "flat";
export type ActivityBarLocation = 'default' | 'top' | 'bottom' | 'hidden';
export type SideBarLocation = 'left' | 'right';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
const defaultFileIconThemeId = 'vs-seti';

/** Typed configuration keys owned by the workbench layer. */
export const WorkbenchConfiguration = Object.freeze({
	...AccessibilityConfiguration,
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
	activityBarLocation: configurationRegistry.registerConfiguration<ActivityBarLocation>({
		key: 'workbench.activityBar.location',
		defaultValue: 'default',
		parse(value: unknown): ActivityBarLocation {
			if (value === 'default' || value === 'top' || value === 'bottom' || value === 'hidden') return value;
			throw new TypeError(`Unknown Activity Bar location: ${String(value)}`);
		},
		setting: {
			valueType: 'select',
			get title() { return localize('workbench.activityBar.location.title', 'Activity Bar Position'); },
			get description() { return localize('workbench.activityBar.location.description', 'Choose where the Activity Bar appears.'); },
			get options() {
				return [
					{ value: 'default', label: localize('workbench.activityBar.location.side', 'Side') },
					{ value: 'top', label: localize('workbench.activityBar.location.top', 'Top') },
					{ value: 'bottom', label: localize('workbench.activityBar.location.bottom', 'Bottom') },
					{ value: 'hidden', label: localize('workbench.activityBar.location.hidden', 'Hidden') },
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

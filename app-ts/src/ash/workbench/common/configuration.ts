import { WorkbenchFileIconThemesRegistry } from '../services/themes/common/themeExtensionPoints.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../platform/configuration/common/configurationRegistry.js";
import { AccessibilityConfiguration } from "../../platform/accessibility/common/accessibility.js";
import { Registry } from "../../platform/registry/common/platform.js";
import { WorkbenchModeConfigurationKey, WorkbenchModeRegistry } from "./workbenchMode.js";
import { defaultWorkbenchColorThemePreference, SystemColorThemePreference, WorkbenchThemesRegistry } from "./theme.js";

export type WorkbenchLayoutStyle = "modern" | "flat";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

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
		defaultValue: 'vs-seti',
		parse(value: unknown): string {
			if (value === null || value === '') { return ''; }
			if (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,256}$/.test(value)) { return value; }
			throw new TypeError('Invalid file icon theme ID');
		},
		serialize: value => value === '' ? null : value,
		setting: {
			valueType: 'select', title: 'File icon theme', description: 'Choose the file icons contributed by an installed extension.',
			get options() { return [{ value: '', label: 'None' }, ...WorkbenchFileIconThemesRegistry.getThemes().map(theme => ({ value: theme.id, label: theme.label }))]; },
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
});

function isColorThemePreference(value: string): boolean {
	return value === SystemColorThemePreference || WorkbenchThemesRegistry.getColorTheme(value) !== undefined || /^extension-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

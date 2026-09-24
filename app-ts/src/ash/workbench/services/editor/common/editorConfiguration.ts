import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";

export type EditorAutoSaveMode = "off" | "afterDelay" | "onFocusChange" | "onWindowChange";
export type EditorTabsMode = "multiple" | "single" | "none";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const EditorTabsModeConfiguration = configurationRegistry.registerConfiguration<EditorTabsMode>({
	key: "workbench.editor.showTabs",
	defaultValue: "multiple",
	parse: value => value === "single" || value === "none" ? value : "multiple",
	setting: {
		title: "Workbench › Editor: Show Tabs",
		description: "Controls whether editor groups show all tabs, only the active tab, or no tabs.",
		valueType: "select",
		options: [
			{ value: "multiple", label: "Multiple" },
			{ value: "single", label: "Single" },
			{ value: "none", label: "None" },
		],
	},
});

export const EditorBreadcrumbsEnabledConfiguration = configurationRegistry.registerConfiguration<boolean>({
	key: "breadcrumbs.enabled",
	defaultValue: true,
	parse: value => typeof value === "boolean" ? value : true,
	setting: {
		title: "Breadcrumbs: Enabled",
		description: "Shows the active editor resource path below the editor title.",
		valueType: "boolean",
	},
});

export const EditorAutoSaveConfiguration = configurationRegistry.registerConfiguration<EditorAutoSaveMode>({
	key: "files.autoSave",
	defaultValue: "off",
	parse: value => value === "afterDelay" || value === "onFocusChange" || value === "onWindowChange" ? value : "off",
	setting: {
		title: "Files: Auto Save",
		description: "Controls when editors with unsaved changes are saved automatically.",
		valueType: "select",
		options: [
			{ value: "off", label: "Off" },
			{ value: "afterDelay", label: "After Delay" },
			{ value: "onFocusChange", label: "On Focus Change" },
			{ value: "onWindowChange", label: "On Window Change" },
		],
	},
});

export const EditorAutoSaveDelayConfiguration = configurationRegistry.registerConfiguration<number>({
	key: "files.autoSaveDelay",
	defaultValue: 1_000,
	parse: value => typeof value === "number" && Number.isFinite(value) ? Math.min(60_000, Math.max(100, Math.round(value))) : 1_000,
	setting: {
		title: "Files: Auto Save Delay",
		description: "Delay in milliseconds before a dirty editor is automatically saved.",
		valueType: "number",
		minimum: 100,
		maximum: 60_000,
	},
});

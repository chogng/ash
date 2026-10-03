import { localize } from "../../../../nls.js";
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { EditorLineWrapping } from "../../../../editor/common/config/editorOptions.js";
import type { IDocumentDiffProviderOptions } from "../../../../editor/common/diff/documentDiffProvider.js";

export type EditorAutoSaveMode = "off" | "afterDelay" | "onFocusChange" | "onWindowChange";
export type EditorTabsMode = "multiple" | "single" | "none";
export type EditorTitleScrollbarSizing = 'default' | 'large';
export type EditorTitleScrollbarVisibility = 'auto' | 'visible' | 'hidden';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const EditorTitleScrollbarSizingConfiguration = configurationRegistry.registerConfiguration<EditorTitleScrollbarSizing>({
	key: 'workbench.editor.titleScrollbarSizing',
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: ['default', 'large'] },
	defaultValue: 'default',
	parse: value => value === 'large' ? 'large' : 'default',
	setting: {
		get title() { return localize('workbench.editor.titleScrollbarSizing.title', 'Workbench › Editor: Title Scrollbar Sizing'); },
		get description() { return localize('workbench.editor.titleScrollbarSizing.description', 'Controls the size of the scrollbars for editor tabs and breadcrumbs.'); },
		valueType: 'select',
		get options() { return [
			{ value: 'default' as const, label: localize('workbench.editor.titleScrollbarSizing.default', 'Default') },
			{ value: 'large' as const, label: localize('workbench.editor.titleScrollbarSizing.large', 'Large') },
		]; },
	},
});

export const EditorTitleScrollbarVisibilityConfiguration = configurationRegistry.registerConfiguration<EditorTitleScrollbarVisibility>({
	key: 'workbench.editor.titleScrollbarVisibility',
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: ['auto', 'visible', 'hidden'] },
	defaultValue: 'auto',
	parse: value => value === 'visible' || value === 'hidden' ? value : 'auto',
	setting: {
		get title() { return localize('workbench.editor.titleScrollbarVisibility.title', 'Workbench › Editor: Title Scrollbar Visibility'); },
		get description() { return localize('workbench.editor.titleScrollbarVisibility.description', 'Controls when scrollbars for editor tabs and breadcrumbs are visible.'); },
		valueType: 'select',
		get options() { return [
			{ value: 'auto' as const, label: localize('workbench.editor.titleScrollbarVisibility.auto', 'Auto') },
			{ value: 'visible' as const, label: localize('workbench.editor.titleScrollbarVisibility.visible', 'Visible') },
			{ value: 'hidden' as const, label: localize('workbench.editor.titleScrollbarVisibility.hidden', 'Hidden') },
		]; },
	},
});

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

export const EditorShowIconsConfiguration = configurationRegistry.registerConfiguration<boolean>({
	key: "workbench.editor.showIcons",
	defaultValue: true,
	parse: value => typeof value === "boolean" ? value : true,
	setting: {
		get title() { return localize('workbench.editor.showIcons.title', 'Workbench › Editor: Show Icons'); },
		get description() { return localize('workbench.editor.showIcons.description', 'Show file icons in editor tabs.'); },
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

/** Reads computation settings shared by single-file and multi-file diff panes. */
export function getDiffComputationOptions(configuration: IConfigurationService, languageId: string): IDocumentDiffProviderOptions {
	return {
		ignoreTrimWhitespace: configuration.getValue<boolean>("diffEditor.ignoreTrimWhitespace", { overrideIdentifier: languageId }),
		maxComputationTimeMs: configuration.getValue<number>("diffEditor.maxComputationTime", { overrideIdentifier: languageId }),
		computeMoves: configuration.getValue<boolean>('diffEditor.experimental.showMoves'),
	};
}

export function getDiffWordWrap(configuration: IConfigurationService): boolean {
	const value = configuration.getValue<"off" | "on" | "inherit">("diffEditor.wordWrap");
	return value === "on" || (value === "inherit" && configuration.getValue<EditorLineWrapping>("editor.wordWrap") === EditorLineWrapping.On);
}

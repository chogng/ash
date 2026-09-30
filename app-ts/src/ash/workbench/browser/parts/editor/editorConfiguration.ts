import { Disposable } from "../../../../base/common/lifecycle.js";
import { match as globMatch } from "../../../../base/common/glob.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { localize } from "../../../../nls.js";
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import { EditorPanes, type EditorPaneRegistry } from "./editorRegistry.js";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
const binaryEditorOptions: { value: string; label: string }[] = [{ value: "", get label() { return localize("workbench.editor.defaultBinaryEditor.default", "Default"); } }];

export const EditorOpenErrorDialogConfiguration = configurationRegistry.registerConfiguration<boolean>({
	key: "workbench.editor.openErrorDialog",
	defaultValue: true,
	parse(value): boolean {
		if (typeof value !== "boolean") throw new TypeError(localize("workbench.editor.openErrorDialog.invalid", "File Open Error Dialog must be true or false."));
		return value;
	},
	setting: {
		get title() { return localize("workbench.editor.openErrorDialog.title", "File Open Error Dialog"); },
		get description() { return localize("workbench.editor.openErrorDialog.description", "Show a dialog for opening errors that support one when you open a file. Errors also appear in the editor. Files restored automatically do not show error dialogs."); },
		valueType: "boolean",
		keywords: ["file", "open", "error", "dialog"],
	},
});

export const DefaultBinaryEditorConfiguration = configurationRegistry.registerConfiguration<string>({
	key: "workbench.editor.defaultBinaryEditor",
	defaultValue: "",
	parse: value => typeof value === "string" ? value : "",
	setting: {
		get title() { return localize("workbench.editor.defaultBinaryEditor.title", "Default Binary Editor"); },
		get description() { return localize("workbench.editor.defaultBinaryEditor.description", "Choose the editor offered when a file cannot be displayed as text because it contains binary content or uses an unsupported encoding."); },
		keywords: ["file", "open", "binary", "encoding"],
		valueType: "select",
		options: binaryEditorOptions,
	},
});

export type EditorAssociations = Readonly<Record<string, string>>;

export const EditorAssociationsConfiguration = configurationRegistry.registerConfiguration<EditorAssociations>({
	key: "workbench.editorAssociations",
	defaultValue: {},
	parse: parseEditorAssociations,
});

export const DiffEditorAssociationsConfiguration = configurationRegistry.registerConfiguration<EditorAssociations>({
	key: "workbench.diffEditorAssociations",
	defaultValue: {},
	parse: parseEditorAssociations,
});

export type AutoLockGroups = Readonly<Record<string, boolean>>;

export const AutoLockGroupsConfiguration = configurationRegistry.registerConfiguration<AutoLockGroups>({
	key: "workbench.editor.autoLockGroups",
	defaultValue: {},
	parse(value): AutoLockGroups {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Auto lock groups must map editor IDs to booleans");
		const result: Record<string, boolean> = {};
		for (const [editorId, enabled] of Object.entries(value)) {
			if (!editorId || typeof enabled !== "boolean") throw new TypeError("Auto lock groups require editor IDs and boolean values");
			result[editorId] = enabled;
		}
		return result;
	},
});

export const EditorLargeFileConfirmationConfiguration = configurationRegistry.registerConfiguration<number>({
	key: "workbench.editorLargeFileConfirmation",
	defaultValue: 1024,
	parse(value): number {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new TypeError("Large file confirmation must be at least one MiB");
		return value;
	},
	setting: {
		get title() { return localize("workbench.editorLargeFileConfirmation.title", "Large File Confirmation (MiB)"); },
		get description() { return localize("workbench.editorLargeFileConfirmation.description", "Ask before opening a file at or above this size in MiB."); },
		keywords: ["file", "open", "large", "size"],
		valueType: "number",
		minimum: 1,
		maximum: Number.MAX_SAFE_INTEGER,
	},
});

function parseEditorAssociations(value: unknown): EditorAssociations {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Editor associations must map file patterns to editor IDs");
	const result: Record<string, string> = {};
	for (const [pattern, editorId] of Object.entries(value)) {
		if (!pattern || typeof editorId !== "string" || !editorId) throw new TypeError("Editor associations require non-empty patterns and editor IDs");
		result[pattern] = editorId;
	}
	return result;
}

/** Keeps the binary-editor setting in sync with available pane registrations. */
export class DynamicEditorConfigurations extends Disposable implements IWorkbenchContribution {
	static readonly ID = "workbench.contrib.dynamicEditorConfigurations";

	constructor(registry: EditorPaneRegistry = EditorPanes) {
		super();
		this._register(registry.onDidChange(() => this.update(registry)));
		this.update(registry);
	}

	private update(registry: EditorPaneRegistry): void {
		binaryEditorOptions.splice(1, binaryEditorOptions.length - 1, ...registry.getAll().map(descriptor => ({
			value: descriptor.id,
			label: descriptor.name,
		})));
	}
}

/** Last matching association wins, so a narrow pattern can override a broad one. */
export function associatedEditorId(path: string, associations: EditorAssociations): string | undefined {
	let matched: string | undefined;
	const normalized = path.replaceAll("\\", "/");
	const name = normalized.slice(normalized.lastIndexOf("/") + 1);
	for (const [pattern, editorId] of Object.entries(associations)) {
		if (globMatch(pattern.toLowerCase(), (pattern.includes("/") ? normalized : name).toLowerCase())) matched = editorId;
	}
	return matched;
}

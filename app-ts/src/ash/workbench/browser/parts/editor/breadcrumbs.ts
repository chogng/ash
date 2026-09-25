import { toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import type { EditorGroupId } from "../../../services/editor/common/editorState.js";
import type { EditorBreadcrumbsControl } from "./breadcrumbsControl.js";

export interface IBreadcrumbsService {
	register(group: EditorGroupId, control: EditorBreadcrumbsControl): IDisposable;
	getWidget(group: EditorGroupId): EditorBreadcrumbsControl | undefined;
}

export const IBreadcrumbsService = createServiceIdentifier<IBreadcrumbsService>("editorBreadcrumbsService");

/** Keeps the visible breadcrumb control associated with its editor group. */
export class BreadcrumbsService implements IBreadcrumbsService {
	private readonly controls = new Map<EditorGroupId, EditorBreadcrumbsControl>();

	register(group: EditorGroupId, control: EditorBreadcrumbsControl): IDisposable {
		if (this.controls.has(group)) throw new Error(`Breadcrumbs are already registered for editor group ${group}`);
		this.controls.set(group, control);
		return toDisposable(() => {
			if (this.controls.get(group) === control) this.controls.delete(group);
		});
	}

	getWidget(group: EditorGroupId): EditorBreadcrumbsControl | undefined {
		return this.controls.get(group);
	}
}

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const BreadcrumbsEnabledConfiguration = configurationRegistry.registerConfiguration<boolean>({
	key: "breadcrumbs.enabled",
	defaultValue: true,
	parse: value => typeof value === "boolean" ? value : true,
	setting: {
		title: "Breadcrumbs: Enabled",
		description: "Shows the active editor resource path below the editor title.",
		valueType: "boolean",
	},
});

export type BreadcrumbsPathMode = "on" | "off" | "last";

function parsePathMode(value: unknown): BreadcrumbsPathMode {
	if (value === "on" || value === "off" || value === "last") return value;
	throw new TypeError("Breadcrumb path mode must be on, off, or last");
}

export const BreadcrumbsFilePathConfiguration = configurationRegistry.registerConfiguration<BreadcrumbsPathMode>({
	key: "breadcrumbs.filePath",
	defaultValue: "on",
	parse: parsePathMode,
	setting: {
		title: "Breadcrumbs: File Path",
		description: "Choose how much of the file path appears in editor breadcrumbs.",
		valueType: "select",
		options: [
			{ value: "on", label: "Full Path" },
			{ value: "last", label: "File Only" },
			{ value: "off", label: "Hidden" },
		],
	},
});

export const BreadcrumbsSymbolPathConfiguration = configurationRegistry.registerConfiguration<BreadcrumbsPathMode>({
	key: "breadcrumbs.symbolPath",
	defaultValue: "on",
	parse: parsePathMode,
	setting: {
		title: "Breadcrumbs: Symbol Path",
		description: "Choose how much of the current symbol path appears in editor breadcrumbs.",
		valueType: "select",
		options: [
			{ value: "on", label: "Full Path" },
			{ value: "last", label: "Current Symbol Only" },
			{ value: "off", label: "Hidden" },
		],
	},
});

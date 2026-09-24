import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../platform/registry/common/platform.js";

export type DefaultNewDocumentEditor = "buildMode" | "code" | "academic";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Workbench-level editor selection preferences applied before a resource has a durable type. */
export const EditorSelectionConfiguration = Object.freeze({
	defaultNewDocumentEditor: configurationRegistry.registerConfiguration<DefaultNewDocumentEditor>({
		key: "workbench.editor.defaultNewDocumentEditor",
		defaultValue: "buildMode",
		parse(value: unknown): DefaultNewDocumentEditor {
			if (value === "profile") return "buildMode";
			if (value === "buildMode" || value === "code" || value === "academic") return value;
			throw new TypeError(`workbench.editor.defaultNewDocumentEditor must be buildMode, code, or academic; received ${String(value)}`);
		},
		setting: {
			valueType: "select",
			title: "Default editor for new documents",
			description: "Follow the active build mode, or explicitly prefer the Code or Academic editor for new untitled documents.",
			options: [
				{ value: "buildMode", label: "Default" },
				{ value: "code", label: "Code" },
				{ value: "academic", label: "Academic" },
			],
		},
	}),
});

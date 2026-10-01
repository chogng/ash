import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../configuration/common/configurationRegistry.js";
import { Registry } from "../../registry/common/platform.js";
import { localize } from "../../../nls.js";

export type ListOpenMode = "doubleClick" | "singleClick";
export type TreeExpandMode = "doubleClick" | "singleClick";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Typed configuration keys owned by Platform List. */
export const ListConfiguration = Object.freeze({
	treeIndent: configurationRegistry.registerConfiguration<number>({
		key: "workbench.tree.indent",
		defaultValue: 8,
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'number', minimum: 4, maximum: 40 },
		parse(value: unknown): number {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 4 || value > 40) throw new TypeError(localize('list.treeIndentInvalid', 'Tree indent must be between 4 and 40 pixels'));
			return value;
		},
		setting: {
			valueType: 'number',
			get title() { return localize('list.treeIndentTitle', 'Tree indentation'); },
			get description() { return localize('list.treeIndentDescription', 'Controls tree indentation in pixels.'); },
			minimum: 4,
			maximum: 40,
		},
	}),
	treeRenderIndentGuides: configurationRegistry.registerConfiguration<"none" | "onHover" | "always">({
		key: "workbench.tree.renderIndentGuides",
		defaultValue: "onHover",
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'string', enum: ['none', 'onHover', 'always'] },
		parse(value: unknown): "none" | "onHover" | "always" {
			if (value !== "none" && value !== "onHover" && value !== "always") throw new TypeError(localize('list.treeGuidesInvalid', 'Unknown tree indent guide mode: {0}', String(value)));
			return value;
		},
		setting: {
			valueType: 'select',
			get title() { return localize('list.treeGuidesTitle', 'Tree indent guides'); },
			get description() { return localize('list.treeGuidesDescription', 'Controls when tree indent guides are visible.'); },
			get options() {
				return [
					{ value: 'none', label: localize('list.treeGuidesNone', 'None') },
					{ value: 'onHover', label: localize('list.treeGuidesOnHover', 'On hover') },
					{ value: 'always', label: localize('list.treeGuidesAlways', 'Always') },
				] as const;
			},
		},
	}),
	openMode: configurationRegistry.registerConfiguration<ListOpenMode>({
		key: "workbench.list.openMode",
		defaultValue: "singleClick",
		parse(value: unknown): ListOpenMode {
			if (value !== "singleClick" && value !== "doubleClick") throw new TypeError(`Unknown list open mode: ${String(value)}`);
			return value;
		},
	}),
	treeExpandMode: configurationRegistry.registerConfiguration<TreeExpandMode>({
		key: "workbench.tree.expandMode",
		defaultValue: "singleClick",
		parse(value: unknown): TreeExpandMode {
			if (value !== "singleClick" && value !== "doubleClick") throw new TypeError(`Unknown tree expand mode: ${String(value)}`);
			return value;
		},
	}),
});

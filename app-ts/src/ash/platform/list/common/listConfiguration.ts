import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../configuration/common/configurationRegistry.js";
import { Registry } from "../../registry/common/platform.js";

export type ListOpenMode = "doubleClick" | "singleClick";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Typed configuration keys owned by Platform List. */
export const ListConfiguration = Object.freeze({
	openMode: configurationRegistry.registerConfiguration<ListOpenMode>({
		key: "workbench.list.openMode",
		defaultValue: "singleClick",
		parse(value: unknown): ListOpenMode {
			if (value !== "singleClick" && value !== "doubleClick") throw new TypeError(`Unknown list open mode: ${String(value)}`);
			return value;
		},
	}),
});

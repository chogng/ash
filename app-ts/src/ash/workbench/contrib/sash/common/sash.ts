import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";

export const MinimumSashSize = 1;
export const MaximumSashSize = 20;
export const MinimumSashHoverDelay = 0;
export const MaximumSashHoverDelay = 2_000;

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Typed configuration keys owned by the Workbench Sash contribution. */
export const SashConfiguration = Object.freeze({
	size: configurationRegistry.registerConfiguration<number>({
		key: "workbench.sash.size",
		defaultValue: 4,
		parse: (value) => parseNumberInRange(
			value,
			"workbench.sash.size",
			MinimumSashSize,
			MaximumSashSize,
		),
		setting: {
			valueType: "number",
			title: "Resize handle size",
			description: "Width in pixels of Workbench resize handles.",
			minimum: MinimumSashSize,
			maximum: MaximumSashSize,
		},
	}),
	hoverDelay: configurationRegistry.registerConfiguration<number>({
		key: "workbench.sash.hoverDelay",
		defaultValue: 300,
		parse: (value) => parseNumberInRange(
			value,
			"workbench.sash.hoverDelay",
			MinimumSashHoverDelay,
			MaximumSashHoverDelay,
		),
		setting: {
			valueType: "number",
			title: "Resize handle hover delay",
			description: "Milliseconds before resize handles show hover feedback.",
			minimum: MinimumSashHoverDelay,
			maximum: MaximumSashHoverDelay,
		},
	}),
});

function parseNumberInRange(
	value: unknown,
	key: string,
	minimum: number,
	maximum: number,
): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < minimum ||
		value > maximum
	) {
		throw new RangeError(
			`${key} must be a finite number between ${minimum} and ${maximum}`,
		);
	}
	return value;
}

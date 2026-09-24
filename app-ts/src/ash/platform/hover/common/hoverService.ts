import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../configuration/common/configurationRegistry.js";
import { Registry } from "../../registry/common/platform.js";

export const MinimumHoverDelay = 0;
export const MaximumHoverDelay = 2_000;

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Typed configuration keys owned by the Workbench Hover service. */
export const HoverConfiguration = Object.freeze({
	delay: configurationRegistry.registerConfiguration<number>({
		key: "workbench.hover.delay",
		defaultValue: 500,
		parse: (value) => parseHoverDelay(value, "workbench.hover.delay"),
		setting: {
			valueType: "number",
			title: "Hover delay",
			description: "Milliseconds before standard managed hovers appear.",
			minimum: MinimumHoverDelay,
			maximum: MaximumHoverDelay,
		},
	}),
	reducedDelay: configurationRegistry.registerConfiguration<number>({
		key: "workbench.hover.reducedDelay",
		defaultValue: 30,
		parse: (value) => parseHoverDelay(
			value,
			"workbench.hover.reducedDelay",
		),
		setting: {
			valueType: "number",
			title: "Fast hover delay",
			description: "Milliseconds used for controls that request reduced-delay hover feedback.",
			minimum: MinimumHoverDelay,
			maximum: MaximumHoverDelay,
		},
	}),
});

/** Selects the Workbench policy used before an automatic Hover is shown. */
export type HoverDelayMode = "standard" | "reduced" | "instant";

function parseHoverDelay(value: unknown, key: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < MinimumHoverDelay ||
		value > MaximumHoverDelay
	) {
		throw new RangeError(
			`${key} must be a finite number between ${MinimumHoverDelay} and ${MaximumHoverDelay}`,
		);
	}
	return value;
}

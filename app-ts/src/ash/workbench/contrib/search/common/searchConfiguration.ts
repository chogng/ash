import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Typed defaults owned by the Workbench content-search surface. */
export const ContentSearchConfiguration = Object.freeze({
	matchCase: configurationRegistry.registerConfiguration<boolean>({
		key: "search.matchCase",
		defaultValue: false,
		parse: value => parseBoolean(value, "search.matchCase"),
		setting: booleanSetting("Match case", "Start workspace searches in case-sensitive mode."),
	}),
	smartCase: configurationRegistry.registerConfiguration<boolean>({
		key: "search.smartCase",
		defaultValue: true,
		parse: value => parseBoolean(value, "search.smartCase"),
		setting: booleanSetting("Smart case", "Use case-sensitive matching automatically when the query contains uppercase characters."),
	}),
	regularExpression: configurationRegistry.registerConfiguration<boolean>({
		key: "search.useRegularExpression",
		defaultValue: false,
		parse: value => parseBoolean(value, "search.useRegularExpression"),
		setting: booleanSetting("Use regular expressions", "Interpret workspace search queries as regular expressions by default."),
	}),
	includePatterns: configurationRegistry.registerConfiguration<string>({
		key: "search.includePatterns",
		defaultValue: "",
		parse: value => parsePatternList(value, "search.includePatterns"),
		setting: textSetting("Files to include", "Comma-separated glob patterns included in new workspace searches.", "src/**, packages/**"),
	}),
	excludePatterns: configurationRegistry.registerConfiguration<string>({
		key: "search.excludePatterns",
		defaultValue: "",
		parse: value => parsePatternList(value, "search.excludePatterns"),
		setting: textSetting("Files to exclude", "Comma-separated glob patterns excluded from new workspace searches.", "**/node_modules/**, **/dist/**"),
	}),
	maxResults: configurationRegistry.registerConfiguration<number>({
		key: "search.maxResults",
		defaultValue: 2_000,
		parse(value: unknown): number {
			if (Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= 5_000) return value as number;
			throw new RangeError(`search.maxResults must be an integer between 100 and 5000; received ${String(value)}`);
		},
		setting: {
			valueType: "number",
			title: "Maximum results",
			description: "Stop a workspace search after this many matches.",
			minimum: 100,
			maximum: 5_000,
		},
	}),
});

function booleanSetting(title: string, description: string) {
	return { valueType: "boolean", title, description } as const;
}

function textSetting(title: string, description: string, placeholder: string) {
	return { valueType: "text", title, description, placeholder } as const;
}

function parseBoolean(value: unknown, key: string): boolean {
	if (typeof value === "boolean") return value;
	throw new TypeError(`${key} must be a boolean; received ${String(value)}`);
}

function parsePatternList(value: unknown, key: string): string {
	if (typeof value === "string" && value.length <= 4_096 && !/[\r\n\0]/u.test(value)) return value;
	throw new TypeError(`${key} must be a single-line string no longer than 4096 characters`);
}

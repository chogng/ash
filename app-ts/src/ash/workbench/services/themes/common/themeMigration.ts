import { serializeUserColorThemeDraft } from "./colorThemeData.js";
import { type ColorValue } from "../../../../platform/theme/common/colorRegistry.js";
import { createColorTheme } from "../../../../platform/theme/common/colorTheme.js";
import type { IColorTheme } from "../../../../platform/theme/common/themeService.js";
import { ColorScheme } from "../../../../platform/theme/common/theme.js";

const USER_COLOR_THEME_SCHEMA_URL = "https://ash.dev/schemas/color-theme.schema.json";

const LEGACY_EDITOR_TOKEN_PREFIX = "editor.semanticToken.";
const EDITOR_TOKEN_PREFIX = "editor.token.";

interface IUserColorThemeDocument {
	readonly version: 1;
	readonly id: string;
	readonly label: string;
	readonly colorScheme: ColorScheme;
	readonly colors: Readonly<Record<string, ColorValue>>;
}

/** Parses untrusted JSON and compiles it through the canonical theme resolver. */
function parseLegacyTheme(source: string): IColorTheme {
	if (source.length > 1_048_576) throw new Error("User theme exceeds the 1 MiB document limit");
	let candidate: unknown;
	try {
		candidate = JSON.parse(source);
	} catch (error) {
		throw new Error("User theme is not valid JSON", { cause: error });
	}
	const document = validateUserColorThemeDocument(candidate);
	return createColorTheme({
		id: document.id,
		label: document.label,
		colorScheme: document.colorScheme,
		colorOverrides: normalizeLegacyEditorTokenOverrides(document.colors),
	});
}

function normalizeLegacyEditorTokenOverrides(colors: Readonly<Record<string, ColorValue>>): Readonly<Record<string, ColorValue>> {
	const normalized: Record<string, ColorValue> = { ...colors };
	for (const [id, value] of Object.entries(colors)) {
		if (!id.startsWith(LEGACY_EDITOR_TOKEN_PREFIX)) continue;
		const replacement = `${EDITOR_TOKEN_PREFIX}${id.slice(LEGACY_EDITOR_TOKEN_PREFIX.length)}`;
		if (!Object.hasOwn(normalized, replacement)) normalized[replacement] = value;
	}
	return normalized;
}

function validateUserColorThemeDocument(value: unknown): IUserColorThemeDocument {
	const document = exactRecord(value, ["$schema", "colorScheme", "colors", "id", "label", "version"]);
	if (document.version !== 1) throw new Error("User theme version must be 1");
	if (document.$schema !== undefined && document.$schema !== USER_COLOR_THEME_SCHEMA_URL) throw new Error(`User theme $schema must be '${USER_COLOR_THEME_SCHEMA_URL}'`);
	if (typeof document.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.id)) throw new Error("User theme id must be lowercase kebab-case");
	if (typeof document.label !== "string" || document.label.trim() !== document.label || document.label.length < 1 || document.label.length > 80) throw new Error("User theme label must contain 1 to 80 trimmed characters");
	if (!Object.values(ColorScheme).includes(document.colorScheme as ColorScheme)) throw new Error(`Unknown user theme colorScheme: ${String(document.colorScheme)}`);
	const colors = record(document.colors, "colors");
	const entries = Object.entries(colors);
	if (entries.length > 512) throw new Error("User theme contains more than 512 color overrides");
	const overrides: Record<string, ColorValue> = {};
	for (const [id, color] of entries) {
		if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(id)) throw new Error(`Invalid user theme color token ID: ${id}`);
		overrides[id] = validateJsonColorValue(color, `colors.${id}`, 0);
	}
	return Object.freeze({
		version: 1,
		id: document.id,
		label: document.label,
		colorScheme: document.colorScheme as ColorScheme,
		colors: Object.freeze(overrides),
	});
}

function validateJsonColorValue(value: unknown, path: string, depth: number): ColorValue {
	if (depth > 8) throw new Error(`${path} exceeds the maximum transform depth`);
	if (typeof value === "string") {
		if (value.length > 128) throw new Error(`${path} is too long`);
		return value;
	}
	const transform = exactRecord(value, ["background", "factor", "op", "other", "value"]);
	if (typeof transform.op !== "string") throw new Error(`${path}.op must be a string`);
	const source = validateJsonColorValue(transform.value, `${path}.value`, depth + 1);
	switch (transform.op) {
		case "transparent":
		case "lighten":
		case "darken":
			requireExactKeys(transform, ["factor", "op", "value"], path);
			return Object.freeze({ op: transform.op, value: source, factor: factor(transform.factor, `${path}.factor`) });
		case "mix":
			requireExactKeys(transform, ["factor", "op", "other", "value"], path);
			return Object.freeze({ op: "mix", value: source, other: validateJsonColorValue(transform.other, `${path}.other`, depth + 1), factor: factor(transform.factor, `${path}.factor`) });
		case "opaque":
			requireExactKeys(transform, ["background", "op", "value"], path);
			return Object.freeze({ op: "opaque", value: source, background: validateJsonColorValue(transform.background, `${path}.background`, depth + 1) });
		default:
			throw new Error(`${path}.op is not a supported color transform`);
	}
}

function factor(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${path} must be a finite number between 0 and 1`);
	return value;
}

function exactRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
	const result = record(value, "value");
	const allowed = new Set(allowedKeys);
	const unknown = Object.keys(result).filter((key) => !allowed.has(key));
	if (unknown.length > 0) throw new Error(`Object contains unknown fields: ${unknown.join(", ")}`);
	return result;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
	const actual = Object.keys(value).filter((key) => value[key] !== undefined).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${path} has invalid fields for '${String(value.op)}'`);
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

/** One-way conversion of the retired version-1 resource, before normal loading. */
export function migrateUserTheme(source: string): { readonly id: string; readonly content: string } | undefined {
	let value: unknown;
	try { value = JSON.parse(source); } catch { return undefined; }
	if (typeof value !== "object" || value === null || !("version" in value)) return undefined;
	const theme = parseLegacyTheme(source);
	return { id: theme.id, content: serializeUserColorThemeDraft(theme, theme.label) };
}

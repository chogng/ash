import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { escapeRegExpCharacters } from "../../../../base/common/strings.js";
import { defaultTextMateScopeResolver, type TextMateResolvedTokenStyle, type TextMateScopeResolver } from "./textMateScopeResolver.js";

/** A transferable semantic presentation rule matched against one TextMate scope selector. */
export interface TextMateScopeThemeRule {
	readonly selector: string;
	readonly tokenType?: string;
	readonly modifiers?: readonly string[];
	readonly foreground?: string;
	readonly background?: string;
	readonly fontStyle?: readonly TextMateTokenFontStyle[];
}

export type TextMateTokenFontStyle = "italic" | "bold" | "underline" | "strikethrough";

/** Immutable, revisioned theme data that can safely cross the Renderer/Worker boundary. */
export interface TextMateScopeTheme {
	readonly revision: number;
	readonly rules: readonly TextMateScopeThemeRule[];
}

/** Provides the current TextMate scope theme and reports whole-theme replacement. */
export interface TextMateScopeThemeSource {
	readonly currentTheme: TextMateScopeTheme;
	readonly onDidChangeTheme: Event<TextMateScopeTheme>;
}

export const EMPTY_TEXTMATE_SCOPE_THEME: TextMateScopeTheme = Object.freeze({
	revision: 0,
	rules: Object.freeze([]),
});

/** Owns revisioned, serializable TextMate scope-theme contributions. */
export class TextMateScopeThemeModel extends Disposable implements TextMateScopeThemeSource {
	private readonly changeEmitter = this._register(new Emitter<TextMateScopeTheme>());
	private theme: TextMateScopeTheme;
	private resolver: TextMateScopeResolver;

	readonly onDidChangeTheme: Event<TextMateScopeTheme> = this.changeEmitter.event;

	constructor(initialTheme: TextMateScopeTheme = EMPTY_TEXTMATE_SCOPE_THEME) {
		super();
		this.theme = normalizeTextMateScopeTheme(initialTheme);
		this.resolver = createTextMateScopeThemeResolver(this.theme);
	}

	get currentTheme(): TextMateScopeTheme {
		this.assertNotDisposed();
		return this.theme;
	}

	replace(theme: TextMateScopeTheme): void {
		this.assertNotDisposed();
		const normalized = normalizeTextMateScopeTheme(theme);
		if (normalized.revision <= this.theme.revision) {
			throw new RangeError("TextMate scope theme revision must increase");
		}
		this.theme = normalized;
		this.resolver = createTextMateScopeThemeResolver(normalized);
		this.changeEmitter.fire(normalized);
	}

	/** Resolves current rules first and preserves the stable fallback vocabulary. */
	resolve(scopes: readonly string[]): TextMateResolvedTokenStyle | undefined {
		this.assertNotDisposed();
		return this.resolver(scopes);
	}

}

/** Creates a pure resolver for a normalized, transferable scope theme. */
export function createTextMateScopeThemeResolver(theme: TextMateScopeTheme): TextMateScopeResolver {
	const normalized = normalizeTextMateScopeTheme(theme);
	return scopes => {
		for (let index = normalized.rules.length - 1; index >= 0; index -= 1) {
			const rule = normalized.rules[index]!;
			if (matchesTextMateScopeSelector(rule.selector, scopes)) {
				const fallback = defaultTextMateScopeResolver(scopes);
				return Object.freeze({ tokenType: rule.tokenType ?? fallback?.tokenType ?? "source", modifiers: rule.modifiers ?? fallback?.modifiers ?? EMPTY_MODIFIERS, ...(rule.foreground === undefined ? {} : { foreground: rule.foreground }), ...(rule.background === undefined ? {} : { background: rule.background }), ...(rule.fontStyle === undefined ? {} : { fontStyle: rule.fontStyle }) });
			}
		}
		return defaultTextMateScopeResolver(scopes);
	};
}

/** Validates and copies untrusted scope-theme data into one immutable revision. */
export function normalizeTextMateScopeTheme(value: TextMateScopeTheme): TextMateScopeTheme {
	if (typeof value !== "object" || value === null) throw new TypeError("TextMate scope theme must be an object");
	if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
		throw new RangeError("TextMate scope theme revision must be a non-negative safe integer");
	}
	if (!Array.isArray(value.rules)) throw new TypeError("TextMate scope theme rules must be an array");
	if (value.rules.length > MAX_RULE_COUNT) throw new RangeError(`TextMate scope theme cannot exceed ${MAX_RULE_COUNT} rules`);
	if (value.revision === 0 && value.rules.length > 0) throw new RangeError("TextMate scope theme revision zero must be empty");
	const rules = value.rules.map(normalizeRule);
	return Object.freeze({ revision: value.revision, rules: Object.freeze(rules) });
}

/** Matches comma-separated TextMate-like selectors against an outer-to-inner scope stack. */
export function matchesTextMateScopeSelector(selector: string, scopes: readonly string[]): boolean {
	if (typeof selector !== "string" || !Array.isArray(scopes)) return false;
	return selector.split(",").some(part => matchesSelectorSequence(part.trim(), scopes));
}

const MAX_RULE_COUNT = 1_024;
const MAX_SELECTOR_LENGTH = 512;
const MAX_TOKEN_TYPE_LENGTH = 128;
const MAX_MODIFIER_COUNT = 32;
const EMPTY_MODIFIERS: readonly string[] = Object.freeze([]);
const SUPPORTED_TOKEN_TYPES = new Set([
	"comment", "keyword", "modifier", "string", "number", "regexp", "class", "enum", "interface", "namespace", "struct", "type", "typeParameter", "function", "method", "enumMember", "event", "parameter", "property", "variable", "operator",
]);
const SUPPORTED_TOKEN_MODIFIERS = new Set(["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async"]);

function normalizeRule(value: TextMateScopeThemeRule): TextMateScopeThemeRule {
	if (typeof value !== "object" || value === null) throw new TypeError("TextMate scope theme rule must be an object");
	const selector = normalizeText(value.selector, "TextMate scope theme selector", MAX_SELECTOR_LENGTH);
	if (!selector.split(",").some(part => part.trim().length > 0)) {
		throw new TypeError("TextMate scope theme selector must contain a selector");
	}
	const tokenType = value.tokenType === undefined ? undefined : normalizeTokenType(value.tokenType);
	const modifiers = value.modifiers === undefined ? undefined : normalizeModifiers(value.modifiers);
	const foreground = value.foreground === undefined ? undefined : normalizeColor(value.foreground, "TextMate scope theme foreground");
	const background = value.background === undefined ? undefined : normalizeColor(value.background, "TextMate scope theme background");
	const fontStyle = value.fontStyle === undefined ? undefined : normalizeFontStyles(value.fontStyle);
	if (tokenType === undefined && modifiers === undefined && foreground === undefined && background === undefined && fontStyle === undefined) throw new TypeError("TextMate scope theme rule must define a token type or presentation");
	return Object.freeze({ selector, ...(tokenType === undefined ? {} : { tokenType }), ...(modifiers === undefined ? {} : { modifiers }), ...(foreground === undefined ? {} : { foreground }), ...(background === undefined ? {} : { background }), ...(fontStyle === undefined ? {} : { fontStyle }) });
}

function normalizeColor(value: unknown, owner: string): string {
	if (typeof value !== "string" || !/^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/iu.test(value)) throw new TypeError(`${owner} must be a hexadecimal color`);
	return value;
}

function normalizeFontStyles(value: readonly TextMateTokenFontStyle[]): readonly TextMateTokenFontStyle[] {
	if (!Array.isArray(value)) throw new TypeError("TextMate scope theme font style must be an array");
	const styles = value.map(style => {
		if (style !== "italic" && style !== "bold" && style !== "underline" && style !== "strikethrough") throw new TypeError(`Unsupported TextMate scope theme font style '${String(style)}'`);
		return style;
	});
	if (new Set(styles).size !== styles.length) throw new RangeError("TextMate scope theme font styles must be unique");
	return Object.freeze(styles);
}

function normalizeModifiers(value: readonly string[]): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError("TextMate scope theme modifiers must be an array");
	if (value.length > MAX_MODIFIER_COUNT) throw new RangeError(`TextMate scope theme cannot exceed ${MAX_MODIFIER_COUNT} modifiers per rule`);
	const modifiers = value.map(normalizeModifier);
	if (new Set(modifiers).size !== modifiers.length) throw new RangeError("TextMate scope theme modifiers must be unique");
	return Object.freeze(modifiers);
}

function normalizeTokenType(value: unknown): string {
	const tokenType = normalizeText(value, "TextMate scope theme token type", MAX_TOKEN_TYPE_LENGTH);
	if (!SUPPORTED_TOKEN_TYPES.has(tokenType)) throw new TypeError(`Unsupported semantic token type '${tokenType}'`);
	return tokenType;
}

function normalizeModifier(value: unknown): string {
	const modifier = normalizeText(value, "TextMate scope theme modifier", MAX_TOKEN_TYPE_LENGTH);
	if (!SUPPORTED_TOKEN_MODIFIERS.has(modifier)) throw new TypeError(`Unsupported semantic token modifier '${modifier}'`);
	return modifier;
}

function normalizeText(value: unknown, owner: string, maximumLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || value.length > maximumLength || /[\r\n]/u.test(value)) {
		throw new TypeError(`${owner} must be a non-empty trimmed single-line string`);
	}
	return value;
}

function matchesSelectorSequence(selector: string, scopes: readonly string[]): boolean {
	if (selector.length === 0) return false;
	const clauses = selector.split(/\s+/u);
	const positive = clauses.filter(clause => !clause.startsWith("-"));
	if (positive.length === 0) return false;
	if (clauses.some(clause => clause === "-" || (clause.startsWith("-") && matchesAnyScope(clause.slice(1), scopes)))) return false;
	let scopeIndex = 0;
	for (const clause of positive) {
		const matchIndex = scopes.findIndex((scope, index) => index >= scopeIndex && matchesScope(clause, scope));
		if (matchIndex < 0) return false;
		scopeIndex = matchIndex + 1;
	}
	return true;
}

function matchesAnyScope(selector: string, scopes: readonly string[]): boolean {
	return scopes.some(scope => matchesScope(selector, scope));
}

function matchesScope(selector: string, scope: string): boolean {
	if (selector.length === 0 || typeof scope !== "string") return false;
	if (!selector.includes("*")) return scope === selector || scope.startsWith(`${selector}.`);
	const expression = selector.split("*").map(escapeRegExpCharacters).join("[^.]*");
	return new RegExp(`^${expression}(?:\\.|$)`, "u").test(scope);
}

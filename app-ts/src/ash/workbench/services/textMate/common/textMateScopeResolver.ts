export interface TextMateResolvedTokenStyle {
	readonly tokenType: string;
	readonly modifiers?: readonly string[];
	readonly foreground?: string;
	readonly background?: string;
	readonly fontStyle?: readonly ("italic" | "bold" | "underline" | "strikethrough")[];
}

export type TextMateScopeResolver = (scopes: readonly string[]) => TextMateResolvedTokenStyle | undefined;

/** Maps conventional TextMate scopes onto Stanza's stable semantic vocabulary. */
export const defaultTextMateScopeResolver: TextMateScopeResolver = scopes => {
	for (let index = scopes.length - 1; index >= 0; index -= 1) {
		const scope = scopes[index]!;
		const tokenType = resolveTokenType(scope);
		if (tokenType) return Object.freeze({ tokenType, modifiers: EMPTY_MODIFIERS });
	}
	return undefined;
};

const EMPTY_MODIFIERS: readonly string[] = Object.freeze([]);

function resolveTokenType(scope: string): string | undefined {
	if (matches(scope, "invalid")) return "invalid";
	if (matches(scope, "comment")) return "comment";
	if (matches(scope, "string.regexp") || matches(scope, "regexp")) return "regexp";
	if (matches(scope, "string")) return "string";
	if (matches(scope, "constant.numeric")) return "number";
	if (matches(scope, "keyword.operator")) return "operator";
	if (matches(scope, "keyword") || matches(scope, "storage")) return "keyword";
	if (matches(scope, "entity.name.function") || matches(scope, "support.function")) return "function";
	if (matches(scope, "entity.name.type") || matches(scope, "entity.name.class") || matches(scope, "support.type")) return "type";
	if (matches(scope, "variable.parameter")) return "parameter";
	if (matches(scope, "variable")) return "variable";
	if (matches(scope, "entity.name.tag")) return "tag";
	if (matches(scope, "entity.other.attribute-name")) return "property";
	if (matches(scope, "constant")) return "constant";
	if (matches(scope, "punctuation")) return "punctuation";
	return undefined;
}

function matches(scope: string, selector: string): boolean {
	return scope === selector || scope.startsWith(`${selector}.`);
}

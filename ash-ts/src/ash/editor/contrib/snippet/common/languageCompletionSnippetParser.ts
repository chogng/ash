import { applyLanguageCompletionSnippetTransform, createLanguageCompletionSnippetTransform, type LanguageCompletionSnippetTransform } from "./snippetTransform.js";

/** One occurrence of a snippet tabstop within its expanded insertion text. */
export interface LanguageCompletionSnippetPlaceholder {
	readonly startOffset: number;
	readonly endOffset: number;
	/** Available values for a choice tabstop; omitted for ordinary tabstops. */
	readonly choices?: readonly string[];
}

/** One logical tabstop and every mirrored occurrence it owns. */
export interface LanguageCompletionSnippetPlaceholderGroup {
	readonly index: number;
	readonly placeholders: readonly LanguageCompletionSnippetPlaceholder[];
	/** The shared choice list when this tabstop was declared as `${1|a,b|}`. */
	readonly choices?: readonly string[];
}

/** One read-only transform result that derives its text from a tabstop group. */
export interface LanguageCompletionSnippetTransformOccurrence {
	readonly index: number;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly transform: LanguageCompletionSnippetTransform;
}

/** Immutable expansion of Stanza's supported completion snippet grammar. */
export interface LanguageCompletionSnippet {
	readonly text: string;
	readonly placeholderGroups: readonly LanguageCompletionSnippetPlaceholderGroup[];
	/** Omitted when the snippet has no tabstop-derived transform result. */
	readonly transforms?: readonly LanguageCompletionSnippetTransformOccurrence[];
}

/** Resolves one snippet variable from the caller-owned editor context. */
export interface LanguageCompletionSnippetVariableResolver {
	resolveVariable(name: string): string | undefined;
}

export interface LanguageCompletionSnippetOptions {
	readonly variables?: LanguageCompletionSnippetVariableResolver;
	/** Permits syntax-only validation before an editor context is available. */
	readonly allowUnresolvedVariables?: boolean;
}

/**
 * Expands tabstops (`$1`, `${1}`, `${1:default}`, `${1|a,b|}`) into insertion text.
 *
 * The parser deliberately supports only structural tabstops and escaping. It
 * resolves caller-provided variables, and applies regular-expression
 * transforms without introducing browser or model dependencies.
 */
export function parseLanguageCompletionSnippet(source: string, options: LanguageCompletionSnippetOptions = {}): LanguageCompletionSnippet {
	if (typeof source !== "string") throw new TypeError("Language completion snippet must be a string");
	if (options.variables !== undefined && typeof options.variables.resolveVariable !== "function") {
		throw new TypeError("Language completion snippet variables require a resolver");
	}
	if (options.allowUnresolvedVariables !== undefined && typeof options.allowUnresolvedVariables !== "boolean") {
		throw new TypeError("Language completion snippet unresolved-variable policy must be boolean");
	}
	const result = parseSegment(source, 0, false, new Map(), options.variables, options.allowUnresolvedVariables ?? false);
	if (result.nextOffset !== source.length) throw new Error("Language completion snippet ended unexpectedly");
	const placeholderGroups = [...result.placeholders.entries()]
		.sort(([left], [right]) => placeholderOrder(left, right))
		.map(([index, placeholders]) => {
			const choices = placeholders.find(placeholder => placeholder.choices)?.choices;
			return Object.freeze({
				index,
				placeholders: Object.freeze(placeholders.map(placeholder => Object.freeze({
					...placeholder,
					...(placeholder.choices ? { choices: Object.freeze([...placeholder.choices]) } : {}),
				}))),
				...(choices ? { choices: Object.freeze([...choices]) } : {}),
			});
		});
	return Object.freeze({
		text: result.text,
		placeholderGroups: Object.freeze(placeholderGroups),
		...(result.transforms.length > 0 ? { transforms: Object.freeze(result.transforms.map(transform => Object.freeze({ ...transform }))) } : {}),
	});
}

interface ParsedSegment {
	readonly text: string;
	readonly placeholders: Map<number, LanguageCompletionSnippetPlaceholder[]>;
	readonly transforms: readonly LanguageCompletionSnippetTransformOccurrence[];
	readonly nextOffset: number;
}

interface SnippetTabstopValue {
	readonly text: string;
	readonly choices?: readonly string[];
}

class SnippetText {
	private readonly parts: SnippetTabstopValue[] = [];
	private readonly offsets: number[] = [0];

	public append(value: string | (() => string)): void {
		let text: string | undefined = typeof value === "string" ? value : undefined;
		let resolving = false;
		this.parts.push({
			get text(): string {
				// A recursive default has no value at its own reference point.
				if (resolving) return "";
				if (text === undefined) {
					resolving = true;
					try {
						text = (value as () => string)();
					} finally {
						resolving = false;
					}
				}
				return text;
			},
		});
	}

	public get text(): string {
		return this.parts.map(part => part.text).join("");
	}

	public position(): () => number {
		const count = this.parts.length;
		return () => {
			while (this.offsets.length <= count) {
				const index = this.offsets.length - 1;
				this.offsets.push(this.offsets[index]! + this.parts[index]!.text.length);
			}
			return this.offsets[count]!;
		};
	}
}

function parseSegment(source: string, startOffset: number, stopsAtClosingBrace: boolean, tabstopValues: Map<number, SnippetTabstopValue>, variables: LanguageCompletionSnippetVariableResolver | undefined, allowUnresolvedVariables: boolean): ParsedSegment {
	const text = new SnippetText();
	let offset = startOffset;
	const placeholders = new Map<number, LanguageCompletionSnippetPlaceholder[]>();
	const transforms: LanguageCompletionSnippetTransformOccurrence[] = [];
	while (offset < source.length) {
		const character = source[offset]!;
		if (character === "}" && stopsAtClosingBrace) {
			return { get text() { return text.text; }, placeholders, transforms, nextOffset: offset + 1 };
		}
		if (character === "}") {
			text.append(character);
			offset += 1;
			continue;
		}
		if (character === "\\") {
			if (offset + 1 >= source.length) throw new SyntaxError("Language completion snippet must not end with an escape");
			const escaped = source[offset + 1]!;
			if (escaped !== "$" && escaped !== "}" && escaped !== "\\") {
				throw new SyntaxError("Language completion snippets may escape only dollar sign, closing brace, and backslash");
			}
			text.append(escaped);
			offset += 2;
			continue;
		}
	 if (character !== "$") {
		 text.append(character);
		 offset += 1;
		 continue;
	 }
		if (source[offset + 1] === "$") {
			text.append("$$");
			offset += 2;
			continue;
		}
		const next = source[offset + 1];
		if (next === undefined || (next !== "{" && !isDigit(next) && !isVariableNameStart(next))) {
			text.append("$");
			offset += 1;
			continue;
		}
		const placeholderStart = text.position();
		const token = readSnippetToken(source, offset, tabstopValues, variables, allowUnresolvedVariables);
		if (token.kind === "variable") {
			const value = variables?.resolveVariable(token.name);
			if (value !== undefined && typeof value !== "string") {
				throw new TypeError(`Language completion snippet variable '${token.name}' must resolve to text`);
			}
			if (value !== undefined || token.defaultText !== undefined) {
				text.append(() => {
					const resolvedText = value ?? token.defaultText!.text;
					return token.transform ? applyLanguageCompletionSnippetTransform(resolvedText, token.transform) : resolvedText;
				});
				if (value === undefined && token.defaultText && !token.transform) {
					mergePlaceholders(placeholders, token.defaultText.placeholders, placeholderStart);
					mergeTransforms(transforms, token.defaultText.transforms, placeholderStart);
				}
			} else if (!allowUnresolvedVariables) {
				throw new SyntaxError(`Language completion snippet variable '${token.name}' has no value`);
			}
			offset = token.nextOffset;
			continue;
		}
		if (token.transform) {
			const transform = token.transform;
			text.append(() => applyLanguageCompletionSnippetTransform(tabstopValues.get(token.index)?.text ?? "", transform));
			const transformEnd = text.position();
			transforms.push(Object.freeze({
				index: token.index,
				get startOffset() { return placeholderStart(); },
				get endOffset() { return transformEnd(); },
				transform: token.transform,
			}));
			offset = token.nextOffset;
			continue;
		}
		let value: SnippetTabstopValue;
		if (token.defaultText !== undefined) {
			text.append(() => token.defaultText!.text);
			mergePlaceholders(placeholders, token.defaultText.placeholders, placeholderStart);
			mergeTransforms(transforms, token.defaultText.transforms, placeholderStart);
			value = { get text() { return token.defaultText!.text; } };
			if (!tabstopValues.has(token.index)) tabstopValues.set(token.index, value);
		} else if (token.choices) {
			value = tabstopValues.get(token.index) ?? Object.freeze({
				text: token.choices[0]!,
				choices: token.choices,
			});
			if (!tabstopValues.has(token.index)) tabstopValues.set(token.index, value);
			text.append(() => value.text);
		} else {
			value = tabstopValues.get(token.index) ?? { text: "" };
			text.append(() => value.text);
		}
		const placeholderEnd = text.position();
		const occurrences = placeholders.get(token.index) ?? [];
		const choices = tabstopValues.get(token.index)?.choices;
		occurrences.push({
			get startOffset() { return placeholderStart(); },
			get endOffset() { return placeholderEnd(); },
			...(choices ? { choices } : {}),
		});
		placeholders.set(token.index, occurrences);
		offset = token.nextOffset;
	}
	if (stopsAtClosingBrace) throw new SyntaxError("Unclosed tabstop in language completion snippet");
	return { get text() { return text.text; }, placeholders, transforms, nextOffset: offset };
}

function readSnippetToken(source: string, offset: number, tabstopValues: Map<number, SnippetTabstopValue>, variables: LanguageCompletionSnippetVariableResolver | undefined, allowUnresolvedVariables: boolean): SnippetToken {
	const next = source[offset + 1];
	if (next === undefined) throw new SyntaxError("Language completion snippet must not end with $");
	if (isDigit(next)) {
		const endOffset = readDigitsEnd(source, offset + 1);
		return { kind: "tabstop", index: Number(source.slice(offset + 1, endOffset)), nextOffset: endOffset };
	}
	if (next !== "{") return readVariable(source, offset + 1, false, tabstopValues, variables, allowUnresolvedVariables);
	const indexStart = offset + 2;
	if (!isDigit(source[indexStart])) return readVariable(source, indexStart, true, tabstopValues, variables, allowUnresolvedVariables);
	const indexEnd = readDigitsEnd(source, indexStart);
	const index = Number(source.slice(indexStart, indexEnd));
	const delimiter = source[indexEnd];
	if (delimiter === "}") return { kind: "tabstop", index, nextOffset: indexEnd + 1 };
	if (delimiter === "/") {
		const transform = readTransform(source, indexEnd);
		return { kind: "tabstop", index, transform: transform.transform, nextOffset: transform.nextOffset };
	}
	if (delimiter === "|") {
		const choice = readChoice(source, indexEnd + 1);
		return { kind: "tabstop", index, choices: choice.values, nextOffset: choice.nextOffset };
	}
	if (delimiter !== ":") throw new SyntaxError("Language completion snippets support only tabstop defaults or choices");
	const defaultText = parseSegment(source, indexEnd + 1, true, tabstopValues, variables, allowUnresolvedVariables);
	return { kind: "tabstop", index, defaultText, nextOffset: defaultText.nextOffset };
}

function readVariable(source: string, nameStartOffset: number, braced: boolean, tabstopValues: Map<number, SnippetTabstopValue>, variables: LanguageCompletionSnippetVariableResolver | undefined, allowUnresolvedVariables: boolean): SnippetVariableToken {
	const nameEndOffset = readVariableNameEnd(source, nameStartOffset);
	if (nameEndOffset === nameStartOffset) throw new SyntaxError("Language completion snippet variable must have a name");
	const name = source.slice(nameStartOffset, nameEndOffset);
	if (!braced) return { kind: "variable", name, nextOffset: nameEndOffset };
	const delimiter = source[nameEndOffset];
	if (delimiter === "}") return { kind: "variable", name, nextOffset: nameEndOffset + 1 };
	if (delimiter === "/") {
		const transform = readTransform(source, nameEndOffset);
		return { kind: "variable", name, transform: transform.transform, nextOffset: transform.nextOffset };
	}
	if (delimiter !== ":") throw new SyntaxError("Language completion snippet variable must end or provide a default");
	const defaultText = parseSegment(source, nameEndOffset + 1, true, tabstopValues, variables, allowUnresolvedVariables);
	return { kind: "variable", name, defaultText, nextOffset: defaultText.nextOffset };
}

interface SnippetTabstopToken {
	readonly kind: "tabstop";
	readonly index: number;
	readonly defaultText?: ParsedSegment;
	readonly choices?: readonly string[];
	readonly transform?: LanguageCompletionSnippetTransform;
	readonly nextOffset: number;
}

interface SnippetVariableToken {
	readonly kind: "variable";
	readonly name: string;
	readonly defaultText?: ParsedSegment;
	readonly transform?: LanguageCompletionSnippetTransform;
	readonly nextOffset: number;
}

type SnippetToken = SnippetTabstopToken | SnippetVariableToken;

function readTransform(source: string, slashOffset: number): { readonly transform: LanguageCompletionSnippetTransform; readonly nextOffset: number } {
	const pattern = readTransformPart(source, slashOffset + 1, false);
	const format = readTransformPart(source, pattern.nextOffset, true);
	let options = "";
	let offset = format.nextOffset;
	while (offset < source.length && source[offset] !== "}") {
		const option = source[offset]!;
		if (option === "\\" || option === "/") throw new SyntaxError("Language completion snippet transform options must end before a closing brace");
		options += option;
		offset += 1;
	}
	if (source[offset] !== "}") throw new SyntaxError("Unclosed language completion snippet transform");
	return Object.freeze({
		transform: createLanguageCompletionSnippetTransform(pattern.text, format.text, options),
		nextOffset: offset + 1,
	});
}

function readTransformPart(source: string, startOffset: number, supportsBracedFormatExpressions: boolean): { readonly text: string; readonly nextOffset: number } {
	let text = "";
	let braceDepth = 0;
	let offset = startOffset;
	while (offset < source.length) {
		const character = source[offset]!;
		if (character === "\\") {
			const escaped = source[offset + 1];
			if (escaped === undefined) throw new SyntaxError("Language completion snippet transform must not end with an escape");
			text += character + escaped;
			offset += 2;
			continue;
		}
		if (supportsBracedFormatExpressions && character === "$" && source[offset + 1] === "{") {
			braceDepth += 1;
			text += "${";
			offset += 2;
			continue;
		}
		if (supportsBracedFormatExpressions && character === "}" && braceDepth > 0) {
			braceDepth -= 1;
			text += character;
			offset += 1;
			continue;
		}
		if (character === "/" && braceDepth === 0) return Object.freeze({ text, nextOffset: offset + 1 });
		if (character === "}") throw new SyntaxError("Language completion snippet transform is missing a slash delimiter");
		text += character;
		offset += 1;
	}
	throw new SyntaxError("Unclosed language completion snippet transform");
}

function readChoice(source: string, startOffset: number): { readonly values: readonly string[]; readonly nextOffset: number } {
	const values: string[] = [];
	let value = "";
	let offset = startOffset;
	while (offset < source.length) {
		const character = source[offset]!;
		if (character === "|") {
			if (source[offset + 1] !== "}") throw new SyntaxError("Language completion snippet choice must end with |}");
			values.push(value);
			return Object.freeze({ values: Object.freeze(values), nextOffset: offset + 2 });
		}
		if (character === ",") {
			values.push(value);
			value = "";
			offset += 1;
			continue;
		}
		if (character === "\\") {
			const escaped = source[offset + 1];
			if (escaped !== "," && escaped !== "|" && escaped !== "\\" && escaped !== "$" && escaped !== "}") {
				throw new SyntaxError("Language completion snippet choice has an invalid escape");
			}
			value += escaped;
			offset += 2;
			continue;
		}
		if (character === "}") throw new SyntaxError("Language completion snippet choice must escape closing braces");
		value += character;
		offset += 1;
	}
	throw new SyntaxError("Unclosed choice in language completion snippet");
}

function mergePlaceholders(target: Map<number, LanguageCompletionSnippetPlaceholder[]>, source: Map<number, LanguageCompletionSnippetPlaceholder[]>, offset: () => number): void {
	for (const [index, placeholders] of source) {
		const targetPlaceholders = target.get(index) ?? [];
		targetPlaceholders.push(...placeholders.map(placeholder => ({
			get startOffset() { return placeholder.startOffset + offset(); },
			get endOffset() { return placeholder.endOffset + offset(); },
		})));
		target.set(index, targetPlaceholders);
	}
}

function mergeTransforms(target: LanguageCompletionSnippetTransformOccurrence[], source: readonly LanguageCompletionSnippetTransformOccurrence[], offset: () => number): void {
	target.push(...source.map(transform => Object.freeze({
		index: transform.index,
		transform: transform.transform,
		get startOffset() { return transform.startOffset + offset(); },
		get endOffset() { return transform.endOffset + offset(); },
	})));
}

function readDigitsEnd(source: string, startOffset: number): number {
	let offset = startOffset;
	while (isDigit(source[offset])) offset += 1;
	return offset;
}

function readVariableNameEnd(source: string, startOffset: number): number {
	if (!isVariableNameStart(source[startOffset])) return startOffset;
	let offset = startOffset + 1;
	while (isVariableNamePart(source[offset])) offset += 1;
	return offset;
}

function isDigit(value: string | undefined): boolean {
	return value !== undefined && value >= "0" && value <= "9";
}

function isVariableNameStart(value: string | undefined): boolean {
	return value !== undefined && ((value >= "A" && value <= "Z") || (value >= "a" && value <= "z") || value === "_");
}

function isVariableNamePart(value: string | undefined): boolean {
	return isVariableNameStart(value) || isDigit(value);
}

function placeholderOrder(left: number, right: number): number {
	if (left === 0) return right === 0 ? 0 : 1;
	if (right === 0) return -1;
	return left - right;
}

import {
	IndentAction,
	type CharacterPair,
	type CommentRule,
	type EnterAction,
	type FoldingRules,
	type IAutoClosingPair,
	type IAutoClosingPairConditional,
	type IndentationRule,
	type LanguageConfiguration,
	type OnEnterRule,
} from '../../../../editor/common/languages/languageConfiguration.js';

/** Converts a VS Code-compatible JSON language configuration into editor rules. */
export function parseLanguageConfiguration(value: unknown, owner: string): LanguageConfiguration {
	const document = record(value, owner);
	return Object.freeze({
		...(document.comments === undefined ? {} : { comments: parseComments(document.comments, `${owner}.comments`) }),
		...(document.brackets === undefined ? {} : { brackets: parsePairList(document.brackets, `${owner}.brackets`) }),
		...(document.autoClosingPairs === undefined ? {} : { autoClosingPairs: parseAutoClosingPairs(document.autoClosingPairs, `${owner}.autoClosingPairs`) }),
		...(document.surroundingPairs === undefined ? {} : { surroundingPairs: parseSurroundingPairs(document.surroundingPairs, `${owner}.surroundingPairs`) }),
		...(document.autoCloseBefore === undefined ? {} : { autoCloseBefore: boundedString(document.autoCloseBefore, `${owner}.autoCloseBefore`, 512) }),
		...(document.indentationRules === undefined ? {} : { indentationRules: parseIndentationRules(document.indentationRules, `${owner}.indentationRules`) }),
		...(document.folding === undefined ? {} : { folding: parseFoldingRules(document.folding, `${owner}.folding`) }),
		...(document.onEnterRules === undefined ? {} : { onEnterRules: parseOnEnterRules(document.onEnterRules, `${owner}.onEnterRules`) }),
		...(document.wordPattern === undefined ? {} : { wordPattern: regularExpression(document.wordPattern, `${owner}.wordPattern`) }),
	});
}

function parseComments(value: unknown, owner: string): CommentRule {
	const comments = record(value, owner);
	const lineComment = comments.lineComment === undefined ? undefined : text(comments.lineComment, `${owner}.lineComment`, 64);
	return Object.freeze({
		...(lineComment === undefined || lineComment.length === 0 ? {} : { lineComment }),
		...(comments.blockComment === undefined ? {} : { blockComment: parsePair(comments.blockComment, `${owner}.blockComment`) }),
	});
}

function parseIndentationRules(value: unknown, owner: string): IndentationRule {
	const rules = record(value, owner);
	return Object.freeze({
		decreaseIndentPattern: regularExpression(rules.decreaseIndentPattern, `${owner}.decreaseIndentPattern`),
		increaseIndentPattern: regularExpression(rules.increaseIndentPattern, `${owner}.increaseIndentPattern`),
		...(rules.indentNextLinePattern === undefined ? {} : { indentNextLinePattern: optionalRegularExpression(rules.indentNextLinePattern, `${owner}.indentNextLinePattern`) }),
		...(rules.unIndentedLinePattern === undefined ? {} : { unIndentedLinePattern: optionalRegularExpression(rules.unIndentedLinePattern, `${owner}.unIndentedLinePattern`) }),
	});
}

function parseFoldingRules(value: unknown, owner: string): FoldingRules {
	const folding = record(value, owner);
	const offSide = folding.offSide === undefined ? undefined : boolean(folding.offSide, `${owner}.offSide`);
	if (folding.markers === undefined) return offSide === undefined ? {} : { offSide };
	const markers = record(folding.markers, `${owner}.markers`);
	return {
		...(offSide === undefined ? {} : { offSide }),
		markers: {
			start: regularExpression(markers.start, `${owner}.markers.start`),
			end: regularExpression(markers.end, `${owner}.markers.end`),
		},
	};
}

function parseOnEnterRules(value: unknown, owner: string): OnEnterRule[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return value.map((candidate, index) => {
		const rule = record(candidate, `${owner}[${index}]`);
		return Object.freeze({
			beforeText: regularExpression(rule.beforeText, `${owner}[${index}].beforeText`),
			...optionalRegularExpressionProperty(rule.afterText, `${owner}[${index}].afterText`, "afterText"),
			...optionalRegularExpressionProperty(rule.previousLineText, `${owner}[${index}].previousLineText`, "previousLineText"),
			action: parseEnterAction(rule.action, `${owner}[${index}].action`),
		});
	});
}

function parseEnterAction(value: unknown, owner: string): EnterAction {
	const action = record(value, owner);
	const indent = text(action.indent, `${owner}.indent`, 32);
	if (!(indent in INDENT_ACTIONS)) throw new TypeError(`${owner}.indent is unsupported`);
	return Object.freeze({
		indentAction: INDENT_ACTIONS[indent as keyof typeof INDENT_ACTIONS],
		...(action.appendText === undefined ? {} : { appendText: text(action.appendText, `${owner}.appendText`, 512) }),
		...(action.removeText === undefined ? {} : { removeText: nonNegativeInteger(action.removeText, `${owner}.removeText`) }),
	});
}

function optionalRegularExpressionProperty(value: unknown, owner: string, key: "afterText" | "previousLineText"): { readonly afterText?: RegExp } | { readonly previousLineText?: RegExp } | Record<never, never> {
	if (value === undefined || value === null) return {};
	const expression = regularExpression(value, owner);
	return key === "afterText" ? { afterText: expression } : { previousLineText: expression };
}

function parseAutoClosingPairs(value: unknown, owner: string): IAutoClosingPairConditional[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return value.map((candidate, index) => {
		if (Array.isArray(candidate)) return pairObject(candidate, `${owner}[${index}]`);
		const pair = record(candidate, `${owner}[${index}]`);
		const notIn = pair.notIn === undefined ? undefined : parseTextList(pair.notIn, `${owner}[${index}].notIn`, 32);
		return Object.freeze({
			open: text(pair.open, `${owner}[${index}].open`, 128),
			close: text(pair.close, `${owner}[${index}].close`, 128),
			...(notIn === undefined ? {} : { notIn }),
		});
	});
}

function parsePairList(value: unknown, owner: string): CharacterPair[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return value.map((candidate, index) => parsePair(candidate, `${owner}[${index}]`));
}

function parseSurroundingPairs(value: unknown, owner: string): IAutoClosingPair[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return value.map((candidate, index) => pairObject(candidate, `${owner}[${index}]`));
}

function parsePair(value: unknown, owner: string): CharacterPair {
	if (Array.isArray(value)) {
		if (value.length !== 2) throw new RangeError(`${owner} must contain exactly two strings`);
		return [text(value[0], `${owner}[0]`, 128), text(value[1], `${owner}[1]`, 128)];
	}
	const pair = record(value, owner);
	return [text(pair.open, `${owner}.open`, 128), text(pair.close, `${owner}.close`, 128)];
}

function pairObject(value: unknown, owner: string): IAutoClosingPair {
	const [open, close] = parsePair(value, owner);
	return { open, close };
}

function parseTextList(value: unknown, owner: string, maximum: number): string[] {
	if (!Array.isArray(value)) throw new TypeError(`${owner} must be an array`);
	return value.map((candidate, index) => text(candidate, `${owner}[${index}]`, maximum));
}

function optionalRegularExpression(value: unknown, owner: string): RegExp | null {
	return value === null ? null : regularExpression(value, owner);
}

function regularExpression(value: unknown, owner: string): RegExp {
	const { source, flags } = typeof value === "string"
		? { source: text(value, owner, 4096), flags: "" }
		: parseRegularExpressionObject(value, owner);
	try {
		return Object.freeze(new RegExp(source, flags));
	} catch (error) {
		throw new TypeError(`${owner} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseRegularExpressionObject(value: unknown, owner: string): { readonly source: string; readonly flags: string } {
	const expression = record(value, owner);
	const keys = Object.keys(expression);
	if (keys.some(key => key !== "pattern" && key !== "flags") || expression.pattern === undefined) {
		throw new TypeError(`${owner} must contain only pattern and flags`);
	}
	const flags = expression.flags === undefined ? "" : text(expression.flags, `${owner}.flags`, 16);
	if (!/^[dgimsuvy]*$/u.test(flags) || new Set(flags).size !== flags.length) {
		throw new TypeError(`${owner}.flags contains unsupported flags`);
	}
	return Object.freeze({ source: text(expression.pattern, `${owner}.pattern`, 4096), flags });
}

function text(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || /[\r\n]/u.test(value)) throw new TypeError(`${owner} must be bounded text`);
	return value;
}

function boundedString(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum) throw new TypeError(`${owner} must be a bounded string`);
	return value;
}

function boolean(value: unknown, owner: string): boolean {
	if (typeof value !== 'boolean') throw new TypeError(`${owner} must be a boolean`);
	return value;
}

function nonNegativeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${owner} must be a non-negative integer`);
	return value as number;
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

const INDENT_ACTIONS = Object.freeze({
	none: IndentAction.None,
	indent: IndentAction.Indent,
	indentOutdent: IndentAction.IndentOutdent,
	outdent: IndentAction.Outdent,
});

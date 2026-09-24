import type { JsonValue } from './jsonValue.js';

export enum JsonTokenKind {
	OpenBrace = 'openBrace',
	CloseBrace = 'closeBrace',
	OpenBracket = 'openBracket',
	CloseBracket = 'closeBracket',
	Comma = 'comma',
	Colon = 'colon',
	String = 'string',
	Number = 'number',
	True = 'true',
	False = 'false',
	Null = 'null',
	LineComment = 'lineComment',
	BlockComment = 'blockComment',
	Trivia = 'trivia',
	Unknown = 'unknown',
}

export interface JsonToken {
	readonly kind: JsonTokenKind;
	readonly offset: number;
	readonly length: number;
	readonly value?: string;
}

export interface JsonParseError {
	readonly message: string;
	readonly offset: number;
	readonly length: number;
}

export interface JsonParseOptions {
	readonly allowComments?: boolean;
	readonly allowTrailingComma?: boolean;
}

export interface JsonFormattingOptions {
	readonly tabSize: number;
	readonly insertSpaces: boolean;
	readonly eol?: '\n' | '\r\n';
}

interface JsonNodeBase {
	readonly offset: number;
	readonly length: number;
}

export interface JsonStringNode extends JsonNodeBase {
	readonly type: 'string';
	readonly value: string;
}

export interface JsonNumberNode extends JsonNodeBase {
	readonly type: 'number';
	readonly value: number;
}

export interface JsonBooleanNode extends JsonNodeBase {
	readonly type: 'boolean';
	readonly value: boolean;
}

export interface JsonNullNode extends JsonNodeBase {
	readonly type: 'null';
	readonly value: null;
}

export interface JsonPropertyNode extends JsonNodeBase {
	readonly type: 'property';
	readonly key: string;
	readonly keyNode: JsonStringNode;
	readonly valueNode: JsonValueNode | undefined;
}

export interface JsonObjectNode extends JsonNodeBase {
	readonly type: 'object';
	readonly properties: readonly JsonPropertyNode[];
}

export interface JsonArrayNode extends JsonNodeBase {
	readonly type: 'array';
	readonly items: readonly JsonValueNode[];
}

export type JsonValueNode = JsonStringNode | JsonNumberNode | JsonBooleanNode | JsonNullNode | JsonObjectNode | JsonArrayNode;
export type JsonNode = JsonValueNode | JsonPropertyNode;

export interface JsonDocument {
	readonly root: JsonValueNode | undefined;
	readonly value: JsonValue | undefined;
	readonly tokens: readonly JsonToken[];
	readonly errors: readonly JsonParseError[];
}

interface ScannedJson {
	readonly tokens: readonly JsonToken[];
	readonly errors: readonly JsonParseError[];
}

const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u;

/** Scans JSON punctuation, values, comments, and trivia without discarding source ranges. */
export function scanJson(source: string, options: JsonParseOptions = {}): ScannedJson {
	if (typeof source !== 'string') throw new TypeError('JSON source must be text');
	const tokens: JsonToken[] = [];
	const errors: JsonParseError[] = [];
	let offset = 0;
	while (offset < source.length) {
		const start = offset;
		const character = source[offset]!;
		const punctuation = punctuationKind(character);
		if (punctuation) {
			offset += 1;
			tokens.push(token(punctuation, start, offset));
			continue;
		}
		if (isJsonWhitespace(character)) {
			do {
				offset += 1;
			} while (offset < source.length && isJsonWhitespace(source[offset]!));
			tokens.push(token(JsonTokenKind.Trivia, start, offset));
			continue;
		}
		if (character === '/' && (source[offset + 1] === '/' || source[offset + 1] === '*')) {
			const isLineComment = source[offset + 1] === '/';
			offset += 2;
			if (isLineComment) {
				while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n') offset += 1;
				tokens.push(token(JsonTokenKind.LineComment, start, offset));
			} else {
				while (offset < source.length && !(source[offset] === '*' && source[offset + 1] === '/')) offset += 1;
				if (offset >= source.length) {
					errors.push(parseError('Unterminated block comment', start, source.length - start));
				} else {
					offset += 2;
				}
				tokens.push(token(JsonTokenKind.BlockComment, start, offset));
			}
			if (!options.allowComments) errors.push(parseError('Comments are not permitted in JSON', start, offset - start));
			continue;
		}
		if (character === '"') {
			offset = scanString(source, start, errors);
			const raw = source.slice(start, offset);
			tokens.push({ kind: JsonTokenKind.String, offset: start, length: offset - start, value: decodeStringToken(raw) });
			continue;
		}
		const number = numberPattern.exec(source.slice(offset))?.[0];
		if (number) {
			offset += number.length;
			tokens.push({ kind: JsonTokenKind.Number, offset: start, length: number.length, value: number });
			continue;
		}
		const keyword = keywordKind(source, offset);
		if (keyword) {
			offset += keyword.length;
			tokens.push(token(keyword.kind, start, offset));
			continue;
		}
		offset += 1;
		while (offset < source.length && !isTokenBoundary(source[offset]!)) offset += 1;
		tokens.push(token(JsonTokenKind.Unknown, start, offset));
		errors.push(parseError(`Unexpected token '${source.slice(start, offset)}'`, start, offset - start));
	}
	return Object.freeze({ tokens: Object.freeze(tokens), errors: Object.freeze(errors) });
}

/** Parses strict JSON or JSONC while retaining a source-ranged syntax tree. */
export function parseJsonDocument(source: string, options: JsonParseOptions = {}): JsonDocument {
	const scanned = scanJson(source, options);
	const parser = new JsonParser(source, scanned.tokens, scanned.errors, options);
	return parser.parse();
}

/** Formats valid JSON or JSONC from tokens while preserving comment text and trailing commas. */
export function formatJson(source: string, options: JsonFormattingOptions): string {
	if (!Number.isSafeInteger(options.tabSize) || options.tabSize < 1) throw new RangeError('JSON formatting tab size must be positive');
	const document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
	if (document.errors.length > 0) throw new TypeError(`Cannot format invalid JSONC: ${document.errors[0]!.message}`);
	const tokens = scanJson(source, { allowComments: true, allowTrailingComma: true }).tokens.filter(candidate => candidate.kind !== JsonTokenKind.Trivia);
	const eol = options.eol ?? (source.includes('\r\n') ? '\r\n' : '\n');
	const indentation = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
	let result = '';
	let level = 0;
	let isLineStart = true;
	const write = (value: string): void => {
		if (isLineStart) {
			result += indentation.repeat(level);
			isLineStart = false;
		}
		result += value;
	};
	const newline = (): void => {
		result = result.replace(/[\t ]+$/u, '');
		if (!result.endsWith(eol)) result += eol;
		isLineStart = true;
	};
	for (let index = 0; index < tokens.length; index += 1) {
		const current = tokens[index]!;
		const next = tokens[index + 1];
		const previous = tokens[index - 1];
		const raw = source.slice(current.offset, current.offset + current.length);
		switch (current.kind) {
			case JsonTokenKind.OpenBrace:
			case JsonTokenKind.OpenBracket:
				write(raw);
				if (!next || !isMatchingClose(current.kind, next.kind)) {
					level += 1;
					newline();
				}
				break;
			case JsonTokenKind.CloseBrace:
			case JsonTokenKind.CloseBracket:
				if (!previous || !isMatchingClose(previous.kind, current.kind)) {
					level = Math.max(0, level - 1);
					if (!isLineStart) newline();
				}
				write(raw);
				break;
			case JsonTokenKind.Comma:
				write(raw);
				newline();
				break;
			case JsonTokenKind.Colon:
				write(': ');
				break;
			case JsonTokenKind.LineComment:
				if (!isLineStart && !/[\t ]$/u.test(result)) result += ' ';
				write(raw);
				newline();
				break;
			case JsonTokenKind.BlockComment:
				if (!isLineStart && !/[\t ]$/u.test(result)) result += ' ';
				write(raw.replace(/\r?\n/gu, eol));
				if (next && next.kind !== JsonTokenKind.Comma) newline();
				else result += ' ';
				break;
			default:
				write(raw);
				break;
		}
	}
	return `${result.trimEnd()}${eol}`;
}

/** Returns the deepest syntax node containing one source offset. */
export function findJsonNodeAtOffset(root: JsonValueNode | undefined, offset: number): JsonNode | undefined {
	if (!root || offset < root.offset || offset > root.offset + root.length) return undefined;
	if (root.type === 'object') {
		for (const property of root.properties) {
			if (offset < property.offset || offset > property.offset + property.length) continue;
			if (offset <= property.keyNode.offset + property.keyNode.length) return property.keyNode;
			return findJsonNodeAtOffset(property.valueNode, offset) ?? property;
		}
	}
	if (root.type === 'array') {
		for (const item of root.items) {
			const nested = findJsonNodeAtOffset(item, offset);
			if (nested) return nested;
		}
	}
	return root;
}

/** Returns the property/index path of one value node. */
export function getJsonNodePath(root: JsonValueNode | undefined, target: JsonValueNode): readonly (string | number)[] | undefined {
	if (!root) return undefined;
	if (root === target) return Object.freeze([]);
	if (root.type === 'object') {
		for (const property of root.properties) {
			if (!property.valueNode) continue;
			const nested = getJsonNodePath(property.valueNode, target);
			if (nested) return Object.freeze([property.key, ...nested]);
		}
	}
	if (root.type === 'array') {
		for (let index = 0; index < root.items.length; index += 1) {
			const nested = getJsonNodePath(root.items[index], target);
			if (nested) return Object.freeze([index, ...nested]);
		}
	}
	return undefined;
}

/** Updates one top-level object property while preserving unrelated JSONC source. */
export function editJsonObjectProperty(source: string, key: string, value: unknown | undefined): string {
	if (typeof key !== 'string' || key.length === 0) throw new TypeError('JSON property key must not be empty');
	const document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
	if (document.errors.length > 0) throw new TypeError(`Cannot edit invalid JSONC: ${document.errors[0]!.message}`);
	if (document.root?.type !== 'object') throw new TypeError('JSONC root must be an object');
	const property = document.root.properties.find(candidate => candidate.key === key);
	if (value === undefined) return property ? removeObjectProperty(source, document, property) : source;
	const formatting = detectFormatting(source, document.root);
	const serialized = formatJsonValue(value, formatting.indent, formatting.eol);
	if (property?.valueNode) {
		if (JSON.stringify(propertyValue(property.valueNode)) === JSON.stringify(value)) return source;
		const propertyIndent = indentationAt(source, property.offset);
		const replacement = indentMultiline(serialized, propertyIndent, formatting.eol);
		return replaceSource(source, property.valueNode.offset, property.valueNode.length, replacement);
	}
	if (property) throw new TypeError(`JSON property '${key}' has no value`);
	return insertObjectProperty(source, document, key, serialized, formatting);
}

function punctuationKind(character: string): JsonTokenKind | undefined {
	switch (character) {
		case '{': return JsonTokenKind.OpenBrace;
		case '}': return JsonTokenKind.CloseBrace;
		case '[': return JsonTokenKind.OpenBracket;
		case ']': return JsonTokenKind.CloseBracket;
		case ',': return JsonTokenKind.Comma;
		case ':': return JsonTokenKind.Colon;
		default: return undefined;
	}
}

function token(kind: JsonTokenKind, offset: number, end: number): JsonToken {
	return Object.freeze({ kind, offset, length: end - offset });
}

function parseError(message: string, offset: number, length: number): JsonParseError {
	return Object.freeze({ message, offset, length: Math.max(length, 1) });
}

function scanString(source: string, start: number, errors: JsonParseError[]): number {
	let offset = start + 1;
	while (offset < source.length) {
		const character = source[offset]!;
		if (character === '"') return offset + 1;
		if (character === '\r' || character === '\n') {
			errors.push(parseError('Unterminated string', start, offset - start));
			return offset;
		}
		if (character.charCodeAt(0) <= 0x1f) errors.push(parseError('Unescaped control character in string', offset, 1));
		if (character === '\\') {
			offset += 1;
			if (offset >= source.length) break;
			const escaped = source[offset]!;
			if (escaped === 'u') {
				const digits = source.slice(offset + 1, offset + 5);
				if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) errors.push(parseError('Invalid Unicode escape sequence', offset - 1, Math.min(6, source.length - offset + 1)));
				offset += Math.min(5, source.length - offset);
				continue;
			}
			if (!'"\\/bfnrt'.includes(escaped)) errors.push(parseError(`Invalid escape sequence '\\${escaped}'`, offset - 1, 2));
		}
		offset += 1;
	}
	errors.push(parseError('Unterminated string', start, source.length - start));
	return source.length;
}

function decodeStringToken(raw: string): string {
	try {
		return JSON.parse(raw) as string;
	} catch {
		const content = raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
		try {
			return JSON.parse(`"${content.replace(/"/gu, '\\"')}"`) as string;
		} catch {
			return content;
		}
	}
}

function keywordKind(source: string, offset: number): { readonly kind: JsonTokenKind; readonly length: number } | undefined {
	for (const [word, kind] of [['true', JsonTokenKind.True], ['false', JsonTokenKind.False], ['null', JsonTokenKind.Null]] as const) {
		if (source.startsWith(word, offset) && isTokenBoundary(source[offset + word.length] ?? '')) return { kind, length: word.length };
	}
	return undefined;
}

function isTokenBoundary(character: string): boolean {
	return character === '' || isJsonWhitespace(character) || /[{}\[\],:]/u.test(character);
}

function isJsonWhitespace(character: string): boolean {
	return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

class JsonParser {
	private readonly significantTokens: readonly JsonToken[];
	private readonly errors: JsonParseError[];
	private index = 0;

	constructor(
		private readonly source: string,
		tokens: readonly JsonToken[],
		scanErrors: readonly JsonParseError[],
		private readonly options: JsonParseOptions,
	) {
		this.significantTokens = tokens.filter(candidate => !isTrivia(candidate.kind));
		this.errors = [...scanErrors];
	}

	public parse(): JsonDocument {
		const root = this.parseValue();
		if (!root && this.significantTokens.length === 0) this.errors.push(parseError('Expected a JSON value', 0, 1));
		if (root && this.current()) this.errors.push(parseError('Unexpected content after the root value', this.current()!.offset, this.current()!.length));
		return Object.freeze({
			root,
			value: root ? propertyValue(root) : undefined,
			tokens: Object.freeze([...this.significantTokens]),
			errors: Object.freeze(this.deduplicatedErrors()),
		});
	}

	private parseValue(): JsonValueNode | undefined {
		const current = this.current();
		if (!current) return undefined;
		switch (current.kind) {
			case JsonTokenKind.OpenBrace: return this.parseObject();
			case JsonTokenKind.OpenBracket: return this.parseArray();
			case JsonTokenKind.String:
				this.index += 1;
				return Object.freeze({ type: 'string', value: current.value ?? '', offset: current.offset, length: current.length });
			case JsonTokenKind.Number:
				this.index += 1;
				return Object.freeze({ type: 'number', value: Number(current.value), offset: current.offset, length: current.length });
			case JsonTokenKind.True:
			case JsonTokenKind.False:
				this.index += 1;
				return Object.freeze({ type: 'boolean', value: current.kind === JsonTokenKind.True, offset: current.offset, length: current.length });
			case JsonTokenKind.Null:
				this.index += 1;
				return Object.freeze({ type: 'null', value: null, offset: current.offset, length: current.length });
			default:
				this.errors.push(parseError('Expected a JSON value', current.offset, current.length));
				this.index += 1;
				return undefined;
		}
	}

	private parseObject(): JsonObjectNode {
		const open = this.consume(JsonTokenKind.OpenBrace)!;
		const properties: JsonPropertyNode[] = [];
		while (this.current() && this.current()!.kind !== JsonTokenKind.CloseBrace) {
			const key = this.current()!;
			if (key.kind !== JsonTokenKind.String) {
				this.errors.push(parseError('Expected an object property name', key.offset, key.length));
				this.recover(JsonTokenKind.Comma, JsonTokenKind.CloseBrace);
				if (this.consume(JsonTokenKind.Comma)) continue;
				break;
			}
			this.index += 1;
			const keyNode = Object.freeze<JsonStringNode>({ type: 'string', value: key.value ?? '', offset: key.offset, length: key.length });
			if (!this.consume(JsonTokenKind.Colon)) {
				const current = this.current();
				this.errors.push(parseError("Expected ':' after the property name", current?.offset ?? key.offset + key.length, current?.length ?? 1));
			}
			const valueNode = this.parseValue();
			const end = valueNode ? valueNode.offset + valueNode.length : key.offset + key.length;
			properties.push(Object.freeze({ type: 'property', key: keyNode.value, keyNode, valueNode, offset: key.offset, length: end - key.offset }));
			const comma = this.consume(JsonTokenKind.Comma);
			if (comma) {
				if (this.current()?.kind === JsonTokenKind.CloseBrace && !this.options.allowTrailingComma) {
					this.errors.push(parseError('Trailing commas are not permitted in JSON', comma.offset, comma.length));
				}
				continue;
			}
			if (this.current()?.kind !== JsonTokenKind.CloseBrace) {
				const current = this.current();
				this.errors.push(parseError("Expected ',' or '}' after the property value", current?.offset ?? end, current?.length ?? 1));
				this.recover(JsonTokenKind.Comma, JsonTokenKind.CloseBrace);
				this.consume(JsonTokenKind.Comma);
			}
		}
		const close = this.consume(JsonTokenKind.CloseBrace);
		if (!close) this.errors.push(parseError("Expected '}'", this.source.length, 1));
		const end = close ? close.offset + close.length : this.source.length;
		return Object.freeze({ type: 'object', properties: Object.freeze(properties), offset: open.offset, length: end - open.offset });
	}

	private parseArray(): JsonArrayNode {
		const open = this.consume(JsonTokenKind.OpenBracket)!;
		const items: JsonValueNode[] = [];
		while (this.current() && this.current()!.kind !== JsonTokenKind.CloseBracket) {
			const before = this.index;
			const value = this.parseValue();
			if (value) items.push(value);
			if (this.index === before) this.index += 1;
			const comma = this.consume(JsonTokenKind.Comma);
			if (comma) {
				if (this.current()?.kind === JsonTokenKind.CloseBracket && !this.options.allowTrailingComma) {
					this.errors.push(parseError('Trailing commas are not permitted in JSON', comma.offset, comma.length));
				}
				continue;
			}
			if (this.current()?.kind !== JsonTokenKind.CloseBracket) {
				const current = this.current();
				this.errors.push(parseError("Expected ',' or ']' after the array item", current?.offset ?? this.source.length, current?.length ?? 1));
				this.recover(JsonTokenKind.Comma, JsonTokenKind.CloseBracket);
				this.consume(JsonTokenKind.Comma);
			}
		}
		const close = this.consume(JsonTokenKind.CloseBracket);
		if (!close) this.errors.push(parseError("Expected ']'", this.source.length, 1));
		const end = close ? close.offset + close.length : this.source.length;
		return Object.freeze({ type: 'array', items: Object.freeze(items), offset: open.offset, length: end - open.offset });
	}

	private current(): JsonToken | undefined {
		return this.significantTokens[this.index];
	}

	private consume(kind: JsonTokenKind): JsonToken | undefined {
		const current = this.current();
		if (current?.kind !== kind) return undefined;
		this.index += 1;
		return current;
	}

	private recover(...kinds: readonly JsonTokenKind[]): void {
		while (this.current() && !kinds.includes(this.current()!.kind)) this.index += 1;
	}

	private deduplicatedErrors(): readonly JsonParseError[] {
		const seen = new Set<string>();
		return this.errors.filter(error => {
			const key = `${error.offset}:${error.length}:${error.message}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
}

function isTrivia(kind: JsonTokenKind): boolean {
	return kind === JsonTokenKind.Trivia || kind === JsonTokenKind.LineComment || kind === JsonTokenKind.BlockComment;
}

function isMatchingClose(open: JsonTokenKind, close: JsonTokenKind): boolean {
	return open === JsonTokenKind.OpenBrace && close === JsonTokenKind.CloseBrace || open === JsonTokenKind.OpenBracket && close === JsonTokenKind.CloseBracket;
}

function propertyValue(node: JsonValueNode): JsonValue {
	switch (node.type) {
		case 'string': return node.value;
		case 'number': return node.value;
		case 'boolean': return node.value;
		case 'null': return null;
		case 'array': return node.items.map(propertyValue);
		case 'object': {
			const result: Record<string, JsonValue> = {};
			for (const property of node.properties) {
				if (property.valueNode) Object.defineProperty(result, property.key, { value: propertyValue(property.valueNode), enumerable: true, configurable: true, writable: true });
			}
			return result;
		}
	}
}

interface JsonFormatting {
	readonly eol: string;
	readonly indent: string;
	readonly rootIndent: string;
}

function detectFormatting(source: string, root: JsonObjectNode): JsonFormatting {
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const rootIndent = indentationAt(source, root.offset);
	const firstProperty = root.properties[0];
	const propertyIndent = firstProperty ? indentationAt(source, firstProperty.offset) : '';
	const indent = propertyIndent.startsWith(rootIndent) && propertyIndent.length > rootIndent.length
		? propertyIndent.slice(rootIndent.length)
		: '\t';
	return { eol, indent, rootIndent };
}

function formatJsonValue(value: unknown, indent: string, eol: string): string {
	const serialized = JSON.stringify(value, null, indent);
	if (serialized === undefined) throw new TypeError('JSON property value must be serializable');
	return serialized.replace(/\n/gu, eol);
}

function indentationAt(source: string, offset: number): string {
	const lineStart = Math.max(source.lastIndexOf('\n', offset - 1) + 1, 0);
	return /^[\t ]*/u.exec(source.slice(lineStart, offset))?.[0] ?? '';
}

function indentMultiline(value: string, propertyIndent: string, eol: string): string {
	return value.split(eol).map((line, index) => index === 0 ? line : `${propertyIndent}${line}`).join(eol);
}

function insertObjectProperty(source: string, document: JsonDocument, key: string, serialized: string, formatting: JsonFormatting): string {
	const root = document.root as JsonObjectNode;
	const closeOffset = root.offset + root.length - 1;
	const propertyIndent = `${formatting.rootIndent}${formatting.indent}`;
	const value = indentMultiline(serialized, propertyIndent, formatting.eol);
	const propertySource = `${JSON.stringify(key)}: ${value}`;
	const lastProperty = root.properties.at(-1);
	if (!lastProperty) {
		const inner = source.slice(root.offset + 1, closeOffset);
		if (/^\s*$/u.test(inner)) {
			return replaceSource(source, root.offset + 1, inner.length, `${formatting.eol}${propertyIndent}${propertySource}${formatting.eol}${formatting.rootIndent}`);
		}
		const separator = inner.endsWith('\n') || inner.endsWith('\r') ? '' : formatting.eol;
		return replaceSource(source, closeOffset, 0, `${separator}${propertyIndent}${propertySource}${formatting.eol}${formatting.rootIndent}`);
	}
	const trailingComma = document.tokens.find(candidate => candidate.kind === JsonTokenKind.Comma && candidate.offset >= lastProperty.offset + lastProperty.length && candidate.offset < closeOffset);
	if (trailingComma) {
		return replaceSource(source, trailingComma.offset + trailingComma.length, 0, `${formatting.eol}${propertyIndent}${propertySource},`);
	}
	return replaceSource(source, lastProperty.offset + lastProperty.length, 0, `,${formatting.eol}${propertyIndent}${propertySource}`);
}

function removeObjectProperty(source: string, document: JsonDocument, property: JsonPropertyNode): string {
	const root = document.root as JsonObjectNode;
	const index = root.properties.indexOf(property);
	const next = root.properties[index + 1];
	const closeOffset = root.offset + root.length - 1;
	const followingLimit = next?.offset ?? closeOffset;
	const followingComma = document.tokens.find(candidate => candidate.kind === JsonTokenKind.Comma && candidate.offset >= property.offset + property.length && candidate.offset < followingLimit);
	if (followingComma) {
		const withoutComma = replaceSource(source, followingComma.offset, followingComma.length, '');
		return replaceSource(withoutComma, property.offset, property.length, '');
	}
	const previous = root.properties[index - 1];
	if (!previous) return replaceSource(source, property.offset, property.length, '');
	const separator = [...document.tokens].reverse().find(candidate => candidate.kind === JsonTokenKind.Comma && candidate.offset >= previous.offset + previous.length && candidate.offset < property.offset);
	const withoutProperty = replaceSource(source, property.offset, property.length, '');
	return separator ? replaceSource(withoutProperty, separator.offset, separator.length, '') : withoutProperty;
}

function replaceSource(source: string, offset: number, length: number, replacement: string): string {
	return `${source.slice(0, offset)}${replacement}${source.slice(offset + length)}`;
}

export * from './jsonEdit.js';
export * from './jsonErrorMessages.js';
export * from './jsonFormatter.js';

export enum ScanError {
	None = 0,
	UnexpectedEndOfComment = 1,
	UnexpectedEndOfString = 2,
	UnexpectedEndOfNumber = 3,
	InvalidUnicode = 4,
	InvalidEscapeCharacter = 5,
	InvalidCharacter = 6,
}

export enum SyntaxKind {
	OpenBraceToken = 1,
	CloseBraceToken = 2,
	OpenBracketToken = 3,
	CloseBracketToken = 4,
	CommaToken = 5,
	ColonToken = 6,
	NullKeyword = 7,
	TrueKeyword = 8,
	FalseKeyword = 9,
	StringLiteral = 10,
	NumericLiteral = 11,
	LineCommentTrivia = 12,
	BlockCommentTrivia = 13,
	LineBreakTrivia = 14,
	Trivia = 15,
	Unknown = 16,
	EOF = 17,
}

export interface JSONScanner {
	setPosition(position: number): void;
	scan(): SyntaxKind;
	getPosition(): number;
	getToken(): SyntaxKind;
	getTokenValue(): string;
	getTokenOffset(): number;
	getTokenLength(): number;
	getTokenError(): ScanError;
}

export interface ParseError {
	readonly error: ParseErrorCode;
	readonly offset: number;
	readonly length: number;
}

export enum ParseErrorCode {
	InvalidSymbol = 1,
	InvalidNumberFormat = 2,
	PropertyNameExpected = 3,
	ValueExpected = 4,
	ColonExpected = 5,
	CommaExpected = 6,
	CloseBraceExpected = 7,
	CloseBracketExpected = 8,
	EndOfFileExpected = 9,
	InvalidCommentToken = 10,
	UnexpectedEndOfComment = 11,
	UnexpectedEndOfString = 12,
	UnexpectedEndOfNumber = 13,
	InvalidUnicode = 14,
	InvalidEscapeCharacter = 15,
	InvalidCharacter = 16,
}

export type NodeType = 'object' | 'array' | 'property' | 'string' | 'number' | 'boolean' | 'null';

export interface Node {
	readonly type: NodeType;
	readonly value?: unknown;
	readonly offset: number;
	readonly length: number;
	readonly colonOffset?: number;
	readonly parent?: Node;
	readonly children?: readonly Node[];
}

export type Segment = string | number;
export type JSONPath = Segment[];

export interface Location {
	readonly previousNode?: Node;
	readonly path: JSONPath;
	readonly matches: (patterns: JSONPath) => boolean;
	readonly isAtPropertyKey: boolean;
}

export interface ParseOptions {
	readonly disallowComments?: boolean;
	readonly allowTrailingComma?: boolean;
	readonly allowEmptyContent?: boolean;
}

export namespace ParseOptions {
	export const DEFAULT: ParseOptions = Object.freeze({ allowTrailingComma: true });
}

export interface JSONVisitor {
	onObjectBegin?: (offset: number, length: number) => void;
	onObjectProperty?: (property: string, offset: number, length: number) => void;
	onObjectEnd?: (offset: number, length: number) => void;
	onArrayBegin?: (offset: number, length: number) => void;
	onArrayEnd?: (offset: number, length: number) => void;
	onLiteralValue?: (value: unknown, offset: number, length: number) => void;
	onSeparator?: (character: string, offset: number, length: number) => void;
	onComment?: (offset: number, length: number) => void;
	onError?: (error: ParseErrorCode, offset: number, length: number) => void;
}

const whitespacePattern = /[\t\v\f \u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/u;
const lineBreakPattern = /[\n\r\u2028\u2029]/u;

export function createScanner(text: string, ignoreTrivia = false): JSONScanner {
	if (typeof text !== 'string') throw new TypeError('JSON source must be text');
	let position = 0;
	let tokenOffset = 0;
	let token = SyntaxKind.Unknown;
	let tokenValue = '';
	let scanError = ScanError.None;

	const setPosition = (newPosition: number): void => {
		position = Math.max(0, Math.min(text.length, newPosition));
		tokenOffset = position;
		token = SyntaxKind.Unknown;
		tokenValue = '';
		scanError = ScanError.None;
	};

	const scanHexDigits = (count: number): number => {
		let value = 0;
		let digits = 0;
		while (digits < count) {
			const character = text.charCodeAt(position);
			const digit = hexDigit(character);
			if (digit < 0) break;
			value = value * 16 + digit;
			position += 1;
			digits += 1;
		}
		if (digits !== count) return -1;
		return value;
	};

	const scanNumber = (): string => {
		const start = position;
		if (text.charCodeAt(position) === 0x30) {
			position += 1;
		} else {
			position += 1;
			while (isDigit(text.charCodeAt(position))) position += 1;
		}
		if (text.charCodeAt(position) === 0x2e) {
			position += 1;
			if (!isDigit(text.charCodeAt(position))) {
				scanError = ScanError.UnexpectedEndOfNumber;
				return text.slice(start, position);
			}
			position += 1;
			while (isDigit(text.charCodeAt(position))) position += 1;
		}
		let end = position;
		if (text.charCodeAt(position) === 0x45 || text.charCodeAt(position) === 0x65) {
			position += 1;
			if (text.charCodeAt(position) === 0x2b || text.charCodeAt(position) === 0x2d) position += 1;
			if (!isDigit(text.charCodeAt(position))) {
				scanError = ScanError.UnexpectedEndOfNumber;
			} else {
				position += 1;
				while (isDigit(text.charCodeAt(position))) position += 1;
				end = position;
			}
		}
		return text.slice(start, end);
	};

	const scanString = (): string => {
		let result = '';
		let start = position;
		while (position < text.length) {
			const character = text.charCodeAt(position);
			if (character === 0x22) {
				result += text.slice(start, position);
				position += 1;
				return result;
			}
			if (character === 0x5c) {
				result += text.slice(start, position);
				position += 1;
				if (position >= text.length) {
					scanError = ScanError.UnexpectedEndOfString;
					return result;
				}
				const escaped = text.charCodeAt(position);
				position += 1;
				switch (escaped) {
					case 0x22: result += '"'; break;
					case 0x5c: result += '\\'; break;
					case 0x2f: result += '/'; break;
					case 0x62: result += '\b'; break;
					case 0x66: result += '\f'; break;
					case 0x6e: result += '\n'; break;
					case 0x72: result += '\r'; break;
					case 0x74: result += '\t'; break;
					case 0x75: {
						const codePoint = scanHexDigits(4);
						if (codePoint < 0) scanError = ScanError.InvalidUnicode;
						else result += String.fromCharCode(codePoint);
						break;
					}
					default: scanError = ScanError.InvalidEscapeCharacter;
				}
				start = position;
				continue;
			}
			if (character <= 0x1f) {
				result += text.slice(start, position);
				if (isLineBreakCode(character)) {
					scanError = ScanError.UnexpectedEndOfString;
					return result;
				}
				scanError = ScanError.InvalidCharacter;
				position += 1;
				start = position;
				continue;
			}
			position += 1;
		}
		result += text.slice(start, position);
		scanError = ScanError.UnexpectedEndOfString;
		return result;
	};

	const scanNext = (): SyntaxKind => {
		tokenValue = '';
		scanError = ScanError.None;
		tokenOffset = position;
		if (position >= text.length) {
			tokenOffset = text.length;
			return (token = SyntaxKind.EOF);
		}
		const code = text.charCodeAt(position);
		if (isWhitespaceCode(code)) {
			do {
				position += 1;
			} while (position < text.length && isWhitespaceCode(text.charCodeAt(position)));
			tokenValue = text.slice(tokenOffset, position);
			return (token = SyntaxKind.Trivia);
		}
		if (isLineBreakCode(code)) {
			position += 1;
			if (code === 0x0d && text.charCodeAt(position) === 0x0a) position += 1;
			tokenValue = text.slice(tokenOffset, position);
			return (token = SyntaxKind.LineBreakTrivia);
		}
		switch (code) {
			case 0x7b: position += 1; return (token = SyntaxKind.OpenBraceToken);
			case 0x7d: position += 1; return (token = SyntaxKind.CloseBraceToken);
			case 0x5b: position += 1; return (token = SyntaxKind.OpenBracketToken);
			case 0x5d: position += 1; return (token = SyntaxKind.CloseBracketToken);
			case 0x3a: position += 1; return (token = SyntaxKind.ColonToken);
			case 0x2c: position += 1; return (token = SyntaxKind.CommaToken);
			case 0x22:
				position += 1;
				tokenValue = scanString();
				return (token = SyntaxKind.StringLiteral);
			case 0x2f:
				if (text.charCodeAt(position + 1) === 0x2f) {
					position += 2;
					while (position < text.length && !isLineBreakCode(text.charCodeAt(position))) position += 1;
					tokenValue = text.slice(tokenOffset, position);
					return (token = SyntaxKind.LineCommentTrivia);
				}
				if (text.charCodeAt(position + 1) === 0x2a) {
					position += 2;
					let closed = false;
					while (position < text.length - 1) {
						if (text.charCodeAt(position) === 0x2a && text.charCodeAt(position + 1) === 0x2f) {
							position += 2;
							closed = true;
							break;
						}
						position += 1;
					}
					if (!closed) {
						position = text.length;
						scanError = ScanError.UnexpectedEndOfComment;
					}
					tokenValue = text.slice(tokenOffset, position);
					return (token = SyntaxKind.BlockCommentTrivia);
				}
				position += 1;
				tokenValue = '/';
				return (token = SyntaxKind.Unknown);
			case 0x2d:
				position += 1;
				if (!isDigit(text.charCodeAt(position))) {
					tokenValue = '-';
					return (token = SyntaxKind.Unknown);
				}
				tokenValue = `-${scanNumber()}`;
				return (token = SyntaxKind.NumericLiteral);
			default:
				if (isDigit(code)) {
					tokenValue = scanNumber();
					return (token = SyntaxKind.NumericLiteral);
				}
				while (position < text.length && isUnknownContentCharacter(text.charCodeAt(position))) position += 1;
				if (position !== tokenOffset) {
					tokenValue = text.slice(tokenOffset, position);
					switch (tokenValue) {
						case 'true': return (token = SyntaxKind.TrueKeyword);
						case 'false': return (token = SyntaxKind.FalseKeyword);
						case 'null': return (token = SyntaxKind.NullKeyword);
						default: return (token = SyntaxKind.Unknown);
					}
				}
				position += 1;
				tokenValue = text.slice(tokenOffset, position);
				return (token = SyntaxKind.Unknown);
		}
	};

	const scan = (): SyntaxKind => {
		let result: SyntaxKind;
		do {
			result = scanNext();
		} while (ignoreTrivia && isCompatibilityTrivia(result));
		return result;
	};

	return {
		setPosition,
		scan,
		getPosition: () => position,
		getToken: () => token,
		getTokenValue: () => tokenValue,
		getTokenOffset: () => tokenOffset,
		getTokenLength: () => position - tokenOffset,
		getTokenError: () => scanError,
	};
}

export function parse(text: string, errors: ParseError[] = [], options: ParseOptions = ParseOptions.DEFAULT): unknown {
	let currentProperty: string | null = null;
	let currentParent: unknown[] | Record<string, unknown> = [];
	const previousParents: Array<unknown[] | Record<string, unknown>> = [];
	const visitor: JSONVisitor = {
		onObjectBegin: () => {
			const object: Record<string, unknown> = {};
			onValue(object);
			previousParents.push(currentParent);
			currentParent = object;
			currentProperty = null;
		},
		onObjectProperty: name => { currentProperty = name; },
		onObjectEnd: () => { currentParent = previousParents.pop() ?? []; },
		onArrayBegin: () => {
			const array: unknown[] = [];
			onValue(array);
			previousParents.push(currentParent);
			currentParent = array;
			currentProperty = null;
		},
		onArrayEnd: () => { currentParent = previousParents.pop() ?? []; },
		onLiteralValue: onValue,
		onError: (error, offset, length) => errors.push({ error, offset, length }),
	};
	visit(text, visitor, options);
	return (currentParent as unknown[])[0];

	function onValue(value: unknown): void {
		if (Array.isArray(currentParent)) {
			currentParent.push(value);
			return;
		}
		if (currentProperty !== null) currentParent[currentProperty] = value;
	}
}

export function parseTree(text: string, errors: ParseError[] = [], options: ParseOptions = ParseOptions.DEFAULT): Node | undefined {
	let currentParent: MutableNode = { type: 'array', offset: -1, length: -1, children: [] };
	const visitor: JSONVisitor = {
		onObjectBegin: (offset, length) => {
			currentParent = append({ type: 'object', offset, length: -1, parent: currentParent, children: [] });
		},
		onObjectProperty: (name, offset, length) => {
			const property = append({ type: 'property', offset, length: -1, parent: currentParent, children: [] });
			property.children!.push({ type: 'string', value: name, offset, length, parent: property });
			currentParent = property;
		},
		onObjectEnd: (offset, length) => {
			currentParent.length = offset + length - currentParent.offset;
			currentParent = currentParent.parent ?? currentParent;
			completeProperty(offset + length);
		},
		onArrayBegin: (offset, length) => { currentParent = append({ type: 'array', offset, length: -1, parent: currentParent, children: [] }); },
		onArrayEnd: (offset, length) => {
			currentParent.length = offset + length - currentParent.offset;
			currentParent = currentParent.parent ?? currentParent;
			completeProperty(offset + length);
		},
		onLiteralValue: (value, offset, length) => {
			append({ type: getNodeType(value), value, offset, length, parent: currentParent });
			completeProperty(offset + length);
		},
		onSeparator: (separator, offset) => {
			if (currentParent.type !== 'property') return;
			if (separator === ':') {
				currentParent.colonOffset = offset;
				return;
			}
			if (separator === ',') completeProperty(offset);
		},
		onError: (error, offset, length) => errors.push({ error, offset, length }),
	};
	visit(text, visitor, options);
	const result = currentParent.children?.[0];
	if (result) delete result.parent;
	return result;

	function append(node: MutableNode): MutableNode {
		currentParent.children!.push(node);
		return node;
	}

	function completeProperty(endOffset: number): void {
		if (currentParent.type !== 'property') return;
		currentParent.length = endOffset - currentParent.offset;
		currentParent = currentParent.parent ?? currentParent;
	}
}

export function visit(text: string, visitor: JSONVisitor, options: ParseOptions = ParseOptions.DEFAULT): boolean {
	const scanner = createScanner(text);
	const disallowComments = options.disallowComments === true;
	const allowTrailingComma = options.allowTrailingComma === true;
	let current = scanNext();
	if (current === SyntaxKind.EOF) {
		if (!options.allowEmptyContent) report(ParseErrorCode.ValueExpected, scanner.getTokenOffset(), 1);
		return options.allowEmptyContent === true;
	}
	if (!parseValue()) {
		report(ParseErrorCode.ValueExpected, scanner.getTokenOffset(), scanner.getTokenLength());
		return false;
	}
	if ((current as SyntaxKind) !== SyntaxKind.EOF) {
		report(ParseErrorCode.EndOfFileExpected, scanner.getTokenOffset(), scanner.getTokenLength());
	}
	return true;

	function scanNext(): SyntaxKind {
		while (true) {
			const result = scanner.scan();
			reportScannerError();
			if (result === SyntaxKind.LineCommentTrivia || result === SyntaxKind.BlockCommentTrivia) {
				if (disallowComments) report(ParseErrorCode.InvalidCommentToken, scanner.getTokenOffset(), scanner.getTokenLength());
				else visitor.onComment?.(scanner.getTokenOffset(), scanner.getTokenLength());
				continue;
			}
			if (result === SyntaxKind.Trivia || result === SyntaxKind.LineBreakTrivia) continue;
			if (result === SyntaxKind.Unknown) report(ParseErrorCode.InvalidSymbol, scanner.getTokenOffset(), scanner.getTokenLength());
			return result;
		}
	}

	function reportScannerError(): void {
		const error = scanner.getTokenError();
		const offset = scanner.getTokenOffset();
		const length = scanner.getTokenLength();
		switch (error) {
			case ScanError.UnexpectedEndOfComment: report(ParseErrorCode.UnexpectedEndOfComment, offset, length); break;
			case ScanError.UnexpectedEndOfString: report(ParseErrorCode.UnexpectedEndOfString, offset, length); break;
			case ScanError.UnexpectedEndOfNumber: report(ParseErrorCode.UnexpectedEndOfNumber, offset, length); break;
			case ScanError.InvalidUnicode: report(ParseErrorCode.InvalidUnicode, offset, length); break;
			case ScanError.InvalidEscapeCharacter: report(ParseErrorCode.InvalidEscapeCharacter, offset, length); break;
			case ScanError.InvalidCharacter: report(ParseErrorCode.InvalidCharacter, offset, length); break;
		}
	}

	function parseValue(): boolean {
		switch (current) {
			case SyntaxKind.OpenBracketToken: return parseArray();
			case SyntaxKind.OpenBraceToken: return parseObject();
			case SyntaxKind.StringLiteral: return parseString(true);
			default: return parseLiteral();
		}
	}

	function parseString(isValue: boolean): boolean {
		const value = scanner.getTokenValue();
		if (isValue) visitor.onLiteralValue?.(value, scanner.getTokenOffset(), scanner.getTokenLength());
		else visitor.onObjectProperty?.(value, scanner.getTokenOffset(), scanner.getTokenLength());
		current = scanNext();
		return true;
	}

	function parseLiteral(): boolean {
		let value: unknown;
		switch (current) {
			case SyntaxKind.NumericLiteral:
				try {
					value = JSON.parse(scanner.getTokenValue());
					if (typeof value !== 'number') throw new TypeError('not a number');
				} catch {
					report(ParseErrorCode.InvalidNumberFormat, scanner.getTokenOffset(), scanner.getTokenLength());
					value = 0;
				}
				break;
			case SyntaxKind.NullKeyword: value = null; break;
			case SyntaxKind.TrueKeyword: value = true; break;
			case SyntaxKind.FalseKeyword: value = false; break;
			default: return false;
		}
		visitor.onLiteralValue?.(value, scanner.getTokenOffset(), scanner.getTokenLength());
		current = scanNext();
		return true;
	}

	function parseProperty(): boolean {
		if (current !== SyntaxKind.StringLiteral) {
			report(ParseErrorCode.PropertyNameExpected, scanner.getTokenOffset(), scanner.getTokenLength());
			recover(SyntaxKind.CloseBraceToken, SyntaxKind.CommaToken);
			return false;
		}
		parseString(false);
		if ((current as SyntaxKind) !== SyntaxKind.ColonToken) {
			report(ParseErrorCode.ColonExpected, scanner.getTokenOffset(), scanner.getTokenLength());
			return false;
		}
		visitor.onSeparator?.(':', scanner.getTokenOffset(), scanner.getTokenLength());
		current = scanNext();
		if (!parseValue()) {
			report(ParseErrorCode.ValueExpected, scanner.getTokenOffset(), scanner.getTokenLength());
			return false;
		}
		return true;
	}

	function parseObject(): boolean {
		visitor.onObjectBegin?.(scanner.getTokenOffset(), scanner.getTokenLength());
		current = scanNext();
		let needsComma = false;
		while (current !== SyntaxKind.CloseBraceToken && current !== SyntaxKind.EOF) {
			if (current === SyntaxKind.CommaToken) {
				if (!needsComma) report(ParseErrorCode.ValueExpected, scanner.getTokenOffset(), scanner.getTokenLength());
				visitor.onSeparator?.(',', scanner.getTokenOffset(), scanner.getTokenLength());
				current = scanNext();
				if (current === SyntaxKind.CloseBraceToken && allowTrailingComma) break;
			} else if (needsComma) {
				report(ParseErrorCode.CommaExpected, scanner.getTokenOffset(), scanner.getTokenLength());
			}
			if (!parseProperty()) recover(SyntaxKind.CloseBraceToken, SyntaxKind.CommaToken);
			needsComma = true;
		}
		visitor.onObjectEnd?.(scanner.getTokenOffset(), scanner.getTokenLength());
		if (current !== SyntaxKind.CloseBraceToken) {
			report(ParseErrorCode.CloseBraceExpected, scanner.getTokenOffset(), 1);
			return true;
		}
		current = scanNext();
		return true;
	}

	function parseArray(): boolean {
		visitor.onArrayBegin?.(scanner.getTokenOffset(), scanner.getTokenLength());
		current = scanNext();
		let needsComma = false;
		while (current !== SyntaxKind.CloseBracketToken && current !== SyntaxKind.EOF) {
			if (current === SyntaxKind.CommaToken) {
				if (!needsComma) report(ParseErrorCode.ValueExpected, scanner.getTokenOffset(), scanner.getTokenLength());
				visitor.onSeparator?.(',', scanner.getTokenOffset(), scanner.getTokenLength());
				current = scanNext();
				if (current === SyntaxKind.CloseBracketToken && allowTrailingComma) break;
			} else if (needsComma) {
				report(ParseErrorCode.CommaExpected, scanner.getTokenOffset(), scanner.getTokenLength());
			}
			if (!parseValue()) recover(SyntaxKind.CloseBracketToken, SyntaxKind.CommaToken);
			needsComma = true;
		}
		visitor.onArrayEnd?.(scanner.getTokenOffset(), scanner.getTokenLength());
		if (current !== SyntaxKind.CloseBracketToken) {
			report(ParseErrorCode.CloseBracketExpected, scanner.getTokenOffset(), 1);
			return true;
		}
		current = scanNext();
		return true;
	}

	function recover(...until: readonly SyntaxKind[]): void {
		while (current !== SyntaxKind.EOF && !until.includes(current)) current = scanNext();
	}

	function report(error: ParseErrorCode, offset: number, length: number): void {
		visitor.onError?.(error, offset, Math.max(length, 1));
	}
}

export function findNodeAtLocation(root: Node | undefined, path: JSONPath): Node | undefined {
	if (!root) return undefined;
	let node = root;
	for (const segment of path) {
		if (typeof segment === 'string') {
			if (node.type !== 'object') return undefined;
			const property = node.children?.find(candidate => candidate.type === 'property' && candidate.children?.[0]?.value === segment);
			if (!property?.children?.[1]) return undefined;
			node = property.children[1];
			continue;
		}
		if (node.type !== 'array' || segment < 0 || segment >= (node.children?.length ?? 0)) return undefined;
		node = node.children![segment]!;
	}
	return node;
}

export function getNodePath(node: Node | undefined): JSONPath {
	if (!node?.parent) return [];
	const path = getNodePath(node.parent);
	if (node.parent.type === 'property') {
		const key = node.parent.children?.[0]?.value;
		if (typeof key === 'string') path.push(key);
	} else if (node.parent.type === 'array') {
		const index = node.parent.children?.indexOf(node) ?? -1;
		if (index >= 0) path.push(index);
	}
	return path;
}

export function getNodeValue(node: Node | undefined): unknown {
	if (!node) return undefined;
	if (node.type === 'array') return (node.children ?? []).map(getNodeValue);
	if (node.type === 'object') {
		const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const property of node.children ?? []) {
			if (property.type !== 'property') continue;
			const key = property.children?.[0]?.value;
			const child = property.children?.[1];
			if (typeof key === 'string' && child) value[key] = getNodeValue(child);
		}
		return value;
	}
	return node.value;
}

export function contains(node: Node, offset: number, includeRightBound = false): boolean {
	return offset >= node.offset && (offset < node.offset + node.length || includeRightBound && offset === node.offset + node.length);
}

export function findNodeAtOffset(node: Node | undefined, offset: number, includeRightBound = false): Node | undefined {
	if (!node || !contains(node, offset, includeRightBound)) return undefined;
	for (const child of node.children ?? []) {
		if (child.offset > offset) break;
		const nested = findNodeAtOffset(child, offset, includeRightBound);
		if (nested) return nested;
	}
	return node;
}

export function getLocation(text: string, position: number): Location {
	const root = parseTree(text, [], { allowTrailingComma: true });
	const boundedPosition = Math.max(0, Math.min(text.length, position));
	const node = root ? findNodeAtOffset(root, boundedPosition, true) : undefined;
	const path = node ? getNodePath(node) : [];
	const previousNode = node && ['property', 'string', 'number', 'boolean', 'null'].includes(node.type) ? node : undefined;
	const isAtPropertyKey = node?.type === 'string' && node.parent?.type === 'property' && node.parent.children?.[0] === node;
	return {
		previousNode,
		path,
		isAtPropertyKey: isAtPropertyKey === true,
		matches: patterns => matchesPath(path, patterns),
	};
}

function matchesPath(path: JSONPath, patterns: JSONPath): boolean {
	const match = (pathIndex: number, patternIndex: number): boolean => {
		if (patternIndex === patterns.length) return pathIndex === path.length;
		const pattern = patterns[patternIndex];
		if (pattern === '**') return match(pathIndex, patternIndex + 1) || pathIndex < path.length && match(pathIndex + 1, patternIndex);
		return pathIndex < path.length && (pattern === '*' || pattern === path[pathIndex]) && match(pathIndex + 1, patternIndex + 1);
	};
	return match(0, 0);
}

function getNodeType(value: unknown): NodeType {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	switch (typeof value) {
		case 'boolean': return 'boolean';
		case 'number': return 'number';
		case 'string': return 'string';
		default: return 'null';
	}
}

function isCompatibilityTrivia(kind: SyntaxKind): boolean {
	return kind >= SyntaxKind.LineCommentTrivia && kind <= SyntaxKind.Trivia;
}

function isWhitespaceCode(code: number): boolean {
	return whitespacePattern.test(String.fromCharCode(code));
}

function isLineBreakCode(code: number): boolean {
	return lineBreakPattern.test(String.fromCharCode(code));
}

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

function isUnknownContentCharacter(code: number): boolean {
	if (code < 0 || isWhitespaceCode(code) || isLineBreakCode(code)) return false;
	return ![0x7d, 0x5d, 0x7b, 0x5b, 0x22, 0x3a, 0x2c, 0x2f].includes(code);
}

function hexDigit(code: number): number {
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	return -1;
}

interface MutableNode {
	type: NodeType;
	value?: unknown;
	offset: number;
	length: number;
	colonOffset?: number;
	parent?: MutableNode;
	children?: MutableNode[];
}

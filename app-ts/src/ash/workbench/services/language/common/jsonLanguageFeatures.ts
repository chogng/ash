import { Registry } from '../../../../platform/registry/common/platform.js';
import { match } from '../../../../base/common/glob.js';
import type { URI } from '../../../../base/common/uri.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { type ITextModel } from '../../../../editor/common/model.js';
import { applyEdits } from '../../../../base/common/jsonEdit.js';
import { format, type FormattingOptions as JsonFormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { getJsonNodePath, parseJsonDocument, JsonTokenKind, type JsonDocument, type JsonObjectNode, type JsonPropertyNode, type JsonValueNode } from '../../../../base/common/json.js';
import { jsonSchemaAtPath, type JsonSchema } from '../../../../base/common/jsonSchema.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { type TextEdit, type DocumentFormattingEditProvider, type FormattingOptions, LanguageCompletionItemKind, type LanguageCompletionProvider, type LanguageCompletionProviderItem, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult, type LanguageHover, type LanguageHoverProvider, type LanguageHoverRequest } from '../../../../editor/common/languages.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

const jsonLanguageIds = Object.freeze(['json', 'jsonc']);

interface JsonPropertyCompletionContext {
	readonly object: JsonObjectNode;
	readonly range: Range;
	readonly currentProperty: JsonPropertyNode | undefined;
	readonly append: string;
}

/** Creates schema-driven completion for every associated JSON or JSONC resource. */
export function createJsonCompletionProvider(registry: IJSONContributionRegistry = jsonRegistry): LanguageCompletionProvider {
	return Object.freeze({
		id: 'ash.json.schema',
		languageIds: jsonLanguageIds,
		triggerCharacters: Object.freeze(['"', ':']),
		provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined {
			signal.throwIfAborted();
			const schemas = getJsonSchemasForResource(registry, request.resource);
			if (schemas.length === 0) return undefined;
			const source = request.snapshot.getText();
			const offset = offsetAt(source, request.position);
			const document = parseJsonDocument(source, jsonParseOptions(request.languageId));
			const propertyContext = propertyCompletionContext(source, document, offset);
			const items = new Map<string, LanguageCompletionProviderItem>();
			for (const schema of schemas) {
				let result: LanguageCompletionProviderResult | undefined;
				if (!document.root && source.trim().length === 0) {
					result = emptyDocumentCompletions(schema, request.position);
				} else if (propertyContext) {
					result = propertyCompletions(document, schema, propertyContext);
				} else {
					result = valueCompletions(source, document, schema, offset);
				}
				for (const item of result?.items ?? []) { items.set(item.label, item); }
			}
			return items.size > 0 ? {
				items: [...items.values()].map((item, index) => ({ ...item, id: `schema-${index}` })),
				isIncomplete: false,
			} : undefined;
		},
	});
}

/** Creates schema descriptions for JSON property keys and values. */
export function createJsonHoverProvider(registry: IJSONContributionRegistry = jsonRegistry): LanguageHoverProvider {
	return Object.freeze({
		provideHover(request: LanguageHoverRequest, signal: AbortSignal): LanguageHover | undefined {
			signal.throwIfAborted();
			const schemas = getJsonSchemasForResource(registry, request.resource);
			if (schemas.length === 0) return undefined;
			const source = request.snapshot.getText();
			const offset = offsetAt(source, request.position);
			const document = parseJsonDocument(source, jsonParseOptions(request.languageId));
			const match = propertyAtOffset(document.root, offset);
			if (!match) return undefined;
			const contents: string[] = [];
			for (const schema of schemas) {
				const propertySchema = jsonSchemaAtPath(schema, match.path, document.root);
				if (!propertySchema?.description && !propertySchema?.title) { continue; }
				contents.push(...[propertySchema.title, propertySchema.description].filter((value): value is string => Boolean(value)));
				if (propertySchema.default !== undefined) contents.push(`Default: ${JSON.stringify(propertySchema.default)}`);
			}
			if (contents.length === 0) { return undefined; }
			return Object.freeze({
				range: rangeFromOffsets(source, match.property.keyNode.offset, match.property.keyNode.offset + match.property.keyNode.length),
				contents: Object.freeze(contents),
			});
		},
	});
}

/** Each schema retains its own reference root when several associations match one resource. */
export function getJsonSchemasForResource(registry: IJSONContributionRegistry, resource: URI | undefined): readonly JsonSchema[] {
	if (!resource) { return []; }
	const uri = resource.toString();
	const schemas = registry.getSchemaContributions().schemas;
	return Object.entries(registry.getSchemaAssociations()).flatMap(([id, patterns]) => {
		const included = patterns.some(pattern => !pattern.startsWith('!') && match(pattern, uri));
		const excluded = patterns.some(pattern => pattern.startsWith('!') && match(pattern.slice(1), uri));
		return included && !excluded && schemas[id] ? [schemas[id]] : [];
	});
}

/** Creates one comment-preserving formatter shared by JSON and JSONC resources. */
export function createJsonFormattingProvider(): DocumentFormattingEditProvider {
	return Object.freeze({
		provideDocumentFormattingEdits(model: ITextModel, options: FormattingOptions, token: CancellationToken): TextEdit[] {
			if (token.isCancellationRequested) throw new CancellationError();
			const source = model.getValue();
			if (parseJsonDocument(source, jsonParseOptions(model.getLanguageId())).errors.length > 0) return [];
			let formatted: string;
			try {
				const formattingEdits = format(source, undefined, options as JsonFormattingOptions);
				formatted = applyEdits(source, formattingEdits);
			} catch {
				return [];
			}
			if (formatted === source) return [];
			return [{ range: rangeFromOffsets(source, 0, source.length), text: formatted }];
		},
	});
}

function emptyDocumentCompletions(schema: JsonSchema, position: Position): LanguageCompletionProviderResult | undefined {
	const properties = Object.entries(schema.properties ?? {});
	if (properties.length === 0) return undefined;
	const range = Range.fromPositions(position, position);
	const items = properties.map(([key, propertySchema], index) => propertyCompletionItem(key, propertySchema, range, index, '{\n\t', '\n}'));
	return Object.freeze({ items: Object.freeze(items), isIncomplete: false });
}

function propertyCompletions(document: JsonDocument, rootSchema: JsonSchema, context: JsonPropertyCompletionContext): LanguageCompletionProviderResult | undefined {
	const path = getJsonNodePath(document.root, context.object);
	const schema = path ? jsonSchemaAtPath(rootSchema, path, document.root) : undefined;
	const properties = Object.entries(schema?.properties ?? {});
	if (properties.length === 0) return undefined;
	const existing = new Set(context.object.properties.map(property => property.key));
	if (context.currentProperty) existing.delete(context.currentProperty.key);
	const isExistingProperty = context.currentProperty?.valueNode !== undefined;
	const items: LanguageCompletionProviderItem[] = [];
	for (const [key, propertySchema] of properties) {
		if (existing.has(key)) continue;
		if (isExistingProperty) {
			items.push(Object.freeze({
				id: `property-${items.length}`,
				label: key,
				kind: LanguageCompletionItemKind.Property,
				range: context.range,
				insertText: JSON.stringify(key),
				filterText: key,
				sortText: key,
				detail: propertySchema.title,
				documentation: propertySchema.description,
			}));
			continue;
		}
		items.push(propertyCompletionItem(key, propertySchema, context.range, items.length, '', context.append));
	}
	return items.length === 0 ? undefined : Object.freeze({ items: Object.freeze(items), isIncomplete: false });
}

function propertyCompletionItem(key: string, schema: JsonSchema, range: Range, index: number, prepend: string, append: string): LanguageCompletionProviderItem {
	return Object.freeze({
		id: `property-${index}`,
		label: key,
		kind: LanguageCompletionItemKind.Property,
		range,
		insertText: `${prepend}${JSON.stringify(key)}: ${JSON.stringify(defaultValue(schema))}${append}`,
		filterText: key,
		sortText: key,
		detail: schema.title,
		documentation: schema.description,
	});
}

function propertyCompletionContext(source: string, document: JsonDocument, offset: number): JsonPropertyCompletionContext | undefined {
	if (!document.root) return undefined;
	const object = deepestObjectAtOffset(document.root, offset);
	if (!object) return undefined;
	for (const property of object.properties) {
		const keyEnd = property.keyNode.offset + property.keyNode.length;
		const hasClosingQuote = property.keyNode.length > 1 && source[keyEnd - 1] === '"';
		const editableKeyEnd = hasClosingQuote ? keyEnd - 1 : keyEnd;
		if (offset >= property.keyNode.offset + 1 && offset <= editableKeyEnd) {
			return {
				object,
				range: rangeFromOffsets(source, property.keyNode.offset, hasClosingQuote ? keyEnd : offset),
				currentProperty: property,
				append: appendAfterProperty(document, hasClosingQuote ? keyEnd : offset),
			};
		}
		if (property.valueNode && offset >= property.valueNode.offset && offset <= property.valueNode.offset + property.valueNode.length) return undefined;
	}
	const previous = [...document.tokens].reverse().find(token => token.offset + token.length <= offset);
	if (previous?.kind !== JsonTokenKind.OpenBrace && previous?.kind !== JsonTokenKind.Comma) return undefined;
	return {
		object,
		range: rangeFromOffsets(source, offset, offset),
		currentProperty: undefined,
		append: appendAfterProperty(document, offset),
	};
}

function appendAfterProperty(document: JsonDocument, offset: number): string {
	const next = document.tokens.find(token => token.offset >= offset && token.kind !== JsonTokenKind.CloseBrace);
	return next ? ',' : '';
}

function valueCompletions(source: string, document: JsonDocument, rootSchema: JsonSchema, offset: number): LanguageCompletionProviderResult | undefined {
	const arrayContext = arrayValueAtOffset(document, offset);
	let path: readonly (string | number)[];
	let range: Range;
	let append = '';
	if (arrayContext) {
		path = arrayContext.path;
		range = rangeFromOffsets(source, arrayContext.start, arrayContext.end);
		append = arrayContext.append;
	} else {
		const match = propertyAwaitingValueAtOffset(document, offset) ?? propertyAtOffset(document.root, offset);
		if (!match) return undefined;
		path = match.path;
		if (match.property.valueNode && offset >= match.property.valueNode.offset && offset <= match.property.valueNode.offset + match.property.valueNode.length) {
			if (match.property.valueNode.type === 'array' || match.property.valueNode.type === 'object') return undefined;
			range = rangeFromOffsets(source, match.property.valueNode.offset, match.property.valueNode.offset + match.property.valueNode.length);
		} else {
			const colon = document.tokens.find(token => token.kind === JsonTokenKind.Colon && token.offset >= match.property.keyNode.offset + match.property.keyNode.length && token.offset <= offset);
			if (!colon) return undefined;
			range = rangeFromOffsets(source, offset, offset);
		}
	}
	const schema = jsonSchemaAtPath(rootSchema, path, document.root);
	if (!schema) return undefined;
	const values = completionValues(schema);
	if (values.length === 0) return undefined;
	const items = values.map((value, index) => Object.freeze({
		id: `value-${index}`,
		label: JSON.stringify(value.value),
		kind: value.kind,
		range,
		insertText: `${JSON.stringify(value.value)}${append}`,
		detail: value.detail,
	}));
	return Object.freeze({ items: Object.freeze(items), isIncomplete: false });
}

/** Array edits replace only the item under the cursor; surrounding preferences stay intact. */
function arrayValueAtOffset(document: JsonDocument, offset: number): {
	readonly path: readonly (string | number)[];
	readonly start: number;
	readonly end: number;
	readonly append: string;
} | undefined {
	const visit = (node: JsonValueNode, path: readonly (string | number)[]): ReturnType<typeof arrayValueAtOffset> => {
		if (offset < node.offset || offset > node.offset + node.length) return undefined;
		if (node.type === 'object') {
			for (const property of node.properties) {
				if (!property.valueNode) continue;
				const result = visit(property.valueNode, [...path, property.key]);
				if (result) return result;
			}
		}
		if (node.type !== 'array') return undefined;
		for (let index = 0; index < node.items.length; index++) {
			const item = node.items[index]!;
			if (offset < item.offset || offset > item.offset + item.length) continue;
			if (item.type === 'array' || item.type === 'object') return visit(item, [...path, index]);
			return { path: [...path, index], start: item.offset, end: item.offset + item.length, append: '' };
		}
		const previous = [...document.tokens].reverse().find(token => token.offset + token.length <= offset
			&& token.kind !== JsonTokenKind.Trivia && token.kind !== JsonTokenKind.LineComment && token.kind !== JsonTokenKind.BlockComment);
		if (previous?.kind !== JsonTokenKind.OpenBracket && previous?.kind !== JsonTokenKind.Comma) return undefined;
		const nextIndex = node.items.findIndex(item => item.offset >= offset);
		const index = nextIndex < 0 ? node.items.length : nextIndex;
		return { path: [...path, index], start: offset, end: offset, append: nextIndex < 0 ? '' : ',' };
	};
	return document.root ? visit(document.root, []) : undefined;
}

function propertyAwaitingValueAtOffset(document: JsonDocument, offset: number): { readonly property: JsonPropertyNode; readonly path: readonly (string | number)[]; } | undefined {
	if (!document.root) return undefined;
	const object = deepestObjectAtOffset(document.root, offset);
	const objectPath = object ? getJsonNodePath(document.root, object) : undefined;
	if (!object || !objectPath) return undefined;
	for (let index = object.properties.length - 1; index >= 0; index -= 1) {
		const property = object.properties[index]!;
		const keyEnd = property.keyNode.offset + property.keyNode.length;
		const valueStart = property.valueNode?.offset ?? object.properties[index + 1]?.offset ?? object.offset + object.length;
		const colon = document.tokens.find(token => token.kind === JsonTokenKind.Colon && token.offset >= keyEnd && token.offset < valueStart);
		if (colon && offset >= colon.offset + colon.length && offset <= valueStart) {
			return { property, path: Object.freeze([...objectPath, property.key]) };
		}
	}
	return undefined;
}

interface JsonCompletionValue {
	readonly value: unknown;
	readonly kind: LanguageCompletionItemKind;
	readonly detail?: string;
}

function completionValues(schema: JsonSchema): readonly JsonCompletionValue[] {
	if (schema.enum) return schema.enum.map((value, index) => ({
		value,
		kind: LanguageCompletionItemKind.Enum,
		detail: schema.enumDescriptions?.[index],
	}));
	const values = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap(completionValues);
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	if (types.includes('boolean')) values.push(...[true, false].map(value => ({ value, kind: LanguageCompletionItemKind.Value })));
	if (values.length === 0 && schema.default !== undefined) values.push({ value: schema.default, kind: LanguageCompletionItemKind.Value });
	const unique = new Map<string, JsonCompletionValue>();
	for (const value of values) {
		const key = JSON.stringify(value.value);
		if (!unique.has(key)) unique.set(key, value);
	}
	return [...unique.values()];
}

function defaultValue(schema: JsonSchema): unknown {
	if (schema.default !== undefined) return schema.default;
	if (schema.enum?.length) return schema.enum[0];
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	switch (type) {
		case 'array': return [];
		case 'boolean': return false;
		case 'integer':
		case 'number': return 0;
		case 'object': return {};
		case 'string': return '';
		default: return null;
	}
}

function deepestObjectAtOffset(node: JsonValueNode, offset: number): JsonObjectNode | undefined {
	if (offset < node.offset || offset > node.offset + node.length) return undefined;
	if (node.type === 'object') {
		for (const property of node.properties) {
			if (!property.valueNode) continue;
			const nested = deepestObjectAtOffset(property.valueNode, offset);
			if (nested) return nested;
		}
		return node;
	}
	if (node.type === 'array') {
		for (const item of node.items) {
			const nested = deepestObjectAtOffset(item, offset);
			if (nested) return nested;
		}
	}
	return undefined;
}

function propertyAtOffset(root: JsonValueNode | undefined, offset: number, path: readonly (string | number)[] = []): { readonly property: JsonPropertyNode; readonly path: readonly (string | number)[]; } | undefined {
	if (!root || offset < root.offset || offset > root.offset + root.length) return undefined;
	if (root.type === 'object') {
		for (const property of root.properties) {
			const propertyPath = Object.freeze([...path, property.key]);
			if (offset >= property.keyNode.offset && offset <= property.keyNode.offset + property.keyNode.length) return { property, path: propertyPath };
			if (!property.valueNode) {
				if (offset >= property.offset && offset <= property.offset + property.length) return { property, path: propertyPath };
				continue;
			}
			const nested = propertyAtOffset(property.valueNode, offset, propertyPath);
			if (nested) return nested;
			if (offset >= property.valueNode.offset && offset <= property.valueNode.offset + property.valueNode.length) return { property, path: propertyPath };
		}
	}
	if (root.type === 'array') {
		for (let index = 0; index < root.items.length; index += 1) {
			const nested = propertyAtOffset(root.items[index], offset, Object.freeze([...path, index]));
			if (nested) return nested;
		}
	}
	return undefined;
}

function jsonParseOptions(languageId: string): { readonly allowComments: boolean; readonly allowTrailingComma: boolean; } {
	return { allowComments: languageId === 'jsonc', allowTrailingComma: languageId === 'jsonc' };
}

function offsetAt(source: string, position: Position): number {
	const lines = source.split('\n');
	if (position.lineNumber < 1 || position.lineNumber > lines.length || position.column < 1 || position.column > lines[position.lineNumber - 1]!.length + 1) throw new RangeError('JSON language position is outside the document');
	let offset = position.column - 1;
	for (let lineIndex = 0; lineIndex < position.lineNumber - 1; lineIndex += 1) offset += lines[lineIndex]!.length + 1;
	return offset;
}

function positionAt(source: string, offset: number): Position {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new RangeError('JSON source offset is outside the document');
	const before = source.slice(0, offset);
	const lineIndex = (before.match(/\n/gu) ?? []).length;
	const lineStart = before.lastIndexOf('\n') + 1;
	return new Position((lineIndex) + 1, (offset - lineStart) + 1);
}

function rangeFromOffsets(source: string, start: number, end: number): Range {
	return Range.fromPositions(positionAt(source, start), positionAt(source, end));
}

import { encodeHex, VSBuffer } from "../../../../base/common/buffer.js";
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import type { LinkedEditingRangeProvider, LinkedEditingRanges, TextEdit, DocumentFormattingEditProvider, LanguageFormattingOptions, LanguageFormattingProvider, LanguageFormattingRequest } from "../../../../editor/common/languages.js";
import { type ITextModel } from '../../../../editor/common/model.js';
import { type TextSnapshot } from "../../../../editor/common/core/textChange.js";
import { type LanguageCompletionProvider, type LanguageCompletionProviderItem, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult } from "../../../../editor/common/languages/completion/languageCompletionProviders.js";
import { LanguageCompletionInsertTextFormat, LanguageCompletionItemKind } from "../../../../editor/common/languages/completion/languageCompletions.js";
import type { LanguageProviderBatch } from '../../../../editor/common/services/languageFeatures.js';
import type { LanguageHover, LanguageHoverContent, LanguageHoverProvider, LanguageHoverRequest } from "../../../../editor/contrib/hover/common/hover.js";
import type { LanguageInlayHint, LanguageInlayHintLabel, LanguageInlayHintsProvider, LanguageInlayHintsRequest } from "../../../../editor/contrib/inlayHints/common/languageInlayHints.js";
import type { LanguageParameterHints, LanguageParameterHintsProvider, LanguageParameterHintsRequest } from "../../../../editor/contrib/parameterHints/common/languageParameterHints.js";
import type { ExtensionHostLanguageRegistration, JsonValue } from "../../../../platform/extensionHost/common/extensionHostApi.js";

export const SUPPORTED_EXTENSION_HOST_LANGUAGE_OPERATIONS = Object.freeze(["completion", "hover", "formatting", "inlayHints", "linkedEditing", "parameterHints"] as const);

export type ExtensionHostProviderInvoker = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

/** Projects one all-or-nothing Host registration into the canonical language provider batch. */
export function createExtensionHostLanguageProviderBatch(registration: ExtensionHostLanguageRegistration, providerId: string, invoke: ExtensionHostProviderInvoker): LanguageProviderBatch {
	const operations = new Set(registration.operations);
	const languageIds = registration.languageIds;
	return Object.freeze({
		completions: Object.freeze(operations.has("completion") ? [completionProvider(providerId, languageIds, invoke)] : []),
		hovers: Object.freeze(operations.has("hover") ? [Object.freeze({ selector: languageIds, provider: hoverProvider(invoke) })] : []),
		formatting: Object.freeze(operations.has("formatting") ? [Object.freeze({ selector: languageIds, provider: formattingProvider(invoke) })] : []),
		inlayHints: Object.freeze(operations.has("inlayHints") ? [Object.freeze({ selector: languageIds, provider: inlayHintsProvider(invoke) })] : []),
		linkedEditing: Object.freeze(operations.has("linkedEditing") ? [Object.freeze({ selector: languageIds, provider: linkedEditingProvider(invoke) })] : []),
		parameterHints: Object.freeze(operations.has("parameterHints") ? [Object.freeze({ selector: languageIds, provider: parameterHintsProvider(invoke) })] : []),
	});
}

export function unsupportedExtensionHostLanguageOperations(registration: ExtensionHostLanguageRegistration): readonly string[] {
	const supported = new Set<string>(SUPPORTED_EXTENSION_HOST_LANGUAGE_OPERATIONS);
	return Object.freeze(registration.operations.filter(operation => !supported.has(operation)));
}

export function extensionHostLanguageProviderId(extensionId: string, registrationId: string): string {
	return `extensionHost.${hexIdentifier(extensionId)}.${hexIdentifier(registrationId)}`;
}

function completionProvider(id: string, languageIds: readonly string[], invoke: ExtensionHostProviderInvoker): LanguageCompletionProvider {
	return Object.freeze({
		id,
		languageIds,
		provideCompletions: async (request: LanguageCompletionProviderRequest, signal: AbortSignal): Promise<LanguageCompletionProviderResult> => normalizeCompletionResult(await invoke("completion", completionPayload(request), signal), request.snapshot),
	});
}

function hoverProvider(invoke: ExtensionHostProviderInvoker): LanguageHoverProvider {
	return Object.freeze({
		provideHover: async (request: LanguageHoverRequest, signal: AbortSignal): Promise<LanguageHover | undefined> => normalizeHoverResult(await invoke("hover", featurePayload(request, { position: positionValue(request.position) }), signal), request.snapshot),
	});
}

function formattingProvider(invoke: ExtensionHostProviderInvoker): DocumentFormattingEditProvider & LanguageFormattingProvider {
	const call = async (kind: "document" | "range" | "onType", request: LanguageFormattingRequest, signal: AbortSignal): Promise<readonly TextEdit[]> => normalizeFormattingResult(await invoke("formatting", formattingPayload(kind, request), signal), request.snapshot);
	return Object.freeze({
		provideDocumentFormattingEdits: async (model: ITextModel, options: LanguageFormattingOptions, token: CancellationToken): Promise<TextEdit[]> => {
			const request = modelRequest(model);
			const value = await withAbortSignal(token, signal => invoke('formatting', featurePayload(request, { kind: 'document', options: formattingOptionsValue(options) }), signal));
			return [...normalizeFormattingResult(value, request.snapshot)];
		},
		provideRangeFormattingEdits: (request: LanguageFormattingRequest, signal: AbortSignal) => call("range", request, signal),
		provideOnTypeFormattingEdits: (request: LanguageFormattingRequest, signal: AbortSignal) => call("onType", request, signal),
	});
}

function inlayHintsProvider(invoke: ExtensionHostProviderInvoker): LanguageInlayHintsProvider {
	return Object.freeze({
		provideInlayHints: async (request: LanguageInlayHintsRequest, signal: AbortSignal): Promise<readonly LanguageInlayHint[]> => normalizeInlayHintsResult(await invoke("inlayHints", featurePayload(request, { range: rangeValue(request.range) }), signal), request.snapshot),
	});
}

function linkedEditingProvider(invoke: ExtensionHostProviderInvoker): LinkedEditingRangeProvider {
	return Object.freeze({
		provideLinkedEditingRanges: async (model: ITextModel, position: Position, token: CancellationToken): Promise<LinkedEditingRanges | undefined> => {
			const request = modelRequest(model);
			const value = await withAbortSignal(token, signal => invoke('linkedEditing', featurePayload(request, { position: positionValue(position) }), signal));
			return normalizeLinkedEditingResult(value, request.snapshot);
		},
	});
}

function parameterHintsProvider(invoke: ExtensionHostProviderInvoker): LanguageParameterHintsProvider {
	return Object.freeze({
		provideParameterHints: async (request: LanguageParameterHintsRequest, signal: AbortSignal): Promise<LanguageParameterHints | undefined> => normalizeParameterHintsResult(await invoke("parameterHints", featurePayload(request, { position: positionValue(request.position), context: parameterHintsContextValue(request) }), signal)),
	});
}

function parameterHintsContextValue(request: LanguageParameterHintsRequest): JsonValue {
	return request.context.kind === "triggerCharacter" ? Object.freeze({ kind: request.context.kind, triggerCharacter: request.context.triggerCharacter }) : Object.freeze({ kind: request.context.kind });
}

function completionPayload(request: LanguageCompletionProviderRequest): JsonValue {
	return featurePayload(request, {
		requestId: request.requestId,
		position: positionValue(request.position),
		context: request.context.kind === "triggerCharacter" ? { kind: request.context.kind, triggerCharacter: request.context.triggerCharacter } : { kind: request.context.kind },
	});
}

function formattingPayload(kind: "document" | "range" | "onType", request: LanguageFormattingRequest): JsonValue {
	return featurePayload(request, {
		kind,
		options: formattingOptionsValue(request.options),
		...(request.range ? { range: rangeValue(request.range) } : {}),
		...(request.position ? { position: positionValue(request.position) } : {}),
		...(request.ch === undefined ? {} : { ch: request.ch }),
	});
}

function featurePayload(request: { readonly languageId: string; readonly resource?: { toString(): string }; readonly snapshot: TextSnapshot }, fields: Record<string, JsonValue>): JsonValue {
	return Object.freeze({
		languageId: request.languageId,
		version: request.snapshot.version,
		text: request.snapshot.getText(),
		...(request.resource ? { resource: request.resource.toString() } : {}),
		...fields,
	});
}

function formattingOptionsValue(options: LanguageFormattingOptions): JsonValue {
	return Object.freeze({ tabSize: options.tabSize, insertSpaces: options.insertSpaces, ...(options.trimTrailingWhitespace === undefined ? {} : { trimTrailingWhitespace: options.trimTrailingWhitespace }) });
}

function positionValue(position: Position): JsonValue {
	return Object.freeze({ lineIndex: position.lineNumber - 1, columnIndex: position.column - 1 });
}

function rangeValue(range: Range): JsonValue {
	return Object.freeze({ start: positionValue(range.getStartPosition()), end: positionValue(range.getEndPosition()) });
}

function normalizeCompletionResult(value: JsonValue, snapshot: TextSnapshot): LanguageCompletionProviderResult {
	const result = exactObject(value, "Extension completion result", ["isIncomplete", "items"]);
	if (typeof result.isIncomplete !== "boolean") throw new TypeError("Extension completion isIncomplete is invalid");
	const items = boundedArray(result.items, "Extension completion items", 10_000).map((item, index) => normalizeCompletionItem(item, snapshot, index));
	return Object.freeze({ items: Object.freeze(items), isIncomplete: result.isIncomplete });
}

function normalizeCompletionItem(value: JsonValue, snapshot: TextSnapshot, index: number): LanguageCompletionProviderItem {
	const item = object(value, `Extension completion item ${index}`);
	const allowed = ["additionalTextEdits", "commitCharacters", "detail", "documentation", "filterText", "id", "insertText", "insertTextFormat", "kind", "label", "preselect", "range", "sortText"];
	assertAllowedKeys(item, `Extension completion item ${index}`, allowed, ["id", "insertText", "kind", "label", "range"]);
	const kind = textEnum(item.kind, `Extension completion item ${index} kind`, Object.values(LanguageCompletionItemKind));
	const insertTextFormat = item.insertTextFormat === undefined ? undefined : textEnum(item.insertTextFormat, `Extension completion item ${index} insertTextFormat`, Object.values(LanguageCompletionInsertTextFormat));
	const commitCharacters = item.commitCharacters === undefined ? undefined : boundedArray(item.commitCharacters, `Extension completion item ${index} commit characters`, 64).map((character, characterIndex) => oneCodePoint(character, `Extension completion item ${index} commit character ${characterIndex}`));
	const additionalTextEdits = item.additionalTextEdits === undefined ? undefined : boundedArray(item.additionalTextEdits, `Extension completion item ${index} additional edits`, 1024).map((edit, editIndex) => normalizeTextEdit(edit, snapshot, `Extension completion item ${index} additional edit ${editIndex}`));
	return Object.freeze({
		id: identifier(item.id, `Extension completion item ${index} ID`),
		label: boundedString(item.label, `Extension completion item ${index} label`, 4096, false),
		kind,
		range: normalizeRange(item.range, snapshot, `Extension completion item ${index} range`),
		insertText: boundedString(item.insertText, `Extension completion item ${index} insert text`, 1_048_576, true),
		...(insertTextFormat === undefined ? {} : { insertTextFormat }),
		...optionalString(item.detail, `Extension completion item ${index} detail`, 16_384, "detail"),
		...optionalString(item.documentation, `Extension completion item ${index} documentation`, 262_144, "documentation"),
		...optionalString(item.filterText, `Extension completion item ${index} filter text`, 4096, "filterText"),
		...optionalString(item.sortText, `Extension completion item ${index} sort text`, 4096, "sortText"),
		...optionalBoolean(item.preselect, `Extension completion item ${index} preselect`, "preselect"),
		...(commitCharacters === undefined ? {} : { commitCharacters: Object.freeze(commitCharacters) }),
		...(additionalTextEdits === undefined ? {} : { additionalTextEdits: Object.freeze(additionalTextEdits) }),
	});
}

function normalizeHoverResult(value: JsonValue, snapshot: TextSnapshot): LanguageHover | undefined {
	if (value === null) return undefined;
	const result = object(value, "Extension hover result");
	assertAllowedKeys(result, "Extension hover result", ["contents", "range"], ["contents"]);
	const contents = boundedArray(result.contents, "Extension hover contents", 256).map((content, index): LanguageHoverContent => {
		if (typeof content === "string") return boundedString(content, `Extension hover content ${index}`, 262_144, true);
		const marked = exactObject(content, `Extension hover content ${index}`, content && typeof content === "object" && "language" in content ? ["language", "value"] : ["value"]);
		return Object.freeze({ value: boundedString(marked.value, `Extension hover content ${index} value`, 262_144, true), ...(marked.language === undefined ? {} : { language: boundedString(marked.language, `Extension hover content ${index} language`, 256, false) }) });
	});
	if (contents.length === 0) throw new TypeError("Extension hover contents must not be empty");
	return Object.freeze({ ...(result.range === undefined ? {} : { range: normalizeRange(result.range, snapshot, "Extension hover range") }), contents: Object.freeze(contents) });
}

function normalizeFormattingResult(value: JsonValue, snapshot: TextSnapshot): readonly TextEdit[] {
	const result = exactObject(value, "Extension formatting result", ["edits"]);
	const edits = boundedArray(result.edits, "Extension formatting edits", 10_000).map((edit, index) => normalizeTextEdit(edit, snapshot, `Extension formatting edit ${index}`));
	return Object.freeze(edits);
}

function normalizeTextEdit(value: JsonValue, snapshot: TextSnapshot, owner: string) {
	const edit = exactObject(value, owner, ["range", "text"]);
	return Object.freeze({ range: normalizeRange(edit.range, snapshot, `${owner} range`), text: boundedString(edit.text, `${owner} text`, 1_048_576, true) });
}

function normalizeInlayHintsResult(value: JsonValue, snapshot: TextSnapshot): readonly LanguageInlayHint[] {
	const result = exactObject(value, "Extension Inlay Hints result", ["hints"]);
	const hints = boundedArray(result.hints, "Extension Inlay Hints", 10_000).map((hint, index) => normalizeInlayHint(hint, snapshot, index));
	return Object.freeze(hints);
}

function normalizeInlayHint(value: JsonValue, snapshot: TextSnapshot, index: number): LanguageInlayHint {
	const hint = object(value, `Extension Inlay Hint ${index}`);
	assertAllowedKeys(hint, `Extension Inlay Hint ${index}`, ["kind", "label", "paddingLeft", "paddingRight", "position", "tooltip"], ["label", "position"]);
	const label = normalizeInlayLabel(hint.label, snapshot, index);
	const kind = hint.kind === undefined ? undefined : textEnum(hint.kind, `Extension Inlay Hint ${index} kind`, ["type", "parameter", "other"] as const);
	return Object.freeze({
		position: normalizePosition(hint.position, snapshot, `Extension Inlay Hint ${index} position`),
		label,
		...(kind === undefined ? {} : { kind }),
		...optionalString(hint.tooltip, `Extension Inlay Hint ${index} tooltip`, 262_144, "tooltip"),
		...optionalBoolean(hint.paddingLeft, `Extension Inlay Hint ${index} paddingLeft`, "paddingLeft"),
		...optionalBoolean(hint.paddingRight, `Extension Inlay Hint ${index} paddingRight`, "paddingRight"),
	});
}

function normalizeInlayLabel(value: JsonValue | undefined, snapshot: TextSnapshot, index: number): LanguageInlayHintLabel {
	if (typeof value === "string") return boundedString(value, `Extension Inlay Hint ${index} label`, 16_384, false);
	const parts = boundedArray(value, `Extension Inlay Hint ${index} label parts`, 256).map((part, partIndex) => {
		const input = object(part, `Extension Inlay Hint ${index} label part ${partIndex}`);
		assertAllowedKeys(input, `Extension Inlay Hint ${index} label part ${partIndex}`, ["location", "value"], ["value"]);
		return Object.freeze({ value: boundedString(input.value, `Extension Inlay Hint ${index} label part ${partIndex} value`, 4096, false), ...(input.location === undefined ? {} : { location: normalizeRange(input.location, snapshot, `Extension Inlay Hint ${index} label part ${partIndex} location`) }) });
	});
	if (parts.length === 0) throw new TypeError(`Extension Inlay Hint ${index} label parts must not be empty`);
	return Object.freeze(parts);
}

function normalizeLinkedEditingResult(value: JsonValue, snapshot: TextSnapshot): LinkedEditingRanges | undefined {
	if (value === null) return undefined;
	const result = exactObject(value, "Extension Linked Editing result", ["ranges"]);
	const ranges = boundedArray(result.ranges, "Extension Linked Editing ranges", 1024).map((range, index) => normalizeRange(range, snapshot, `Extension Linked Editing range ${index}`));
	if (ranges.length === 0) throw new TypeError("Extension Linked Editing ranges must not be empty");
	return Object.freeze({ ranges });
}

function modelRequest(model: ITextModel): { readonly languageId: string; readonly resource: { toString(): string }; readonly snapshot: TextSnapshot } {
	const text = model.getValue();
	const snapshot: TextSnapshot = Object.freeze({
		version: model.getVersionId(),
		length: text.length,
		lineCount: model.getLineCount(),
		getText: () => text,
		getTextBetweenOffsets: (startOffset: number, endOffset: number) => text.slice(startOffset, endOffset),
	});
	return Object.freeze({ languageId: model.getLanguageId(), resource: model.uri, snapshot });
}

async function withAbortSignal<T>(token: CancellationToken, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	if (token.isCancellationRequested) controller.abort();
	const listener = token.onCancellationRequested(() => controller.abort());
	try {
		return await run(controller.signal);
	} finally {
		listener.dispose();
	}
}

function normalizeParameterHintsResult(value: JsonValue): LanguageParameterHints | undefined {
	if (value === null) return undefined;
	const result = object(value, "Extension Parameter Hints result");
	assertAllowedKeys(result, "Extension Parameter Hints result", ["activeSignature", "signatures"], ["signatures"]);
	const signatures = boundedArray(result.signatures, "Extension Parameter Hints signatures", 256).map((signature, signatureIndex) => {
		const input = object(signature, `Extension Parameter Hints signature ${signatureIndex}`);
		assertAllowedKeys(input, `Extension Parameter Hints signature ${signatureIndex}`, ["activeParameter", "documentation", "label", "parameters"], ["label", "parameters"]);
		const parameters = boundedArray(input.parameters, `Extension Parameter Hints signature ${signatureIndex} parameters`, 256).map((parameter, parameterIndex) => {
			const value = object(parameter, `Extension Parameter Hints parameter ${signatureIndex}/${parameterIndex}`);
			assertAllowedKeys(value, `Extension Parameter Hints parameter ${signatureIndex}/${parameterIndex}`, ["documentation", "label"], ["label"]);
			return Object.freeze({ label: boundedString(value.label, `Extension Parameter Hints parameter ${signatureIndex}/${parameterIndex} label`, 4096, false), ...optionalString(value.documentation, `Extension Parameter Hints parameter ${signatureIndex}/${parameterIndex} documentation`, 262_144, "documentation") });
		});
		const activeParameter = input.activeParameter === undefined ? undefined : boundedIndex(input.activeParameter, parameters.length, `Extension Parameter Hints signature ${signatureIndex} active parameter`);
		return Object.freeze({ label: boundedString(input.label, `Extension Parameter Hints signature ${signatureIndex} label`, 16_384, false), ...optionalString(input.documentation, `Extension Parameter Hints signature ${signatureIndex} documentation`, 262_144, "documentation"), parameters: Object.freeze(parameters), ...(activeParameter === undefined ? {} : { activeParameter }) });
	});
	const activeSignature = result.activeSignature === undefined ? undefined : boundedIndex(result.activeSignature, signatures.length, "Extension Parameter Hints active signature");
	return Object.freeze({ signatures: Object.freeze(signatures), ...(activeSignature === undefined ? {} : { activeSignature }) });
}

function normalizePosition(value: JsonValue | undefined, snapshot: TextSnapshot, owner: string): Position {
	const position = exactObject(value, owner, ["columnIndex", "lineIndex"]);
	const lineIndex = nonNegativeInteger(position.lineIndex, `${owner} lineIndex`);
	const columnIndex = nonNegativeInteger(position.columnIndex, `${owner} columnIndex`);
	const lines = snapshot.getText().split("\n");
	if (lineIndex >= lines.length || columnIndex > lines[lineIndex]!.length) throw new RangeError(`${owner} is outside the document snapshot`);
	return new Position((lineIndex) + 1, (columnIndex) + 1);
}

function normalizeRange(value: JsonValue | undefined, snapshot: TextSnapshot, owner: string): Range {
	const range = exactObject(value, owner, ["end", "start"]);
	return Range.fromPositions(normalizePosition(range.start, snapshot, `${owner} start`), normalizePosition(range.end, snapshot, `${owner} end`));
}

function exactObject(value: JsonValue | undefined, owner: string, keys: readonly string[]): Record<string, JsonValue> {
	const result = object(value, owner);
	const actual = Object.keys(result).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${owner} has an invalid shape`);
	return result;
}

function object(value: JsonValue | undefined, owner: string): Record<string, JsonValue> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, JsonValue>;
}

function assertAllowedKeys(value: Record<string, JsonValue>, owner: string, allowed: readonly string[], required: readonly string[]): void {
	const keys = Object.keys(value);
	if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${owner} has an invalid shape`);
}

function boundedArray(value: JsonValue | undefined, owner: string, maximum: number): readonly JsonValue[] {
	if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}

function boundedString(value: JsonValue | undefined, owner: string, maximum: number, allowEmpty: boolean): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} is invalid`);
	return value;
}

function identifier(value: JsonValue | undefined, owner: string): string {
	const result = boundedString(value, owner, 256, false);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) throw new TypeError(`${owner} is invalid`);
	return result;
}

function oneCodePoint(value: JsonValue, owner: string): string {
	const result = boundedString(value, owner, 8, false);
	if ([...result].length !== 1) throw new TypeError(`${owner} must contain one Unicode code point`);
	return result;
}

function textEnum<const T extends readonly string[]>(value: JsonValue | undefined, owner: string, values: T): T[number] {
	if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${owner} is invalid`);
	return value as T[number];
}

function optionalString(value: JsonValue | undefined, owner: string, maximum: number, field: string): Record<string, string> {
	return value === undefined ? {} : { [field]: boundedString(value, owner, maximum, true) };
}

function optionalBoolean(value: JsonValue | undefined, owner: string, field: string): Record<string, boolean> {
	if (value === undefined) return {};
	if (typeof value !== "boolean") throw new TypeError(`${owner} is invalid`);
	return { [field]: value };
}

function nonNegativeInteger(value: JsonValue | undefined, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${owner} is invalid`);
	return value as number;
}

function boundedIndex(value: JsonValue | undefined, length: number, owner: string): number {
	const index = nonNegativeInteger(value, owner);
	if (index >= length) throw new RangeError(`${owner} is outside its collection`);
	return index;
}

function hexIdentifier(value: string): string {
	return encodeHex(VSBuffer.fromString(value));
}

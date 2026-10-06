import { URI } from '../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { encodeHex, VSBuffer } from "../../../base/common/buffer.js";
import { type CancellationToken } from '../../../base/common/cancellation.js';
import { Position } from "../../../editor/common/core/position.js";
import { Range } from "../../../editor/common/core/range.js";
import * as languages from '../../../editor/common/languages.js';
import { type ITextModel } from '../../../editor/common/model.js';
import { type TextSnapshot } from "../../../editor/common/core/textChange.js";

import type { LanguageProviderBatch } from '../../../editor/common/services/languageFeatures.js';
import type { ExtensionHostLanguageRegistration, JsonValue } from "../../../platform/extensionHost/common/extensionHostApi.js";

export const SUPPORTED_EXTENSION_HOST_LANGUAGE_OPERATIONS = Object.freeze(["diagnostics", "selectionRanges", "documentHighlights", "workspaceSymbols", "completion", "hover", "formatting", "inlayHints", "linkedEditing", "parameterHints", "definition", "references", "rename", "documentSymbols", "foldingRanges", "documentLinks", "codeAction"] as const);

export type ExtensionHostProviderInvoker = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

/** Projects one all-or-nothing Host registration into the canonical language provider batch. */
export function createExtensionHostLanguageProviderBatch(
	registration: ExtensionHostLanguageRegistration,
	extensionId: string,
	providerId: string,
	invoke: ExtensionHostProviderInvoker,
): LanguageProviderBatch {
	const operations = new Set(registration.operations);
	const languageIds = registration.languageIds;
	return Object.freeze({
		documentHighlights: operations.has('documentHighlights')
			? [{ selector: languageIds, provider: documentHighlightsProvider(invoke) }]
			: [],
		syntax: operations.has('diagnostics') ? [syntaxProvider(providerId, languageIds, extensionId, invoke)] : [],
		workspaceSymbols: operations.has('workspaceSymbols') ? [{ selector: languageIds, provider: workspaceSymbolsProvider(invoke) }] : [],
		selectionRanges: operations.has('selectionRanges') ? [{ selector: languageIds, provider: selectionRangesProvider(invoke) }] : [],
		definitions: operations.has('definition') ? [{ selector: languageIds, provider: definitionsProvider(invoke) }] : [],
		references: operations.has('references') ? [{ selector: languageIds, provider: referencesProvider(invoke) }] : [],
		renames: operations.has('rename') ? [{ selector: languageIds, provider: renamesProvider(invoke) }] : [],
		documentSymbols: operations.has('documentSymbols') ? [{ selector: languageIds, provider: documentSymbolsProvider(invoke) }] : [],
		foldingRanges: operations.has('foldingRanges') ? [{ selector: languageIds, provider: foldingRangesProvider(invoke) }] : [],
		documentLinks: operations.has('documentLinks') ? [{ selector: languageIds, provider: documentLinksProvider(invoke) }] : [],
		codeActions: operations.has('codeAction') ? [{ selector: languageIds, provider: codeActionsProvider(invoke) }] : [],
		completions: Object.freeze(
			operations.has('completion')
				? [completionProvider(providerId, languageIds, registration.completionTriggerCharacters ?? [], invoke)]
				: [],
		),
		hovers: Object.freeze(operations.has('hover') ? [Object.freeze({ selector: languageIds, provider: hoverProvider(invoke) })] : []),
		formatting: Object.freeze(
			operations.has('formatting')
				? [
					Object.freeze({
						selector: languageIds,
						provider: formattingProvider(new ExtensionIdentifier(extensionId), invoke),
					}),
				]
				: [],
		),
		inlayHints: Object.freeze(
			operations.has('inlayHints') ? [Object.freeze({ selector: languageIds, provider: inlayHintsProvider(invoke) })] : [],
		),
		linkedEditing: Object.freeze(
			operations.has('linkedEditing') ? [Object.freeze({ selector: languageIds, provider: linkedEditingProvider(invoke) })] : [],
		),
		parameterHints: Object.freeze(
			operations.has('parameterHints') ? [Object.freeze({ selector: languageIds, provider: parameterHintsProvider(invoke) })] : [],
		),
	});
}


export function unsupportedExtensionHostLanguageOperations(registration: ExtensionHostLanguageRegistration): readonly string[] {
	const supported = new Set<string>(SUPPORTED_EXTENSION_HOST_LANGUAGE_OPERATIONS);
	return Object.freeze(registration.operations.filter(operation => !supported.has(operation)));
}

export function extensionHostLanguageProviderId(extensionId: string, registrationId: string): string {
	return `extensionHost.${hexIdentifier(extensionId)}.${hexIdentifier(registrationId)}`;
}

function documentHighlightsProvider(invoke: ExtensionHostProviderInvoker): languages.DocumentHighlightProvider {
	return {
		provideDocumentHighlights: async (model, position, token) => {
			const request = modelRequest(model);
			const value = await withAbortSignal(token, signal =>
				invoke('documentHighlights', featurePayload(request, { position: positionValue(position) }), signal),
			);
			return boundedArray(value, 'Extension highlights', 8192).map(value => {
				const highlight = exactObject(value, 'Extension highlight', ['range', 'kind']);
				const kind = nonNegativeInteger(highlight.kind, 'Extension highlight kind');
				if (kind < 1 || kind > 3) throw new TypeError('Invalid extension highlight kind');
				return {
					range: normalizeRange(highlight.range, request.snapshot, 'Extension highlight range'),
					kind: kind - 1,
				};
			});
		},
	};
}

function syntaxProvider(
	providerId: string,
	languageIds: readonly string[],
	extensionId: string,
	invoke: ExtensionHostProviderInvoker,
): languages.SyntaxProvider {
	return {
		id: providerId,
		languageIds,
		diagnosticPriority: 10,
		provideDiagnostics: async (request, signal) => {
			const value = exactObject(await invoke('diagnostics', featurePayload(request, {}), signal), 'Extension diagnostics', [
				'diagnostics',
			]);
			return {
				diagnostics: boundedArray(value.diagnostics, 'Extension diagnostics', 8192).map(value => {
					const diagnostic = object(value, 'Extension diagnostic');
					assertAllowedKeys(
						diagnostic,
						'Extension diagnostic',
						['range', 'severity', 'message', 'code'],
						['range', 'severity', 'message'],
					);
					return {
						range: normalizeRange(diagnostic.range, request.snapshot, 'Extension diagnostic range'),
						severity: textEnum(
							diagnostic.severity,
							'Extension diagnostic severity',
							Object.values(languages.LanguageDiagnosticSeverity),
						),
						message: boundedString(diagnostic.message, 'Extension diagnostic message', 16384, false),
						...optionalString(diagnostic.code, 'Extension diagnostic code', 256, 'code'),
						source: extensionId,
					};
				}),
			};
		},
	};
}

function workspaceSymbolsProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageWorkspaceSymbolProvider {
	return {
		provideWorkspaceSymbols: async (query, signal) =>
			boundedArray(await invoke('workspaceSymbols', { query }, signal), 'Extension workspace symbols', 8192).map(value => {
				const symbol = exactObject(value, 'Extension workspace symbol', ['name', 'kind', 'resource', 'range']);
				return {
					name: boundedString(symbol.name, 'Extension symbol name', 4096, false),
					kind: nonNegativeInteger(symbol.kind, 'Extension symbol kind'),
					resource: URI.parse(boundedString(symbol.resource, 'Extension symbol resource', 8192, false)),
					range: normalizeExternalRange(symbol.range),
				};
			}),
	};
}

function selectionRangesProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageSelectionRangeProvider {
	return {
		provideSelectionRanges: async (request, signal) =>
			boundedArray(
				await invoke(
					'selectionRanges',
					featurePayload(request, {
						positions: request.ranges.map(range => positionValue(range.getStartPosition())),
					}),
					signal,
				),
				'Extension selections',
				8192,
			).map(value => normalizeRange(value, request.snapshot, 'Extension selection range')),
	};
}

function definitionsProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageDefinitionProvider {
	return {
		provideDefinition: async (request, signal) =>
			normalizeLocations(await invoke('definition', featurePayload(request, { position: positionValue(request.position) }), signal)),
	};
}

function referencesProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageReferenceProvider {
	return {
		provideReferences: async (request, signal) =>
			normalizeLocations(
				await invoke(
					'references',
					featurePayload(request, {
						position: positionValue(request.position),
						includeDeclaration: request.includeDeclaration,
					}),
					signal,
				),
			),
	};
}

function renamesProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageRenameProvider {
	return {
		prepareRename: async (request, signal) => {
			const value = await invoke(
				'rename',
				featurePayload(request, {
					position: positionValue(request.position),
					kind: 'prepare',
				}),
				signal,
			);
			if (value === null) return undefined;
			const result = exactObject(value, 'Extension rename preparation', ['range', 'placeholder']);
			return {
				range: normalizeRange(result.range, request.snapshot, 'Extension rename range'),
				placeholder: boundedString(result.placeholder, 'Extension rename placeholder', 4096, true),
			};
		},
		provideRenameEdits: async (request, signal) =>
			normalizeWorkspaceEdit(
				await invoke(
					'rename',
					featurePayload(request, {
						position: positionValue(request.position),
						kind: 'edit',
						newName: request.newName ?? '',
					}),
					signal,
				),
			),
	};
}

function documentSymbolsProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageDocumentSymbolProvider {
	return {
		provideDocumentSymbols: async (request, signal) =>
			normalizeSymbols(await invoke('documentSymbols', featurePayload(request, {}), signal), request.snapshot),
	};
}

function foldingRangesProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageFoldingRangeProvider {
	return {
		provideFoldingRanges: async (request, signal) =>
			boundedArray(await invoke('foldingRanges', featurePayload(request, {}), signal), 'Extension folds', 8192).map(value => {
				const fold = object(value, 'Extension fold');
				assertAllowedKeys(fold, 'Extension fold', ['startLineIndex', 'endLineIndex', 'kind'], ['startLineIndex', 'endLineIndex']);
				const startLineIndex = nonNegativeInteger(fold.startLineIndex, 'Extension fold start');
				const endLineIndex = nonNegativeInteger(fold.endLineIndex, 'Extension fold end');
				if (endLineIndex < startLineIndex || endLineIndex >= request.snapshot.lineCount)
					throw new RangeError('Extension fold is outside the document');
				return {
					startLineIndex,
					endLineIndex,
					...(fold.kind === undefined
						? {}
						: {
							kind: textEnum(fold.kind, 'Extension fold kind', ['comment', 'imports', 'region'] as const),
						}),
				};
			}),
	};
}

function documentLinksProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageLinkProvider {
	return {
		provideLinks: async (request, signal) =>
			boundedArray(await invoke('documentLinks', featurePayload(request, {}), signal), 'Extension links', 8192).map(value => {
				const link = exactObject(value, 'Extension link', ['range', 'target']);
				return {
					range: normalizeRange(link.range, request.snapshot, 'Extension link range'),
					target: boundedString(link.target, 'Extension link target', 8192, false),
				};
			}),
	};
}

function codeActionsProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageCodeActionProvider {
	return {
		provideCodeActions: async (request, signal) =>
			boundedArray(
				await invoke(
					'codeAction',
					featurePayload(request, {
						range: rangeValue(request.range),
						only: request.only ?? [],
					}),
					signal,
				),
				'Extension code actions',
				1024,
			).map(value => {
				const action = object(value, 'Extension code action');
				assertAllowedKeys(action, 'Extension code action', ['title', 'kind', 'edit', 'disabledReason'], ['title']);
				return {
					title: boundedString(action.title, 'Extension action title', 4096, false),
					...optionalString(action.kind, 'Extension action kind', 256, 'kind'),
					...optionalString(action.disabledReason, 'Extension action disabled', 4096, 'disabledReason'),
					...(action.edit === undefined ? {} : { edit: normalizeWorkspaceEdit(action.edit) }),
				};
			}),
	};
}

function completionProvider(id: string, languageIds: readonly string[], triggerCharacters: readonly string[], invoke: ExtensionHostProviderInvoker): languages.LanguageCompletionProvider {
	return Object.freeze({
		id,
		languageIds,
		triggerCharacters,
		provideCompletions: async (request: languages.LanguageCompletionProviderRequest, signal: AbortSignal): Promise<languages.LanguageCompletionProviderResult> => normalizeCompletionResult(await invoke("completion", completionPayload(request), signal), request.snapshot),
	});
}

function hoverProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageHoverProvider {
	return Object.freeze({
		provideHover: async (request: languages.LanguageHoverRequest, signal: AbortSignal): Promise<languages.LanguageHover | undefined> => normalizeHoverResult(await invoke("hover", featurePayload(request, { position: positionValue(request.position) }), signal), request.snapshot),
	});
}

function formattingProvider(extensionId: ExtensionIdentifier, invoke: ExtensionHostProviderInvoker): languages.DocumentFormattingEditProvider & languages.DocumentRangeFormattingEditProvider {
	return Object.freeze({
		extensionId,
		provideDocumentFormattingEdits: async (model: ITextModel, options: languages.LanguageFormattingOptions, token: CancellationToken): Promise<languages.TextEdit[]> => {
			const request = modelRequest(model);
			const value = await withAbortSignal(token, signal => invoke('formatting', featurePayload(request, { kind: 'document', options: formattingOptionsValue(options) }), signal));
			return [...normalizeFormattingResult(value, request.snapshot)];
		},
		provideDocumentRangeFormattingEdits: async (model: ITextModel, range: Range, options: languages.LanguageFormattingOptions, token: CancellationToken): Promise<languages.TextEdit[]> => {
			const request = modelRequest(model);
			const value = await withAbortSignal(token, signal => invoke('formatting', featurePayload(request, { kind: 'range', range: rangeValue(range), options: formattingOptionsValue(options) }), signal));
			return [...normalizeFormattingResult(value, request.snapshot)];
		},
	});
}

function inlayHintsProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageInlayHintsProvider {
	return Object.freeze({
		provideInlayHints: async (request: languages.LanguageInlayHintsRequest, signal: AbortSignal): Promise<readonly languages.LanguageInlayHint[]> => normalizeInlayHintsResult(await invoke("inlayHints", featurePayload(request, { range: rangeValue(request.range) }), signal), request.snapshot),
	});
}

function linkedEditingProvider(invoke: ExtensionHostProviderInvoker): languages.LinkedEditingRangeProvider {
	return Object.freeze({
		provideLinkedEditingRanges: async (model: ITextModel, position: Position, token: CancellationToken): Promise<languages.LinkedEditingRanges | undefined> => {
			const request = modelRequest(model);
			const value = await withAbortSignal(token, signal => invoke('linkedEditing', featurePayload(request, { position: positionValue(position) }), signal));
			return normalizeLinkedEditingResult(value, request.snapshot);
		},
	});
}

function parameterHintsProvider(invoke: ExtensionHostProviderInvoker): languages.LanguageParameterHintsProvider {
	return Object.freeze({
		signatureHelpTriggerCharacters: Object.freeze(['(', ',']),
		provideParameterHints: async (request: languages.LanguageParameterHintsRequest, signal: AbortSignal): Promise<languages.LanguageParameterHints | undefined> => normalizeParameterHintsResult(await invoke("parameterHints", featurePayload(request, { position: positionValue(request.position), context: parameterHintsContextValue(request) }), signal)),
	});
}

function parameterHintsContextValue(request: languages.LanguageParameterHintsRequest): JsonValue {
	const context = request.context;
	const hints = context.activeSignatureHelp;
	return {
		kind: context.kind,
		...(context.kind === 'triggerCharacter' ? { triggerCharacter: context.triggerCharacter } : {}),
		isRetrigger: context.isRetrigger === true,
		...(hints ? {
			activeSignatureHelp: {
				...(hints.activeSignature !== undefined ? { activeSignature: hints.activeSignature } : {}),
				signatures: hints.signatures.map(signature => ({
					label: signature.label,
					...(signature.documentation !== undefined ? { documentation: signature.documentation } : {}),
					...(signature.activeParameter !== undefined ? { activeParameter: signature.activeParameter } : {}),
					parameters: signature.parameters.map(parameter => ({
						label: parameter.label,
						...(parameter.documentation !== undefined ? { documentation: parameter.documentation } : {}),
					})),
				})),
			}
		} : {}),
	};
}

function completionPayload(request: languages.LanguageCompletionProviderRequest): JsonValue {
	return featurePayload(request, {
		requestId: request.requestId,
		position: positionValue(request.position),
		context: request.context.kind === "triggerCharacter" ? { kind: request.context.kind, triggerCharacter: request.context.triggerCharacter } : { kind: request.context.kind },
	});
}

function featurePayload(request: { readonly languageId: string; readonly resource?: { toString(): string; }; readonly snapshot: TextSnapshot; readonly model?: { readonly uri: URI; }; }, fields: Record<string, JsonValue>): JsonValue {
	return Object.freeze({
		languageId: request.languageId,
		version: request.snapshot.version,
		text: request.snapshot.getText(),
		...((request.resource ?? request.model?.uri) ? { resource: (request.resource ?? request.model!.uri).toString() } : {}),
		...fields,
	});
}

function formattingOptionsValue(options: languages.LanguageFormattingOptions): JsonValue {
	return Object.freeze({ tabSize: options.tabSize, insertSpaces: options.insertSpaces, ...(options.trimTrailingWhitespace === undefined ? {} : { trimTrailingWhitespace: options.trimTrailingWhitespace }) });
}

function positionValue(position: Position): JsonValue {
	return Object.freeze({ lineIndex: position.lineNumber - 1, columnIndex: position.column - 1 });
}

function rangeValue(range: Range): JsonValue {
	return Object.freeze({ start: positionValue(range.getStartPosition()), end: positionValue(range.getEndPosition()) });
}

function normalizeCompletionResult(value: JsonValue, snapshot: TextSnapshot): languages.LanguageCompletionProviderResult {
	const result = exactObject(value, "Extension completion result", ["isIncomplete", "items"]);
	if (typeof result.isIncomplete !== "boolean") throw new TypeError("Extension completion isIncomplete is invalid");
	const items = boundedArray(result.items, "Extension completion items", 10_000).map((item, index) => normalizeCompletionItem(item, snapshot, index));
	return Object.freeze({ items: Object.freeze(items), isIncomplete: result.isIncomplete });
}

function normalizeCompletionItem(value: JsonValue, snapshot: TextSnapshot, index: number): languages.LanguageCompletionProviderItem {
	const item = object(value, `Extension completion item ${index}`);
	const allowed = ["additionalTextEdits", "commitCharacters", "detail", "documentation", "filterText", "id", "insertText", "insertTextFormat", "kind", "label", "preselect", "range", "sortText"];
	assertAllowedKeys(item, `Extension completion item ${index}`, allowed, ["id", "insertText", "kind", "label", "range"]);
	const kind = textEnum(item.kind, `Extension completion item ${index} kind`, Object.values(languages.LanguageCompletionItemKind));
	const insertTextFormat = item.insertTextFormat === undefined ? undefined : textEnum(item.insertTextFormat, `Extension completion item ${index} insertTextFormat`, Object.values(languages.LanguageCompletionInsertTextFormat));
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

function normalizeHoverResult(value: JsonValue, snapshot: TextSnapshot): languages.LanguageHover | undefined {
	if (value === null) return undefined;
	const result = object(value, "Extension hover result");
	assertAllowedKeys(result, "Extension hover result", ["contents", "range"], ["contents"]);
	const contents = boundedArray(result.contents, "Extension hover contents", 256).map((content, index): languages.LanguageHoverContent => {
		if (typeof content === "string") return boundedString(content, `Extension hover content ${index}`, 262_144, true);
		const marked = exactObject(content, `Extension hover content ${index}`, content && typeof content === "object" && "language" in content ? ["language", "value"] : ["value"]);
		return Object.freeze({ value: boundedString(marked.value, `Extension hover content ${index} value`, 262_144, true), ...(marked.language === undefined ? {} : { language: boundedString(marked.language, `Extension hover content ${index} language`, 256, false) }) });
	});
	if (contents.length === 0) throw new TypeError("Extension hover contents must not be empty");
	return Object.freeze({ ...(result.range === undefined ? {} : { range: normalizeRange(result.range, snapshot, "Extension hover range") }), contents: Object.freeze(contents) });
}

function normalizeFormattingResult(value: JsonValue, snapshot: TextSnapshot): readonly languages.TextEdit[] {
	const result = exactObject(value, "Extension formatting result", ["edits"]);
	const edits = boundedArray(result.edits, "Extension formatting edits", 10_000).map((edit, index) => normalizeTextEdit(edit, snapshot, `Extension formatting edit ${index}`));
	return Object.freeze(edits);
}

function normalizeTextEdit(value: JsonValue, snapshot: TextSnapshot, owner: string) {
	const edit = exactObject(value, owner, ["range", "text"]);
	return Object.freeze({ range: normalizeRange(edit.range, snapshot, `${owner} range`), text: boundedString(edit.text, `${owner} text`, 1_048_576, true) });
}

function normalizeInlayHintsResult(value: JsonValue, snapshot: TextSnapshot): readonly languages.LanguageInlayHint[] {
	const result = exactObject(value, "Extension Inlay Hints result", ["hints"]);
	const hints = boundedArray(result.hints, "Extension Inlay Hints", 10_000).map((hint, index) => normalizeInlayHint(hint, snapshot, index));
	return Object.freeze(hints);
}

function normalizeInlayHint(value: JsonValue, snapshot: TextSnapshot, index: number): languages.LanguageInlayHint {
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

function normalizeInlayLabel(value: JsonValue | undefined, snapshot: TextSnapshot, index: number): languages.LanguageInlayHintLabel {
	if (typeof value === "string") return boundedString(value, `Extension Inlay Hint ${index} label`, 16_384, false);
	const parts = boundedArray(value, `Extension Inlay Hint ${index} label parts`, 256).map((part, partIndex) => {
		const input = object(part, `Extension Inlay Hint ${index} label part ${partIndex}`);
		assertAllowedKeys(input, `Extension Inlay Hint ${index} label part ${partIndex}`, ["location", "value"], ["value"]);
		return Object.freeze({ value: boundedString(input.value, `Extension Inlay Hint ${index} label part ${partIndex} value`, 4096, false), ...(input.location === undefined ? {} : { location: normalizeRange(input.location, snapshot, `Extension Inlay Hint ${index} label part ${partIndex} location`) }) });
	});
	if (parts.length === 0) throw new TypeError(`Extension Inlay Hint ${index} label parts must not be empty`);
	return Object.freeze(parts);
}

function normalizeLinkedEditingResult(value: JsonValue, snapshot: TextSnapshot): languages.LinkedEditingRanges | undefined {
	if (value === null) return undefined;
	const result = exactObject(value, "Extension Linked Editing result", ["ranges"]);
	const ranges = boundedArray(result.ranges, "Extension Linked Editing ranges", 1024).map((range, index) => normalizeRange(range, snapshot, `Extension Linked Editing range ${index}`));
	if (ranges.length === 0) throw new TypeError("Extension Linked Editing ranges must not be empty");
	return Object.freeze({ ranges });
}

function modelRequest(model: ITextModel): { readonly languageId: string; readonly resource: { toString(): string; }; readonly snapshot: TextSnapshot; } {
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

function normalizeParameterHintsResult(value: JsonValue): languages.LanguageParameterHints | undefined {
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

function normalizeExternalRange(value: JsonValue | undefined): Range {
	const range = exactObject(value, 'Extension target range', ['start', 'end']);
	const point = (value: JsonValue | undefined): Position => {
		const input = exactObject(value, 'Extension target position', ['lineIndex', 'columnIndex']);
		return new Position(nonNegativeInteger(input.lineIndex, 'Extension target line') + 1, nonNegativeInteger(input.columnIndex, 'Extension target column') + 1);
	};
	const start = point(range.start);
	const end = point(range.end);
	if (Position.compare(start, end) > 0) throw new RangeError('Extension target range is reversed');
	return Range.fromPositions(start, end);
}

function normalizeLocations(value: JsonValue): readonly languages.LanguageLocation[] {
	return boundedArray(value, 'Extension locations', 8192).map(value => {
		const location = exactObject(value, 'Extension location', ['resource', 'range']);
		return { resource: URI.parse(boundedString(location.resource, 'Extension location resource', 8192, false)), range: normalizeExternalRange(location.range) };
	});
}

function normalizeSymbols(
	value: JsonValue,
	snapshot: TextSnapshot,
	depth = 0,
): readonly languages.LanguageDocumentSymbol[] {
	if (depth > 32) throw new RangeError('Extension symbol hierarchy is too deep');
	return boundedArray(value, 'Extension symbols', 8192).map((value) => {
		const symbol = object(value, 'Extension symbol');
		assertAllowedKeys(
			symbol,
			'Extension symbol',
			['name', 'kind', 'range', 'selectionRange', 'children'],
			['name', 'kind', 'range', 'selectionRange'],
		);
		return {
			name: boundedString(symbol.name, 'Extension symbol name', 4096, false),
			kind: nonNegativeInteger(symbol.kind, 'Extension symbol kind'),
			range: normalizeRange(symbol.range, snapshot, 'Extension symbol range'),
			selectionRange: normalizeRange(symbol.selectionRange, snapshot, 'Extension symbol selection'),
			...(symbol.children === undefined
				? {}
				: { children: normalizeSymbols(symbol.children, snapshot, depth + 1) }),
		};
	});
}

function normalizeWorkspaceEdit(value: JsonValue): languages.LanguageWorkspaceEdit {
	const result = exactObject(value, 'Extension workspace edit', ['entries']);
	return languages.normalizeLanguageWorkspaceEdit({
		entries: boundedArray(result.entries, 'Extension edit documents', 8192).map((value) => {
			const entry = object(value, 'Extension edit document');
			if (entry.kind === 'rename') {
				assertAllowedKeys(entry, 'Extension file rename', ['kind', 'source', 'target', 'existing'], ['kind', 'source', 'target', 'existing']);
				return {
					kind: 'rename' as const,
					source: URI.parse(boundedString(entry.source, 'Extension rename source', 8192, false)),
					target: URI.parse(boundedString(entry.target, 'Extension rename target', 8192, false)),
					existing: boundedString(entry.existing, 'Extension rename target behavior', 16, false) as languages.LanguageExistingTargetBehavior,
				};
			}
			if (entry.kind !== 'textDocument') throw new TypeError('Unsupported extension workspace edit kind');
			assertAllowedKeys(
				entry,
				'Extension edit document',
				['kind', 'resource', 'version', 'expectedText', 'edits'],
				['kind', 'resource', 'expectedText', 'edits'],
			);
			const expectedText = boundedString(entry.expectedText, 'Extension edit baseline', 1_048_576, true);
			const snapshot: TextSnapshot = {
				version: 1,
				length: expectedText.length,
				lineCount: expectedText.split('\n').length,
				getText: () => expectedText,
				getTextBetweenOffsets: (start, end) => expectedText.slice(start, end),
			};
			return {
				kind: 'textDocument',
				resource: URI.parse(boundedString(entry.resource, 'Extension edit resource', 8192, false)),
				expectedText,
				...(entry.version === undefined
					? {}
					: { version: nonNegativeInteger(entry.version, 'Extension edit version') }),
				edits: boundedArray(entry.edits, 'Extension text edits', 8192).map((value) => {
					const edit = exactObject(value, 'Extension text edit', ['range', 'text']);
					return {
						range: normalizeRange(edit.range, snapshot, 'Extension edit range'),
						text: boundedString(edit.text, 'Extension edit text', 1_048_576, true),
					};
				}),
			};
		}),
	});
}

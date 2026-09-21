import { LanguageCompletionItemKind, type LanguageCompletionProvider, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult, type LanguageCompletionRequest, type TextEdit } from '../languages.js';

import { Position } from "../core/position.js";
import { Range } from "../core/range.js";
import { getTextWordSegments } from "../core/textSegmentation.js";
import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { normalizeTextLineEndings, type TextSnapshot } from '../core/textChange.js';

import { StringText } from '../core/text/abstractText.js';
import { TextReplacement } from '../core/edits/textEdit.js';
import { getWordAtText } from '../core/wordHelper.js';
import { BasicInplaceReplace } from '../languages/supports/inplaceReplaceSupport.js';
import { type LanguageWorkerRequest } from '../languages/languageRequestCoordinator.js';
import { EDITOR_WORKER_TEXTUAL_SUGGEST_LANE, EDITOR_WORKER_MINIMAL_EDITS_LANE, EDITOR_WORKER_NAVIGATE_VALUE_LANE, EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE, type EditorWorkerImplementation, type EditorWorkerLane, type EditorWorkerMinimalEditsRequest, type EditorWorkerNavigateValueRequest, type EditorWorkerRequest, type EditorWorkerResult } from './editorWorkerWire.js';
import { computeUnicodeHighlights } from './unicodeTextModelHighlighter.js';

const MINIMAL_EDIT_LIMIT = 100_000;

/** Executes model-versioned editor computations inside a dedicated Worker or in-process host. */
export class EditorWorker extends AbstractDisposable implements EditorWorkerImplementation {
	private readonly wordProvider = createLanguageWordCompletionProvider();

	public async run(request: LanguageWorkerRequest<EditorWorkerLane, EditorWorkerRequest>, signal: AbortSignal): Promise<EditorWorkerResult> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		switch (request.lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE: {
				const payload = request.payload as LanguageCompletionRequest;
				const result = await this.wordProvider.provideCompletions({ ...payload, requestId: request.requestId, snapshot: request.snapshot }, signal);
				return {
					position: payload.position,
					items: (result?.items ?? []).map(item => ({ ...item, providerId: this.wordProvider.id, hasDeferredDetails: false })),
					isIncomplete: result?.isIncomplete ?? false,
				};
			}
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return computeUnicodeHighlights(request.snapshot, signal);
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				return computeMoreMinimalEdits(request.snapshot, request.payload as EditorWorkerMinimalEditsRequest, signal);
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE:
				return navigateValueSet(request.snapshot, request.payload as EditorWorkerNavigateValueRequest);
		}
	}

	protected disposeCore(): void {}
}

function computeMoreMinimalEdits(snapshot: TextSnapshot, request: EditorWorkerMinimalEditsRequest, signal: AbortSignal): readonly TextEdit[] {
	const document = new StringText(snapshot.getText());
	const edits = mergeAdjacentEdits(request.edits);
	const result: TextEdit[] = [];
	const eol = [...request.edits].reverse().find(edit => edit.eol !== undefined)?.eol;
	for (const edit of edits) {
		signal.throwIfAborted();
		const text = normalizeTextLineEndings(edit.text);
		const range = Range.lift(edit.range);
		const original = document.getValueOfRange(range);
		if (original === text) continue;
		if (Math.max(original.length, text.length) > MINIMAL_EDIT_LIMIT) {
			result.push(Object.freeze({ range: edit.range, text }));
			continue;
		}
		const replacement = new TextReplacement(range, text).removeCommonPrefixAndSuffix(document);
		if (!replacement.isEmpty) result.push(Object.freeze({ range: replacement.range, text: replacement.text }));
	}
	if (eol !== undefined) {
		if (result.length > 0) {
			result[result.length - 1] = { ...result[result.length - 1], eol };
		} else {
			result.push({ range: new Range(1, 1, 1, 1), text: '', eol });
		}
	}
	return Object.freeze(result);
}

function mergeAdjacentEdits(edits: readonly TextEdit[]): readonly TextEdit[] {
	const sorted = edits.map(edit => Object.freeze({ range: Range.lift(edit.range), text: edit.text })).sort((left, right) => Position.compare(left.range.getStartPosition(), right.range.getStartPosition()));
	const result: { readonly range: Range; readonly text: string }[] = [];
	for (const edit of sorted) {
		const previous = result.at(-1);
		if (previous && previous.range.getEndPosition().equals(edit.range.getStartPosition())) {
			result[result.length - 1] = Object.freeze({ range: previous.range.plusRange(edit.range), text: previous.text + edit.text });
			continue;
		}
		if (previous && Position.isBefore(edit.range.getStartPosition(), previous.range.getEndPosition())) throw new RangeError('Editor worker edits must not overlap');
		result.push(edit);
	}
	return result;
}

function navigateValueSet(snapshot: TextSnapshot, request: EditorWorkerNavigateValueRequest): EditorWorkerResult {
	const document = new StringText(snapshot.getText());
	const range = validateRange(document, request.range);
	const selectionRange = range.isEmpty() && range.getEndPosition().column <= document.getLineLength(range.getEndPosition().lineNumber)
		? Range.fromPositions(range.getStartPosition(), new Position(range.endLineNumber, range.endColumn + 1))
		: range;
	const selectionText = document.getValueOfRange(selectionRange);
	const line = document.getLineAt(range.getStartPosition().lineNumber);
	const word = getWordAtText(range.getStartPosition().column, request.wordDefinition, line, 0)
		?? (range.startColumn > 1 ? getWordAtText(range.startColumn - 1, request.wordDefinition, line, 0) : undefined);
	const wordRange = word ? Range.fromPositions(
		new Position(range.startLineNumber, word.startColumn),
		new Position(range.startLineNumber, word.endColumn),
	) : undefined;
	if (range.isEmpty() && wordRange) {
		return BasicInplaceReplace.INSTANCE.navigateValueSet(wordRange, word!.word, selectionRange, selectionText, request.up) ?? undefined;
	}
	return BasicInplaceReplace.INSTANCE.navigateValueSet(selectionRange, selectionText, wordRange ?? selectionRange, word?.word ?? null, request.up) ?? undefined;
}

function validateRange(document: StringText, range: Range): Range {
	const lifted = Range.fromPositions(range.getStartPosition(), range.getEndPosition());
	document.getValueOfRange(lifted);
	return lifted;
}

const DEFAULT_MAXIMUM_WORD_COMPLETIONS = 100;

export interface LanguageWordCompletionProviderOptions {
	readonly id?: string;
	readonly languageIds?: readonly string[];
	readonly maximumItems?: number;
}

/** Creates a snapshot-local lexical word provider suitable for a worker realm. */
export function createLanguageWordCompletionProvider(options: LanguageWordCompletionProviderOptions = {}): LanguageCompletionProvider {
	const id = options.id ?? "language.word";
	const languageIds = Object.freeze([...(options.languageIds ?? ["*"])]);
	const maximumItems = options.maximumItems ?? DEFAULT_MAXIMUM_WORD_COMPLETIONS;
	if (!Number.isSafeInteger(maximumItems) || maximumItems <= 0) {
		throw new RangeError("Maximum word completion items must be a positive safe integer");
	}
	return Object.freeze({
		id,
		languageIds,
		provideCompletions: (request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined => {
			signal.throwIfAborted();
			const lines = request.snapshot.getText().split("\n");
			const columnIndex = request.position.column - 1;
			const triggerLine = lines[request.position.lineNumber - 1];
			if (triggerLine === undefined || columnIndex < 0 || columnIndex > triggerLine.length) {
				throw new RangeError("Word completion position is outside its snapshot");
			}
			const active = getTextWordSegments(triggerLine).find(segment => (
				segment.wordLike &&
				columnIndex > segment.start &&
				columnIndex <= segment.end
			));
			if (!active) return undefined;
			const prefix = triggerLine.slice(active.start, columnIndex);
			if (prefix.length === 0) return undefined;
			const currentWord = triggerLine.slice(active.start, active.end);
			const words = new Set<string>();
			for (const line of lines) {
				signal.throwIfAborted();
				for (const segment of getTextWordSegments(line)) {
					if (!segment.wordLike) continue;
					const word = line.slice(segment.start, segment.end);
					if (word !== currentWord && word.startsWith(prefix)) words.add(word);
				}
			}
			const candidates = [...words].sort().slice(0, maximumItems);
			if (candidates.length === 0) return undefined;
			const range = Range.fromPositions(
				new Position(request.position.lineNumber, active.start + 1),
				new Position(request.position.lineNumber, active.end + 1),
			);
			return Object.freeze({
				items: Object.freeze(candidates.map(word => Object.freeze({
					id: wordIdentity(word),
					label: word,
					kind: LanguageCompletionItemKind.Text,
					range,
					insertText: word,
					sortText: word,
				}))),
				isIncomplete: words.size > maximumItems,
			});
		},
	});
}

function wordIdentity(word: string): string {
	return `word-${[...word].map(character => character.codePointAt(0)!.toString(16)).join("-")}`;
}

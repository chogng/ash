import { localize } from '../../../nls.js';
import { URI } from '../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import type { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import type { DiffEditorWidget } from '../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { EndOfLinePreference } from '../../../editor/common/model.js';
import { Range } from '../../../editor/common/core/range.js';
import type { ITextFileService } from '../../services/textfile/common/textfiles.js';
import type { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import type { JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
/** Validates an extension's diff coordinates against the client's current editor models. */
export class MainThreadEditorChanges {
	constructor(private readonly codeEditors: ICodeEditorService, private readonly workingCopies: IWorkingCopyService, private readonly files: ITextFileService) { }
	public async handle(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
		signal.throwIfAborted();
		const request = record(value);
		switch (request.method) {
			case 'dirty': return this.workingCopies.get(URI.parse(text(request.uri))).map(copy => ({ isDirty: copy.isDirty }));
			case 'diffChange': return this.captureDiffChange(request.context);
			case 'readTextFile': {
				const file = await this.files.resolve({ resource: URI.parse(text(request.uri)) }, signal);
				return { text: file.text, revision: file.revision ?? null, encoding: file.encoding };
			}
			case 'saveTextFile': {
				if (request.encoding !== 'utf8' && request.encoding !== 'utf8bom') {
					throw new TypeError('Invalid file encoding');
				}
				const target = URI.parse(text(request.uri));
				if (this.workingCopies.get(target).some(copy => copy.isDirty)) {
					throw new Error(localize({ bundle: 'ash.workbench', key: 'extension.editor.unsavedChanges' }, 'The open file has unsaved changes.'));
				}
				const result = await this.files.save({ resource: target, text: text(request.text), expectedRevision: text(request.expectedRevision), encoding: request.encoding }, signal);
				return { revision: result.revision ?? null };
			}
			default: throw new TypeError('Unsupported editor change operation');
		}
	}

	private captureDiffChange(value: JsonValue): JsonValue {
		const context = record(value);
		const originalUri = URI.parse(text(context.originalUri));
		const modifiedUri = URI.parse(text(context.modifiedUri));
		const editor = this.codeEditors.listDiffEditors().find((candidate): candidate is DiffEditorWidget => 'originalEditor' in candidate && 'diff' in candidate && extUriBiasedIgnorePathCase.isEqual(candidate.getModifiedEditor().getModel()?.uri, modifiedUri));
		if (!editor || editor.isDisposed || !extUriBiasedIgnorePathCase.isEqual(editor.originalEditor.getModel()?.uri, originalUri)) { return null; }
		const changes = editor.diff?.changes;
		const mapping = record(context.mapping);
		const signature = (value: unknown) => JSON.stringify(JSON.parse(JSON.stringify(value)), (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
		const whole = changes?.find(change => signature(change) === signature(mapping));
		const selected = Array.isArray(mapping.innerChanges) ? mapping.innerChanges : [];
		if (!whole && (!selected.length || !selected.every(range => changes?.some(change => change.innerChanges?.some(candidate => signature(candidate) === signature(range)))))) {
			return null;
		}
		const original = editor.originalEditor.getModel()!;
		const modified = editor.modifiedEditor.getModel()!;
		const innerChanges = selected.map(value => {
			const entry = record(value);
			const originalRange = parseRange(entry.originalRange), modifiedRange = parseRange(entry.modifiedRange);
			return { start: modified.getOffsetAt(modifiedRange.getStartPosition()), end: modified.getOffsetAt(modifiedRange.getEndPosition()), text: original.getValueInRange(originalRange) };
		});
		if (whole && !innerChanges.length) {
			// Whole-line additions and deletions need no character refinements.
			// At EOF their separator belongs to the preceding line, so include it
			// when translating the line span to the extension's UTF-16 edit.
			const atEnd = whole.modified.endLineNumberExclusive > modified.getLineCount();
			const precedingBreak = atEnd && whole.modified.startLineNumber > 1;
			const startLine = precedingBreak ? whole.modified.startLineNumber - 1 : whole.modified.startLineNumber;
			const endLine = atEnd ? modified.getLineCount() : whole.modified.endLineNumberExclusive;
			const replacement = original.getLinesContent().slice(whole.original.startLineNumber - 1, whole.original.endLineNumberExclusive - 1);
			const eol = modified.getEOL();
			let text = replacement.join(eol);
			if (replacement.length) {
				if (precedingBreak) text = eol + text;
				else if (!atEnd) text += eol;
			}
			innerChanges.push({
				start: modified.getOffsetAt({ lineNumber: startLine, column: precedingBreak ? modified.getLineMaxColumn(startLine) : 1 }),
				end: modified.getOffsetAt({ lineNumber: endLine, column: atEnd ? modified.getLineMaxColumn(endLine) : 1 }),
				text,
			});
		}
		const lines = record(mapping.modified);
		const lastLine = modified.getLineCount();
		const selectedLines = selected.map(value => {
			const range = parseRange(record(value).modifiedRange);
			return { start: Math.min(lastLine, range.startLineNumber), end: Math.min(lastLine, range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber) };
		});
		const start = whole ? Math.min(lastLine, positiveInteger(lines.startLineNumber)) : Math.min(...selectedLines.map(range => range.start));
		const end = whole ? Math.min(lastLine, Math.max(start, positiveInteger(lines.endLineNumberExclusive) - 1)) : Math.max(...selectedLines.map(range => range.end));
		const contiguous = Boolean(whole) || !changes?.some(change => change.innerChanges?.some(range => {
			const line = Math.min(lastLine, range.modifiedRange.startLineNumber);
			return line >= start && line <= end && !selectedLines.some(selected => line >= selected.start && line <= selected.end);
		}));
		return { originalText: original.getValue(), modifiedText: modified.getValue(), originalFileText: original.getValue(EndOfLinePreference.TextDefined, true), modifiedFileText: modified.getValue(EndOfLinePreference.TextDefined, true), originalVersion: original.getVersionId(), modifiedVersion: modified.getVersionId(), start, end, contiguous, edits: innerChanges };
	}
}
function record(value: JsonValue): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Expected extension editor object');
	} return value as Record<string, JsonValue>;
}
function text(value: JsonValue, limit = 16 * 1024 * 1024): string {
	if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
		throw new TypeError('Invalid extension editor text');
	} return value;
}
function positiveInteger(value: JsonValue): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new TypeError('Invalid editor coordinate');
	} return value;
}
function parseRange(value: JsonValue): Range { const range = record(value); return new Range(positiveInteger(range.startLineNumber), positiveInteger(range.startColumn), positiveInteger(range.endLineNumber), positiveInteger(range.endColumn)); }

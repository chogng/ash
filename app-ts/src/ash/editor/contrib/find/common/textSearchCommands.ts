import { ReplaceCommand } from '../../../common/commands/replaceCommand.js';
import { Selection } from '../../../common/core/selection.js';
import { normalizeTextLineEndings } from "../../../common/core/textChange.js";
import { type ICursorStateComputerData, type IEditOperationBuilder, type ICommand } from '../../../common/editorCommon.js';
import { type TextModel } from "../../../common/model/textModel.js";
import { type TextSearchMatch } from "../../../common/model/textModelSearch.js";
import { type TextEdit } from '../../../common/languages.js';

/** Expands JavaScript-style regular-expression replacement tokens against one search match. */
export function resolveTextSearchReplacement(match: TextSearchMatch, replacement: string): string {
	if (typeof replacement !== "string") throw new TypeError("Text search replacement must be a string");
	return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (token, reference: string) => {
		if (reference === "$") return "$";
		if (reference === "&") return match.text;
		if (reference.startsWith("<")) {
			const name = reference.slice(1, -1);
			return Object.hasOwn(match.namedCaptures, name) ? match.namedCaptures[name] ?? "" : token;
		}
		const captureIndex = Number(reference);
		if (captureIndex === 0 || captureIndex > match.captures.length) return token;
		return match.captures[captureIndex - 1] ?? "";
	});
}

/** Replaces one current-version search match as an isolated undo step. */
export function createReplaceTextMatchCommand(model: TextModel, match: TextSearchMatch, replacement: string): ICommand {
	assertCurrentMatch(model, match);
	return new ReplaceCommand(match.range, normalizeTextLineEndings(replacement));
}

/** Replaces ordered, non-overlapping current-version matches as one isolated undo step. */
export function createReplaceAllTextMatchesCommand(model: TextModel, matches: readonly TextSearchMatch[], replacements: readonly string[]): ICommand {
	if (matches.length !== replacements.length) {
		throw new RangeError("Text search replacements must match the result count");
	}
	if (matches.length === 0) throw new RangeError("Replace all requires at least one text search match");

	const edits: TextEdit[] = [];
	let previousEndOffset = -1;
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index]!;
		const replacement = normalizeTextLineEndings(replacements[index]!);
		assertCurrentMatch(model, match);
		const startOffset = model.offsetAt(match.range.getStartPosition());
		const endOffset = model.offsetAt(match.range.getEndPosition());
		if (startOffset < previousEndOffset) throw new RangeError("Text search matches must not overlap");
		edits.push(Object.freeze({ range: match.range, text: replacement }));
		previousEndOffset = endOffset;
	}
	return new ReplaceAllTextMatchesCommand(edits);
}

class ReplaceAllTextMatchesCommand implements ICommand {
	constructor(private readonly edits: readonly TextEdit[]) {}

	getEditOperations(_model: TextModel, builder: IEditOperationBuilder): void {
		for (const edit of this.edits) builder.addTrackedEditOperation(edit.range, edit.text);
	}

	computeCursorState(_model: TextModel, helper: ICursorStateComputerData) {
		const inverse = helper.getInverseEditOperations();
		return Selection.fromPositions(inverse.at(-1)!.range.getEndPosition());
	}
}

function assertCurrentMatch(model: TextModel, match: TextSearchMatch): void {
	if (match.modelVersion !== model.version) throw new Error("Text search match belongs to a stale model version");
	if (model.getTextInRange(match.range) !== match.text) throw new Error("Text search match no longer identifies the same text");
}

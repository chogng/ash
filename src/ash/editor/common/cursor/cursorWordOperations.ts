import { CharCode } from '../../../base/common/charCode.js';
import * as strings from '../../../base/common/strings.js';
import { type EditorAutoClosingEditStrategy, type EditorAutoClosingStrategy } from '../config/editorOptions.js';
import { type CursorConfiguration, type ICursorSimpleModel, SelectionStartKind, SingleCursorState } from '../cursorCommon.js';
import { WordCharacterClass, type WordCharacterClassifier, getMapForWordSeparators } from '../core/wordCharacterClassifier.js';
import { type IWordAtPosition } from '../core/wordHelper.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { type Selection } from '../core/selection.js';
import { type AutoClosingPairs } from '../languages/languageConfiguration.js';
import { type ITextModel } from '../model.js';
import { DeleteOperations } from './cursorDeleteOperations.js';

interface WordBoundary {
	readonly start: number;
	readonly end: number;
	readonly type: WordBoundaryType;
	readonly nextClass: WordCharacterClass;
}

const enum WordBoundaryType {
	Regular,
	Separator,
}

export const enum WordNavigationType {
	WordStart,
	WordStartFast,
	WordEnd,
	WordAccessibility,
}

export interface DeleteWordContext {
	readonly wordSeparators: WordCharacterClassifier;
	readonly model: ITextModel;
	readonly selection: Selection;
	readonly whitespaceHeuristics: boolean;
	readonly autoClosingDelete: EditorAutoClosingEditStrategy;
	readonly autoClosingBrackets: EditorAutoClosingStrategy;
	readonly autoClosingQuotes: EditorAutoClosingStrategy;
	readonly autoClosingPairs: AutoClosingPairs;
	readonly autoClosedCharacters: Range[];
}

export class WordOperations {
	public static moveWordLeft(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position, wordNavigationType: WordNavigationType, hasMulticursor: boolean): Position {
		let lineNumber = position.lineNumber;
		let column = position.column;
		if (column === 1 && lineNumber > 1) {
			lineNumber -= 1;
			column = model.getLineMaxColumn(lineNumber);
		}
		let word = previousWord(wordSeparators, model, new Position(lineNumber, column));
		if (wordNavigationType === WordNavigationType.WordStartFast && !hasMulticursor && isSingleSeparatorBeforeRegular(word)) {
			word = previousWord(wordSeparators, model, new Position(lineNumber, word!.start + 1));
		}
		if (wordNavigationType === WordNavigationType.WordAccessibility) {
			while (word?.type === WordBoundaryType.Separator) word = previousWord(wordSeparators, model, new Position(lineNumber, word.start + 1));
		}
		if (wordNavigationType === WordNavigationType.WordEnd && word && column <= word.end + 1) {
			word = previousWord(wordSeparators, model, new Position(lineNumber, word.start + 1));
		}
		return new Position(lineNumber, word ? (wordNavigationType === WordNavigationType.WordEnd ? word.end : word.start) + 1 : 1);
	}

	public static _moveWordPartLeft(model: ICursorSimpleModel, position: Position): Position {
		if (position.column === 1) {
			return position.lineNumber > 1 ? new Position(position.lineNumber - 1, model.getLineMaxColumn(position.lineNumber - 1)) : position;
		}
		const line = model.getLineContent(position.lineNumber);
		for (let column = position.column - 1; column > 1; column -= 1) {
			if (isWordPartBoundary(line, column, 'left')) return new Position(position.lineNumber, column);
		}
		return new Position(position.lineNumber, 1);
	}

	public static moveWordRight(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position, wordNavigationType: WordNavigationType): Position {
		let lineNumber = position.lineNumber;
		let column = position.column;
		let crossedLine = false;
		if (column === model.getLineMaxColumn(lineNumber) && lineNumber < model.getLineCount()) {
			lineNumber += 1;
			column = 1;
			crossedLine = true;
		}
		let word = nextWord(wordSeparators, model, new Position(lineNumber, column));
		if (wordNavigationType === WordNavigationType.WordEnd) {
			if (isSingleSeparatorBeforeRegular(word)) word = nextWord(wordSeparators, model, new Position(lineNumber, word!.end + 1));
			return new Position(lineNumber, word ? word.end + 1 : model.getLineMaxColumn(lineNumber));
		}
		if (wordNavigationType === WordNavigationType.WordAccessibility) {
			if (crossedLine) column = 0;
			while (word && (word.type === WordBoundaryType.Separator || word.start + 1 <= column)) {
				word = nextWord(wordSeparators, model, new Position(lineNumber, word.end + 1));
			}
		} else if (word && !crossedLine && column >= word.start + 1) {
			word = nextWord(wordSeparators, model, new Position(lineNumber, word.end + 1));
		}
		return new Position(lineNumber, word ? word.start + 1 : model.getLineMaxColumn(lineNumber));
	}

	public static _moveWordPartRight(model: ICursorSimpleModel, position: Position): Position {
		const maxColumn = model.getLineMaxColumn(position.lineNumber);
		if (position.column === maxColumn) {
			return position.lineNumber < model.getLineCount() ? new Position(position.lineNumber + 1, 1) : position;
		}
		const line = model.getLineContent(position.lineNumber);
		for (let column = position.column + 1; column < maxColumn; column += 1) {
			if (isWordPartBoundary(line, column, 'right')) return new Position(position.lineNumber, column);
		}
		return new Position(position.lineNumber, maxColumn);
	}

	protected static _deleteWordLeftWhitespace(model: ICursorSimpleModel, position: Position): Range | null {
		const line = model.getLineContent(position.lineNumber);
		const startIndex = position.column - 2;
		const lastNonWhitespace = strings.lastNonWhitespaceIndex(line, startIndex);
		return lastNonWhitespace + 1 < startIndex
			? new Range(position.lineNumber, lastNonWhitespace + 2, position.lineNumber, position.column)
			: null;
	}

	public static deleteWordLeft(context: DeleteWordContext, wordNavigationType: WordNavigationType): Range | null {
		if (!context.selection.isEmpty()) return context.selection;
		if (DeleteOperations.isAutoClosingPairDelete(
			context.autoClosingDelete,
			context.autoClosingBrackets,
			context.autoClosingQuotes,
			context.autoClosingPairs.autoClosingPairsOpenByEnd,
			context.model,
			[context.selection],
			context.autoClosedCharacters,
		)) {
			const position = context.selection.getPosition();
			return new Range(position.lineNumber, position.column - 1, position.lineNumber, position.column + 1);
		}
		const position = context.selection.getPosition();
		if (position.lineNumber === 1 && position.column === 1) return null;
		if (context.whitespaceHeuristics) {
			const whitespace = this._deleteWordLeftWhitespace(context.model, position);
			if (whitespace) return whitespace;
		}
		return Range.fromPositions(this.moveWordLeft(context.wordSeparators, context.model, position, wordNavigationType, false), position);
	}

	public static deleteInsideWord(wordSeparators: WordCharacterClassifier, model: ITextModel, selection: Selection, onlyWord = false): Range {
		if (!selection.isEmpty()) return selection;
		const position = selection.getPosition();
		const whitespace = insideWhitespaceRange(model, position);
		if (whitespace) return whitespace;
		const line = model.getLineContent(position.lineNumber);
		if (line.length === 0) {
			if (position.lineNumber > 1) return new Range(position.lineNumber - 1, model.getLineMaxColumn(position.lineNumber - 1), position.lineNumber, 1);
			if (position.lineNumber < model.getLineCount()) return new Range(position.lineNumber, 1, position.lineNumber + 1, 1);
			return Range.fromPositions(position);
		}
		const previous = previousWord(wordSeparators, model, position);
		const next = nextWord(wordSeparators, model, position);
		const touching = [previous, next].find(word => word && word.start + 1 <= position.column && position.column <= word.end + 1);
		if (touching) return expandWordDeletion(line, position, touching, onlyWord);
		if (previous && next) return orderedRange(position.lineNumber, previous.end + 1, next.start + 1, position.column);
		if (previous) return orderedRange(position.lineNumber, previous.start + 1, previous.end + 1, position.column);
		if (next) return orderedRange(position.lineNumber, next.start + 1, next.end + 1, position.column);
		return orderedRange(position.lineNumber, 1, line.length + 1, position.column);
	}

	public static _deleteWordPartLeft(model: ICursorSimpleModel, selection: Selection): Range {
		if (!selection.isEmpty()) return selection;
		return Range.fromPositions(this._moveWordPartLeft(model, selection.getPosition()), selection.getPosition());
	}

	protected static _deleteWordRightWhitespace(model: ICursorSimpleModel, position: Position): Range | null {
		const line = model.getLineContent(position.lineNumber);
		let index = position.column - 1;
		while (index < line.length && isWhitespace(line, index)) index += 1;
		return index > position.column - 1 ? new Range(position.lineNumber, position.column, position.lineNumber, index + 1) : null;
	}

	public static deleteWordRight(context: DeleteWordContext, wordNavigationType: WordNavigationType): Range | null {
		if (!context.selection.isEmpty()) return context.selection;
		const position = context.selection.getPosition();
		if (position.lineNumber === context.model.getLineCount() && position.column === context.model.getLineMaxColumn(position.lineNumber)) return null;
		if (context.whitespaceHeuristics) {
			const whitespace = this._deleteWordRightWhitespace(context.model, position);
			if (whitespace) return whitespace;
		}
		return Range.fromPositions(position, deleteWordRightTarget(context.wordSeparators, context.model, position, wordNavigationType));
	}

	public static _deleteWordPartRight(model: ICursorSimpleModel, selection: Selection): Range {
		if (!selection.isEmpty()) return selection;
		return Range.fromPositions(selection.getPosition(), this._moveWordPartRight(model, selection.getPosition()));
	}

	public static getWordAtPosition(model: ITextModel, wordSeparators: string, intlSegmenterLocales: string[], position: Position): IWordAtPosition | null {
		const classifier = getMapForWordSeparators(wordSeparators, intlSegmenterLocales);
		const offset = position.column - 1;
		const word = [previousWord(classifier, model, position), nextWord(classifier, model, position)]
			.find(candidate => candidate?.type === WordBoundaryType.Regular && candidate.start <= offset && offset <= candidate.end);
		if (!word) return null;
		const range = new Range(position.lineNumber, word.start + 1, position.lineNumber, word.end + 1);
		return { word: model.getValueInRange(range), startColumn: range.startColumn, endColumn: range.endColumn };
	}

	public static word(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean, position: Position): SingleCursorState {
		const classifier = getMapForWordSeparators(config.wordSeparators, config.wordSegmenterLocales);
		const range = wordRangeAt(classifier, model, position);
		if (!inSelectionMode) return new SingleCursorState(range, SelectionStartKind.Word, 0, range.getEndPosition(), 0);
		let active: Position;
		if (cursor.selectionStart.containsPosition(position)) {
			active = cursor.selectionStart.getEndPosition();
		} else if (position.isBeforeOrEqual(cursor.selectionStart.getStartPosition())) {
			active = range.getStartPosition();
			if (cursor.selectionStart.containsPosition(active)) active = cursor.selectionStart.getEndPosition();
		} else {
			active = range.getEndPosition();
			if (cursor.selectionStart.containsPosition(active)) active = cursor.selectionStart.getStartPosition();
		}
		return cursor.move(true, active.lineNumber, active.column, 0);
	}
}

export class WordPartOperations extends WordOperations {
	public static deleteWordPartLeft(context: DeleteWordContext): Range {
		const candidates = defined([
			WordOperations.deleteWordLeft(context, WordNavigationType.WordStart),
			WordOperations.deleteWordLeft(context, WordNavigationType.WordEnd),
			WordOperations._deleteWordPartLeft(context.model, context.selection),
		]).sort(Range.compareRangesUsingEnds);
		return candidates[candidates.length - 1]!;
	}

	public static deleteWordPartRight(context: DeleteWordContext): Range {
		const candidates = defined([
			WordOperations.deleteWordRight(context, WordNavigationType.WordStart),
			WordOperations.deleteWordRight(context, WordNavigationType.WordEnd),
			WordOperations._deleteWordPartRight(context.model, context.selection),
		]).sort(Range.compareRangesUsingStarts);
		return candidates[0]!;
	}

	public static moveWordPartLeft(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position, hasMulticursor: boolean): Position {
		const candidates = [
			WordOperations.moveWordLeft(wordSeparators, model, position, WordNavigationType.WordStart, hasMulticursor),
			WordOperations.moveWordLeft(wordSeparators, model, position, WordNavigationType.WordEnd, hasMulticursor),
			WordOperations._moveWordPartLeft(model, position),
		].sort(Position.compare);
		return candidates[candidates.length - 1]!;
	}

	public static moveWordPartRight(wordSeparators: WordCharacterClassifier, model: ICursorSimpleModel, position: Position): Position {
		return [
			WordOperations.moveWordRight(wordSeparators, model, position, WordNavigationType.WordStart),
			WordOperations.moveWordRight(wordSeparators, model, position, WordNavigationType.WordEnd),
			WordOperations._moveWordPartRight(model, position),
		].sort(Position.compare)[0]!;
	}
}

function previousWord(classifier: WordCharacterClassifier, model: ICursorSimpleModel, position: Position): WordBoundary | null {
	const line = model.getLineContent(position.lineNumber);
	const offset = position.column - 2;
	const words = wordsOnLine(classifier, line);
	for (let index = words.length - 1; index >= 0; index -= 1) {
		if (words[index]!.start <= offset) return words[index]!;
	}
	return null;
}

function nextWord(classifier: WordCharacterClassifier, model: ICursorSimpleModel, position: Position): WordBoundary | null {
	const line = model.getLineContent(position.lineNumber);
	const offset = position.column - 1;
	return wordsOnLine(classifier, line).find(word => word.end > offset) ?? null;
}

function wordsOnLine(classifier: WordCharacterClassifier, line: string): WordBoundary[] {
	const result: WordBoundary[] = [];
	let index = 0;
	while (index < line.length) {
		const intl = classifier.findNextIntlWordAtOrAfterOffset(line, index);
		if (intl?.index === index) {
			const end = index + intl.segment.length;
			result.push(wordBoundary(index, end, WordBoundaryType.Regular, characterClassAt(classifier, line, end)));
			index = end;
			continue;
		}
		const current = classifier.get(line.charCodeAt(index));
		if (current === WordCharacterClass.Whitespace) {
			index += 1;
			continue;
		}
		const type = current === WordCharacterClass.WordSeparator ? WordBoundaryType.Separator : WordBoundaryType.Regular;
		const start = index;
		index += 1;
		while (index < line.length) {
			if (classifier.findNextIntlWordAtOrAfterOffset(line, index)?.index === index) break;
			const next = classifier.get(line.charCodeAt(index));
			if (next === WordCharacterClass.Whitespace) break;
			const nextType = next === WordCharacterClass.WordSeparator ? WordBoundaryType.Separator : WordBoundaryType.Regular;
			if (nextType !== type) break;
			index += 1;
		}
		result.push(wordBoundary(start, index, type, characterClassAt(classifier, line, index)));
	}
	return result;
}

function characterClassAt(classifier: WordCharacterClassifier, line: string, index: number): WordCharacterClass {
	return index < line.length ? classifier.get(line.charCodeAt(index)) : WordCharacterClass.Whitespace;
}

function wordRangeAt(classifier: WordCharacterClassifier, model: ICursorSimpleModel, position: Position): Range {
	const offset = position.column - 1;
	const previous = previousWord(classifier, model, position);
	const next = nextWord(classifier, model, position);
	const touched = [previous, next].find(candidate => candidate && candidate.start <= offset && (candidate.type === WordBoundaryType.Regular ? offset <= candidate.end : offset < candidate.end));
	if (touched) return new Range(position.lineNumber, touched.start + 1, position.lineNumber, touched.end + 1);
	return new Range(position.lineNumber, previous ? previous.end + 1 : 1, position.lineNumber, next ? next.start + 1 : model.getLineMaxColumn(position.lineNumber));
}

function deleteWordRightTarget(classifier: WordCharacterClassifier, model: ICursorSimpleModel, position: Position, type: WordNavigationType): Position {
	let lineNumber = position.lineNumber;
	let word = nextWord(classifier, model, position);
	if (type === WordNavigationType.WordEnd) {
		if (word) return new Position(lineNumber, word.end + 1);
	} else {
		if (word && position.column >= word.start + 1) word = nextWord(classifier, model, new Position(lineNumber, word.end + 1));
		if (word) return new Position(lineNumber, word.start + 1);
	}
	if (position.column < model.getLineMaxColumn(lineNumber) || lineNumber === model.getLineCount()) {
		return new Position(lineNumber, model.getLineMaxColumn(lineNumber));
	}
	lineNumber += 1;
	word = nextWord(classifier, model, new Position(lineNumber, 1));
	return new Position(lineNumber, word ? word.start + 1 : model.getLineMaxColumn(lineNumber));
}

function insideWhitespaceRange(model: ICursorSimpleModel, position: Position): Range | null {
	const line = model.getLineContent(position.lineNumber);
	if (line.length === 0) return null;
	let left = Math.max(position.column - 2, 0);
	let right = Math.min(position.column - 1, line.length - 1);
	if (!isWhitespace(line, left) || !isWhitespace(line, right)) return null;
	while (left > 0 && isWhitespace(line, left - 1)) left -= 1;
	while (right + 1 < line.length && isWhitespace(line, right + 1)) right += 1;
	return new Range(position.lineNumber, left + 1, position.lineNumber, right + 2);
}

function expandWordDeletion(line: string, position: Position, word: WordBoundary, onlyWord: boolean): Range {
	let start = word.start + 1;
	let end = word.end + 1;
	if (!onlyWord) {
		let expandedRight = false;
		while (end - 1 < line.length && isWhitespace(line, end - 1)) {
			end += 1;
			expandedRight = true;
		}
		if (!expandedRight) while (start > 1 && isWhitespace(line, start - 2)) start -= 1;
	}
	return orderedRange(position.lineNumber, start, end, position.column);
}

function orderedRange(lineNumber: number, start: number, end: number, position: number): Range {
	return new Range(lineNumber, Math.min(start, position), lineNumber, Math.max(end, position));
}

function wordBoundary(start: number, end: number, type: WordBoundaryType, nextClass: WordCharacterClass): WordBoundary {
	return { start, end, type, nextClass };
}

function isSingleSeparatorBeforeRegular(value: WordBoundary | null): boolean {
	return value?.type === WordBoundaryType.Separator && value.end - value.start === 1 && value.nextClass === WordCharacterClass.Regular;
}

function isWordPartBoundary(line: string, column: number, direction: 'left' | 'right'): boolean {
	const left = line.charCodeAt(column - 2);
	const right = line.charCodeAt(column - 1);
	if (direction === 'left' && (left === CharCode.Underline || left === CharCode.Dash) && left !== right) return true;
	if (direction === 'right' && (right === CharCode.Underline || right === CharCode.Dash) && left !== right) return true;
	if ((strings.isLowerAsciiLetter(left) || strings.isAsciiDigit(left)) && strings.isUpperAsciiLetter(right)) return true;
	return strings.isUpperAsciiLetter(left) && strings.isUpperAsciiLetter(right)
		&& column < line.length
		&& (strings.isLowerAsciiLetter(line.charCodeAt(column)) || strings.isAsciiDigit(line.charCodeAt(column)));
}

function isWhitespace(text: string, index: number): boolean {
	const code = text.charCodeAt(index);
	return code === CharCode.Space || code === CharCode.Tab;
}

function defined<T>(values: Array<T | null | undefined>): T[] {
	return values.filter((value): value is T => value !== null && value !== undefined);
}

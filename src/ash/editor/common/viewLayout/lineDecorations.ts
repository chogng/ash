import { isHighSurrogate } from '../../../base/common/strings.js';
import { InlineDecorationType, type InlineDecoration } from '../viewModel/inlineDecorations.js';
import { LinePartMetadata } from './linePart.js';

/** One one-based source span after line decorations have been clipped. */
export class LineDecoration {
	_lineDecorationBrand: void = undefined;
	public constructor(
		public readonly startColumn: number,
		public readonly endColumn: number,
		public readonly className: string,
		public readonly type: InlineDecorationType,
	) {
		if (!Number.isSafeInteger(startColumn) || !Number.isSafeInteger(endColumn) || startColumn < 0 || endColumn < startColumn) {
			throw new RangeError('Line decoration columns must be ordered non-negative safe integers');
		}
		if (typeof className !== 'string' || className.trim().length === 0) throw new TypeError('Line decoration class name must be non-empty');
	}

	public static equalsArr(left: readonly LineDecoration[], right: readonly LineDecoration[]): boolean {
		if (left.length !== right.length) return false;
		return left.every((decoration, index) => {
			const other = right[index]!;
			return decoration.startColumn === other.startColumn && decoration.endColumn === other.endColumn &&
				decoration.className === other.className && decoration.type === other.type;
		});
	}

	private static _equals(left: LineDecoration, right: LineDecoration): boolean {
		return left.startColumn === right.startColumn && left.endColumn === right.endColumn && left.className === right.className && left.type === right.type;
	}

	public static extractWrapped(decorations: LineDecoration[], startOffset: number, endOffset: number): LineDecoration[] {
		if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset < startOffset) {
			throw new RangeError('Wrapped line offsets must be ordered non-negative safe integers');
		}
		const wrappedStartColumn = startOffset + 1;
		const wrappedEndColumn = endOffset + 1;
		return decorations.flatMap(decoration => {
			if (decoration.endColumn <= wrappedStartColumn || decoration.startColumn >= wrappedEndColumn) return [];
			const startColumn = Math.max(1, decoration.startColumn - wrappedStartColumn + 1);
			const endColumn = Math.min(endOffset - startOffset + 1, decoration.endColumn - wrappedStartColumn + 1);
			return endColumn >= startColumn
				? [new LineDecoration(startColumn, endColumn, decoration.className, decoration.type)]
				: [];
		});
	}

	public static filter(
		decorations: InlineDecoration[],
		lineNumber: number,
		minColumn: number,
		maxColumn: number,
	): LineDecoration[] {
		if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(minColumn) || !Number.isSafeInteger(maxColumn) || minColumn < 0 || maxColumn < minColumn) {
			throw new RangeError('Line decoration filter coordinates are invalid');
		}
		return decorations.flatMap(decoration => {
			if (decoration.range.endLineNumber < lineNumber || decoration.range.startLineNumber > lineNumber) return [];
			if (decoration.range.isEmpty() && (decoration.type === InlineDecorationType.Regular || decoration.type === InlineDecorationType.RegularAffectingLetterSpacing)) return [];
			const startColumn = decoration.range.startLineNumber === lineNumber ? decoration.range.startColumn : minColumn;
			const endColumn = decoration.range.endLineNumber === lineNumber ? decoration.range.endColumn : maxColumn;
			const clippedStartColumn = Math.max(minColumn, startColumn);
			const clippedEndColumn = Math.min(maxColumn, endColumn);
			if (clippedEndColumn < clippedStartColumn) return [];
			if (clippedEndColumn === clippedStartColumn && (decoration.type === InlineDecorationType.Regular || decoration.type === InlineDecorationType.RegularAffectingLetterSpacing)) return [];
			return [new LineDecoration(clippedStartColumn, clippedEndColumn, decoration.inlineClassName, decoration.type)];
		});
	}

	public static compare(left: LineDecoration, right: LineDecoration): number {
		if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
		if (left.endColumn !== right.endColumn) return left.endColumn - right.endColumn;
		return LineDecoration._typeCompare(left.type, right.type) || (left.className < right.className ? -1 : left.className > right.className ? 1 : 0);
	}

	private static _typeCompare(left: InlineDecorationType, right: InlineDecorationType): number {
		const order = [3, 1, 2, 4, 0];
		return order[left]! - order[right]!;
	}
}

export class DecorationSegment {
	public startOffset: number;
	public endOffset: number;
	public className: string;
	public metadata: number;

	public constructor(
		startOffset: number,
		endOffset: number,
		className: string,
		metadata: number,
	) {
		this.startOffset = startOffset;
		this.endOffset = endOffset;
		this.className = className;
		this.metadata = metadata;
	}
}

/** Converts overlapping line decorations into sorted, renderable segments. */
export class LineDecorationsNormalizer {
	public static normalize(lineContent: string, decorations: LineDecoration[]): DecorationSegment[] {
		if (typeof lineContent !== 'string') throw new TypeError('Line content must be a string');
		if (decorations.length === 0) return [];
		const normalizedDecorations = decorations.map(decoration => ({
			decoration,
			startColumn: moveSurrogateBoundary(lineContent, decoration.startColumn - 1),
			endColumn: moveSurrogateBoundary(lineContent, decoration.endColumn - 1),
		}));
		const boundaries = new Set<number>([0, lineContent.length]);
		for (const { startColumn, endColumn } of normalizedDecorations) {
			if (endColumn > lineContent.length) throw new RangeError('Line decoration exceeds line content');
			boundaries.add(startColumn);
			boundaries.add(endColumn);
		}
		const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
		const result: DecorationSegment[] = [];
		for (let index = 0; index + 1 < sortedBoundaries.length; index += 1) {
			const startOffset = sortedBoundaries[index]!;
			const endOffset = sortedBoundaries[index + 1]!;
			if (endOffset <= startOffset) continue;
			const active = normalizedDecorations.filter(({ startColumn, endColumn }) => startColumn <= startOffset && endColumn >= endOffset);
			if (active.length === 0) continue;
			result.push(new DecorationSegment(
				startOffset,
				endOffset,
				active.map(({ decoration }) => decoration.className).join(' '),
				active.reduce((metadata, { decoration }) => metadata | metadataFor(decoration.type), 0),
			));
		}
		for (const { decoration, startColumn, endColumn } of normalizedDecorations) {
			if (startColumn !== endColumn) continue;
			const metadata = metadataFor(decoration.type);
			if (metadata === 0) continue;
			result.push(new DecorationSegment(startColumn, endColumn, decoration.className, metadata));
		}
		return result.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
	}
}

function metadataFor(type: InlineDecorationType): number {
	return type === InlineDecorationType.Before
		? LinePartMetadata.PSEUDO_BEFORE
		: type === InlineDecorationType.After ? LinePartMetadata.PSEUDO_AFTER : 0;
}

function moveSurrogateBoundary(lineContent: string, column: number): number {
	return column > 0 && column < lineContent.length && isHighSurrogate(lineContent.charCodeAt(column - 1))
		? column - 1
		: column;
}

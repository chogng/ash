import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';

/** Relates a changed line span in one merge document to its span in another. */
export class LineRangeMapping {
	constructor(
		public readonly inputRange: LineRange,
		public readonly outputRange: LineRange,
	) { }

	public reverse(): LineRangeMapping {
		return new LineRangeMapping(this.outputRange, this.inputRange);
	}
}

/** Maps both changed spans and the unchanged lines between them. */
export class DocumentLineRangeMap {
	public static betweenOutputs(
		inputToOutput1: readonly LineRangeMapping[],
		inputToOutput2: readonly LineRangeMapping[],
		inputLineCount: number,
	): DocumentLineRangeMap {
		const first = new DocumentLineRangeMap(inputToOutput1, inputLineCount);
		const second = new DocumentLineRangeMap(inputToOutput2, inputLineCount);
		const changes = [...inputToOutput1, ...inputToOutput2]
			.map(mapping => mapping.inputRange)
			.sort((left, right) => left.startLineNumber - right.startLineNumber || left.endLineNumberExclusive - right.endLineNumberExclusive);
		const groups: LineRange[] = [];
		for (const change of changes) {
			const previous = groups.at(-1);
			if (previous && previous.endLineNumberExclusive >= change.startLineNumber) {
				groups[groups.length - 1] = previous.join(change);
			} else {
				groups.push(change);
			}
		}
		return new DocumentLineRangeMap(groups.map(group => new LineRangeMapping(first.mapRange(group), second.mapRange(group))), first.outputLineCount);
	}

	constructor(
		public readonly lineRangeMappings: readonly LineRangeMapping[],
		public readonly inputLineCount: number,
	) {
		for (let index = 1; index < lineRangeMappings.length; index++) {
			const previous = lineRangeMappings[index - 1];
			const next = lineRangeMappings[index];
			const inputGap = next.inputRange.startLineNumber - previous.inputRange.endLineNumberExclusive;
			const outputGap = next.outputRange.startLineNumber - previous.outputRange.endLineNumberExclusive;
			if (inputGap < 0 || inputGap !== outputGap) throw new RangeError('Merge line mappings must preserve unchanged lines');
		}
	}

	public get outputLineCount(): number {
		const last = this.lineRangeMappings.at(-1);
		return this.inputLineCount + (last ? last.outputRange.endLineNumberExclusive - last.inputRange.endLineNumberExclusive : 0);
	}

	public reverse(): DocumentLineRangeMap {
		return new DocumentLineRangeMap(this.lineRangeMappings.map(mapping => mapping.reverse()), this.outputLineCount);
	}

	public project(lineNumber: number): LineRangeMapping {
		let offset = 0;
		for (const mapping of this.lineRangeMappings) {
			if (mapping.inputRange.contains(lineNumber)) return mapping;
			if (mapping.inputRange.startLineNumber > lineNumber) break;
			if (mapping.inputRange.endLineNumberExclusive <= lineNumber) {
				offset = mapping.outputRange.endLineNumberExclusive - mapping.inputRange.endLineNumberExclusive;
			}
		}
		return new LineRangeMapping(LineRange.ofLength(lineNumber, 1), LineRange.ofLength(lineNumber + offset, 1));
	}

	public mapRange(range: LineRange): LineRange {
		return new LineRange(this.mapBoundary(range.startLineNumber, 'start'), this.mapBoundary(range.endLineNumberExclusive, 'end'));
	}

	private mapBoundary(lineNumber: number, edge: 'start' | 'end'): number {
		let offset = 0;
		for (const mapping of this.lineRangeMappings) {
			const input = mapping.inputRange;
			const output = mapping.outputRange;
			if (lineNumber < input.startLineNumber) break;
			if (lineNumber === input.startLineNumber) {
				if (input.isEmpty && edge === 'end') return output.endLineNumberExclusive;
				return output.startLineNumber;
			}
			if (lineNumber < input.endLineNumberExclusive) {
				return edge === 'start' ? output.startLineNumber : output.endLineNumberExclusive;
			}
			offset = output.endLineNumberExclusive - input.endLineNumberExclusive;
		}
		return lineNumber + offset;
	}
}

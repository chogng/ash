import { Position } from "../position.js";
import { Range } from "../range.js";
import { TextLength } from "../text/textLength.js";

export class RangeMapping {
	constructor(readonly mappings: readonly SingleRangeMapping[]) {}

	mapPosition(position: Position): PositionOrRange {
		const mapping = [...this.mappings].reverse().find(candidate => candidate.original.getStartPosition().isBeforeOrEqual(position));
		if (!mapping) return PositionOrRange.position(position);
		if (mapping.original.containsPosition(position)) return PositionOrRange.range(mapping.modified);
		return PositionOrRange.position(TextLength.betweenPositions(mapping.original.getEndPosition(), position).addToPosition(mapping.modified.getEndPosition()));
	}

	mapRange(range: Range): Range {
		const start = this.mapPosition(range.getStartPosition());
		const end = this.mapPosition(range.getEndPosition());
		return Range.fromPositions(start.range?.getStartPosition() ?? start.position!, end.range?.getEndPosition() ?? end.position!);
	}

	reverse(): RangeMapping { return new RangeMapping(this.mappings.map(mapping => mapping.reverse())); }
}

export class SingleRangeMapping {
	constructor(readonly original: Range, readonly modified: Range) {}
	reverse(): SingleRangeMapping { return new SingleRangeMapping(this.modified, this.original); }
	toString() { return `${this.original.toString()} -> ${this.modified.toString()}`; }
}

export class PositionOrRange {
	static position(position: Position): PositionOrRange { return new PositionOrRange(position, undefined); }
	static range(range: Range): PositionOrRange { return new PositionOrRange(undefined, range); }
	private constructor(readonly position: Position | undefined, readonly range: Range | undefined) {}
}

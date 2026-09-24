import { LineRange } from '../core/ranges/lineRange.js';
import { Range } from '../core/range.js';

/** Relates one half-open line span in the original document to the modified document. */
export class LineRangeMapping {
	constructor(public readonly original: LineRange, public readonly modified: LineRange) {}

	public flip(): LineRangeMapping {
		return new LineRangeMapping(this.modified, this.original);
	}

	public get changedLineCount(): number {
		return Math.max(this.original.length, this.modified.length);
	}
}

/** One line mapping with its paired character-level edits. */
export class DetailedLineRangeMapping extends LineRangeMapping {
	constructor(original: LineRange, modified: LineRange, public readonly innerChanges: readonly RangeMapping[] | undefined) {
		super(original, modified);
	}

	public override flip(): DetailedLineRangeMapping {
		return new DetailedLineRangeMapping(this.modified, this.original, this.innerChanges?.map(change => change.flip()));
	}
}

/** Relates one text range in each document. Either side may be empty. */
export class RangeMapping {
	constructor(public readonly originalRange: Range, public readonly modifiedRange: Range) {}

	public flip(): RangeMapping {
		return new RangeMapping(this.modifiedRange, this.originalRange);
	}
}

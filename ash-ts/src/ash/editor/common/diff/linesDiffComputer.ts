import { DetailedLineRangeMapping, LineRangeMapping } from './rangeMapping.js';

export interface ILinesDiffComputer {
	computeDiff(originalLines: string[], modifiedLines: string[], options: ILinesDiffComputerOptions): LinesDiff;
}

export interface ILinesDiffComputerOptions {
	readonly ignoreTrimWhitespace: boolean;
	readonly maxComputationTimeMs: number;
	readonly computeMoves: boolean;
	readonly extendToSubwords?: boolean;
}

export class LinesDiff {
	constructor(
		public readonly changes: readonly DetailedLineRangeMapping[],
		public readonly moves: readonly MovedText[],
		public readonly hitTimeout: boolean,
	) {}
}

export class MovedText {
	constructor(public readonly lineRangeMapping: LineRangeMapping, public readonly changes: readonly DetailedLineRangeMapping[]) {}

	public flip(): MovedText {
		return new MovedText(this.lineRangeMapping.flip(), this.changes.map(change => change.flip()));
	}
}

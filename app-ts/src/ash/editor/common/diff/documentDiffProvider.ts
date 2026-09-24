import { type CancellationToken } from '../../../base/common/cancellation.js';
import { type Event } from '../../../base/common/event.js';
import { type ITextModel } from '../model.js';
import { type MovedText } from './linesDiffComputer.js';
import { type DetailedLineRangeMapping } from './rangeMapping.js';

/** Computes a document diff from two caller-owned text models. */
export interface IDocumentDiffProvider {
	computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, cancellationToken: CancellationToken): Promise<IDocumentDiff>;
	readonly onDidChange: Event<void>;
}

export interface IDocumentDiffProviderOptions {
	ignoreTrimWhitespace: boolean;
	maxComputationTimeMs: number;
	computeMoves: boolean;
	extendToSubwords?: boolean;
}

export interface IDocumentDiff {
	readonly identical: boolean;
	readonly quitEarly: boolean;
	readonly changes: readonly DetailedLineRangeMapping[];
	readonly moves: readonly MovedText[];
}

export const nullDocumentDiff: IDocumentDiff = Object.freeze({
	identical: true,
	quitEarly: false,
	changes: Object.freeze([]),
	moves: Object.freeze([]),
});

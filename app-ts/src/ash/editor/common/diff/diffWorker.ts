import { type WebWorkerRequestHandler } from '../../../base/common/worker/webWorker.js';
import { LineRange } from '../core/ranges/lineRange.js';
import { Range } from '../core/range.js';
import { type DiffComputationRequest } from './diffComputationService.js';
import { DefaultLinesDiffComputer } from './defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { LinesDiff, MovedText } from './linesDiffComputer.js';
import { DetailedLineRangeMapping, LineRangeMapping, RangeMapping } from './rangeMapping.js';

export const diffWorkerChannel = { protocol: 'ash.editor.diff', version: 1 };

/** Each request owns its input snapshots; the Worker retains no document state. */
export const diffWorkerHandler: WebWorkerRequestHandler = {
	async handleRequest(message, signal) {
		const request = message.request;
		if (!isRecord(request) || !isDocument(request.original) || !isDocument(request.modified) || !isOptions(request.options)) {
			throw new TypeError('Invalid editor diff request');
		}
		return new DefaultLinesDiffComputer().computeDiffAsync(
			request.original.text.split('\n'),
			request.modified.text.split('\n'),
			request.options,
			signal,
		);
	},
	handleNotification() {
		throw new TypeError('Editor diff does not accept notifications');
	},
};

/** Validates Worker coordinates and restores the standard diff value classes. */
export function readDiffResult(value: unknown, request: DiffComputationRequest): LinesDiff {
	if (!isRecord(value) || !Array.isArray(value.changes) || !Array.isArray(value.moves) || typeof value.hitTimeout !== 'boolean') {
		throw new TypeError('Invalid editor diff result');
	}
	const original = request.original.text.split('\n');
	const modified = request.modified.text.split('\n');
	let originalEnd = 1;
	let modifiedEnd = 1;
	const changes = value.changes.map((item): DetailedLineRangeMapping => {
		if (!isRecord(item)) throw new TypeError('Invalid editor diff change');
		const left = readLineRange(item.original, original.length);
		const right = readLineRange(item.modified, modified.length);
		if (left.startLineNumber < originalEnd || right.startLineNumber < modifiedEnd
			|| left.startLineNumber - originalEnd !== right.startLineNumber - modifiedEnd
			|| left.isEmpty && right.isEmpty) {
			throw new RangeError('Invalid editor diff change order');
		}
		originalEnd = left.endLineNumberExclusive;
		modifiedEnd = right.endLineNumberExclusive;
		const innerChanges = item.innerChanges === undefined ? undefined : readRangeMappings(item.innerChanges, original, modified, left, right);
		return new DetailedLineRangeMapping(left, right, innerChanges);
	});
	if (original.length + 1 - originalEnd !== modified.length + 1 - modifiedEnd) {
		throw new RangeError('Editor diff changes do not cover the requested lines');
	}
	const moves = value.moves.map((item): MovedText => {
		if (!isRecord(item) || !isRecord(item.lineRangeMapping) || !Array.isArray(item.changes)) {
			throw new TypeError('Invalid editor diff move');
		}
		const left = readLineRange(item.lineRangeMapping.original, original.length);
		const right = readLineRange(item.lineRangeMapping.modified, modified.length);
		const moveChanges = item.changes.map((change): DetailedLineRangeMapping => {
			if (!isRecord(change)) throw new TypeError('Invalid editor diff move change');
			const changeLeft = readLineRange(change.original, original.length);
			const changeRight = readLineRange(change.modified, modified.length);
			if (!left.containsRange(changeLeft) || !right.containsRange(changeRight)) {
				throw new RangeError('Invalid editor diff move change range');
			}
			return new DetailedLineRangeMapping(changeLeft, changeRight,
				change.innerChanges === undefined ? undefined : readRangeMappings(change.innerChanges, original, modified, changeLeft, changeRight));
		});
		return new MovedText(new LineRangeMapping(left, right), moveChanges);
	});
	return new LinesDiff(changes, moves, value.hitTimeout);
}

function readLineRange(value: unknown, lineCount: number): LineRange {
	if (!isRecord(value) || !isIndex(value.startLineNumber) || !isIndex(value.endLineNumberExclusive)
		|| value.startLineNumber < 1 || value.startLineNumber > value.endLineNumberExclusive
		|| value.endLineNumberExclusive > lineCount + 1) {
		throw new RangeError('Invalid editor diff line range');
	}
	return new LineRange(value.startLineNumber, value.endLineNumberExclusive);
}

function readRangeMappings(value: unknown, original: readonly string[], modified: readonly string[], left: LineRange, right: LineRange): RangeMapping[] {
	if (!Array.isArray(value)) throw new TypeError('Invalid editor diff inner changes');
	let previousOriginal: Range | undefined;
	let previousModified: Range | undefined;
	return value.map((item): RangeMapping => {
		if (!isRecord(item)) throw new TypeError('Invalid editor diff inner change');
		const originalRange = readRange(item.originalRange, original, left);
		const modifiedRange = readRange(item.modifiedRange, modified, right);
		if ((previousOriginal && startsBeforeEnd(originalRange, previousOriginal))
			|| (previousModified && startsBeforeEnd(modifiedRange, previousModified))) {
			throw new RangeError('Invalid editor diff inner change order');
		}
		previousOriginal = originalRange;
		previousModified = modifiedRange;
		return new RangeMapping(originalRange, modifiedRange);
	});
}

function startsBeforeEnd(next: Range, previous: Range): boolean {
	return next.startLineNumber < previous.endLineNumber
		|| (next.startLineNumber === previous.endLineNumber && next.startColumn < previous.endColumn);
}

function readRange(value: unknown, lines: readonly string[], parent: LineRange): Range {
	if (!isRecord(value) || !isIndex(value.startLineNumber) || !isIndex(value.endLineNumber)
		|| !isIndex(value.startColumn) || !isIndex(value.endColumn)
		|| value.startLineNumber !== value.endLineNumber
		|| !parent.contains(value.startLineNumber)
		|| value.startColumn < 1 || value.startColumn > value.endColumn
		|| value.endColumn > lines[value.startLineNumber - 1]!.length + 1) {
		throw new RangeError('Invalid editor diff text range');
	}
	return new Range(value.startLineNumber, value.startColumn, value.endLineNumber, value.endColumn);
}

function isDocument(value: unknown): value is { version: number; text: string } {
	return isRecord(value) && isIndex(value.version) && typeof value.text === 'string';
}

function isOptions(value: unknown): value is DiffComputationRequest['options'] {
	return isRecord(value)
		&& typeof value.ignoreTrimWhitespace === 'boolean'
		&& typeof value.computeMoves === 'boolean'
		&& typeof value.maxComputationTimeMs === 'number'
		&& Number.isFinite(value.maxComputationTimeMs)
		&& value.maxComputationTimeMs >= 0
		&& (value.extendToSubwords === undefined || typeof value.extendToSubwords === 'boolean');
}

function isIndex(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

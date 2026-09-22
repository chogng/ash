import { type WebWorkerRequestHandler } from '../../../base/common/worker/webWorker.js';
import { type DiffComputationRequest } from './diffComputationService.js';
import { computeLineDiff, LineDiffKind, type LineDiff } from './lineDiff.js';

export const diffWorkerChannel = { protocol: 'ash.editor.diff', version: 1 };
const rowKinds = new Set(Object.values(LineDiffKind));

/** Each request owns its input snapshots; the Worker retains no document state. */
export const diffWorkerHandler: WebWorkerRequestHandler = {
	async handleRequest(message, signal) {
		const request = message.request;
		if (!isRecord(request) || !isDocument(request.original) || !isDocument(request.modified)) {
			throw new TypeError('Invalid editor diff request');
		}
		return computeLineDiff(request.original.text, request.modified.text, signal);
	},
	handleNotification() {
		throw new TypeError('Editor diff does not accept notifications');
	},
};

export function readDiffResult(value: unknown, request: DiffComputationRequest): LineDiff {
	if (!isRecord(value) || !Array.isArray(value.rows) || !Array.isArray(value.hunks)) {
		throw new TypeError('Invalid editor diff result');
	}
	const original = request.original.text.split('\n');
	const modified = request.modified.text.split('\n');
	let originalIndex = 0;
	let modifiedIndex = 0;
	for (const row of value.rows as unknown[]) {
		if (!isRecord(row) || !rowKinds.has(row.kind as LineDiffKind)) {
			throw new TypeError('Invalid editor diff row');
		}
		const hasOriginal = row.kind !== LineDiffKind.Added;
		const hasModified = row.kind !== LineDiffKind.Removed;
		if (row.originalLineIndex !== (hasOriginal ? originalIndex : undefined) || row.modifiedLineIndex !== (hasModified ? modifiedIndex : undefined)) {
			throw new RangeError('Editor diff rows do not cover the requested lines');
		}
		readRanges(row.originalChanges, hasOriginal ? original[originalIndex] : '');
		readRanges(row.modifiedChanges, hasModified ? modified[modifiedIndex] : '');
		originalIndex += Number(hasOriginal);
		modifiedIndex += Number(hasModified);
	}
	if (originalIndex !== original.length || modifiedIndex !== modified.length) {
		throw new RangeError('Editor diff line counts do not match the request');
	}
	let rowEnd = 0;
	for (const hunk of value.hunks as unknown[]) {
		if (!isRecord(hunk) || !isIndex(hunk.rowStart) || !isIndex(hunk.rowEnd) || hunk.rowStart < rowEnd || hunk.rowEnd <= hunk.rowStart || hunk.rowEnd > value.rows.length || !isSpan(hunk.originalStartLineIndex, hunk.originalLineCount, original.length) || !isSpan(hunk.modifiedStartLineIndex, hunk.modifiedLineCount, modified.length)) {
			throw new RangeError('Invalid editor diff hunk');
		}
		rowEnd = hunk.rowEnd;
	}
	return value as unknown as LineDiff;
}

function readRanges(value: unknown, text: string | undefined): void {
	if (!Array.isArray(value) || text === undefined) {
		throw new TypeError('Invalid editor diff ranges');
	}
	let end = 0;
	for (const range of value as unknown[]) {
		if (!isRecord(range) || !isIndex(range.startColumn) || !isIndex(range.endColumn) || range.startColumn < end || range.endColumn < range.startColumn || range.endColumn > text.length) {
			throw new RangeError('Invalid editor diff columns');
		}
		end = range.endColumn;
	}
}

function isSpan(start: unknown, count: unknown, length: number): boolean {
	return isIndex(start) && isIndex(count) && start + count <= length;
}

function isDocument(value: unknown): value is { version: number; text: string } {
	return isRecord(value) && isIndex(value.version) && typeof value.text === 'string';
}

function isIndex(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

import { Range } from "./range.js";
import type { Selection } from "./selection.js";
import { decodeUTF16LE } from "./stringBuilder.js";

/** A compact offset change used by incremental buffers and worker protocols. */
export class TextChange {
	private static _writeStringSize(text: string): number { return encodedStringSize(text); }
	private static _writeString(buffer: Uint8Array, text: string, offset: number): number { return writeString(buffer, text, offset); }
	private static _readString(buffer: Uint8Array, offset: number): string {
		const length = readUInt32BE(buffer, offset);
		return decodeUTF16LE(buffer, offset + 4, length);
	}
	get oldLength(): number { return this.oldText.length; }
	get oldEnd(): number { return this.oldPosition + this.oldText.length; }
	get newLength(): number { return this.newText.length; }
	get newEnd(): number { return this.newPosition + this.newText.length; }

	constructor(readonly oldPosition: number, readonly oldText: string, readonly newPosition: number, readonly newText: string) {
		if (!Number.isSafeInteger(oldPosition) || !Number.isSafeInteger(newPosition) || oldPosition < 0 || newPosition < 0) throw new RangeError("Text change positions must be non-negative safe integers");
	}

	toString(): string {
		const oldText = escapeNewline(this.oldText);
		const newText = escapeNewline(this.newText);
		if (this.oldText.length === 0) return `(insert@${this.oldPosition} \"${newText}\")`;
		if (this.newText.length === 0) return `(delete@${this.oldPosition} \"${oldText}\")`;
		return `(replace@${this.oldPosition} \"${oldText}\" with \"${newText}\")`;
	}

	writeSize(): number { return 8 + TextChange._writeStringSize(this.oldText) + TextChange._writeStringSize(this.newText); }
	write(buffer: Uint8Array, offset: number): number {
		writeUInt32BE(buffer, this.oldPosition, offset); offset += 4;
		writeUInt32BE(buffer, this.newPosition, offset); offset += 4;
		offset = TextChange._writeString(buffer, this.oldText, offset);
		return TextChange._writeString(buffer, this.newText, offset);
	}

	static read(buffer: Uint8Array, offset: number, destination: TextChange[]): number {
		const oldPosition = readUInt32BE(buffer, offset); offset += 4;
		const newPosition = readUInt32BE(buffer, offset); offset += 4;
		const oldText = TextChange._readString(buffer, offset); offset += TextChange._writeStringSize(oldText);
		const newText = TextChange._readString(buffer, offset); offset += TextChange._writeStringSize(newText);
		destination.push(new TextChange(oldPosition, oldText, newPosition, newText));
		return offset;
	}
}

/** Compresses two consecutive change lists into one old-document change list. */
export function compressConsecutiveTextChanges(previous: TextChange[] | null, current: TextChange[]): TextChange[] {
	if (!previous || previous.length === 0) return [...current];
	const compressor = new TextChangeCompressor([...previous], [...current]);
	return compressor.compress();
}

/** The operation that committed one text-model version. */
export enum TextModelChangeReason {
	Edit = "edit",
	EOL = "eol",
	/** Text changed as part of an atomic rich-document transaction. */
	Blocks = "blocks",
	Reset = "reset",
	Undo = "undo",
	Redo = "redo",
	HistoryCancellation = "historyCancellation",
}

/** One normalized replacement reported after a transaction commits. */
export interface TextModelContentChange {
	readonly range: Range;
	readonly rangeOffset: number;
	readonly rangeLength: number;
	readonly text: string;
}

/**
 * Immutable description of one committed text-model transaction.
 *
 * `transactionId` identifies one undo step and remains stable across grouped
 * edits and their undo/redo commits. `version` identifies each commit.
 */
export interface TextModelChange {
	readonly version: number;
	readonly transactionId: number;
	readonly reason: TextModelChangeReason;
	readonly changes: readonly TextModelContentChange[];
	readonly eol: '\n' | '\r\n';
	readonly isEolChange: boolean;
	readonly detailedReasons: readonly TextModelEditSource[];
	readonly resultingSelection: Selection[] | null;
}

import type { TextModelEditSource } from '../textModelEditSource.js';

/**
 * An immutable, versioned view of normalized model text.
 *
 * Offset ranges are end-exclusive and use UTF-16 code units. A snapshot
 * remains readable after later model edits or disposal.
 */
export interface TextSnapshot {
	readonly version: number;
	readonly length: number;
	readonly lineCount: number;
	getText(): string;
	getTextBetweenOffsets(startOffset: number, endOffset: number): string;
}

export function normalizeTextLineEndings(text: string): string {
	return text.replace(/\r\n?|\u2028|\u2029/g, "\n");
}

function escapeNewline(text: string): string { return text.replace(/\n/g, "\\n").replace(/\r/g, "\\r"); }
function encodedStringSize(text: string): number { return 4 + text.length * 2; }

function writeUInt32BE(buffer: Uint8Array, value: number, offset: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff || offset < 0 || offset + 4 > buffer.length) throw new RangeError("Invalid uint32 write");
	buffer[offset] = value >>> 24;
	buffer[offset + 1] = value >>> 16;
	buffer[offset + 2] = value >>> 8;
	buffer[offset + 3] = value;
}

function readUInt32BE(buffer: Uint8Array, offset: number): number {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > buffer.length) throw new RangeError("Invalid uint32 read");
	return buffer[offset]! * 0x1000000 + buffer[offset + 1]! * 0x10000 + buffer[offset + 2]! * 0x100 + buffer[offset + 3]!;
}

function writeString(buffer: Uint8Array, text: string, offset: number): number {
	writeUInt32BE(buffer, text.length, offset);
	offset += 4;
	if (offset + text.length * 2 > buffer.length) throw new RangeError("Text change buffer is too small");
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		buffer[offset++] = code;
		buffer[offset++] = code >>> 8;
	}
	return offset;
}

class TextChangeCompressor {
	private readonly result: TextChange[] = [];
	private previousDelta = 0;
	private currentDelta = 0;

	constructor(private readonly previous: TextChange[], private readonly current: TextChange[]) {}

	compress(): TextChange[] {
		let previousIndex = 0;
		let currentIndex = 0;
		let previous = this.previous[previousIndex] ?? null;
		let current = this.current[currentIndex] ?? null;
		while (previous || current) {
			if (!previous) {
				this.acceptCurrent(current!);
				current = this.current[++currentIndex] ?? null;
				continue;
			}
			if (!current) {
				this.acceptPrevious(previous);
				previous = this.previous[++previousIndex] ?? null;
				continue;
			}
			if (current.oldEnd <= previous.newPosition) {
				this.acceptCurrent(current);
				current = this.current[++currentIndex] ?? null;
				continue;
			}
			if (previous.newEnd <= current.oldPosition) {
				this.acceptPrevious(previous);
				previous = this.previous[++previousIndex] ?? null;
				continue;
			}
			if (current.oldPosition < previous.newPosition) {
				const [first, rest] = TextChangeCompressor.splitCurrent(current, previous.newPosition - current.oldPosition);
				this.acceptCurrent(first);
				current = rest;
				continue;
			}
			if (previous.newPosition < current.oldPosition) {
				const [first, rest] = TextChangeCompressor.splitPrevious(previous, current.oldPosition - previous.newPosition);
				this.acceptPrevious(first);
				previous = rest;
				continue;
			}

			let mergedPrevious: TextChange;
			let mergedCurrent: TextChange;
			if (current.oldEnd === previous.newEnd) {
				mergedPrevious = previous;
				mergedCurrent = current;
				previous = this.previous[++previousIndex] ?? null;
				current = this.current[++currentIndex] ?? null;
			} else if (current.oldEnd < previous.newEnd) {
				const [first, rest] = TextChangeCompressor.splitPrevious(previous, current.oldLength);
				mergedPrevious = first;
				mergedCurrent = current;
				previous = rest;
				current = this.current[++currentIndex] ?? null;
			} else {
				const [first, rest] = TextChangeCompressor.splitCurrent(current, previous.newLength);
				mergedPrevious = previous;
				mergedCurrent = first;
				previous = this.previous[++previousIndex] ?? null;
				current = rest;
			}
			this.result.push(new TextChange(mergedPrevious.oldPosition, mergedPrevious.oldText, mergedCurrent.newPosition, mergedCurrent.newText));
			this.previousDelta += mergedPrevious.newLength - mergedPrevious.oldLength;
			this.currentDelta += mergedCurrent.newLength - mergedCurrent.oldLength;
		}
		return TextChangeCompressor.removeNoOps(TextChangeCompressor.merge(this.result));
	}

	private acceptCurrent(change: TextChange): void {
		this.result.push(new TextChange(change.oldPosition - this.previousDelta, change.oldText, change.newPosition, change.newText));
		this.currentDelta += change.newLength - change.oldLength;
	}

	private acceptPrevious(change: TextChange): void {
		this.result.push(new TextChange(change.oldPosition, change.oldText, change.newPosition + this.currentDelta, change.newText));
		this.previousDelta += change.newLength - change.oldLength;
	}

	private static splitPrevious(change: TextChange, offset: number): [TextChange, TextChange] {
		return [
			new TextChange(change.oldPosition, change.oldText, change.newPosition, change.newText.slice(0, offset)),
			new TextChange(change.oldEnd, "", change.newPosition + offset, change.newText.slice(offset)),
		];
	}

	private static splitCurrent(change: TextChange, offset: number): [TextChange, TextChange] {
		return [
			new TextChange(change.oldPosition, change.oldText.slice(0, offset), change.newPosition, change.newText),
			new TextChange(change.oldPosition + offset, change.oldText.slice(offset), change.newEnd, ""),
		];
	}

	private static merge(changes: readonly TextChange[]): TextChange[] {
		if (changes.length === 0) return [];
		const result: TextChange[] = [];
		let previous = changes[0]!;
		for (let index = 1; index < changes.length; index += 1) {
			const current = changes[index]!;
			if (previous.oldEnd === current.oldPosition) previous = new TextChange(previous.oldPosition, previous.oldText + current.oldText, previous.newPosition, previous.newText + current.newText);
			else { result.push(previous); previous = current; }
		}
		result.push(previous);
		return result;
	}

	private static removeNoOps(changes: readonly TextChange[]): TextChange[] { return changes.filter(change => change.oldText !== change.newText); }
}

import { PieceBuffer, PieceNode, canCoalesce, coalescePieces, createPiece, lowerBound, nodeLength, nodeLineFeeds, nodePieces, slicePiece, updateNodeAndAncestors, type BufferPiece } from "./pieceTreeBase.js";
import { containsRTL, isBasicASCII } from '../../../../base/common/strings.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { NodeColor, deleteNode, insertAfter, insertBefore, leftmost, nextNode, previousNode } from "./rbTreeBase.js";
import { Position } from '../../core/position.js';
import { Range } from '../../core/range.js';
import { WordCharacterClass } from '../../core/wordCharacterClassifier.js';
import { ApplyEditsResult, EndOfLinePreference, FindMatch, type IInternalModelContentChange, type ITextBuffer, type IValidEditOperation, type SearchData, type ValidAnnotatedEditOperation } from '../../model.js';
import { TextChange } from '../../core/textChange.js';
import { createTextBufferSnapshot, type TextBufferSnapshot, type TextBufferSnapshotSegment } from "../textBufferSnapshot.js";

export interface PieceTreeTextBufferStatistics {
	readonly liveTextUnits: number;
	readonly retainedTextUnits: number;
	readonly reclaimableTextUnits: number;
	readonly pieceCount: number;
}

const MINIMUM_RECLAIMABLE_TEXT_UNITS = 64 * 1_024;
const MAXIMUM_RECLAIMABLE_TEXT_UNITS = 64 * 1_024 * 1_024;
const MAXIMUM_PIECE_COUNT = 4_096;

/**
 * Private piece-tree storage for `TextModel`.
 *
 * Pieces reference immutable original/add buffers. A red-black tree keeps
 * character length and line-feed counts on every subtree so edits and
 * coordinate queries do not rebuild a document-wide line index.
 */
interface PreparedBufferEdit {
	readonly sortIndex: number;
	readonly identifier: ValidAnnotatedEditOperation['identifier'];
	readonly range: Range;
	readonly rangeOffset: number;
	readonly rangeLength: number;
	readonly text: string;
	readonly replacedText: string;
	readonly forceMoveMarkers: boolean;
	readonly isAutoWhitespaceEdit: boolean;
}

export class PieceTreeTextBuffer extends Disposable implements ITextBuffer {
	private readonly changeContentEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeContent: Event<void> = this.changeContentEmitter.event;
	private originalBuffer: string;
	private addBuffer = "";
	private root: PieceNode | undefined;
	private readonly bom: string;
	private eol: '\n' | '\r\n';
	private mightContainUnusualLineTerminatorsValue: boolean;

	constructor(text: string, eol: '\n' | '\r\n' = preferredEOL(text), bom = '', shouldNormalizeEOL = true) {
		super();
		if (bom !== '' && bom !== '\uFEFF') throw new TypeError('PieceTreeTextBuffer BOM must be empty or UTF-8 BOM');
		if (!bom && text.startsWith('\uFEFF')) {
			bom = '\uFEFF';
			text = text.slice(1);
		}
		this.bom = bom;
		this.eol = eol;
		this.originalBuffer = shouldNormalizeEOL ? normalizeEOL(text, eol) : text;
		this.mightContainUnusualLineTerminatorsValue = text.includes('\u2028') || text.includes('\u2029');
		if (this.originalBuffer.length > 0) this.root = this.createRootNode(createPiece(PieceBuffer.Original, 0, this.originalBuffer));
	}

	equals(other: ITextBuffer): boolean {
		return this.bom === other.getBOM()
			&& this.eol === other.getEOL()
			&& this.getText() === other.createSnapshot().getText();
	}

	mightContainRTL(): boolean {
		return containsRTL(this.getText());
	}

	mightContainUnusualLineTerminators(): boolean {
		return this.mightContainUnusualLineTerminatorsValue;
	}

	resetMightContainUnusualLineTerminators(): void {
		this.mightContainUnusualLineTerminatorsValue = false;
	}

	mightContainNonBasicASCII(): boolean {
		return !isBasicASCII(this.getText());
	}

	getLength(): number {
		return nodeLength(this.root);
	}

	getLineCount(): number {
		return nodeLineFeeds(this.root) + 1;
	}

	get pieceCount(): number {
		return nodePieces(this.root);
	}

	getBOM(): string {
		return this.bom;
	}

	getEOL(): '\n' | '\r\n' {
		return this.eol;
	}

	getStatistics(): PieceTreeTextBufferStatistics {
		const retainedTextUnits =
			this.originalBuffer.length +
			this.addBuffer.length;
		return Object.freeze({
			liveTextUnits: this.getLength(),
			retainedTextUnits,
			reclaimableTextUnits: Math.max(
				0,
				retainedTextUnits - this.getLength(),
			),
			pieceCount: this.pieceCount,
		});
	}

	private getText(): string {
		const parts: string[] = [];
		this.collectText(this.root, parts);
		return parts.join("");
	}

	createSnapshot(preserveBOM = false): TextBufferSnapshot {
		const segments: TextBufferSnapshotSegment[] = [];
		if (preserveBOM && this.bom) segments.push({ source: this.bom, startOffset: 0, length: this.bom.length });
		this.collectSnapshotSegments(this.root, segments);
		return createTextBufferSnapshot(
			segments,
			this.getLength() + (preserveBOM ? this.bom.length : 0),
			this.getLineCount(),
		);
	}

	private getTextBetweenOffsets(startOffset: number, endOffset: number): string {
		this.assertRange(startOffset, endOffset);
		if (startOffset === endOffset) return "";
		const parts: string[] = [];
		this.collectRange(this.root, 0, startOffset, endOffset, parts);
		return parts.join("");
	}

	getValueInRange(range: Range, eol = EndOfLinePreference.TextDefined): string {
		const startOffset = this.getOffsetAt(range.startLineNumber, range.startColumn);
		const endOffset = this.getOffsetAt(range.endLineNumber, range.endColumn);
		const value = this.getTextBetweenOffsets(startOffset, endOffset);
		if (eol === EndOfLinePreference.TextDefined) return value;
		const lineFeedValue = value.replace(/\r\n|\r/g, '\n');
		return eol === EndOfLinePreference.CRLF ? lineFeedValue.replace(/\n/g, '\r\n') : lineFeedValue;
	}

	getValueLengthInRange(range: Range, eol = EndOfLinePreference.TextDefined): number {
		return this.getValueInRange(range, eol).length;
	}

	getCharacterCountInRange(range: Range, eol = EndOfLinePreference.TextDefined): number {
		return [...this.getValueInRange(range, eol)].length;
	}

	getNearestChunk(offset: number): string {
		assertSafeIndex(offset, 'offset');
		if (offset > this.getLength()) throw new RangeError(`offset must be between 0 and ${this.getLength()}`);
		let node = leftmost(this.root);
		let nodeStartOffset = 0;
		while (node) {
			const nodeEndOffset = nodeStartOffset + node.piece.length;
			if (offset < nodeEndOffset) return this.pieceText(node.piece).slice(offset - nodeStartOffset);
			nodeStartOffset = nodeEndOffset;
			node = nextNode(node);
		}
		return '';
	}

	getRangeAt(start: number, length: number): Range {
		assertSafeIndex(length, 'length');
		return Range.fromPositions(this.getPositionAt(start), this.getPositionAt(start + length));
	}

	getLinesContent(): string[] {
		return Array.from({ length: this.getLineCount() }, (_, lineIndex) => this.getLineContent(lineIndex + 1));
	}

	getLineContent(lineNumber: number): string {
		this.assertLineNumber(lineNumber);
		const lineIndex = lineNumber - 1;
		const startOffset = this.lineStartOffset(lineIndex);
		return this.getTextBetweenOffsets(startOffset, this.lineEndOffset(lineIndex));
	}

	getLineCharCode(lineNumber: number, index: number): number {
		this.assertLineNumber(lineNumber);
		assertSafeIndex(index, 'index');
		const lineIndex = lineNumber - 1;
		const startOffset = this.lineStartOffset(lineIndex);
		const offset = startOffset + index;
		return offset < this.lineEndOffset(lineIndex) ? this.getCharCode(offset) : Number.NaN;
	}

	getCharCode(offset: number): number {
		assertSafeIndex(offset, 'offset');
		if (offset > this.getLength()) throw new RangeError(`offset must be between 0 and ${this.getLength()}`);
		return this.getNearestChunk(offset).charCodeAt(0);
	}

	getLineLength(lineNumber: number): number {
		this.assertLineNumber(lineNumber);
		const lineIndex = lineNumber - 1;
		return this.lineEndOffset(lineIndex) - this.lineStartOffset(lineIndex);
	}

	getLineMinColumn(lineNumber: number): number {
		this.assertLineNumber(lineNumber);
		return 1;
	}

	getLineMaxColumn(lineNumber: number): number {
		return this.getLineLength(lineNumber) + 1;
	}

	getLineFirstNonWhitespaceColumn(lineNumber: number): number {
		const index = this.getLineContent(lineNumber).search(/\S/u);
		return index < 0 ? 0 : index + 1;
	}

	getLineLastNonWhitespaceColumn(lineNumber: number): number {
		const content = this.getLineContent(lineNumber);
		for (let index = content.length - 1; index >= 0; index -= 1) {
			if (/\S/u.test(content[index]!)) return index + 2;
		}
		return 0;
	}

	findMatchesLineByLine(searchRange: Range, searchData: SearchData, captureMatches: boolean, limitResultCount: number): FindMatch[] {
		if (!Number.isSafeInteger(limitResultCount) || limitResultCount < 0) throw new RangeError('PieceTreeTextBuffer search result limit must be a non-negative safe integer');
		const range = Range.lift(searchRange);
		this.getOffsetAt(range.startLineNumber, range.startColumn);
		this.getOffsetAt(range.endLineNumber, range.endColumn);
		const flags = searchData.regex.flags.includes('g') ? searchData.regex.flags : `${searchData.regex.flags}g`;
		const expression = new RegExp(searchData.regex.source, flags);
		const matches: FindMatch[] = [];
		for (let lineNumber = range.startLineNumber; lineNumber <= range.endLineNumber && matches.length < limitResultCount; lineNumber += 1) {
			const line = this.getLineContent(lineNumber);
			const startIndex = lineNumber === range.startLineNumber ? range.startColumn - 1 : 0;
			const endIndex = lineNumber === range.endLineNumber ? range.endColumn - 1 : line.length;
			const value = line.slice(startIndex, endIndex);
			expression.lastIndex = 0;
			let match: RegExpExecArray | null;
			while (matches.length < limitResultCount && (match = expression.exec(value))) {
				const matchStart = startIndex + match.index;
				const matchEnd = matchStart + match[0].length;
				if (isWholeWordMatch(line, matchStart, matchEnd, searchData)) {
					matches.push(new FindMatch(new Range(lineNumber, matchStart + 1, lineNumber, matchEnd + 1), captureMatches ? [...match] : null));
				}
				if (match[0].length === 0) {
					if (expression.lastIndex >= value.length) break;
					expression.lastIndex += value.codePointAt(expression.lastIndex)! > 0xffff ? 2 : 1;
				}
			}
		}
		return matches;
	}

	getOffsetAt(lineNumber: number, column: number): number {
		this.assertLineNumber(lineNumber);
		assertSafeIndex(column, "column");
		const lineIndex = lineNumber - 1;
		const columnIndex = column - 1;
		const startOffset = this.lineStartOffset(lineIndex);
		const lineLength = this.lineEndOffset(lineIndex) - startOffset;
		if (columnIndex < 0 || columnIndex > lineLength) {
			throw new RangeError(
				`column ${column} exceeds line ${lineNumber} maximum column ${lineLength + 1}`,
			);
		}
		return startOffset + columnIndex;
	}

	getPositionAt(offset: number): Position {
		assertSafeIndex(offset, "offset");
		if (offset > this.getLength()) {
			throw new RangeError(
				`offset must be a safe integer between 0 and ${this.getLength()}`,
			);
		}
		const lineIndex = this.countLineFeedsBefore(this.root, offset);
		const startOffset = this.lineStartOffset(lineIndex);
		return new Position(
			lineIndex + 1,
			Math.min(
				offset - startOffset,
				this.lineEndOffset(lineIndex) - startOffset,
			) + 1,
		);
	}

	applyEdits(rawOperations: ValidAnnotatedEditOperation[], recordTrimAutoWhitespace: boolean, computeUndoEdits: boolean): ApplyEditsResult {
		if (!Array.isArray(rawOperations)) throw new TypeError('PieceTreeTextBuffer edits must be an array');
		const operations = rawOperations.map<PreparedBufferEdit>((operation, sortIndex) => {
			const range = Range.lift(operation.range);
			const rangeOffset = this.getOffsetAt(range.startLineNumber, range.startColumn);
			const rangeEndOffset = this.getOffsetAt(range.endLineNumber, range.endColumn);
			const text = normalizeEOL(operation.text ?? '', this.eol);
			return {
				sortIndex,
				identifier: operation.identifier,
				range,
				rangeOffset,
				rangeLength: rangeEndOffset - rangeOffset,
				text,
				replacedText: this.getTextBetweenOffsets(rangeOffset, rangeEndOffset),
				forceMoveMarkers: operation.forceMoveMarkers,
				isAutoWhitespaceEdit: operation.isAutoWhitespaceEdit,
			};
		}).sort(comparePreparedBufferEdits);

		for (let index = 1; index < operations.length; index += 1) {
			const previous = operations[index - 1]!;
			const current = operations[index]!;
			const ambiguousSharedStart = current.rangeOffset === previous.rangeOffset && (current.rangeLength === 0 || previous.rangeLength === 0);
			if (current.rangeOffset < previous.rangeOffset + previous.rangeLength || ambiguousSharedStart) {
				throw new RangeError('PieceTreeTextBuffer edits must not overlap');
			}
		}

		const reverseOffsets = new Map<PreparedBufferEdit, { readonly startOffset: number; readonly endOffset: number }>();
		let cumulativeDelta = 0;
		for (const operation of operations) {
			const startOffset = operation.rangeOffset + cumulativeDelta;
			reverseOffsets.set(operation, { startOffset, endOffset: startOffset + operation.text.length });
			cumulativeDelta += operation.text.length - operation.rangeLength;
		}

		const changes = operations.slice().reverse().map<IInternalModelContentChange>(operation => ({
			range: operation.range,
			rangeOffset: operation.rangeOffset,
			rangeLength: operation.rangeLength,
			text: operation.text,
			forceMoveMarkers: operation.forceMoveMarkers,
		}));
		for (const operation of operations.slice().reverse()) {
			this.replace(operation.rangeOffset, operation.rangeOffset + operation.rangeLength, operation.text);
		}

		let reverseEdits: IValidEditOperation[] | null = null;
		if (computeUndoEdits) {
			reverseEdits = operations.slice().sort((left, right) => left.sortIndex - right.sortIndex).map(operation => {
				const offsets = reverseOffsets.get(operation)!;
				return {
					identifier: operation.identifier,
					range: this.getRangeAt(offsets.startOffset, offsets.endOffset - offsets.startOffset),
					text: operation.replacedText,
					textChange: new TextChange(operation.rangeOffset, operation.replacedText, offsets.startOffset, operation.text),
				};
			});
		}

		let trimAutoWhitespaceLineNumbers: number[] | null = null;
		if (recordTrimAutoWhitespace) {
			const lines = new Set<number>();
			for (const operation of operations) {
				if (!operation.isAutoWhitespaceEdit || !operation.range.isEmpty()) continue;
				const offsets = reverseOffsets.get(operation)!;
				const range = this.getRangeAt(offsets.startOffset, offsets.endOffset - offsets.startOffset);
				for (let lineNumber = range.startLineNumber; lineNumber <= range.endLineNumber; lineNumber += 1) {
					const line = this.getLineContent(lineNumber);
					if (line.length > 0 && /^\s+$/u.test(line)) lines.add(lineNumber);
				}
			}
			trimAutoWhitespaceLineNumbers = [...lines].sort((left, right) => right - left);
		}

		this.changeContentEmitter.fire();
		return new ApplyEditsResult(reverseEdits, changes, trimAutoWhitespaceLineNumbers);
	}

	private replace(startOffset: number, endOffset: number, text: string): void {
		this.assertRange(startOffset, endOffset);
		if (!this.mightContainUnusualLineTerminatorsValue && (text.includes('\u2028') || text.includes('\u2029'))) {
			this.mightContainUnusualLineTerminatorsValue = true;
		}
		const endNode = this.ensureBoundary(endOffset);
		const startNode = this.ensureBoundary(startOffset);
		let current = startNode;
		while (current && current !== endNode) {
			const next = nextNode(current);
			this.root = deleteNode(this.root!, current);
			current = next;
		}

		if (text.length > 0) {
			const addStartOffset = this.addBuffer.length;
			this.addBuffer += text;
			const inserted = new PieceNode(createPiece(PieceBuffer.Add, addStartOffset, text));
			this.root = insertBefore(this.root, endNode, inserted);
			this.coalesceAround(inserted);
		} else if (endNode) {
			this.coalesceAround(endNode);
		}
	}

	setEOL(eol: '\n' | '\r\n'): void {
		if (eol !== '\n' && eol !== '\r\n') throw new TypeError('PieceTreeTextBuffer EOL must be LF or CRLF');
		if (this.eol === eol) return;
		const text = normalizeEOL(this.getText(), eol);
		this.eol = eol;
		this.originalBuffer = text;
		this.addBuffer = '';
		this.root = text.length > 0 ? this.createRootNode(createPiece(PieceBuffer.Original, 0, text)) : undefined;
	}

	compactIfNeeded(): boolean {
		if (!this.needsCompaction()) return false;
		this.compact();
		return true;
	}

	maintainIfNeeded(): boolean {
		return this.compactIfNeeded();
	}

	/** Reports whether retaining obsolete piece buffers exceeds the maintenance budget. */
	needsCompaction(): boolean {
		const statistics = this.getStatistics();
		const fragmented = statistics.pieceCount > MAXIMUM_PIECE_COUNT;
		const disproportionatelyRetained =
			statistics.reclaimableTextUnits >=
				MINIMUM_RECLAIMABLE_TEXT_UNITS &&
			statistics.retainedTextUnits >=
				statistics.liveTextUnits * 2;
		const absolutelyRetained =
			statistics.reclaimableTextUnits >=
				MAXIMUM_RECLAIMABLE_TEXT_UNITS;
		return fragmented || disproportionatelyRetained || absolutelyRetained;
	}

	needsMaintenance(): boolean {
		return this.needsCompaction();
	}

	compact(): void {
		const text = this.getText();
		this.originalBuffer = text;
		this.addBuffer = "";
		this.root = text.length > 0 ? this.createRootNode(createPiece(PieceBuffer.Original, 0, text)) : undefined;
	}

	maintain(): void {
		this.compact();
	}

	private collectText(
		node: PieceNode | undefined,
		parts: string[],
	): void {
		if (!node) return;
		this.collectText(node.left, parts);
		parts.push(this.pieceText(node.piece));
		this.collectText(node.right, parts);
	}

	private collectSnapshotSegments(
		node: PieceNode | undefined,
		segments: TextBufferSnapshotSegment[],
	): void {
		if (!node) return;
		this.collectSnapshotSegments(node.left, segments);
		segments.push({
			source: node.piece.buffer === PieceBuffer.Original
				? this.originalBuffer
				: this.addBuffer,
			startOffset: node.piece.startOffset,
			length: node.piece.length,
		});
		this.collectSnapshotSegments(node.right, segments);
	}

	private collectRange(
		node: PieceNode | undefined,
		baseOffset: number,
		startOffset: number,
		endOffset: number,
		parts: string[],
	): void {
		if (!node || startOffset >= endOffset) return;
		const leftLength = nodeLength(node.left);
		const pieceStartOffset = baseOffset + leftLength;
		const pieceEndOffset = pieceStartOffset + node.piece.length;
		if (startOffset < pieceStartOffset) {
			this.collectRange(
				node.left,
				baseOffset,
				startOffset,
				Math.min(endOffset, pieceStartOffset),
				parts,
			);
		}
		const intersectionStart = Math.max(startOffset, pieceStartOffset);
		const intersectionEnd = Math.min(endOffset, pieceEndOffset);
		if (intersectionStart < intersectionEnd) {
			const buffer = node.piece.buffer === PieceBuffer.Original ? this.originalBuffer : this.addBuffer;
			parts.push(buffer.slice(
				node.piece.startOffset + intersectionStart - pieceStartOffset,
				node.piece.startOffset + intersectionEnd - pieceStartOffset,
			));
		}
		if (endOffset > pieceEndOffset) {
			this.collectRange(
				node.right,
				pieceEndOffset,
				Math.max(startOffset, pieceEndOffset),
				endOffset,
				parts,
			);
		}
	}

	private lineStartOffset(lineIndex: number): number {
		return lineIndex === 0
			? 0
			: this.lineFeedOffset(lineIndex - 1) + 1;
	}

	private lineEndOffset(lineIndex: number): number {
		if (lineIndex + 1 >= this.getLineCount()) return this.getLength();
		const lineFeedOffset = this.lineFeedOffset(lineIndex);
		return this.eol === '\r\n' ? lineFeedOffset - 1 : lineFeedOffset;
	}

	private lineFeedOffset(lineFeedIndex: number): number {
		let node = this.root;
		let baseOffset = 0;
		let remaining = lineFeedIndex;
		while (node) {
			const leftLineFeeds = nodeLineFeeds(node.left);
			const leftLength = nodeLength(node.left);
			if (remaining < leftLineFeeds) {
				node = node.left;
				continue;
			}
			remaining -= leftLineFeeds;
			if (remaining < node.piece.lineFeedOffsets.length) {
				return baseOffset +
					leftLength +
					node.piece.lineFeedOffsets[remaining];
			}
			remaining -= node.piece.lineFeedOffsets.length;
			baseOffset += leftLength + node.piece.length;
			node = node.right;
		}
		throw new RangeError(`Unknown line feed index ${lineFeedIndex}`);
	}

	private countLineFeedsBefore(
		node: PieceNode | undefined,
		offset: number,
	): number {
		if (!node || offset <= 0) return 0;
		const leftLength = nodeLength(node.left);
		if (offset <= leftLength) {
			return this.countLineFeedsBefore(node.left, offset);
		}
		let count = nodeLineFeeds(node.left);
		const pieceOffset = Math.min(
			offset - leftLength,
			node.piece.length,
		);
		count += lowerBound(node.piece.lineFeedOffsets, pieceOffset);
		if (offset <= leftLength + node.piece.length) return count;
		return count + this.countLineFeedsBefore(
			node.right,
			offset - leftLength - node.piece.length,
		);
	}

	private ensureBoundary(offset: number): PieceNode | undefined {
		if (offset === this.getLength()) return undefined;
		let node = this.root;
		let baseOffset = 0;
		while (node) {
			const leftLength = nodeLength(node.left);
			const pieceStartOffset = baseOffset + leftLength;
			const pieceEndOffset = pieceStartOffset + node.piece.length;
			if (offset < pieceStartOffset) {
				node = node.left;
				continue;
			}
			if (offset > pieceEndOffset) {
				baseOffset = pieceEndOffset;
				node = node.right;
				continue;
			}
			if (offset === pieceStartOffset) return node;
			if (offset === pieceEndOffset) return nextNode(node);

			const pieceOffset = offset - pieceStartOffset;
			const rightPiece = slicePiece(node.piece, pieceOffset, node.piece.length);
			node.piece = slicePiece(node.piece, 0, pieceOffset);
			updateNodeAndAncestors(node);
			const right = new PieceNode(rightPiece);
			this.root = insertAfter(this.root!, node, right);
			return right;
		}
		throw new Error(`Unable to resolve PieceTree boundary at offset ${offset}`);
	}

	private coalesceAround(node: PieceNode): void {
		let current = node;
		const previous = previousNode(current);
		if (previous && canCoalesce(previous.piece, current.piece)) {
			const combined = coalescePieces(previous.piece, current.piece);
			this.root = deleteNode(this.root!, current)!;
			previous.piece = combined;
			updateNodeAndAncestors(previous);
			current = previous;
		}
		const next = nextNode(current);
		if (next && canCoalesce(current.piece, next.piece)) {
			const combined = coalescePieces(current.piece, next.piece);
			this.root = deleteNode(this.root!, next)!;
			current.piece = combined;
			updateNodeAndAncestors(current);
		}
	}

	private createRootNode(piece: BufferPiece): PieceNode {
		const node = new PieceNode(piece);
		node.color = NodeColor.Black;
		return node;
	}

	private pieceText(piece: BufferPiece): string {
		const buffer = piece.buffer === PieceBuffer.Original
			? this.originalBuffer
			: this.addBuffer;
		return buffer.slice(
			piece.startOffset,
			piece.startOffset + piece.length,
		);
	}

	private assertRange(startOffset: number, endOffset: number): void {
		if (
			!Number.isSafeInteger(startOffset) ||
			!Number.isSafeInteger(endOffset) ||
			startOffset < 0 ||
			endOffset < startOffset ||
			endOffset > this.getLength()
		) {
			throw new RangeError(
				`Offsets must satisfy 0 <= start <= end <= ${this.getLength()}`,
			);
		}
	}

	private assertLineNumber(lineNumber: number): void {
		if (
			!Number.isSafeInteger(lineNumber) ||
			lineNumber < 1 ||
			lineNumber > this.getLineCount()
		) {
			throw new RangeError(
				`lineNumber must be a safe integer between 1 and ${this.getLineCount()}`,
			);
		}
	}
}

function preferredEOL(text: string): '\n' | '\r\n' {
	let cr = 0;
	let lf = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text.charCodeAt(index);
		if (character === 13) {
			cr += 1;
			if (text.charCodeAt(index + 1) === 10) index += 1;
		} else if (character === 10) lf += 1;
	}
	return cr > (cr + lf) / 2 ? '\r\n' : '\n';
}

function comparePreparedBufferEdits(left: PreparedBufferEdit, right: PreparedBufferEdit): number {
	return left.rangeOffset - right.rangeOffset || left.rangeLength - right.rangeLength;
}

function isWholeWordMatch(line: string, startIndex: number, endIndex: number, searchData: SearchData): boolean {
	const classifier = searchData.wordSeparators;
	if (!classifier) return true;
	const firstIsRegular = startIndex < line.length && classifier.get(line.charCodeAt(startIndex)) === WordCharacterClass.Regular;
	const lastIsRegular = endIndex > startIndex && classifier.get(line.charCodeAt(endIndex - 1)) === WordCharacterClass.Regular;
	const beforeIsRegular = startIndex > 0 && classifier.get(line.charCodeAt(startIndex - 1)) === WordCharacterClass.Regular;
	const afterIsRegular = endIndex < line.length && classifier.get(line.charCodeAt(endIndex)) === WordCharacterClass.Regular;
	return !(firstIsRegular && beforeIsRegular) && !(lastIsRegular && afterIsRegular);
}

function normalizeEOL(text: string, eol: '\n' | '\r\n'): string {
	return text.replace(/\r\n|\r|\n/g, eol);
}

function assertSafeIndex(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
}

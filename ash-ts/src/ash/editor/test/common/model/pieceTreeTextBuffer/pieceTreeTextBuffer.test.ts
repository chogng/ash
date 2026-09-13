import assert from "node:assert/strict";
import { test } from "mocha";
import { CharCode } from "../../../../../base/common/charCode.js";
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { PieceNode } from "../../../../common/model/pieceTreeTextBuffer/pieceTreeBase.js";
import { NodeColor } from "../../../../common/model/pieceTreeTextBuffer/rbTreeBase.js";
import { PieceTreeTextBuffer } from "../../../../common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.js";
import { PieceTreeTextBufferBuilder } from "../../../../common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js";
import { DefaultEndOfLine, FindMatch, SearchData, ValidAnnotatedEditOperation } from '../../../../common/model.js';

test("PieceTreeTextBuffer matches a string oracle and red-black invariants across deterministic edits", () => {
	const random = createRandom(0x71ece);
	const buffer = new PieceTreeTextBuffer("seed\n😀text");
	let oracle = "seed\n😀text";
	const insertions = ["", "a", "XYZ", "\n", "x\ny", "😀"];
	assertTreeInvariants(buffer);

	for (let iteration = 0; iteration < 1_000; iteration += 1) {
		const startOffset = integer(random, oracle.length + 1);
		const endOffset = startOffset +
			integer(random, oracle.length - startOffset + 1);
		const insertedText = insertions[integer(random, insertions.length)];
		applyOffsetEdit(buffer, startOffset, endOffset, insertedText);
		assertTreeInvariants(buffer);
		oracle =
			oracle.slice(0, startOffset) +
			insertedText +
			oracle.slice(endOffset);

		const rangeStart = integer(random, oracle.length + 1);
		const rangeEnd = rangeStart +
			integer(random, oracle.length - rangeStart + 1);
		const offset = integer(random, oracle.length + 1);
		const expectedPosition = positionAt(oracle, offset);
		const lineStarts = computeLineStarts(oracle);
		const lineIndex = integer(random, lineStarts.length);
		const lineEndOffset = lineIndex + 1 < lineStarts.length
			? lineStarts[lineIndex + 1] - 1
			: oracle.length;
		const columnIndex = integer(
			random,
			lineEndOffset - lineStarts[lineIndex] + 1,
		);

		assert.deepEqual({
			text: buffer.createSnapshot().getText(),
			length: buffer.getLength(),
			lineCount: buffer.getLineCount(),
			range: buffer.getValueInRange(buffer.getRangeAt(rangeStart, rangeEnd - rangeStart)),
			position: buffer.getPositionAt(offset),
			offset: buffer.getOffsetAt(lineIndex + 1, columnIndex + 1),
			line: buffer.getLineContent(lineIndex + 1),
		}, {
			text: oracle,
			length: oracle.length,
			lineCount: lineStarts.length,
			range: oracle.slice(rangeStart, rangeEnd),
			position: expectedPosition,
			offset: lineStarts[lineIndex] + columnIndex,
			line: oracle.slice(lineStarts[lineIndex], lineEndOffset),
		});
	}
});

test("PieceTreeTextBufferBuilder constructs one buffer from ordered chunks", () => {
	const builder = new PieceTreeTextBufferBuilder();
	builder.acceptChunk("first\n");
	builder.acceptChunk("");
	builder.acceptChunk("second😀");
	const factory = builder.finish();
	const { textBuffer: buffer } = factory.create(DefaultEndOfLine.LF);

	assert.deepEqual({
		text: buffer.createSnapshot().getText(),
		lineCount: buffer.getLineCount(),
		position: buffer.getPositionAt(8),
	}, {
		text: "first\nsecond😀",
		lineCount: 2,
		position: new Position(2, 3),
	});
	assert.equal(factory.getFirstLineText(100), 'first');
});

test('PieceTreeTextBufferBuilder owns BOM and the predominant EOL', () => {
	const builder = new PieceTreeTextBufferBuilder();
	builder.acceptChunk('\uFEFFfirst\r');
	builder.acceptChunk('\nsecond\rthird');
	const { textBuffer: buffer } = builder.finish().create(DefaultEndOfLine.LF);

	assert.equal(buffer.getBOM(), '\uFEFF');
	assert.equal(buffer.getEOL(), '\r\n');
	assert.equal(buffer.createSnapshot().getText(), 'first\r\nsecond\r\nthird');
	assert.equal(buffer.getLineContent(2), 'second');
	assert.equal(buffer.getOffsetAt(2, 3), 9);
	assert.deepEqual(buffer.getPositionAt(9), new Position(2, 3));
	assert.equal(buffer.createSnapshot(true).getText(), '\uFEFFfirst\r\nsecond\r\nthird');

	buffer.setEOL('\n');
	assert.equal(buffer.getEOL(), '\n');
	assert.equal(buffer.createSnapshot().getText(), 'first\nsecond\nthird');
	assert.equal(buffer.getOffsetAt(2, 3), 8);
});

test('PieceTreeTextBufferBuilder joins split surrogate pairs without normalizing when disabled', () => {
	const builder = new PieceTreeTextBufferBuilder();
	builder.acceptChunk('alpha\r\nbeta\uD83D');
	builder.acceptChunk('\uDE03\ngamma');
	const factory = builder.finish(false);
	const { textBuffer: buffer, disposable } = factory.create(DefaultEndOfLine.CRLF);

	assert.equal(factory.getFirstLineText(3), 'alp');
	assert.equal(buffer.getEOL(), '\n');
	assert.equal(buffer.createSnapshot().getText(), 'alpha\r\nbeta😃\ngamma');
	assert.equal(buffer.getLineContent(2), 'beta😃');
	disposable.dispose();
});

test('PieceTreeTextBuffer exposes the ITextBuffer query contract', () => {
	using buffer = new PieceTreeTextBuffer('alpha\n\u05D0mega');
	using equal = new PieceTreeTextBuffer('alpha\n\u05D0mega');

	assert.equal(buffer.equals(equal), true);
	assert.equal(buffer.mightContainRTL(), true);
	assert.equal(buffer.mightContainNonBasicASCII(), true);
	assert.equal(buffer.getCharCode(0), 'a'.charCodeAt(0));
	assert.equal(buffer.getLineCharCode(2, 0), '\u05D0'.charCodeAt(0));
	assert.equal(buffer.getNearestChunk(6), '\u05D0mega');
	assert.equal(buffer.getNearestChunk(buffer.getLength()), '');
	assert.deepEqual(buffer.getRangeAt(6, 5), new Range(2, 1, 2, 6));
	assert.deepEqual(buffer.findMatchesLineByLine(new Range(1, 1, 2, 6), new SearchData(/mega/gu, null, 'mega'), true, 10), [
		new FindMatch(new Range(2, 2, 2, 6), ['mega']),
	]);
});

test('PieceTreeTextBuffer applies one atomic edit batch and returns inverse edits', () => {
	using buffer = new PieceTreeTextBuffer('abc\ndef');
	let changeEvents = 0;
	using listener = buffer.onDidChangeContent(() => changeEvents += 1);
	const result = buffer.applyEdits([
		new ValidAnnotatedEditOperation({ major: 1, minor: 0 }, new Range(2, 1, 2, 2), 'D', false, false, false),
		new ValidAnnotatedEditOperation({ major: 0, minor: 0 }, new Range(1, 2, 1, 3), 'B', false, false, false),
	], false, true);

	assert.equal(buffer.createSnapshot().getText(), 'aBc\nDef');
	assert.equal(changeEvents, 1);
	assert.deepEqual(result.changes.map(change => change.range), [new Range(2, 1, 2, 2), new Range(1, 2, 1, 3)]);
	assert.ok(result.reverseEdits);
	buffer.applyEdits(result.reverseEdits.map(edit => new ValidAnnotatedEditOperation(edit.identifier, edit.range, edit.text, false, false, false)), false, false);
	assert.equal(buffer.createSnapshot().getText(), 'abc\ndef');
	assert.equal(changeEvents, 2);
});

test("PieceTreeTextBuffer coalesces contiguous source pieces", () => {
	const typed = new PieceTreeTextBuffer("");
	for (const character of "continuous") {
		applyOffsetEdit(typed, typed.getLength(), typed.getLength(), character);
		assertTreeInvariants(typed);
	}
	assert.deepEqual({
		text: typed.createSnapshot().getText(),
		pieceCount: typed.pieceCount,
	}, {
		text: "continuous",
		pieceCount: 1,
	});

	const restoredOriginal = new PieceTreeTextBuffer("abcdef");
	applyOffsetEdit(restoredOriginal, 3, 3, "X");
	assertTreeInvariants(restoredOriginal);
	assert.equal(restoredOriginal.pieceCount, 3);
	applyOffsetEdit(restoredOriginal, 3, 4, "");
	assertTreeInvariants(restoredOriginal);
	assert.deepEqual({
		text: restoredOriginal.createSnapshot().getText(),
		pieceCount: restoredOriginal.pieceCount,
	}, {
		text: "abcdef",
		pieceCount: 1,
	});
});

test("PieceTreeTextBuffer compaction preserves captured sources", () => {
	const insertedText = "line\n".repeat(20_000);
	const retainedText = insertedText.slice(-10_000);
	const buffer = new PieceTreeTextBuffer("");
	applyOffsetEdit(buffer, 0, 0, insertedText);
	assertTreeInvariants(buffer);
	const snapshot = buffer.createSnapshot();
	applyOffsetEdit(buffer, 0, insertedText.length - retainedText.length, "");
	assertTreeInvariants(buffer);

	const before = buffer.getStatistics();
	assert.equal(buffer.compactIfNeeded(), true);
	assertTreeInvariants(buffer);
	const after = buffer.getStatistics();

	assert.deepEqual({
		text: buffer.createSnapshot().getText(),
		lineCount: buffer.getLineCount(),
		before,
		after,
		capturedText: snapshot.getText(),
		secondCompaction: buffer.compactIfNeeded(),
	}, {
		text: retainedText,
		lineCount: 2_001,
		before: {
			liveTextUnits: retainedText.length,
			retainedTextUnits: insertedText.length,
			reclaimableTextUnits:
				insertedText.length - retainedText.length,
			pieceCount: 1,
		},
		after: {
			liveTextUnits: retainedText.length,
			retainedTextUnits: retainedText.length,
			reclaimableTextUnits: 0,
			pieceCount: 1,
		},
		capturedText: insertedText,
		secondCompaction: false,
	});
});

function assertTreeInvariants(buffer: PieceTreeTextBuffer): void {
	const root = (buffer as unknown as PieceTreeTextBufferInternals).root;
	if (root) {
		assert.equal(root.color, NodeColor.Black, "red-black root must be black");
		assert.equal(root.parent, undefined, "red-black root must not have a parent");
	}
	const aggregate = assertNode(root, undefined);
	assert.deepEqual({
		length: aggregate.length,
		lineFeeds: aggregate.lineFeeds,
		pieces: aggregate.pieces,
	}, {
		length: buffer.getLength(),
		lineFeeds: buffer.getLineCount() - 1,
		pieces: buffer.pieceCount,
	});
}

function assertNode(node: PieceNode | undefined, parent: PieceNode | undefined): TreeAggregate {
	if (!node) return { length: 0, lineFeeds: 0, pieces: 0, blackHeight: 1 };
	assert.equal(node.parent, parent, "red-black parent pointer must match its owner");
	const left = assertNode(node.left, node);
	const right = assertNode(node.right, node);
	assert.equal(left.blackHeight, right.blackHeight, "red-black paths must have equal black height");
	if (node.color === NodeColor.Red) {
		assert.equal(node.left?.color ?? NodeColor.Black, NodeColor.Black, "a red node cannot have a red left child");
		assert.equal(node.right?.color ?? NodeColor.Black, NodeColor.Black, "a red node cannot have a red right child");
	}
	assert.ok(node.piece.length > 0, "piece-tree nodes must not retain empty pieces");
	const aggregate = {
		length: left.length + node.piece.length + right.length,
		lineFeeds: left.lineFeeds + node.piece.lineFeedOffsets.length + right.lineFeeds,
		pieces: left.pieces + 1 + right.pieces,
		blackHeight: left.blackHeight + (node.color === NodeColor.Black ? 1 : 0),
	};
	assert.equal(node.totalLength, aggregate.length, "node text-length aggregate must match its subtree");
	assert.equal(node.totalLineFeeds, aggregate.lineFeeds, "node line-feed aggregate must match its subtree");
	assert.equal(node.totalPieces, aggregate.pieces, "node piece-count aggregate must match its subtree");
	return aggregate;
}

interface PieceTreeTextBufferInternals {
	readonly root: PieceNode | undefined;
}

interface TreeAggregate {
	readonly length: number;
	readonly lineFeeds: number;
	readonly pieces: number;
	readonly blackHeight: number;
}

function applyOffsetEdit(buffer: PieceTreeTextBuffer, startOffset: number, endOffset: number, text: string): void {
	buffer.applyEdits([new ValidAnnotatedEditOperation(null, buffer.getRangeAt(startOffset, endOffset - startOffset), text, false, false, false)], false, false);
}

function positionAt(
	text: string,
	offset: number,
): Position {
	const lineStarts = computeLineStarts(text);
	let lineIndex = 0;
	while (
		lineIndex + 1 < lineStarts.length &&
		lineStarts[lineIndex + 1] <= offset
	) {
		lineIndex += 1;
	}
	const lineEndOffset = lineIndex + 1 < lineStarts.length
		? lineStarts[lineIndex + 1] - 1
		: text.length;
	return new Position(
		lineIndex + 1,
		Math.min(
			offset - lineStarts[lineIndex],
			lineEndOffset - lineStarts[lineIndex],
		) + 1,
	);
}

function computeLineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === CharCode.LineFeed) starts.push(index + 1);
	}
	return starts;
}

function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function integer(random: () => number, limit: number): number {
	return Math.floor(random() * limit);
}

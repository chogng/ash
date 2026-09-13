import assert from "node:assert/strict";
import { test } from "mocha";
import { BugIndicatingError } from "../../../base/common/errors.js";
import { Rect } from "../../common/core/2d/rect.js";
import { ArrayEdit, ArrayReplacement } from "../../common/core/edits/arrayEdit.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { StringEdit, StringReplacement } from "../../common/core/edits/stringEdit.js";
import { LineEdit, LineReplacement } from "../../common/core/edits/lineEdit.js";
import { TextEdit } from "../../common/core/edits/textEdit.js";
import { LineRange } from "../../common/core/ranges/lineRange.js";
import { OffsetRange } from "../../common/core/ranges/offsetRange.js";
import { RangeMapping, SingleRangeMapping } from "../../common/core/ranges/rangeMapping.js";
import { RangeSingleLine } from "../../common/core/ranges/rangeSingleLine.js";
import { PositionOffsetTransformer } from "../../common/core/text/positionToOffset.js";
import { TextLength } from "../../common/core/text/textLength.js";
import { StringText } from "../../common/core/text/abstractText.js";
import { TextChange } from "../../common/core/textChange.js";

const position = (lineIndex: number, columnIndex: number): Position => new Position(lineIndex + 1, columnIndex + 1);

test("rect rejects unordered edges as a bug-indicating error", () => {
	assert.throws(() => new Rect(3, 0, 2, 1), BugIndicatingError);
	assert.throws(() => new Rect(0, 3, 1, 2), BugIndicatingError);
});

test("core converts UTF-16 positions and text lengths", () => {
	const transformer = new PositionOffsetTransformer("A😀\nbeta");
	assert.equal(transformer.getOffset(position(0, 3)), 3);
	assert.deepEqual(transformer.getPosition(2), position(0, 2));
	assert.deepEqual(transformer.getPosition(transformer.text.length), position(1, 4));
	assert.deepEqual(TextLength.ofText("ab\ncd"), new TextLength(1, 2));
	assert.deepEqual(TextLength.ofText("ab\ncd").addToPosition(position(3, 4)), position(4, 2));
});

test("core edit algebra applies, composes, and inverts string edits", () => {
	const first = StringEdit.replace(new OffsetRange(1, 3), "X");
	const second = StringEdit.replace(new OffsetRange(1, 3), "YZ");
	const composed = first.compose(second);
	assert.equal(first.apply("abcdef"), "aXdef");
	assert.equal(second.apply(first.apply("abcdef")), "aYZef");
	assert.equal(composed.apply("abcdef"), "aYZef");
	assert.equal(composed.inverse("abcdef").apply(composed.apply("abcdef")), "abcdef");
	assert.equal(StringEdit.create([StringReplacement.insert(0, "a"), StringReplacement.insert(1, "b")]).apply(""), "ab");
});

test("array edits share the same composition algebra as string edits", () => {
	const first = ArrayEdit.create([
		new ArrayReplacement(new OffsetRange(1, 3), ["X"]),
		new ArrayReplacement(new OffsetRange(4, 5), ["Y", "Z"]),
	]);
	const second = ArrayEdit.replace(new OffsetRange(1, 2), ["A", "B"]);
	const source = ["0", "1", "2", "3", "4", "5"];
	const composed = first.compose(second);

	assert.deepEqual(first.apply(source), ["0", "X", "3", "Y", "Z", "5"]);
	assert.deepEqual(composed.apply(source), second.apply(first.apply(source)));
	assert.deepEqual(composed.inverse(source).apply(composed.apply(source)), source);
});

test("range mapping projects positions, ranges, and single-line ranges", () => {
	const original = Range.fromPositions(position(1, 2), position(1, 4));
	const modified = Range.fromPositions(position(2, 1), position(2, 6));
	const mapping = new RangeMapping([new SingleRangeMapping(original, modified)]);

	assert.deepEqual(mapping.mapPosition(position(1, 3)).range, modified);
	assert.deepEqual(mapping.mapPosition(position(1, 5)).position, position(2, 7));
	assert.deepEqual(mapping.reverse().mapRange(modified), original);
	assert.deepEqual(RangeSingleLine.fromRange(original)?.toRange(), original);
	assert.equal(RangeSingleLine.fromRange(Range.fromPositions(position(1, 0), position(2, 0))), undefined);
});

test("text edits map coordinate ranges and preserve multiline text", () => {
	const source = new StringText("alpha\nbeta");
	const edit = TextEdit.replace(Range.fromPositions(position(0, 1), position(0, 3)), "X\nY");
	assert.equal(edit.apply(source), "aX\nYha\nbeta");
	assert.deepEqual(edit.getNewRanges(), [Range.fromPositions(position(0, 1), position(1, 1))]);
	assert.deepEqual(edit.mapRange(Range.fromPositions(position(0, 0), position(0, 5))), Range.fromPositions(position(0, 0), position(1, 3)));
	const second = TextEdit.replace(Range.fromPositions(position(1, 0), position(1, 1)), "Z");
	assert.equal(edit.compose(second).apply(source), "aX\nZha\nbeta");
});

test("line edits replace line spans and can invert against original lines", () => {
	const edit = new LineEdit([new LineReplacement(new LineRange(2, 3), ["B", "C"])]);
	const original = ["A", "b", "D"];
	assert.deepEqual(edit.apply(original), ["A", "B", "C", "D"]);
	assert.deepEqual(edit.inverse(original).apply(edit.apply(original)), original);

	const source = new StringText(original.join("\n"));
	assert.equal(new LineReplacement(new LineRange(2, 3), []).toSingleEdit(source).replace(source.value), "A\nD");
	assert.equal(new LineReplacement(new LineRange(2, 4), []).toSingleEdit(source).replace(source.value), "A");
	assert.equal(new LineReplacement(new LineRange(1, 2), []).toSingleEdit(source).replace(source.value), "b\nD");
	assert.equal(new LineReplacement(new LineRange(2, 4), ["B", "C"]).toSingleEdit(source).replace(source.value), "A\nB\nC");
	assert.equal(new LineReplacement(new LineRange(4, 4), ["E"]).toSingleEdit(source).replace(source.value), "A\nb\nD\nE");
});

test("text changes round-trip through the compact binary shape", () => {
	const change = new TextChange(3, "old", 4, "new\n");
	const buffer = new Uint8Array(change.writeSize());
	const end = change.write(buffer, 0);
	const decoded: TextChange[] = [];
	assert.equal(TextChange.read(buffer, 0, decoded), end);
	assert.equal(decoded[0]!.toString(), change.toString());
});

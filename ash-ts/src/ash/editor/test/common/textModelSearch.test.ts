import assert from "node:assert/strict";
import { test } from "mocha";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { findNextTextMatch } from "../../common/model/textModelSearch.js";
import { findTextMatches } from "../../common/model/textModelSearch.js";
import { TextSearchPatternKind } from "../../common/model/textModelSearch.js";
import { TextSearchQueryError } from "../../common/model/textModelSearch.js";

test("literal search is case-insensitive by default and preserves UTF-16 ranges", () => {
	using model = new TextModel("Alpha 😀 alpha\nALPHA");

	const matches = findTextMatches(model, { pattern: "alpha" });

	assert.deepEqual(matches.map(match => ({
		start: [match.range.getStartPosition().lineNumber, match.range.getStartPosition().column],
		end: [match.range.getEndPosition().lineNumber, match.range.getEndPosition().column],
		text: match.text,
	})), [
		{ start: [1, 1], end: [1, 6], text: "Alpha" },
		{ start: [1, 10], end: [1, 15], text: "alpha" },
		{ start: [2, 1], end: [2, 6], text: "ALPHA" },
	]);
	assert.equal(findTextMatches(model, { pattern: "alpha", matchCase: true }).length, 1);
});

test("regular-expression search supports multiline captures and bounded ranges", () => {
	using model = new TextModel("before\nname: ash\nafter\nname: alpha");
	const range = Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((3) + 1, (11) + 1));

	const matches = findTextMatches(model, {
		pattern: "name: (ash|alpha)",
		patternKind: TextSearchPatternKind.RegularExpression,
	}, { range, resultLimit: 1 });

	assert.equal(matches.length, 1);
	assert.equal(matches[0].text, "name: ash");
	assert.deepEqual(matches[0].captures, ["ash"]);
	assert.deepEqual(matches[0].range, Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (9) + 1)));
});

test("whole-word search uses Unicode word boundaries", () => {
	using model = new TextModel("cat scatter cat_ 猫 猫咪 猫");

	assert.deepEqual(
		findTextMatches(model, { pattern: "cat", wholeWord: true }).map(match => match.range.getStartPosition().column),
		[1],
	);
	assert.deepEqual(
		findTextMatches(model, { pattern: "猫", wholeWord: true }).map(match => match.range.getStartPosition().column),
		[18, 23],
	);
});

test('whole-word search obeys editor word separators', () => {
	using model = new TextModel('foo.bar foo-bar foobar');
	assert.deepEqual(
		findTextMatches(model, { pattern: 'foo', wholeWord: true, wordSeparators: '.-' }).map(match => match.range.getStartPosition().column),
		[1, 9],
	);
	assert.deepEqual(
		findTextMatches(model, { pattern: 'foo', wholeWord: true, wordSeparators: '-' }).map(match => match.range.getStartPosition().column),
		[9],
	);
});

test("zero-length regular expressions advance and next search wraps", () => {
	using model = new TextModel("a\nb");
	const lineStarts = findTextMatches(model, {
		pattern: "^",
		patternKind: TextSearchPatternKind.RegularExpression,
	});
	assert.deepEqual(lineStarts.map(match => match.range.getStartPosition()), [
		new Position((0) + 1, (0) + 1),
		new Position((1) + 1, (0) + 1),
	]);

	const wrapped = findNextTextMatch(model, { pattern: "a", matchCase: true }, new Position((1) + 1, (1) + 1));
	assert.deepEqual(wrapped?.range, Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1)));
});

test("invalid expressions and limits fail before scanning", () => {
	using model = new TextModel("text");
	assert.throws(() => findTextMatches(model, {
		pattern: "(",
		patternKind: TextSearchPatternKind.RegularExpression,
	}), TextSearchQueryError);
	assert.throws(() => findTextMatches(model, { pattern: "text" }, { resultLimit: -1 }), RangeError);
	assert.deepEqual(findTextMatches(model, { pattern: "text" }, { resultLimit: 0 }), []);
});

test('TextModel exposes the editor search contract with wrapping and captures', () => {
	using model = new TextModel('alpha beta\nalpha gamma');
	const scopes = [
		new Range(1, 1, 1, 11),
		new Range(1, 7, 2, 12),
	];
	const matches = model.findMatches('(alpha) (beta|gamma)', scopes, true, true, null, true);
	assert.deepEqual(matches.map(match => ({
		range: match.range,
		captures: match.matches,
	})), [
		{ range: new Range(1, 1, 1, 11), captures: ['alpha beta', 'alpha', 'beta'] },
		{ range: new Range(2, 1, 2, 12), captures: ['alpha gamma', 'alpha', 'gamma'] },
	]);
	assert.deepEqual(model.findNextMatch('alpha', new Position(2, 2), false, true, null, false)?.range, new Range(1, 1, 1, 6));
	assert.deepEqual(model.findPreviousMatch('alpha', new Position(1, 1), false, true, null, false)?.range, new Range(2, 1, 2, 6));
});

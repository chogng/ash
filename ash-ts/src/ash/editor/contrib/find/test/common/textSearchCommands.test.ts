import assert from "node:assert/strict";
import { test } from "mocha";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { findTextMatches, TextSearchPatternKind } from "../../../../common/model/textModelSearch.js";
import { createReplaceAllTextMatchesCommand, createReplaceTextMatchCommand, resolveTextSearchReplacement } from "../../common/textSearchCommands.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

test("regular-expression replacement expands captures and named captures", () => {
	using model = new TextModel("name: ash");
	const match = findTextMatches(model, {
		pattern: "(?<key>name): (ash)",
		patternKind: TextSearchPatternKind.RegularExpression,
	})[0]!;

	assert.equal(resolveTextSearchReplacement(match, "$<key>=$2 $$ $&"), "name=ash $ name: ash");
});

test("replace match is isolated, positions the caret, and rejects stale results", () => {
	using model = new TextModel("one two");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	const match = findTextMatches(model, { pattern: "one" })[0]!;

	selections.executeCommand(createReplaceTextMatchCommand(model, match, "first"));
	assert.equal(model.getText(), "first two");
	assert.deepEqual(selections.getSelections()[0]!.getPosition(), new Position((0) + 1, (5) + 1));
	assert.throws(() => createReplaceTextMatchCommand(model, match, "stale"), /stale model version/);

	selections.context.model.undo();
	assert.equal(model.getText(), "one two");
});

test("replace all maps the result caret and undoes as one transaction", () => {
	using model = new TextModel("a a a");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	const matches = findTextMatches(model, { pattern: "a", matchCase: true });

	selections.executeCommand(createReplaceAllTextMatchesCommand(model, matches, ["long", "", "x"]));
	assert.equal(model.getText(), "long  x");
	assert.deepEqual(selections.getSelections()[0]!.getPosition(), new Position((0) + 1, (7) + 1));

	selections.context.model.undo();
	assert.equal(model.getText(), "a a a");
});

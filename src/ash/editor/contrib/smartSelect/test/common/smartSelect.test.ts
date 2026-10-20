import assert from "node:assert/strict";
import { test } from "mocha";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { expandSmartSelection } from "../../common/smartSelectionExpansion.js";

test("Smart select expands a caret through word, pair, line, and document scopes", () => {
	using model = new TextModel("const value = (one + two);\nnext");
	const caret = Selection.fromPositions(new Position((0) + 1, (16) + 1));
	const word = expandSmartSelection(model, caret);
	assert.equal(model.getTextInRange(word), "one");
	const pair = expandSmartSelection(model, word);
	assert.equal(model.getTextInRange(pair), "(one + two)");
	const line = expandSmartSelection(model, pair);
	assert.equal(model.getTextInRange(line), "const value = (one + two);");
});

test("Smart select prefers the smallest parser scope before lexical pair and line fallbacks", () => {
	using model = new TextModel("fn outer() { let value = call(1 + 2); }");
	const valueStart = model.getText().indexOf("value");
	const declarationStart = model.getText().indexOf("let value");
	const declarationEnd = model.getText().indexOf(";", declarationStart) + 1;
	const functionEnd = model.length;
	const syntaxRanges = [
		Range.fromPositions(model.positionAt(valueStart), model.positionAt(valueStart + "value".length)),
		Range.fromPositions(model.positionAt(declarationStart), model.positionAt(declarationEnd)),
		Range.fromPositions(model.positionAt(0), model.positionAt(functionEnd)),
	];
	const caret = Selection.fromPositions(model.positionAt(valueStart + 2));

	const word = expandSmartSelection(model, caret, syntaxRanges);
	const declaration = expandSmartSelection(model, word, syntaxRanges);
	const functionScope = expandSmartSelection(model, declaration, syntaxRanges);

	assert.equal(model.getTextInRange(word), "value");
	assert.equal(model.getTextInRange(declaration), "let value = call(1 + 2);");
	assert.equal(model.getTextInRange(functionScope), model.getText());
});

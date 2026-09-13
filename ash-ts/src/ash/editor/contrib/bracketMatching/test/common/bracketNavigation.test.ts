import assert from "node:assert/strict";
import { test } from "mocha";
import { jumpToMatchingBrackets, selectToMatchingBrackets } from "../../common/bracketNavigation.js";
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { LanguageBracketPairs } from "../../../../common/languages/languageBracketPairs.js";
import { LanguageLexicalContextIndex } from "../../../../common/languages/languageLexicalContext.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Bracket navigation jumps and selects lexical configured pairs without changing text", () => {
	using model = new TextModel("{\n  (value)\n}");
	using configurations = bracketConfigurations();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	const selections = primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (0) + 1)),
		Selection.fromPositions(new Position((1) + 1, (8) + 1)),
	], 1);

	const jumped = jumpToMatchingBrackets(bracketPairs, selections);
	assert.deepEqual(jumped, primaryFirst([
		Selection.fromPositions(new Position((2) + 1, (0) + 1)),
		Selection.fromPositions(new Position((1) + 1, (2) + 1)),
	], 1));
	assert.deepEqual(selectToMatchingBrackets(bracketPairs, jumped), primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((2) + 1, (1) + 1)),
		Selection.fromPositions(new Position((1) + 1, (2) + 1), new Position((1) + 1, (9) + 1)),
	], 1));
	assert.equal(model.getText(), "{\n  (value)\n}");
});

test("Bracket navigation leaves selections without a lexical match unchanged", () => {
	using model = new TextModel("// ( text");
	using configurations = bracketConfigurations();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	const selections = [Selection.fromPositions(new Position((0) + 1, (3) + 1))];
	assert.equal(jumpToMatchingBrackets(bracketPairs, selections), selections);
	assert.equal(selectToMatchingBrackets(bracketPairs, selections), selections);
});

function bracketConfigurations(): TestLanguageConfigurationService {
	const configurations = new TestLanguageConfigurationService();
	configurations.register("typescript", {
		comments: { lineComment: "//", blockComment: ["/*", "*/"] },
		brackets: [["(", ")"], ["{", "}"]],
	});
	return configurations;
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}

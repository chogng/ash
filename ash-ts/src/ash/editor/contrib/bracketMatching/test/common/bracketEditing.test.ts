import assert from "node:assert/strict";
import { test } from "mocha";
import { createRemoveMatchingBracketsCommand } from "../../common/bracketEditing.js";
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { LanguageBracketPairs } from "../../../../common/languages/languageBracketPairs.js";
import { LanguageLexicalContextIndex } from "../../../../common/languages/languageLexicalContext.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

test("Remove matching brackets deletes distinct lexical pairs atomically and restores undo", () => {
	using model = new TextModel("{(value)}");
	using configurations = configurationsForBrackets();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	using selections = createTestCursorsController(model, primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (0) + 1)),
		Selection.fromPositions(new Position((0) + 1, (1) + 1)),
	], 1));
	const commands = createRemoveMatchingBracketsCommand(bracketPairs, selections.getSelections());
	assert.ok(commands);
	selections.executeCommands(commands);
	assert.equal(model.getText(), "value");
	assert.deepEqual(selections.getSelections(), [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	selections.context.model.undo();
	assert.equal(model.getText(), "{(value)}");
});

test("Remove matching brackets leaves non-bracket or range selections alone", () => {
	using model = new TextModel("// ()");
	using configurations = configurationsForBrackets();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	const cursor = [Selection.fromPositions(new Position((0) + 1, (3) + 1))];
	assert.equal(createRemoveMatchingBracketsCommand(bracketPairs, cursor), undefined);
	const range = [Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1))];
	assert.equal(createRemoveMatchingBracketsCommand(bracketPairs, range), undefined);
});

function configurationsForBrackets(): TestLanguageConfigurationService {
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

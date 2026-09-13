import assert from "node:assert/strict";
import { test } from "mocha";
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { LanguageBracketPairs } from "../../../common/languages/languageBracketPairs.js";
import { TestLanguageConfigurationService } from '../modes/testLanguageConfigurationService.js';
import { LanguageLexicalContextIndex } from "../../../common/languages/languageLexicalContext.js";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { TextModel } from "../../../common/model/textModel.js";

test("Language bracket pairs resolve nested cross-line configured pairs", () => {
	using model = new TextModel("function value() {\n  return [call(1)];\n}");
	using configurations = bracketConfigurations();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);

	assert.deepEqual(bracketPairs.matchBracket(new Position((0) + 1, (17) + 1)), {
		opening: Range.fromPositions(new Position((0) + 1, (17) + 1), new Position((0) + 1, (18) + 1)),
		closing: Range.fromPositions(new Position((2) + 1, (0) + 1), new Position((2) + 1, (1) + 1)),
	});
	assert.deepEqual(bracketPairs.matchBracket(new Position((1) + 1, (16) + 1)), {
		opening: Range.fromPositions(new Position((1) + 1, (14) + 1), new Position((1) + 1, (15) + 1)),
		closing: Range.fromPositions(new Position((1) + 1, (16) + 1), new Position((1) + 1, (17) + 1)),
	});
	assert.deepEqual(bracketPairs.getBracketPairsInLineRange(1, 1).map(bracket => bracket.token), ['{', '[', '(']);
});

test("Language bracket pairs ignore strings and comments, and invalidate on edits", () => {
	using model = new TextModel("const text = \"{\"; // [\n{");
	using configurations = bracketConfigurations();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	assert.equal(bracketPairs.matchBracket(new Position((0) + 1, (14) + 1)), undefined);
	assert.equal(bracketPairs.matchBracket(new Position((0) + 1, (21) + 1)), undefined);
	assert.equal(bracketPairs.matchBracket(new Position((1) + 1, (0) + 1)), undefined);

	model.applyEdits([{
		range: Range.fromPositions(new Position((1) + 1, (1) + 1)),
		text: "\n}",
	}]);
	assert.deepEqual(bracketPairs.matchBracket(new Position((1) + 1, (0) + 1)), {
		opening: Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (1) + 1)),
		closing: Range.fromPositions(new Position((2) + 1, (0) + 1), new Position((2) + 1, (1) + 1)),
	});
});

test("Language bracket pairs expose enclosing, next, and invalid bracket structure", () => {
	using model = new TextModel("{ value ([)] }");
	using configurations = bracketConfigurations();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	assert.deepEqual(bracketPairs.findEnclosingBrackets(new Position((0) + 1, (3) + 1)), {
		opening: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1)),
		closing: Range.fromPositions(new Position((0) + 1, (13) + 1), new Position((0) + 1, (14) + 1)),
	});
	assert.equal(bracketPairs.findNextBracket(new Position((0) + 1, (8) + 1))?.token, "(");
	assert.deepEqual(bracketPairs.getLineBrackets(0).filter(bracket => bracket.isInvalid).map(bracket => bracket.token), ["[", "]"]);
});

test("Language bracket pairs invalidate when the language configuration changes", () => {
	using model = new TextModel("{}");
	using configurations = new TestLanguageConfigurationService();
	using registration = new DisposableStore();
	registration.add(configurations.register("typescript", { brackets: [["{", "}"]] }));
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	assert.equal(bracketPairs.getLineBrackets(0).length, 2);

	registration.clear();
	registration.add(configurations.register("typescript", { brackets: [] }));
	assert.deepEqual(bracketPairs.getLineBrackets(0), []);
});

function bracketConfigurations(): TestLanguageConfigurationService {
	const configurations = new TestLanguageConfigurationService();
	configurations.register("typescript", {
		comments: { lineComment: "//", blockComment: ["/*", "*/"] },
		brackets: [
			["(", ")"],
			["[", "]"],
			["{", "}"],
		],
	});
	return configurations;
}

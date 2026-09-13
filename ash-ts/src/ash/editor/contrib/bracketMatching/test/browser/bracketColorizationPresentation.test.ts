import assert from "node:assert/strict";
import { test } from "mocha";
import { LanguageBracketColorizationSource } from '../../browser/bracketColorizationPresentation.js';
import { LanguageBracketPairs } from "../../../../common/languages/languageBracketPairs.js";
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { LanguageLexicalContextIndex } from "../../../../common/languages/languageLexicalContext.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Bracket colorization follows lexical nesting and excludes brackets in strings", () => {
	using model = new TextModel("{\n  (\"}\")\n}");
	using configurations = new TestLanguageConfigurationService();
	using registration = configurations.register("typescript", {
		brackets: [["{", "}"], ["(", ")"]],
	});
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	const colors = new LanguageBracketColorizationSource(bracketPairs);

	assert.deepEqual(colors.getLineBrackets(0), [{ startColumn: 0, endColumn: 1, level: 1 }]);
	assert.deepEqual(colors.getLineBrackets(1), [
		{ startColumn: 2, endColumn: 3, level: 2 },
		{ startColumn: 6, endColumn: 7, level: 2 },
	]);
	assert.deepEqual(colors.getLineBrackets(2), [{ startColumn: 0, endColumn: 1, level: 1 }]);
});

test("Bracket colorization invalidates its cached nesting after model edits", () => {
	using model = new TextModel("{\n}");
	using configurations = new TestLanguageConfigurationService();
	using registration = configurations.register("typescript", { brackets: [["{", "}"]] });
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	const colors = new LanguageBracketColorizationSource(bracketPairs);
	assert.deepEqual(colors.getLineBrackets(1), [{ startColumn: 0, endColumn: 1, level: 1 }]);
	model.applyEdits([{ range: Range.fromPositions(model.positionAt(0)), text: "{\n" }]);
	assert.deepEqual(colors.getLineBrackets(2), [{ startColumn: 0, endColumn: 1, level: 2 }]);
});

test('Bracket guide projection remains available when bracket colors are disabled', () => {
	using model = new TextModel('{\n  value\n}');
	using configurations = new TestLanguageConfigurationService();
	using registration = configurations.register('typescript', { brackets: [['{', '}']] });
	using lexical = new LanguageLexicalContextIndex(model, 'typescript', configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	const guides = new LanguageBracketColorizationSource(bracketPairs, false);

	assert.deepEqual(guides.getLineBrackets(0), []);
	assert.deepEqual(guides.getBracketGuides(1, 1), [{
		opening: Range.fromPositions(model.positionAt(0), model.positionAt(1)),
		closing: Range.fromPositions(model.positionAt(model.getText().length - 1), model.positionAt(model.getText().length)),
		level: 1,
	}]);
});

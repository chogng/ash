import { registerTestTokens } from '../../../../test/common/testTokenization.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { LanguageBracketColorizationSource } from '../../browser/bracketColorizationPresentation.js';
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Bracket colorization follows model nesting and excludes brackets in strings", async () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel("{\n  (\"}\")\n}", { languageId: "typescript", languageConfigurationService: configurations });
	using registration = configurations.register("typescript", {
		brackets: [["{", "}"], ["(", ")"]],
	});
	using tokens = registerTestTokens(new Map([
		['  ("}")', [{ offset: 0, type: '' }, { offset: 3, type: 'string' }, { offset: 6, type: '' }]],
	]));
	await new Promise(resolve => setImmediate(resolve));
	const colors = new LanguageBracketColorizationSource(model);

	assert.deepEqual(colors.getLineBrackets(0), [{ startColumn: 0, endColumn: 1, level: 1 }]);
	assert.deepEqual(colors.getLineBrackets(1), [
		{ startColumn: 2, endColumn: 3, level: 2 },
		{ startColumn: 6, endColumn: 7, level: 2 },
	]);
	assert.deepEqual(colors.getLineBrackets(2), [{ startColumn: 0, endColumn: 1, level: 1 }]);
});

test("Bracket colorization invalidates its cached nesting after model edits", () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel("{\n}", { languageId: "typescript", languageConfigurationService: configurations });
	using registration = configurations.register("typescript", { brackets: [["{", "}"]] });
	const colors = new LanguageBracketColorizationSource(model);
	assert.deepEqual(colors.getLineBrackets(1), [{ startColumn: 0, endColumn: 1, level: 1 }]);
	model.applyEdits([{ range: Range.fromPositions(model.positionAt(0)), text: "{\n" }]);
	assert.deepEqual(colors.getLineBrackets(2), [{ startColumn: 0, endColumn: 1, level: 2 }]);
});

test('Bracket guide projection remains available when bracket colors are disabled', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{\n  value\n}', { languageId: "typescript", languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}']] });
	const guides = new LanguageBracketColorizationSource(model, false);

	assert.deepEqual(guides.getLineBrackets(0), []);
	assert.deepEqual(guides.getBracketGuides(1, 1), [{
		opening: Range.fromPositions(model.positionAt(0), model.positionAt(1)),
		closing: Range.fromPositions(model.positionAt(model.getText().length - 1), model.positionAt(model.getText().length)),
		level: 1,
	}]);
});

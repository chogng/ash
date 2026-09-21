import { registerTestTokens } from '../../../../test/common/testTokenization.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { LanguageBracketGuideSource } from '../../browser/bracketColorizationPresentation.js';
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
	const colors = {
		getLineBrackets: (lineIndex: number) => model.getLineDecorations(lineIndex + 1).map(decoration => ({
			startColumn: decoration.range.startColumn - 1,
			endColumn: decoration.range.endColumn - 1,
			className: decoration.options.inlineClassName,
		})),
	};

	assert.deepEqual(colors.getLineBrackets(0), [{ startColumn: 0, endColumn: 1, className: 'stanza-editor-bracket-level-1' }]);
	assert.deepEqual(colors.getLineBrackets(1), [
		{ startColumn: 2, endColumn: 3, className: 'stanza-editor-bracket-level-2' },
		{ startColumn: 6, endColumn: 7, className: 'stanza-editor-bracket-level-2' },
	]);
	assert.deepEqual(colors.getLineBrackets(2), [{ startColumn: 0, endColumn: 1, className: 'stanza-editor-bracket-level-1' }]);
});

test("Bracket colorization invalidates its cached nesting after model edits", () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel("{\n}", { languageId: "typescript", languageConfigurationService: configurations });
	using registration = configurations.register("typescript", { brackets: [["{", "}"]] });
	const colors = {
		getLineBrackets: (lineIndex: number) => model.getLineDecorations(lineIndex + 1).map(decoration => ({
			startColumn: decoration.range.startColumn - 1,
			endColumn: decoration.range.endColumn - 1,
			className: decoration.options.inlineClassName,
		})),
	};
	assert.deepEqual(colors.getLineBrackets(1), [{ startColumn: 0, endColumn: 1, className: 'stanza-editor-bracket-level-1' }]);
	model.applyEdits([{ range: Range.fromPositions(model.positionAt(0)), text: "{\n" }]);
	assert.deepEqual(colors.getLineBrackets(2), [{ startColumn: 0, endColumn: 1, className: 'stanza-editor-bracket-level-2' }]);
});

test('Bracket guide projection remains available when bracket colors are disabled', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{\n  value\n}', { languageId: "typescript", languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}']] });
	const guides = new LanguageBracketGuideSource(model);

	model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
	assert.deepEqual(model.getLineDecorations(1), []);
	assert.deepEqual(guides.getBracketGuides(1, 1), [{
		opening: Range.fromPositions(model.positionAt(0), model.positionAt(1)),
		closing: Range.fromPositions(model.positionAt(model.getText().length - 1), model.positionAt(model.getText().length)),
		level: 1,
	}]);
});

test('Model bracket decorations honor color pools, query filters and option changes', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{([])}', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}'], ['(', ')'], ['[', ']']] });
	const colors = () => model.getAllDecorations(12).map(decoration => decoration.options.inlineClassName);
	assert.deepEqual(colors(), [1, 2, 3, 3, 2, 1].map(level => `stanza-editor-bracket-level-${level}`));
	assert.deepEqual(model.getDecorationsInRange(model.getFullModelRange(), 12, false, false, true), []);
	assert.deepEqual(model.getAllMarginDecorations(12), []);
	let changes = 0;
	using listener = model.onDidChangeDecorations(() => changes++);
	model.updateOptions({ bracketColorizationOptions: { enabled: true, independentColorPoolPerBracketType: true } });
	assert.ok(changes > 0);
	assert.deepEqual(colors(), Array(6).fill('stanza-editor-bracket-level-1'));
	model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: true } });
	assert.deepEqual(colors(), []);
});

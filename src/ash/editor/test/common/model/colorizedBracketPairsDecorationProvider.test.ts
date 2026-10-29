import { createTextModelFeatures } from '../../../common/model/modelFeatures.js';
import { registerTextModelFeatures } from '../../../common/model/textModelFeatures.js';
import { after as afterModelFeatures } from 'mocha';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../../common/core/range.js';
import { TextModel } from '../../../common/model/textModel.js';
import { TestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';
import { registerTestTokens } from '../../common/testTokenization.js';

test('Bracket colorization follows model nesting and excludes brackets in strings', async () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{\n  ("}")\n}', {
		languageId: 'typescript',
		languageConfigurationService: configurations,
	});
	using registration = configurations.register('typescript', {
		brackets: [
			['{', '}'],
			['(', ')'],
		],
	});
	using tokens = registerTestTokens(
		new Map([
			[
				'  ("}")',
				[
					{ offset: 0, type: '' },
					{ offset: 3, type: 'string' },
					{ offset: 6, type: '' },
				],
			],
		]),
	);
	model.tokenization.forceTokenization(model.getLineCount());
	const colors = {
		getLineBrackets: (lineIndex: number) =>
			model.getLineDecorations(lineIndex + 1).map(decoration => ({
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

test('Bracket colorization invalidates its cached nesting after model edits', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}']] });
	const colors = {
		getLineBrackets: (lineIndex: number) =>
			model.getLineDecorations(lineIndex + 1).map(decoration => ({
				startColumn: decoration.range.startColumn - 1,
				endColumn: decoration.range.endColumn - 1,
				className: decoration.options.inlineClassName,
			})),
	};
	assert.deepEqual(colors.getLineBrackets(1), [{ startColumn: 0, endColumn: 1, className: 'stanza-editor-bracket-level-1' }]);
	model.applyEdits([{ range: Range.fromPositions(model.positionAt(0)), text: '{\n' }]);
	assert.deepEqual(colors.getLineBrackets(2), [{ startColumn: 0, endColumn: 1, className: 'stanza-editor-bracket-level-2' }]);
});

test('Model bracket decorations honor color pools, query filters and option changes', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{([])}', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', {
		brackets: [
			['{', '}'],
			['(', ')'],
			['[', ']'],
		],
	});
	const colors = () => model.getAllDecorations(12).map(decoration => decoration.options.inlineClassName);
	assert.deepEqual(
		colors(),
		[1, 2, 3, 3, 2, 1].map(level => `stanza-editor-bracket-level-${level}`),
	);
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

test('Margin and injected text queries do not generate whole-document bracket colors', () => {
	using configurations = new TestLanguageConfigurationService();
	using registration = configurations.register('typescript', { brackets: [['{', '}']] });
	using model = new TextModel('{\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	let bracketQueries = 0;
	const getBrackets = model.bracketPairs.getBracketsInRange.bind(model.bracketPairs);
	model.bracketPairs.getBracketsInRange = (...args) => {
		bracketQueries++;
		return getBrackets(...args);
	};
	const [margin, injected] = model.deltaDecorations(
		[],
		[
			{ range: new Range(1, 1, 1, 1), options: { description: 'margin', glyphMarginClassName: 'glyph' } },
			{ range: new Range(1, 1, 1, 1), options: { description: 'injected', before: { content: 'inlay' } } },
		],
		2,
	);
	assert.deepEqual(
		model.getAllMarginDecorations(2).map(value => value.id),
		[margin],
	);
	assert.deepEqual(
		model.getInjectedTextDecorations(2).map(value => value.id),
		[injected],
	);
	assert.equal(model.getLineInjectedText(1, 2)[0]?.options.content, 'inlay');
	assert.deepEqual(model.getLineInjectedText(2, 2), []);
	assert.deepEqual(model.getOverviewRulerDecorations(2), []);
	assert.deepEqual(model.getFontDecorationsInRange(model.getFullModelRange(), 2), []);
	assert.deepEqual(model.getCustomLineHeightsDecorations(2), []);
	assert.deepEqual(model.getCustomLineHeightsDecorationsInRange(model.getFullModelRange(), 2), []);
	assert.equal(bracketQueries, 0);
	assert.ok(model.getAllDecorations(2).some(value => value.options.description === 'BracketPairColorization'));
	assert.ok(bracketQueries > 0);
});

const modelFeatures = registerTextModelFeatures(createTextModelFeatures);
afterModelFeatures(() => modelFeatures.dispose());

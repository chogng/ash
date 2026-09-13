import assert from 'node:assert/strict';
import { test } from 'mocha';
import { WordNavigationType, WordOperations, WordPartOperations } from '../../common/cursor/cursorWordOperations.js';
import { ReplaceCommand } from '../../common/commands/replaceCommand.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { Selection } from '../../common/core/selection.js';
import { TextModel } from '../../common/model/textModel.js';
import { getMapForWordSeparators } from '../../common/core/wordCharacterClassifier.js';
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { createTestCursorConfiguration, createTestCursorsController, createTestDeleteWordContext } from './testCursorConfiguration.js';

test('WordOperations resolves Unicode words at a position', () => {
	using model = new TextModel('alpha beta');
	assert.deepEqual(WordOperations.getWordAtPosition(model, ',.;', [], new Position(1, 8)), {
		word: 'beta',
		startColumn: 7,
		endColumn: 11,
	});
});

test('WordOperations returns standard word movement and deletion ranges', () => {
	using model = new TextModel('alpha beta');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const classifier = getMapForWordSeparators(config.wordSeparators, config.wordSegmenterLocales);
	using controller = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 11))]);
	assert.deepEqual(WordOperations.moveWordLeft(classifier, model, new Position(1, 11), WordNavigationType.WordStart, false), new Position(1, 7));
	assert.deepEqual(WordOperations.moveWordRight(classifier, model, new Position(1, 1), WordNavigationType.WordEnd), new Position(1, 6));
	const range = WordOperations.deleteWordLeft(createTestDeleteWordContext(config, model, controller.getSelections()[0]!), WordNavigationType.WordStart);
	assert.deepEqual(range, new Range(1, 7, 1, 11));
	controller.executeCommands([new ReplaceCommand(range!, '')]);
	assert.equal(model.getText(), 'alpha ');
	assert.deepEqual(controller.getSelections(), [Selection.fromPositions(new Position(1, 7))]);
});

test('WordOperations handles whitespace, inside-word, and word-part boundaries', () => {
	using model = new TextModel('alpha   camelCase snake_case');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const classifier = getMapForWordSeparators(config.wordSeparators, config.wordSegmenterLocales);
	const whitespace = Selection.fromPositions(new Position(1, 7));
	assert.deepEqual(WordOperations.deleteInsideWord(classifier, model, whitespace), new Range(1, 6, 1, 9));
	assert.deepEqual(WordOperations._moveWordPartRight(model, new Position(1, 10)), new Position(1, 14));
	assert.deepEqual(WordOperations._moveWordPartLeft(model, new Position(1, 18)), new Position(1, 14));
	assert.deepEqual(WordPartOperations.moveWordPartRight(classifier, model, new Position(1, 10)), new Position(1, 14));
});

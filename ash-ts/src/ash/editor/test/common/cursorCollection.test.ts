import assert from 'node:assert/strict';
import { test } from 'mocha';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { CursorCollection } from '../../common/cursor/cursorCollection.js';
import { CursorContext } from '../../common/cursor/cursorContext.js';
import { IdentityCoordinatesConverter } from '../../common/coordinatesConverter.js';
import { Selection } from '../../common/core/selection.js';
import { createBuiltinLanguageConfigurationService } from '../../common/languages/languageBuiltinConfigurations.js';
import { TextModel } from '../../common/model/textModel.js';
import { createTestCursorConfiguration } from './testCursorConfiguration.js';

test('CursorCollection preserves primary-first selection order', () => {
	using model = new TextModel('abcdef\nsecond');
	using languages = createBuiltinLanguageConfigurationService();
	const context = new CursorContext(model, model, new IdentityCoordinatesConverter(model), createTestCursorConfiguration(model, languages));
	const selections = primaryFirst([new Selection(1, 1, 1, 3), new Selection(2, 2, 2, 2)], 1);
	const cursors = new CursorCollection(context);
	using cleanup = toDisposable(() => cursors.dispose());
	cursors.setSelections([...selections]);
	assert.deepEqual(cursors.getSelections()[0], selections[0]);
	assert.equal(Selection.selectionsArrEqual(cursors.getSelections(), [...selections]), true);
	assert.equal(cursors.getAll().length, 2);
	assert.equal(cursors.getPrimaryCursor().modelState.selection.equalsSelection(selections[0]!), true);
});

test('CursorCollection tracks edits and can remove secondary cursors', () => {
	using model = new TextModel('abcdef');
	using languages = createBuiltinLanguageConfigurationService();
	const context = new CursorContext(model, model, new IdentityCoordinatesConverter(model), createTestCursorConfiguration(model, languages));
	const cursors = new CursorCollection(context);
	using cleanup = toDisposable(() => cursors.dispose());
	cursors.setSelections([new Selection(1, 2, 1, 2), new Selection(1, 5, 1, 5)]);
	model.applyEdits([{ range: new Selection(1, 1, 1, 1), text: 'x' }]);
	assert.deepEqual(cursors.readSelectionFromMarkers().map(selection => selection.positionColumn), [3, 6]);
	cursors.killSecondaryCursors();
	assert.equal(cursors.getSelections().length, 1);
});

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}

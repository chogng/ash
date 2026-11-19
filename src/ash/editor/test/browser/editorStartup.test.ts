import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import './testEditorDom.js';
import '../../editor.all.js';
import '../../contrib/suggest/browser/suggestController.js';
import { activateEditorFeatures } from '../../browser/editorFeatureRegistration.js';
import { EditorExtensionsRegistry } from '../../browser/editorExtensions.js';
import { TextModel } from '../../common/model/textModel.js';
import { Range } from '../../common/core/range.js';

suite('Incremental product editor startup', () => {
	test('admitting Code preserves an existing plain input and its registered completion identity', async () => {
		activateEditorFeatures();
		const suggest = EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.suggestController'])[0];
		assert.ok(suggest);
		assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.renameController']).length, 0);
		using model = new TextModel('An unsent input');
		model.pushEditOperations(null, [{ range: new Range(1, 16, 1, 16), text: ' draft' }], () => null);
		model.pushStackElement();
		const tokens = model.tokenization;
		const version = model.getVersionId();
		await import('../../editor.code.all.js');
		assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.renameController']).length, 1);
		assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.suggestController'])[0], suggest);
		assert.equal(model.tokenization, tokens);
		assert.equal(model.getValue(), 'An unsent input draft');
		assert.equal(model.getVersionId(), version);
		// Repeated admission must not reinstall model providers or command handlers.
		activateEditorFeatures();
		assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.renameController']).length, 1);
		model.undo();
		assert.equal(model.getValue(), 'An unsent input');
	});
});

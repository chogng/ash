import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { EditorGroupModel } from '../../../../../../common/editor/editorGroupModel.js';
import { ChatEditorInput, ChatEditorInputSerializer } from '../../../../browser/widgetHosts/editor/chatEditorInput.js';

suite('Chat editor identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the common editor model reveals a materialized draft through its current conversation identity', () => {
		using draft = new ChatEditorInput('untitled:draft', 'Draft');
		const model = new EditorGroupModel();
		const original = model.openEditor(draft, { pinned: true }).editor;
		const resource = draft.resource;
		draft.updateSession('session:created', 'Created');
		using historyInput = new ChatEditorInput('session:created', 'Created');

		assert.notEqual(historyInput.resource.toString(), resource.toString());
		assert.equal(model.openEditor(historyInput, { pinned: true }).editor.input, draft);
		assert.equal(model.entries.length, 1);
		assert.equal(model.entries[0]?.instanceId, original.instanceId);
		assert.equal(draft.resource, resource);
		assert.equal(draft.editorId, ChatEditorInput.EditorID);
		model.updateEditor(historyInput, { pinned: true });
		assert.equal(model.entries[0]?.input, draft);
	});

	test('restoration matches the current conversation without merging independent conversations or the canvas', () => {
		using input = new ChatEditorInput('untitled:draft', 'Draft');
		input.updateSession('session:created', 'Created');
		const serializer = new ChatEditorInputSerializer();
		using restored = serializer.deserialize(serializer.serialize(input));
		using other = new ChatEditorInput('session:other', 'Other');
		using canvas = new ChatEditorInput();
		const model = new EditorGroupModel();
		model.openEditor(input, { pinned: true });

		assert.equal(model.openEditor(restored).editor.input, input);
		assert.equal(model.openEditor(other, { pinned: true }).editor.input, other);
		assert.equal(model.openEditor(canvas, { pinned: true }).editor.input, canvas);
		assert.deepEqual(model.getEditors(), [input, other, canvas]);
	});

	test('plain resource requests can still replace their content when reopened', () => {
		using input = new ChatEditorInput('session:original');
		const model = new EditorGroupModel();
		const original = { resource: input.resource, initialText: 'First snapshot' };
		const revised = { resource: input.resource, initialText: 'Revised snapshot' };
		model.openEditor(original, { pinned: true });
		model.openEditor(revised, { pinned: true });
		assert.equal(model.entries[0]?.input, revised);
		const updated = { resource: input.resource, initialText: 'Updated snapshot' };
		model.updateEditor(updated, {});
		assert.equal(model.entries[0]?.input, updated);
		assert.equal(model.entries.length, 1);
	});
});

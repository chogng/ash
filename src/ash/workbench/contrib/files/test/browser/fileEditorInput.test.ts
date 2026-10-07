import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { FileEditorInputSerializer } from '../../browser/editors/fileEditorHandler.js';
import { FILE_EDITOR_INPUT_ID, FileEditorInput } from '../../browser/editors/fileEditorInput.js';

test('File editor input restores its file identity and selected language after a working-set round trip', () => {
	const resource = URI.parse('file:///C:/project/notes.txt');
	using input = new FileEditorInput(resource, { label: 'Notes', languageId: 'markdown', readOnly: true });
	const serialized = EditorInputSerializers.serialize(input);
	assert.equal(serialized.typeId, FILE_EDITOR_INPUT_ID);
	const restored = EditorInputSerializers.deserialize(serialized);
	assert.ok(restored instanceof FileEditorInput);
	try {
		assert.equal(restored.resource.toString(), resource.toString());
		assert.equal(restored.label, 'Notes');
		assert.equal(restored.languageId, 'markdown');
		assert.equal(restored.readOnly, true);
		assert.equal(restored.showBreadcrumbs, true);
	} finally { restored.dispose(); }
});

test('File editor input rejects non-file resources and corrupt restored data', () => {
	using encoded = new FileEditorInput(URI.from({ scheme: 'file', path: '/C:/project/hello %中.txt' }));
	assert.equal(encoded.label, 'hello %中.txt');
	assert.throws(() => new FileEditorInput(URI.parse('untitled:/draft')), /file resource/);
	assert.throws(() => new FileEditorInputSerializer().deserialize({ resource: 'untitled:/draft' }), /file resource/);
	assert.throws(() => new FileEditorInputSerializer().deserialize({ resource: URI.parse('file:///C:/project/notes.txt').toString(), readOnly: 'yes' }), /boolean/);
});

test('file resource names remain decoded and retain identity through restoration', () => {
	using input = new FileEditorInput(URI.from({ scheme: 'file', path: '/project/hello %中.txt' }));
	const restored = EditorInputSerializers.deserialize(EditorInputSerializers.serialize(input));
	assert.ok(restored instanceof FileEditorInput);
	try {
		assert.deepEqual([input.getName(), restored.getName(), restored.matches(input)], ['hello %中.txt', 'hello %中.txt', true]);
	} finally { restored.dispose(); }
});

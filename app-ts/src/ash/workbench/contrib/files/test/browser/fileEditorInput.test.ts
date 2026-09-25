import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { FileEditorInputSerializer } from '../../browser/editors/fileEditorHandler.js';
import { FILE_EDITOR_INPUT_ID, FileEditorInput } from '../../browser/editors/fileEditorInput.js';

test('File editor input restores its file identity and selected language after a working-set round trip', () => {
	const resource = URI.file('C:\\project\\notes.txt');
	const input = new FileEditorInput(resource, { label: 'Notes', languageId: 'markdown', readOnly: true });
	const serialized = EditorInputSerializers.serialize(input);
	assert.equal(serialized.typeId, FILE_EDITOR_INPUT_ID);
	const restored = EditorInputSerializers.deserialize(serialized);
	assert.ok(restored instanceof FileEditorInput);
	assert.equal(restored.resource.toString(), resource.toString());
	assert.equal(restored.label, 'Notes');
	assert.equal(restored.languageId, 'markdown');
	assert.equal(restored.readOnly, true);
	assert.equal(restored.showBreadcrumbs, true);
});

test('File editor input rejects non-file resources and corrupt restored data', () => {
	assert.equal(new FileEditorInput(URI.file('C:\\project\\hello %中.txt')).label, 'hello %中.txt');
	assert.throws(() => new FileEditorInput(URI.parse('untitled:/draft')), /file resource/);
	assert.throws(() => new FileEditorInputSerializer().deserialize({ resource: 'untitled:/draft' }), /file resource/);
	assert.throws(() => new FileEditorInputSerializer().deserialize({ resource: URI.file('C:\\project\\notes.txt').toString(), readOnly: 'yes' }), /boolean/);
});

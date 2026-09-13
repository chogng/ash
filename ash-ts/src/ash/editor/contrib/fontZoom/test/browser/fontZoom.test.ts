import assert from 'node:assert/strict';
import { test } from 'mocha';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { EditorExtensionsRegistry, type ServicesAccessor } from '../../../../browser/editorExtensions.js';
import { EditorZoom } from '../../../../common/config/editorZoom.js';
import '../../browser/fontZoom.js';

test('font zoom actions update the shared editor zoom owner', () => {
	const previous = EditorZoom.getZoomLevel();
	const actions = new Map([...EditorExtensionsRegistry.getEditorActions()].map(action => [action.id, action]));
	const accessor = {} as ServicesAccessor;
	const editor = {} as ICodeEditor;
	try {
		EditorZoom.setZoomLevel(0);
		actions.get('editor.action.fontZoomIn')!.run(accessor, editor, {});
		assert.equal(EditorZoom.getZoomLevel(), 1);
		actions.get('editor.action.fontZoomOut')!.run(accessor, editor, {});
		assert.equal(EditorZoom.getZoomLevel(), 0);
		EditorZoom.setZoomLevel(4);
		actions.get('editor.action.fontZoomReset')!.run(accessor, editor, {});
		assert.equal(EditorZoom.getZoomLevel(), 0);
	} finally {
		EditorZoom.setZoomLevel(previous);
	}
});

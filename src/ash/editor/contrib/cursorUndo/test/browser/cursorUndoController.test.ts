import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingResolver, KeybindingResolveKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { EditorExtensionsRegistry } = await import('../../../../browser/editorExtensions.js');
const { CursorUndoRedoController } = await import('../../browser/cursorUndo.js');


test('CursorUndoRedoController restores and reapplies cursor-only history', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('one\ntwo');
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	const original = [Selection.fromPositions(new Position(1, 1))];
	const multiple = [Selection.fromPositions(new Position(2, 1)), Selection.fromPositions(new Position(1, 1))];
	assert.ok(CursorUndoRedoController.get(editor));
	editor.setSelections(multiple);

	const undo = [...EditorExtensionsRegistry.getEditorActions()].find(action => action.id === 'cursorUndo');
	assert.ok(undo);
	editor.invokeWithinContext(accessor => undo.run(accessor, editor, {}));
	assert.deepEqual(editor.getSelections(), original);

	const redo = [...EditorExtensionsRegistry.getEditorActions()].find(action => action.id === 'cursorRedo');
	assert.ok(redo);
	editor.invokeWithinContext(accessor => redo.run(accessor, editor, {}));
	assert.deepEqual(editor.getSelections(), multiple);
	assert.equal(model.getText(), 'one\ntwo');
	dom.window.close();
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());

test('Cursor Undo shortcut reaches the shell outside text inputs and retains editor cursor undo', () => {
	using context = new ContextKeyService();
	const resolver = new KeybindingResolver();
	const shortcut = { key: 'u', code: 'KeyU', keyCode: KeyCode.KeyU, ctrlKey: !isMacintosh, metaKey: isMacintosh, altKey: false, shiftKey: false };
	context.setContext('terminalFocus', true);
	context.setContext('textInputFocus', false);
	assert.equal(resolver.resolve(context, [shortcut]).kind, KeybindingResolveKind.NoMatch, 'the editor action must leave the native shell control key available');
	context.setContext('terminalFocus', false);
	context.setContext('textInputFocus', true);
	const resolved = resolver.resolve(context, [shortcut]);
	assert.ok(resolved.kind === KeybindingResolveKind.Command);
	assert.equal(resolved.command, 'cursorUndo');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\ntwo');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(2, 2)));
	const action = [...EditorExtensionsRegistry.getEditorActions()].find(value => value.id === resolved.command);
	assert.ok(action);
	editor.invokeWithinContext(accessor => action.run(accessor, editor, {}));
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 1)));
	assert.equal(model.getText(), 'one\ntwo');
	dom.window.close();
});

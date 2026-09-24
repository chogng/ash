import '../../../../test/browser/testEditorDom.js';
import { browserEnvironment as environment } from '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { Range } from '../../../../common/core/range.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../browser/editorState.js';
import { EditorKeybindingCancellationTokenSource } from '../../browser/keybindingCancellation.js';

const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');

function createEditor(model: TextModel): ReturnType<typeof createTestCodeEditor> {
	const container = environment.window.document.createElement('div');
	environment.window.document.body.append(container);
	const editor = createTestCodeEditor({
		container,
		model,
		contributions: [],
	});
	editor.onDidDispose(() => container.remove());
	return editor;
}

test('position cancellation remains cancelled after returning to the starting position', () => {
	using model = new TextModel('alpha');
	using editor = createEditor(model);
	using source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Position);
	editor.setPosition(new Position(1, 3));
	editor.setPosition(new Position(1, 1));
	assert.equal(source.token.isCancellationRequested, true);
});

test('allowed range keeps an operation alive until the caret leaves it', () => {
	using model = new TextModel('alpha');
	using editor = createEditor(model);
	using source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Position, new Range(1, 1, 1, 3));
	editor.setPosition(new Position(1, 3));
	assert.equal(source.token.isCancellationRequested, false);
	editor.setPosition(new Position(1, 4));
	assert.equal(source.token.isCancellationRequested, true);
});

test('model replacement cancels even when the text and version match', () => {
	using model = new TextModel('alpha');
	using next = new TextModel('alpha');
	using editor = createEditor(model);
	using source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Value);
	editor.setModel(next);
	assert.equal(source.token.isCancellationRequested, true);
});

test('disposing a source removes state listeners without cancelling its token', () => {
	using model = new TextModel('alpha');
	using editor = createEditor(model);
	const source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Position);
	const token = source.token;
	source.dispose();
	editor.setPosition(new Position(1, 3));
	assert.equal(token.isCancellationRequested, false);
});

test('editor disposal and an already cancelled parent cancel pending operations', () => {
	using model = new TextModel('alpha');
	using editor = createEditor(model);
	using pending = new EditorKeybindingCancellationTokenSource(editor);
	using cancelled = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Value, undefined, CancellationToken.Cancelled);
	editor.dispose();
	assert.deepEqual([pending.token.isCancellationRequested, cancelled.token.isCancellationRequested], [true, true]);
});

test('Escape cancels nested operations one at a time and releases its handler', () => {
	using model = new TextModel('alpha');
	using editor = createEditor(model);
	editor.focus();
	using outer = new EditorKeybindingCancellationTokenSource(editor);
	using inner = new EditorKeybindingCancellationTokenSource(editor);
	const escape = (): boolean => {
		const event = new environment.window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
		editor.controller.element.dispatchEvent(event);
		return event.defaultPrevented;
	};
	assert.equal(escape(), true);
	assert.deepEqual([outer.token.isCancellationRequested, inner.token.isCancellationRequested], [false, true]);
	assert.equal(escape(), true);
	assert.equal(outer.token.isCancellationRequested, true);
	assert.equal(escape(), false);
});

test('scroll cancellation observes the editor layout owner', () => {
	using model = new TextModel(Array.from({ length: 100 }, () => 'alpha').join('\n'));
	using editor = createEditor(model);
	editor.layout({ width: 400, height: 100 });
	using source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Scroll);
	editor.setScrollTop(150);
	assert.equal(source.token.isCancellationRequested, true);
});

test('selection cancellation observes an anchor change without a caret move', () => {
	using model = new TextModel('alpha');
	using editor = createEditor(model);
	editor.setSelection(new Selection(1, 1, 1, 6));
	using source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Selection);
	editor.setSelection(new Selection(1, 2, 1, 6));
	assert.equal(source.token.isCancellationRequested, true);
});

test('selection cancellation observes a secondary selection while the primary stays unchanged', () => {
	using model = new TextModel('alpha\nbeta');
	using editor = createEditor(model);
	const primary = new Selection(1, 1, 1, 6);
	editor.setSelections([primary, new Selection(2, 1, 2, 5)]);
	using source = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Selection);
	editor.setSelections([primary, new Selection(2, 2, 2, 5)]);
	assert.equal(source.token.isCancellationRequested, true);
});

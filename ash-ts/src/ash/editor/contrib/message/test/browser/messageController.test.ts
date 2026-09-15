import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { TextModel } from '../../../../common/model/textModel.js';
import '../../browser/messageController.js';
import '../../../readOnlyMessage/browser/contribution.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	HTMLCanvasElement: environment.window.HTMLCanvasElement,
	Event: environment.window.Event,
	KeyboardEvent: environment.window.KeyboardEvent,
	PointerEvent: environment.window.PointerEvent ?? environment.window.MouseEvent,
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) Object.defineProperty(globalThis, name, { configurable: true, value });
environment.window.HTMLCanvasElement.prototype.getContext = () => null;
setARIAContainer(environment.window.document.body);

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { MessageController } = await import('../../browser/messageController.js');
const { ReadOnlyMessageController } = await import('../../../readOnlyMessage/browser/contribution.js');

suiteTeardown(() => environment.window.close());

test('read-only edit attempts use MessageController and close after cursor movement', () => {
	const container = environment.window.document.createElement('main');
	using model = new TextModel('alpha\nbeta');
	using editor = createTestCodeEditor({
		container,
		model,
		input: { resource: model.uri, readOnly: true },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 400, height: 100 });
	assert.ok(editor.getContribution(ReadOnlyMessageController.ID));
	editor.executeCommand('test', {
		getEditOperations: (_textModel, builder) => builder.addEditOperation({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, 'x'),
		computeCursorState: () => Selection.fromPositions(new Position(1, 2)),
	});

	const messages = MessageController.get(editor);
	assert.ok(messages?.isVisible());
	const messageWidget = environment.window.document.body.querySelector<HTMLElement>('.stanza-editor-overlay-message');
	assert.ok(messageWidget);
	assert.match(messageWidget.textContent ?? '', /Cannot edit in read-only editor/);
	editor.setSelection(Selection.fromPositions(new Position(2, 1)));
	assert.equal(messages?.isVisible(), false);
	messages.showMessage('Closing message', new Position(1, 1));
	assert.equal(messages.isVisible(), true);
	messages.dispose();
	assert.equal(messages.isVisible(), false);
	assert.equal(environment.window.document.body.querySelector('.stanza-editor-overlay-message'), null);
});

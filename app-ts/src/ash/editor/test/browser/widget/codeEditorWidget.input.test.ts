import '../testEditorDom.js';

import { h, text } from '../../../../base/browser/dom.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { browserEnvironment } from '../testEditorDom.js';
import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { StandardKeyboardEvent, type IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Event as EditorEvent } from '../../../../base/common/event.js';
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { MouseTargetType, type ICodeEditor, type IMouseTarget } from '../../../browser/editorBrowser.js';
import { NavigationCommandRevealType } from '../../../browser/coreCommands.js';
import { ViewUserInputEvents } from '../../../browser/view/viewUserInputEvents.js';
import { type ICoordinatesConverter } from '../../../common/coordinatesConverter.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { TextModel } from "../../../common/model/textModel.js";
import { EditorLineWrapping, EditorOption } from '../../../common/config/editorOptions.js';
import { type ViewConfigurationChangedEvent } from '../../../common/viewEvents.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { ViewContext } from '../../../common/viewModel/viewContext.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';

const { CodeEditorWidget } = await import("../../../browser/widget/codeEditor/codeEditorWidget.js");
const { createTestCodeEditor } = await import('../testCodeEditor.js');
const { NativeEditContext } = await import('../../../browser/controller/editContext/native/nativeEditContext.js');
const { NativeEditContextRegistry } = await import('../../../browser/controller/editContext/native/nativeEditContextRegistry.js');
const { ScreenReaderSupport } = await import('../../../browser/controller/editContext/native/screenReaderSupport.js');
const { TextAreaEditContext } = await import('../../../browser/controller/editContext/textArea/textAreaEditContext.js');
const { TestView } = await import('../viewModel/testViewModel.js');
const { ServiceContainer } = await import("../../../../platform/instantiation/common/instantiation.js");
const { ILogService, NullLoggerService } = await import('../../../../platform/log/common/log.js');
await import("../../../contrib/placeholderText/browser/placeholderText.contribution.js");
await import('../../../contrib/inPlaceReplace/browser/inPlaceReplace.js');

const enabledAccessibilityService: IAccessibilityService = {
	onDidChangeScreenReaderOptimized: EditorEvent.None,
	onDidChangeReducedMotion: EditorEvent.None,
	onDidChangeReducedTransparency: EditorEvent.None,
	onDidChangeLinkUnderlines: EditorEvent.None,
	alwaysUnderlineAccessKeys: async () => false,
	isScreenReaderOptimized: () => true,
	isMotionReduced: () => false,
	isTransparencyReduced: () => false,
	getAccessibilitySupport: () => AccessibilitySupport.Enabled,
	setAccessibilitySupport: () => {},
	alert: () => {},
	status: () => {},
};

function pointerEvent(dom: JSDOM, type: string, pointerId: number, buttons: number, clientX: number, clientY: number): Event {
	const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX, clientY }) as unknown as Event & { pointerId: number };
	Object.defineProperty(event, 'pointerId', { configurable: true, value: pointerId });
	return event;
}

function delay(targetWindow: Pick<Window, 'setTimeout'>, duration: number): Promise<void> {
	return new Promise(resolve => targetWindow.setTimeout(resolve, duration));
}

test('textarea system-caret movement returns through TextAreaInput and stops after blur', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		accessibilityService: enabledAccessibilityService,
	});
	editor.layout({ width: 320, height: 80 });
	assert.ok(editor.controller.editContext instanceof TextAreaEditContext);
	const editContext = editor.controller.editContext as InstanceType<typeof TextAreaEditContext>;
	const textArea = editContext.getTextAreaDomNode();
	editContext.focus();
	editContext.writeScreenReaderContent('test');
	editContext.textAreaInput.resetSelectionChangeTime();

	textArea.setSelectionRange(1, 3, 'forward');
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(editor.getSelections(), [new Selection(1, 2, 1, 4)]);

	textArea.blur();
	textArea.setSelectionRange(0, 1, 'forward');
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(editor.getSelections(), [new Selection(1, 2, 1, 4)]);
	const lateInput = new dom.window.InputEvent('beforeinput', {
		bubbles: true,
		cancelable: true,
		inputType: 'insertText',
		data: 'X',
	});
	textArea.dispatchEvent(lateInput);
	assert.deepEqual({ prevented: lateInput.defaultPrevented, value: model.getValue(), version: model.getVersionId() }, {
		prevented: true,
		value: 'alpha',
		version: 1,
	});
	textArea.dispatchEvent(new dom.window.InputEvent('beforeinput', {
		bubbles: true,
		inputType: 'insertText',
		data: 'Y',
	}));
	assert.deepEqual({ value: model.getValue(), version: model.getVersionId() }, { value: 'alpha', version: 1 });
	dom.window.close();
});

test('textarea system-caret movement maps LF screen-reader content back to a CRLF model', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('ab\r\ncd');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		accessibilityService: enabledAccessibilityService,
	});
	editor.layout({ width: 320, height: 80 });
	assert.ok(editor.controller.editContext instanceof TextAreaEditContext);
	const editContext = editor.controller.editContext as InstanceType<typeof TextAreaEditContext>;
	const textArea = editContext.getTextAreaDomNode();
	editContext.focus();
	editContext.writeScreenReaderContent('test');
	editContext.textAreaInput.resetSelectionChangeTime();
	assert.equal(textArea.value, 'ab\ncd');

	textArea.setSelectionRange(1, 4, 'forward');
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(editor.getSelections(), [new Selection(1, 2, 2, 2)]);
	dom.window.close();
});

test('EditContext owns default copy, paste, and cut behavior without a clipboard contribution', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha beta');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});
	const input = editor.controller.editContext.domNode.domNode;
	assert.ok(editor.controller.editContext instanceof TextAreaEditContext);
	input.focus();
	const textAreaInput = editor.controller.editContext.textAreaInput;
	let willCopyCount = 0;
	let cutCount = 0;
	let pasteCount = 0;
	using willCopyListener = textAreaInput.onWillCopy(() => willCopyCount += 1);
	using cutListener = textAreaInput.onCut(() => cutCount += 1);
	using pasteListener = textAreaInput.onPaste(() => pasteCount += 1);
	editor.setSelection(new Selection(1, 1, 1, 6));
	const copied = new TestClipboardData();
	const copy = testClipboardEvent(dom.window, 'copy', copied);
	input.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, true);
	assert.equal(copied.getData('text/plain'), 'alpha');
	assert.equal(willCopyCount, 1);

	const pasted = new TestClipboardData();
	pasted.setData('text/plain', 'omega');
	const paste = testClipboardEvent(dom.window, 'paste', pasted);
	input.dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.equal(model.getText(), 'omega beta');
	assert.equal(pasteCount, 1);

	editor.setSelection(new Selection(1, 1, 1, 6));
	const cutData = new TestClipboardData();
	const cut = testClipboardEvent(dom.window, 'cut', cutData);
	input.dispatchEvent(cut);
	assert.equal(cut.defaultPrevented, true);
	assert.equal(cutData.getData('text/plain'), 'omega');
	assert.equal(model.getText(), ' beta');
	assert.equal(cutCount, 1);
	dom.window.close();
});

test('EditContext rejects cut and paste while composition owns the edit transaction', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});
	editor.setSelection(new Selection(1, 6, 1, 6));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { data: '' }));
	assert.equal(editor.inComposition, true);
	const pasteData = new TestClipboardData();
	pasteData.setData('text/plain', 'omega');
	const paste = testClipboardEvent(dom.window, 'paste', pasteData);
	input.dispatchEvent(paste);
	const cut = testClipboardEvent(dom.window, 'cut', new TestClipboardData());
	input.dispatchEvent(cut);
	assert.equal(paste.defaultPrevented, true);
	assert.equal(cut.defaultPrevented, true);
	assert.equal(model.getText(), 'alpha');
	const textArea = input as HTMLTextAreaElement;
	try {
		textArea.value = 'xy';
		textArea.setSelectionRange(1, 1);
		textArea.dispatchEvent(new dom.window.CompositionEvent('compositionupdate', { data: 'xy' }));
		assert.equal(model.getText(), 'alphaxy');
		assert.deepEqual(editor.getPosition(), new Position(1, 7));
		assert.deepEqual(model.getAllDecorations().map(decoration => decoration.options.inlineClassName), ['edit-context-composition-primary']);
	} finally {
		textArea.dispatchEvent(new dom.window.CompositionEvent('compositionend', { data: 'xy' }));
	}
	assert.equal(model.getAllDecorations().some(decoration => decoration.options.description === 'composition-decoration'), false);
	dom.window.close();
});

test('EditContext routes word deletion through standard WordOperations ranges', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha beta');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});
	const input = editor.controller.editContext.domNode.domNode;
	editor.setPosition(new Position(1, 11));
	input.focus();
	const backward = new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteWordBackward' });
	input.dispatchEvent(backward);
	assert.equal(backward.defaultPrevented, true);
	assert.equal(model.getText(), 'alpha ');

	editor.controller.undo();
	editor.setPosition(new Position(1, 1));
	const forward = new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteWordForward' });
	input.dispatchEvent(forward);
	assert.equal(forward.defaultPrevented, true);
	assert.equal(model.getText(), ' beta');
	dom.window.close();
});

test('setSelection accepts ranges, preserves selection direction, and reports its source', () => {
	using model = new TextModel('alpha\nbeta');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using editor = createTestCodeEditor({ container, model });
	const api: ICodeEditor = editor;
	const events: { selection: string; source: string }[] = [];
	using listener = api.onDidChangeCursorSelection(event => events.push({ selection: event.selection.toString(), source: event.source }));
	api.setSelections([new Selection(1, 1, 1, 1), new Selection(2, 1, 2, 1)]);
	events.length = 0;
	const version = model.getVersionId();

	api.setSelection(new Range(1, 2, 1, 4), 'find');
	assert.deepEqual(api.getSelections(), [new Selection(1, 2, 1, 4)]);
	api.setSelection({ startLineNumber: 1, startColumn: 3, endLineNumber: 9, endColumn: 99 });
	assert.deepEqual(api.getSelection(), new Selection(1, 3, 2, 5));
	api.setSelection(new Selection(2, 4, 1, 2), 'reverse');
	assert.deepEqual(api.getSelection(), new Selection(2, 4, 1, 2));
	api.setSelection({ selectionStartLineNumber: 2, selectionStartColumn: 3, positionLineNumber: 1, positionColumn: 1 });
	assert.deepEqual(api.getSelection(), new Selection(2, 3, 1, 1));
	assert.deepEqual(events, [
		{ selection: '[1,2 -> 1,4]', source: 'find' },
		{ selection: '[1,3 -> 2,5]', source: 'api' },
		{ selection: '[2,4 -> 1,2]', source: 'reverse' },
		{ selection: '[2,3 -> 1,1]', source: 'api' },
	]);
	assert.equal(model.getVersionId(), version);
});

test('setSelection rejects malformed input without changing selection or detached editor state', () => {
	using model = new TextModel('alpha');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using editor = createTestCodeEditor({ container, model });
	const selection = new Selection(1, 2, 1, 4);
	editor.setSelection(selection);
	let changes = 0;
	using listener = editor.onDidChangeCursorSelection(() => changes++);
	for (const value of [null, undefined, {}, { startLineNumber: 1, startColumn: 1 }]) {
		assert.throws(() => Reflect.apply(editor.setSelection, editor, [value]), TypeError);
	}
	assert.deepEqual(editor.getSelection(), selection);
	assert.equal(changes, 0);
	editor.setModel(null);
	editor.setSelection(new Range(1, 1, 2, 3));
	assert.equal(editor.getSelection(), null);
	assert.throws(() => Reflect.apply(editor.setSelection, editor, [null]), TypeError);
});

test('executeEdits applies one editor transaction and its requested cursor state', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});

	editor.pushUndoStop();
	assert.equal(editor.executeEdits('test.executeEdits', [
		{ range: new Range(1, 1, 1, 6), text: 'beta' },
	], [Selection.fromPositions(new Position(1, 5))]), true);
	editor.pushUndoStop();
	assert.equal(model.getText(), 'beta');
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 5)));

	editor.getModel()!.undo();
	assert.equal(model.getText(), 'alpha');
	dom.window.close();
});

test('CodeEditorWidget publishes canonical cursor position and selection events', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});
	const positions: Parameters<Parameters<typeof editor.onDidChangeCursorPosition>[0]>[0][] = [];
	const selections: Parameters<Parameters<typeof editor.onDidChangeCursorSelection>[0]>[0][] = [];
	using positionListener = editor.onDidChangeCursorPosition(event => positions.push(event));
	using selectionListener = editor.onDidChangeCursorSelection(event => selections.push(event));

	editor.setSelections([
		Selection.fromPositions(new Position(1, 3)),
		Selection.fromPositions(new Position(1, 5)),
	], 'test.cursorEvents');

	assert.deepEqual(positions, [{
		position: new Position(1, 3),
		secondaryPositions: [new Position(1, 5)],
		reason: CursorChangeReason.NotSet,
		source: 'test.cursorEvents',
	}]);
	assert.deepEqual(selections, [{
		selection: Selection.fromPositions(new Position(1, 3)),
		secondarySelections: [Selection.fromPositions(new Position(1, 5))],
		modelVersionId: model.getVersionId(),
		oldSelections: [Selection.fromPositions(new Position(1, 1))],
		oldModelVersionId: model.getVersionId(),
		source: 'test.cursorEvents',
		reason: CursorChangeReason.NotSet,
	}]);
	dom.window.close();
});

test('editor focus updates the view overlay presentation', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha '.repeat(20));
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		lineWrapping: EditorLineWrapping.On,
		renderLineHighlight: 'all',
		renderLineHighlightOnlyWhenFocus: true,
	});
	editor.layout({ width: 120, height: 100 });
	const overlays = requiredElement(editor.getDomNode(), '.view-overlays');

	assert.equal(overlays.classList.contains('focused'), false);
	assert.equal(editor.getDomNode().querySelector('.view-overlays .current-line'), null);
	assert.equal(editor.getDomNode().querySelector('.margin-view-overlays .current-line-margin'), null);
	editor.focus();
	assert.equal(overlays.classList.contains('focused'), true);
	assert.deepEqual(
		[...requiredElement(editor.getDomNode(), '.view-overlays .current-line').classList],
		['current-line', 'stanza-editor-current-line-highlight', 'current-line-both', 'current-line-exact'],
	);
	assert.deepEqual(
		[...requiredElement(editor.getDomNode(), '.margin-view-overlays .current-line-margin').classList],
		['current-line', 'stanza-editor-current-line-margin-highlight', 'current-line-margin', 'current-line-margin-both', 'current-line-exact-margin'],
	);
	assert.ok(editor.getDomNode().querySelectorAll('.view-overlays .current-line').length > 1);
	assert.equal(editor.getDomNode().querySelectorAll('.view-overlays .current-line-exact').length, 1);
	editor.setSelection(new Selection(1, 1, 1, 2));
	assert.equal(editor.getDomNode().querySelector('.view-overlays .current-line'), null);
	assert.ok(editor.getDomNode().querySelector('.margin-view-overlays .current-line-margin'));
	editor.setSelection(Selection.fromPositions(new Position(1, 1)));
	editor.controller.editContext.domNode.domNode.blur();
	assert.equal(overlays.classList.contains('focused'), false);
	assert.equal(editor.getDomNode().querySelector('.view-overlays .current-line'), null);
	assert.equal(editor.getDomNode().querySelector('.margin-view-overlays .current-line-margin'), null);

	editor.dispose();
	dom.window.close();
});

test('browser EditContext reattaches its editing object after DOM ownership changes', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	class TestEditContext extends dom.window.EventTarget implements EditContext {
		public text = '';
		public selectionStart = 0;
		public selectionEnd = 0;
		public selectionBounds: DOMRect | undefined;
		public controlBounds: DOMRect | undefined;
		public updateCharacterBounds(): void {}
		public updateText(start: number, end: number, text: string): void {
			this.text = `${this.text.slice(0, start)}${text}${this.text.slice(end)}`;
		}
		public updateSelection(start: number, end: number): void {
			this.selectionStart = start;
			this.selectionEnd = end;
		}
		public updateSelectionBounds(bounds: DOMRect): void {
			this.selectionBounds = bounds;
		}
		public updateControlBounds(bounds: DOMRect): void {
			this.controlBounds = bounds;
		}
	}
	Object.defineProperty(dom.window, 'EditContext', { configurable: true, value: TestEditContext });
	using model = new TextModel('alpha');
	using services = new ServiceContainer();
	services.registerInstance(ILogService, new NullLoggerService());
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		instantiationService: services,
		accessibilityService: enabledAccessibilityService,
	});
	const ownerId = editor.getId();
	assert.ok(editor.controller.editContext instanceof NativeEditContext);
	const editContext = editor.controller.editContext as InstanceType<typeof NativeEditContext>;
	editor.layout({ width: 320, height: 80 });
	assert.strictEqual(NativeEditContextRegistry.get(ownerId), editContext);
	assert.ok(editContext.nativeContext.updateSelectionBounds);
	assert.ok((editContext.nativeContext as TestEditContext).selectionBounds);
	assert.ok((editContext.nativeContext as TestEditContext).controlBounds);
	const input = editContext.domNode.domNode as HTMLElement & { editContext?: unknown };
	assert.strictEqual(input.editContext, editContext.nativeContext);
	editContext.focus();
	let receivedKeyDown: IKeyboardEvent | undefined;
	let receivedKeyUp: IKeyboardEvent | undefined;
	using keyDownListener = editor.onKeyDown(event => receivedKeyDown = event);
	using keyUpListener = editor.onKeyUp(event => receivedKeyUp = event);
	const keyDown = new dom.window.KeyboardEvent('keydown', { bubbles: true, code: 'F2', key: 'F2' });
	const keyUp = new dom.window.KeyboardEvent('keyup', { bubbles: true, code: 'F2', key: 'F2' });
	input.dispatchEvent(keyDown);
	input.dispatchEvent(keyUp);
	assert.ok(receivedKeyDown instanceof StandardKeyboardEvent);
	assert.ok(receivedKeyUp instanceof StandardKeyboardEvent);
	assert.strictEqual(receivedKeyDown.browserEvent, keyDown);
	assert.strictEqual(receivedKeyUp.browserEvent, keyUp);
	editContext.writeScreenReaderContent('test');
	const simpleContent = requiredElement<HTMLElement>(input, '.stanza-native-screen-reader-content');
	assert.equal(simpleContent.textContent, 'alpha');
	assert.equal(simpleContent.querySelector('span[data-line-index]'), null);
	editor.updateOptions({ renderRichScreenReaderContent: true });
	editContext.writeScreenReaderContent('test');
	const richContent = requiredElement<HTMLElement>(input, '.stanza-native-screen-reader-content');
	assert.notStrictEqual(richContent, simpleContent);
	assert.equal(simpleContent.isConnected, false);
	assert.equal(richContent.querySelector('span[data-line-index="0"]')?.textContent, 'alpha');
	const nativeComposition = editContext.nativeContext as TestEditContext;
	nativeComposition.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { data: '' }));
	assert.equal(editor.inComposition, true);
	const textUpdate = Object.assign(new dom.window.Event('textupdate'), {
		text: '你',
		updateRangeStart: 0,
		updateRangeEnd: 0,
		selectionStart: 1,
		selectionEnd: 1,
	});
	nativeComposition.dispatchEvent(textUpdate);
	assert.equal(model.getText(), '你alpha');
	nativeComposition.dispatchEvent(new dom.window.CompositionEvent('compositionend', { data: '你' }));
	assert.equal(editor.inComposition, false);
	model.undo();
	assert.equal(model.getText(), 'alpha');
	input.blur();
	assert.equal(editContext.isFocused(), false);
	const versionBeforeLateInput = model.getVersionId();
	const lateCompositionStart = new dom.window.CompositionEvent('compositionstart', { cancelable: true });
	nativeComposition.dispatchEvent(lateCompositionStart);
	assert.equal(lateCompositionStart.defaultPrevented, true);
	assert.equal(editor.inComposition, false);
	nativeComposition.dispatchEvent(Object.assign(new dom.window.Event('textupdate'), {
		text: 'late',
		updateRangeStart: 0,
		updateRangeEnd: 0,
		selectionStart: 4,
		selectionEnd: 4,
	}));
	assert.deepEqual({ text: model.getText(), version: model.getVersionId(), browserText: nativeComposition.text }, {
		text: 'alpha',
		version: versionBeforeLateInput,
		browserText: 'alpha',
	});

	const adoptedDom = new JSDOM('<!doctype html><body></body>');
	input.editContext = undefined;
	adoptedDom.window.document.body.append(adoptedDom.window.document.adoptNode(input));
	editContext.setEditContextOnDomNode();
	assert.strictEqual(input.ownerDocument, adoptedDom.window.document);
	assert.strictEqual(input.editContext, editContext.nativeContext);
	editor.dispose();
	assert.equal(NativeEditContextRegistry.get(ownerId), undefined);
	adoptedDom.window.close();
	dom.window.close();
});

test('ScreenReaderSupport projects one model and screen-reader selection returns through its content owner', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('alpha');
	using viewport = new TestView({
		container,
		model,
		lineHeight: 20,
	});
	viewport.layout({ width: 320, height: 80 });
	const element = h(dom.window.document, 'div');
	container.append(element);
	const context = new ViewContext(viewport.testConfiguration, darkColorTheme, viewport.testViewModel);
	viewport.testConfiguration.updateOptions({ accessibilitySupport: 'on' });
	using support = new ScreenReaderSupport({
		domNode: new FastDomNode(element),
		context,
		viewport,
		viewController: viewport.controller,
	});

	support.handleFocusChange(true);
	support.writeScreenReaderContent();
	const content = requiredElement<HTMLElement>(element, '.stanza-native-screen-reader-content');
	assert.equal(content.textContent, 'alpha');
	assert.equal(content.getAttribute('aria-hidden'), 'false');

	model.setValue('beta');
	support.writeScreenReaderContent();
	assert.equal(content.textContent, 'beta');
	await new Promise(resolve => setTimeout(resolve, 110));
	const textNode = content.firstChild;
	const domSelection = dom.window.document.getSelection();
	assert.ok(textNode);
	assert.ok(domSelection);
	domSelection.setBaseAndExtent(textNode, 1, textNode, 3);
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(
		viewport.testViewModel.getSelections(),
		[Selection.fromPositions(new Position(1, 2), new Position(1, 4))],
	);

	viewport.testConfiguration.updateOptions({ renderRichScreenReaderContent: true });
	support.onConfigurationChanged(configurationChange(EditorOption.renderRichScreenReaderContent));
	support.writeScreenReaderContent();
	const richContent = requiredElement<HTMLElement>(element, '.stanza-native-screen-reader-content');
	assert.notStrictEqual(richContent, content);
	assert.equal(content.isConnected, false);
	assert.equal(richContent.textContent, 'beta');
	assert.equal(richContent.querySelector('span[data-line-index="0"]')?.textContent, 'beta');
	await new Promise(resolve => setTimeout(resolve, 110));
	const richTextNode = firstTextNode(richContent);
	assert.ok(richTextNode);
	domSelection.setBaseAndExtent(richTextNode, 0, richTextNode, 2);
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(
		viewport.testViewModel.getSelections(),
		[Selection.fromPositions(new Position(1, 1), new Position(1, 3))],
	);

	viewport.testConfiguration.updateOptions({ renderRichScreenReaderContent: false });
	support.onConfigurationChanged(configurationChange(EditorOption.renderRichScreenReaderContent));
	support.writeScreenReaderContent();
	const nextSimpleContent = requiredElement<HTMLElement>(element, '.stanza-native-screen-reader-content');
	assert.notStrictEqual(nextSimpleContent, richContent);
	assert.equal(richContent.isConnected, false);
	assert.equal(nextSimpleContent.textContent, 'beta');
	assert.equal(nextSimpleContent.querySelector('span[data-line-index="0"]'), null);

	support.handleFocusChange(false);
	assert.equal(nextSimpleContent.textContent, '');
	assert.equal(nextSimpleContent.getAttribute('aria-hidden'), 'true');
	const outsideText = text(dom.window.document, 'outside');
	container.append(outsideText);
	domSelection.setBaseAndExtent(outsideText, 0, outsideText, 4);
	dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
	assert.deepEqual(
		viewport.testViewModel.getSelections(),
		[Selection.fromPositions(new Position(1, 1), new Position(1, 3))],
	);

	using unrelatedModel = new TextModel('unrelated');
	using unrelatedViewport = new TestView({
		container,
		model: unrelatedModel,
		lineHeight: 20,
	});
	const unrelatedContext = new ViewContext(
		unrelatedViewport.testConfiguration,
		darkColorTheme,
		unrelatedViewport.testViewModel,
	);
	assert.throws(() => new ScreenReaderSupport({
		domNode: new FastDomNode(element),
		context: unrelatedContext,
		viewport,
		viewController: unrelatedViewport.controller,
	}), /must share one text model/u);
	dom.window.close();
});

test('ViewUserInputEvents converts view targets once and CodeEditorWidget publishes the shared event', () => {
	const converter: ICoordinatesConverter = {
		convertViewPositionToModelPosition: position => new Position(position.lineNumber + 10, position.column + 20),
		convertViewRangeToModelRange: range => new Range(range.startLineNumber + 10, range.startColumn + 20, range.endLineNumber + 10, range.endColumn + 20),
		validateViewPosition: position => position,
		validateViewRange: range => range,
		convertModelPositionToViewPosition: position => position,
		convertModelRangeToViewRange: range => range,
		modelPositionIsVisible: () => true,
		getModelLineViewLineCount: () => 1,
		getViewLineNumberOfModelPosition: lineNumber => lineNumber,
	};
	const viewZone: IMouseTarget = {
		type: MouseTargetType.CONTENT_VIEW_ZONE,
		element: null,
		mouseColumn: 3,
		position: new Position(2, 3),
		range: new Range(2, 3, 2, 4),
		detail: {
			viewZoneId: 'zone',
			positionBefore: new Position(1, 2),
			positionAfter: new Position(3, 4),
			position: new Position(2, 3),
			afterLineNumber: 2,
		},
	};

	assert.deepEqual(ViewUserInputEvents.convertViewToModelMouseTarget(viewZone, converter), {
		...viewZone,
		position: new Position(12, 23),
		range: new Range(12, 23, 12, 24),
		detail: {
			viewZoneId: 'zone',
			positionBefore: new Position(11, 22),
			positionAfter: new Position(13, 24),
			position: new Position(12, 23),
			afterLineNumber: 12,
		},
	});

	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 40, width: 240, height: 40, toJSON: () => ({}) });
	let received: Parameters<Parameters<typeof editor.onMouseMove>[0]>[0] | undefined;
	let releasedKey: string | undefined;
	let dropped = false;
	let dropPosition: Position | undefined;
	using listener = editor.onMouseMove(event => received = event);
	using keyListener = editor.onKeyUp(event => releasedKey = event.key);
	using dropListener = editor.onMouseDrop(event => dropped = event.target !== null);
	using dropIntoEditorListener = editor.onDropIntoEditor(event => dropPosition = Position.lift(event.position));
	const browserEvent = new dom.window.MouseEvent('mousemove', {
		bubbles: true,
		clientX: editor.getLayoutInfo().contentLeft + 2,
		clientY: 10,
	});
	requiredElement<HTMLElement>(editor.getDomNode(), '.view-line .stanza-editor-line-text > span').dispatchEvent(browserEvent);
	editor.controller.textArea!.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
	editor.getDomNode().dispatchEvent(new dom.window.MouseEvent('drop', { bubbles: true, clientX: 80, clientY: 10 }) as unknown as DragEvent);

	assert.ok(received);
	assert.ok(received.event instanceof StandardMouseEvent);
	assert.strictEqual(received.event.browserEvent, browserEvent);
	assert.equal(received.target.type, MouseTargetType.CONTENT_TEXT);
	assert.equal(received.target.position?.lineNumber, 1);
	assert.equal(releasedKey, 'a');
	assert.equal(dropped, true);
	assert.deepEqual(dropPosition, new Position(1, 6));
	editor.dispose();
	dom.window.close();
});

test('ViewController owns mouse selection policy for pointer dispatch', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha beta\nsecond\nthird');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});
	editor.layout({ width: 240, height: 60 });
	editor.getDomNode().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 60, width: 240, height: 60, toJSON: () => ({}) });
	editor.getDomNode().dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 80, clientY: 25 }));
	dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 80, clientY: 25 }));
	assert.equal(editor.getPosition()?.lineNumber, 2);

	const dispatch = (position: Position, options: { count?: number; selecting?: boolean; altKey?: boolean; lineNumbers?: boolean } = {}) => editor.controller.dispatchMouse({
		position,
		mouseColumn: position.column,
		revealType: NavigationCommandRevealType.None,
		startedOnLineNumbers: options.lineNumbers ?? false,
		inSelectionMode: options.selecting ?? false,
		mouseDownCount: options.count ?? 1,
		altKey: options.altKey ?? false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		leftButton: true,
		middleButton: false,
		onInjectedText: false,
	});

	dispatch(new Position(1, 2));
	dispatch(new Position(2, 4), { selecting: true });
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 2), new Position(2, 4)));

	dispatch(new Position(1, 3), { count: 2 });
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(1, 1), new Position(1, 6)));

	dispatch(new Position(2, 2), { lineNumbers: true });
	assert.deepEqual(editor.getSelection(), Selection.fromPositions(new Position(2, 1), new Position(3, 1)));

	editor.setSelection(Selection.fromPositions(new Position(1, 1)));
	dispatch(new Position(3, 2), { altKey: true });
	assert.deepEqual(editor.getSelections(), [
		Selection.fromPositions(new Position(3, 2)),
		Selection.fromPositions(new Position(1, 1)),
	]);
	dom.window.close();
});

test('pointer selection uses outside-editor targets to scroll both axes and stops on release', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel(Array.from({ length: 40 }, (_, index) => `${index} ${'wide '.repeat(30)}`).join('\n'));
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
	});
	editor.layout({ width: 120, height: 60 });
	editor.getDomNode().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 60, width: 120, height: 60, toJSON: () => ({}) });
	let mouseUpEvents = 0;
	using mouseUpListener = editor.onMouseUp(() => { mouseUpEvents += 1; });

	editor.getDomNode().dispatchEvent(pointerEvent(dom, 'pointerdown', 17, 1, editor.getLayoutInfo().contentLeft + 8, 10));
	dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', 17, 1, editor.getLayoutInfo().contentLeft + 8, 120));
	await delay(dom.window, 45);
	assert.ok(editor.getScrollTop() > 0);
	assert.ok((editor.getSelection()?.endLineNumber ?? 1) > 1);

	dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', 17, 1, 260, 20));
	await delay(dom.window, 45);
	assert.ok(editor.getScrollLeft() > 0);
	dom.window.dispatchEvent(pointerEvent(dom, 'pointerup', 17, 0, 260, 20));
	editor.getDomNode().dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 260, clientY: 20 }));
	assert.equal(mouseUpEvents, 1);
	const releasedScroll = { left: editor.getScrollLeft(), top: editor.getScrollTop() };
	await delay(dom.window, 35);
	assert.deepEqual({ left: editor.getScrollLeft(), top: editor.getScrollTop() }, releasedScroll);
	editor.getDomNode().dispatchEvent(pointerEvent(dom, 'pointerdown', 18, 1, editor.getLayoutInfo().contentLeft + 8, 10));
	editor.getDomNode().dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: editor.getLayoutInfo().contentLeft + 8, clientY: 10 }));
	assert.equal(mouseUpEvents, 2);
	dom.window.close();
});

test("CodeEditorWidget creates one selection controller for its model", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("alpha");
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	assert.equal(editor.getModel(), model);
	dom.window.close();
});

test('CodeEditorWidget keyboard navigation uses standard cursor movement state', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('12345\n1\n12345');
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 5)));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const observed: string[] = [];
	using firstInputListener = editor.controller.userInputEvents.onKeyDown(() => observed.push('first'));
	using secondInputListener = editor.controller.userInputEvents.onKeyDown(() => observed.push('second'));

	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.deepEqual(editor.getPosition(), new Position(2, 2));
	firstInputListener.dispose();
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.deepEqual(editor.getPosition(), new Position(3, 5));
	assert.deepEqual(observed, ['first', 'second', 'second']);
	using keyDownListener = editor.onKeyDown(event => event.stop());
	const prevented = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowUp' });
	input.dispatchEvent(prevented);
	assert.equal(prevented.defaultPrevented, true);
	assert.deepEqual(editor.getPosition(), new Position(3, 5));

	dom.window.close();
});

test('CodeEditorWidget offers keys to input consumers before cursor navigation', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('first\nsecond');
	using editor = createTestCodeEditor({
		container,
		model,
		lineHeight: 20,
	});
	editor.setPosition(new Position(1, 3));
	const order: string[] = [];
	using inputConsumer = editor.controller.onWillKeydown(event => {
		order.push('consumer');
		if (event.key === 'ArrowDown') event.preventDefault();
	});
	using publicEvent = editor.onKeyDown(event => {
		order.push(event.browserEvent.defaultPrevented ? 'public:handled' : 'public:available');
	});
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const down = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' });
	input.dispatchEvent(down);

	assert.deepEqual({
		position: editor.getPosition(),
		prevented: down.defaultPrevented,
		order,
	}, {
		position: new Position(1, 3),
		prevented: true,
		order: ['consumer', 'public:handled'],
	});
	dom.window.close();
});

function firstTextNode(root: Node): Text | undefined {
	if (root.nodeType === 3) return root as Text;
	for (const child of Array.from(root.childNodes)) {
		const text = firstTextNode(child);
		if (text) return text;
	}
	return undefined;
}

class TestClipboardData {
	readonly files: readonly File[] = [];
	private readonly values = new Map<string, string>();

	get types(): string[] { return [...this.values.keys()]; }
	getData(type: string): string { return this.values.get(type) ?? '';
	}
	setData(type: string, value: string): void { this.values.set(type, value); }
}

function testClipboardEvent(targetWindow: typeof browserEnvironment.window, type: 'copy' | 'cut' | 'paste', clipboardData: TestClipboardData): ClipboardEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
	return event as unknown as ClipboardEvent;
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

for (const edit of ['type', 'paste', 'executeEdits'] as const) {
	test(`selection events retain the state before ${edit} and distinguish later navigation`, () => {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using model = new TextModel('ab');
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'), model,
		});
		const before = new Selection(1, 1, 1, 2);
		editor.setSelection(before);
		const oldVersion = model.version;
		const events: Parameters<Parameters<typeof editor.onDidChangeCursorSelection>[0]>[0][] = [];
		using listener = editor.onDidChangeCursorSelection(event => events.push(event));
		if (edit === 'executeEdits') {
			editor.executeEdits('test', [{ range: before, text: 'xy' }], [new Selection(1, 3, 1, 3)]);
		} else {
			editor.trigger('keyboard', edit, { text: 'xy' });
		}
		editor.setPosition(new Position(1, 1));
		assert.equal(model.getValue(), 'xyb');
		assert.deepEqual(events.map(event => ({
			old: event.oldSelections?.map(selection => selection.toString()),
			current: event.selection.toString(),
			oldVersion: event.oldModelVersionId,
			version: event.modelVersionId,
		})), [
			{ old: [before.toString()], current: new Selection(1, 3, 1, 3).toString(), oldVersion, version: oldVersion + 1 },
			{ old: [new Selection(1, 3, 1, 3).toString()], current: new Selection(1, 1, 1, 1).toString(), oldVersion: oldVersion + 1, version: oldVersion + 1 },
		]);
		dom.window.close();
	});
}

function configurationChange(...changed: EditorOption[]): ViewConfigurationChangedEvent {
	return { hasChanged: option => changed.includes(option) } as ViewConfigurationChangedEvent;
}

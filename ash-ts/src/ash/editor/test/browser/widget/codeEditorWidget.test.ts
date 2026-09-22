import { StandaloneCodeEditorService } from '../../../standalone/browser/standaloneCodeEditorService.js';
import { h, text } from '../../../../base/browser/dom.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { createTestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../common/services/languageFeaturesService.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { StandardKeyboardEvent, type IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Event as EditorEvent } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { ContentWidgetPositionPreference, MouseTargetType, type ICodeEditor, type IContentWidget, type IGlyphMarginWidget, type IMouseTarget } from '../../../browser/editorBrowser.js';
import { NavigationCommandRevealType } from '../../../browser/coreCommands.js';
import { ViewUserInputEvents } from '../../../browser/view/viewUserInputEvents.js';
import { type ICoordinatesConverter } from '../../../common/coordinatesConverter.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { TextModel } from "../../../common/model/textModel.js";
import { GlyphMarginLane } from '../../../common/model.js';
import { EditorLineWrapping, EditorOption, RenderLineNumbersType } from '../../../common/config/editorOptions.js';
import { ScrollType } from '../../../common/editorCommon.js';
import { type ViewConfigurationChangedEvent, VerticalRevealType } from '../../../common/viewEvents.js';
import { IContextKeyService, ContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { AccessibilitySupport, type IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { ViewContext } from '../../../common/viewModel/viewContext.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { type TextEditorContributionContext } from '../../../browser/editorExtensions.js';
import { IInstantiationService, ServiceConstructionDescriptor, createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../base/common/errors.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: TestResizeObserver,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { CodeEditorWidget } = await import("../../../browser/widget/codeEditor/codeEditorWidget.js");
const { createTestCodeEditor } = await import('../testCodeEditor.js');
const { NativeEditContext } = await import('../../../browser/controller/editContext/native/nativeEditContext.js');
const { NativeEditContextRegistry } = await import('../../../browser/controller/editContext/native/nativeEditContextRegistry.js');
const { ScreenReaderSupport } = await import('../../../browser/controller/editContext/native/screenReaderSupport.js');
const { TextAreaEditContext } = await import('../../../browser/controller/editContext/textArea/textAreaEditContext.js');
const { TextAreaEditContextRegistry } = await import('../../../browser/controller/editContext/textArea/textAreaEditContextRegistry.js');
const { TestView } = await import('../viewModel/testViewModel.js');
const { ViewPart } = await import('../../../browser/view/viewPart.js');
const { EditorContributionInstantiation } = await import('../../../browser/editorExtensions.js');
const { ServiceContainer } = await import("../../../../platform/instantiation/common/instantiation.js");
const { ILogService, NullLoggerService } = await import('../../../../platform/log/common/log.js');
const { PlaceholderTextContribution } = await import("../../../contrib/placeholderText/browser/placeholderTextContribution.js");
const { VersionedEditorWorkerClient } = await import('../../../browser/services/editorWorkerService.js');
const { EditorWorker } = await import('../../../common/services/editorWebWorker.js');
await import("../../../contrib/placeholderText/browser/placeholderText.contribution.js");
await import('../../../contrib/inPlaceReplace/browser/inPlaceReplace.js');

suiteTeardown(() => browserEnvironment.window.close());

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

test("CodeEditorWidget owns one canonical browser editing surface", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("alpha");
	const editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20, ariaLabel: "Code" });
	const ownerId = editor.getId();

	editor.layout({ width: 320, height: 80 });
	const fontTarget = h(dom.window.document, 'span');
	editor.applyFontInfo(fontTarget);

	assert.equal(editor.getDomNode().parentElement, container);
	assert.equal(editor.getDomNode().getAttribute("aria-label"), "Code");
	assert.equal(editor.controller.element.getAttribute("aria-label"), "Code");
	const margin = requiredElement<HTMLElement>(editor.getDomNode(), '.margin');
	assert.equal(margin.getAttribute('role'), 'presentation');
	assert.equal(margin.getAttribute('aria-hidden'), 'true');
	assert.equal(margin.firstElementChild?.className, 'glyph-margin');
	assert.ok(editor.controller.editContext instanceof ViewPart);
	assert.strictEqual(TextAreaEditContextRegistry.get(editor.getId()), editor.controller.editContext);
	assert.deepEqual(editor.view.viewportLayout.viewportSize, { width: 320, height: 80 });
	assert.equal(fontTarget.style.fontFamily, editor.getDomNode().style.fontFamily);
	assert.equal(fontTarget.style.fontFeatureSettings, editor.getDomNode().style.fontFeatureSettings);

	editor.dispose();
	assert.equal(TextAreaEditContextRegistry.get(ownerId), undefined);
	assert.equal(editor.getDomNode().isConnected, false);
	assert.equal(model.getText(), "alpha");
	assert.equal(editor.getModel(), null);
	assert.equal(editor.getSelections(), null);
	dom.window.close();
});

test('textarea system-caret movement returns through TextAreaInput and stops after blur', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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

test('CodeEditorWidget scopes and updates the standard editor context keys', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using services = new ServiceContainer();
	using rootContextKeys = new ContextKeyService();
	services.registerInstance(IContextKeyService, rootContextKeys);
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		instantiationService: services,
	});
	const scoped = editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
	assert.notStrictEqual(scoped, rootContextKeys);
	assert.equal(scoped.getValue('editorSimpleInput'), false);
	assert.equal(scoped.getValue('editorReadonly'), false);
	assert.equal(scoped.getValue('editorHasSelection'), false);
	assert.equal(scoped.getValue('editorLangId'), model.getLanguageId());

	editor.setSelection(new Selection(1, 1, 1, 3));
	assert.equal(scoped.getValue('editorHasSelection'), true);
	editor.updateOptions({ readOnly: true });
	assert.equal(scoped.getValue('editorReadonly'), true);
	dom.window.close();
});

test('CodeEditorWidget actions keep their editor context across read-only changes and model switches', async () => {
	await import('../../../contrib/linesOperations/browser/linesOperations.js');
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using first = new TextModel('first\nkeep');
	using second = new TextModel('second\nkeep');
	using replacement = new TextModel('replacement\nkeep');
	using services = new ServiceContainer();
	using rootContext = new ContextKeyService();
	services.registerInstance(IContextKeyService, rootContext);
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'), model: first,
		input: { resource: first.uri, readOnly: true }, languageId: first.getLanguageId(), instantiationService: services,
	});
	using other = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'aside'), model: second,
		input: { resource: second.uri }, languageId: second.getLanguageId(), instantiationService: services,
	});
	try {
		const action = editor.getAction('editor.action.deleteLines')!;
		const context = editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
		other.focus();
		assert.equal(editor.getAction('missing.action'), null);
		assert.equal(action.isSupported(), false);
		assert.equal(other.getAction(action.id)!.isSupported(), true);
		await action.run();
		assert.deepEqual([first.getValue(), second.getValue()], ['first\nkeep', 'second\nkeep']);
		editor.updateOptions({ readOnly: false });
		assert.equal(action.isSupported(), true);
		await action.run();
		assert.deepEqual([first.getValue(), second.getValue()], ['keep', 'second\nkeep']);
		editor.setModel(null);
		await action.run();
		assert.equal(context.getValue('editorLangId'), '');
		editor.setModel(replacement);
		assert.strictEqual(editor.invokeWithinContext(accessor => accessor.get(IContextKeyService)), context);
		await action.run();
		assert.deepEqual([first.getValue(), replacement.getValue(), second.getValue()], ['keep', 'keep', 'second\nkeep']);
		editor.dispose();
		await assert.rejects(action.run(), ReferenceError);
	} finally {
		dom.window.close();
	}
});

test('EditContext owns default copy, paste, and cut behavior without a clipboard contribution', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha beta');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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

test('editor configuration updates rerender line-number, selection, whitespace, and indent overlays', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\n    two\n\tthree');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		lineNumbers: 'relative',
		renderWhitespace: 'selection',
		guides: { indentation: true },
		minimap: { enabled: false },
	});
	editor.layout({ width: 280, height: 60 });

	const lineNumber = (lineIndex: number): string => requiredElement<HTMLElement>(
		editor.getDomNode(),
		`.margin-view-overlays .view-overlay-line[data-line-index="${lineIndex}"] .line-numbers`,
	).textContent ?? '';
	assert.equal(lineNumber(0), '1');
	editor.setPosition(new Position(3, 1));
	assert.equal(lineNumber(0), '2');
	assert.equal(lineNumber(2), '3');

	editor.setSelection(new Selection(2, 1, 2, 5));
	assert.equal(editor.getDomNode().querySelectorAll('.stanza-editor-selection').length, 1);
	assert.equal(editor.getDomNode().querySelectorAll('.stanza-editor-whitespace').length, 4);
	assert.equal(editor.getDomNode().querySelectorAll('.view-overlay-line[data-line-index="1"] .stanza-editor-indent-guide').length, 1);
	assert.equal(editor.getDomNode().querySelectorAll('.view-overlay-line[data-line-index="2"] .stanza-editor-indent-guide').length, 1);

	let configurationChanges = 0;
	using configurationListener = editor.onDidChangeConfiguration(() => configurationChanges += 1);
	editor.updateOptions({
		lineNumbers: 'off',
		renderWhitespace: 'all',
		guides: { indentation: false },
	});
	assert.equal(configurationChanges, 1);
	assert.equal(editor.getOption(EditorOption.lineNumbers).renderType, RenderLineNumbersType.Off);
	assert.equal(editor.getOptions().get(EditorOption.renderWhitespace), 'all');
	assert.equal(editor.getRawOptions().lineNumbers, 'off');
	assert.equal(editor.getDomNode().classList.contains('hide-line-numbers'), true);
	assert.equal(requiredElement<HTMLElement>(editor.getDomNode(), '.margin').style.getPropertyValue('--stanza-editor-line-numbers-width'), '0px');
	assert.deepEqual([0, 1, 2].map(lineNumber), ['', '', '']);
	assert.equal(editor.getDomNode().querySelectorAll('.stanza-editor-whitespace').length, 5);
	assert.equal(editor.getDomNode().querySelectorAll('.stanza-editor-indent-guide').length, 0);
	dom.window.close();
});

test('indent guides use model indentation units and include blank lines in the active block', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	using model = new TextModel('root\n\tchild\n\n    sibling\nroot');
	model.updateOptions({ tabSize: 4, indentSize: 2 });
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		guides: { indentation: true, bracketPairs: false, highlightActiveIndentation: true },
		minimap: { enabled: false },
	});
	editor.layout({ width: 300, height: 140 });
	editor.setPosition(new Position(3, 1));
	const guides = (line: number) => [...editor.getDomNode().querySelectorAll<HTMLElement>(`.view-overlay-line[data-line-index="${line}"] .stanza-editor-indent-guide`)];
	assert.deepEqual([0, 1, 2, 3, 4].map(line => guides(line).length), [0, 2, 2, 2, 0]);
	assert.deepEqual(guides(2).map(guide => guide.classList.contains('active')), [false, true]);
	assert.deepEqual(guides(1).map(guide => guide.style.left), guides(2).map(guide => guide.style.left));
	assert.deepEqual(guides(3).map(guide => guide.style.left), guides(2).map(guide => guide.style.left));
	model.updateOptions({ indentSize: 4 });
	assert.deepEqual([1, 2, 3].map(line => guides(line).length), [1, 1, 1]);
	assert.equal(guides(2)[0]?.classList.contains('active'), true);
	editor.updateOptions({ guides: { highlightActiveIndentation: false } });
	assert.equal(editor.getDomNode().querySelectorAll('.stanza-editor-indent-guide.active').length, 0);
	model.setValue('root\nplain\n\nplain\nroot');
	assert.equal(editor.getDomNode().querySelectorAll('.stanza-editor-indent-guide').length, 0);
});

test('setSelection accepts ranges, preserves selection direction, and reports its source', () => {
	using model = new TextModel('alpha\nbeta');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId() });
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
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId() });
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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

for (const edit of ['type', 'paste', 'executeEdits'] as const) {
	test(`selection events retain the state before ${edit} and distinguish later navigation`, () => {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using model = new TextModel('ab');
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'), model,
			input: { resource: model.uri }, languageId: model.getLanguageId(),
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

test('editor focus updates the view overlay presentation', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha '.repeat(20));
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
	using support = new ScreenReaderSupport({
		domNode: new FastDomNode(element),
		context,
		viewport,
		viewController: viewport.controller,
		accessibilityService: enabledAccessibilityService,
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
		accessibilityService: enabledAccessibilityService,
	}), /must share one text model/u);
	dom.window.close();
});

function configurationChange(...changed: EditorOption[]): ViewConfigurationChangedEvent {
	return { hasChanged: option => changed.includes(option) } as ViewConfigurationChangedEvent;
}

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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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

test('CodeEditorWidget publishes service lifecycle in construction order', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using service = new StandaloneCodeEditorService();
	const events: string[] = [];
	using willCreate = service.onWillCreateCodeEditor(() => events.push('will'));
	using add = service.onCodeEditorAdd(editor => events.push(`add:${editor.getId()}`));
	using remove = service.onCodeEditorRemove(editor => events.push(`remove:${editor.getId()}`));
	const editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		codeEditorService: service,
	});

	assert.deepEqual(events, ['will', `add:${editor.getId()}`]);
	assert.strictEqual(service.getActiveCodeEditor(), editor);
	editor.dispose();
	assert.deepEqual(events, ['will', `add:${editor.getId()}`, `remove:${editor.getId()}`]);
	assert.equal(service.getActiveCodeEditor(), null);
	dom.window.close();
});

test('CodeEditorWidget switches models without replacing its identity or retaining the old view', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first');
	using second = new TextModel('second');
	const contributionEvents: string[] = [];
	class TrackingContribution extends Disposable {
		constructor(editor: ICodeEditor) {
			super();
			const resource = editor.getModel()?.uri.toString();
			contributionEvents.push(`create:${resource}`);
			this._register(toDisposable(() => contributionEvents.push(`dispose:${resource}`)));
		}
	}
	const editor = createTestCodeEditor({
		container,
		model: first,
		input: { resource: first.uri },
		languageId: first.getLanguageId(),
		lineHeight: 20,
		contributions: [{ id: 'test.modelSwitch', ctor: TrackingContribution, instantiation: EditorContributionInstantiation.Eager }],
	});
	try {
		const root = editor.getDomNode();
		const oldInput = root.querySelector('.stanza-editor-input');
		const widgetDomNode = h(dom.window.document, 'button');
		const widget: IContentWidget = {
			getId: () => 'test.modelSwitchWidget',
			getDomNode: () => widgetDomNode,
			getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
		};
		editor.addContentWidget(widget);
		assert.equal(root.contains(widgetDomNode), true);
		const decorations = editor.createDecorationsCollection([{ range: new Range(1, 1, 1, 2), options: { description: 'first model' } }]);
		assert.equal(decorations.length, 1);
		const modelEvents: string[] = [];
		const focusedAtChange: boolean[] = [];
		using willChange = editor.onWillChangeModel(event => modelEvents.push(`will:${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`));
		using didChange = editor.onDidChangeModel(event => {
			modelEvents.push(`did:${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`);
			focusedAtChange.push(editor.hasTextFocus());
		});
		let contentChanges = 0;
		using contentListener = editor.onDidChangeModelContent(() => { contentChanges += 1; });
		editor.setModel(first);
		assert.deepEqual(modelEvents, []);
		editor.focus();
		editor.setModel(second);
		assert.strictEqual(editor.getDomNode(), root);
		assert.strictEqual(editor.getModel(), second);
		assert.equal(editor.hasTextFocus(), true);
		assert.notStrictEqual(root.querySelector('.stanza-editor-input'), oldInput);
		assert.equal(root.contains(widgetDomNode), true);
		assert.equal(first.isDisposed(), false);
		assert.equal(first.getAllDecorations().length, 0);
		assert.equal(decorations.length, 0);
		decorations.set([{ range: new Range(1, 1, 1, 2), options: { description: 'second model' } }]);
		assert.equal(second.getAllDecorations().length, 1);
		first.setValue('old edit');
		assert.equal(contentChanges, 0);
		second.setValue('new edit');
		assert.equal(contentChanges, 1);

		editor.setModel(null);
		assert.deepEqual({ model: editor.getModel(), hasModel: editor.hasModel(), value: editor.getValue(), mounted: container.contains(root), input: root.querySelector('.stanza-editor-input') }, {
			model: null,
			hasModel: false,
			value: '',
			mounted: true,
			input: null,
		});
		assert.equal(widgetDomNode.isConnected, false);
		assert.equal(decorations.length, 0);
		editor.setModel(first);
		assert.strictEqual(editor.getDomNode(), root);
		assert.strictEqual(editor.getModel(), first);
		assert.equal(root.contains(widgetDomNode), true);
		decorations.set([{ range: new Range(1, 2, 1, 3), options: { description: 'reattached' } }]);
		assert.deepEqual(decorations.getRanges(), [new Range(1, 2, 1, 3)]);
		assert.deepEqual(contributionEvents, [
			`create:${first.uri}`, `dispose:${first.uri}`,
			`create:${second.uri}`, `dispose:${second.uri}`,
			`create:${first.uri}`,
		]);
		assert.deepEqual(modelEvents, [
			`will:${first.uri}->${second.uri}`, `did:${first.uri}->${second.uri}`,
			`will:${second.uri}->undefined`, `did:${second.uri}->undefined`,
			`will:undefined->${first.uri}`, `did:undefined->${first.uri}`,
		]);
		assert.deepEqual(focusedAtChange, [true, false, false]);
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('CodeEditorWidget detaches a disposed model and can attach a later model', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	const first = new TextModel('first');
	using second = new TextModel('second');
	const editor = createTestCodeEditor({ container, model: first, input: { resource: first.uri }, languageId: first.getLanguageId(), lineHeight: 20 });
	try {
		const root = editor.getDomNode();
		first.dispose();
		assert.deepEqual({ model: editor.getModel(), input: root.querySelector('.stanza-editor-input'), mounted: container.contains(root) }, { model: null, input: null, mounted: true });
		editor.setModel(second);
		assert.strictEqual(editor.getModel(), second);
		assert.strictEqual(editor.getDomNode(), root);
		assert.equal(root.querySelectorAll('.stanza-editor-input').length, 1);
		assert.throws(() => editor.setModel(first), /live TextModel/);
		assert.strictEqual(editor.getModel(), second);
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('CodeEditorWidget leaves a usable empty editor when replacement setup fails', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first');
	using failed = new TextModel('failed');
	const editor = createTestCodeEditor({
		container,
		model: first,
		input: { resource: first.uri },
		languageId: first.getLanguageId(),
		lineHeight: 20,
		editorWorkerFactory: model => {
			if (model === failed) throw new Error('worker unavailable');
			return new VersionedEditorWorkerClient(model, () => new EditorWorker());
		},
	});
	try {
		const root = editor.getDomNode();
		const changes: string[] = [];
		using listener = editor.onDidChangeModel(event => changes.push(`${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`));
		assert.throws(() => editor.setModel(failed), /worker unavailable/);
		assert.deepEqual({ model: editor.getModel(), input: root.querySelector('.stanza-editor-input'), mounted: container.contains(root) }, { model: null, input: null, mounted: true });
		assert.deepEqual(changes, [`${first.uri}->undefined`]);
		editor.setModel(first);
		assert.strictEqual(editor.getModel(), first);
		assert.equal(root.querySelectorAll('.stanza-editor-input').length, 1);
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('CodeEditorWidget stops a model switch when a will-change listener disposes it', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first');
	using second = new TextModel('second');
	const editor = createTestCodeEditor({ container, model: first, input: { resource: first.uri }, languageId: first.getLanguageId(), lineHeight: 20 });
	const root = editor.getDomNode();
	using listener = editor.onWillChangeModel(() => editor.dispose());
	assert.doesNotThrow(() => editor.setModel(second));
	assert.deepEqual({ disposed: editor.isDisposed, rootMounted: container.contains(root), firstDisposed: first.isDisposed(), secondDisposed: second.isDisposed() }, {
		disposed: true,
		rootMounted: false,
		firstDisposed: false,
		secondDisposed: false,
	});
	dom.window.close();
});

test('CodeEditorWidget clears its model state when contribution disposal fails during a switch', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first');
	using second = new TextModel('second');
	class FailingContribution extends Disposable {
		protected override disposeCore(): void {
			super.disposeCore();
			throw new Error('contribution cleanup failed');
		}
	}
	const editor = createTestCodeEditor({
		container,
		model: first,
		input: { resource: first.uri },
		languageId: first.getLanguageId(),
		lineHeight: 20,
		contributions: [{ id: 'test.failOnDispose', ctor: FailingContribution, instantiation: EditorContributionInstantiation.Eager }],
	});
	try {
		const root = editor.getDomNode();
		const events: string[] = [];
		using listener = editor.onDidChangeModel(event => events.push(`${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`));
		assert.throws(() => editor.setModel(second));
		assert.deepEqual({ model: editor.getModel(), mounted: container.contains(root), input: root.querySelector('.stanza-editor-input'), events }, {
			model: null,
			mounted: true,
			input: null,
			events: [`${first.uri}->undefined`],
		});
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('CodeEditorWidget exposes editor-owned scroll geometry', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\ntwo\nthree\nfour\nfive');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 240, height: 40 });
	editor.setScrollTop(40);

	assert.equal(editor.getScrollTop(), 40);
	assert.equal(editor.getContentHeight(), 100);
	assert.equal(editor.hasPendingScrollAnimation(), false);
	assert.equal(editor.getTopForLineNumber(3), 40);
	assert.equal(editor.getTopForPosition(3, 2), 40);
	assert.equal(editor.getBottomForLineNumber(3), 60);
	assert.deepEqual(editor.getVisibleRanges(), [new Range(3, 1, 4, 5)]);
	dom.window.close();
});

test('CodeEditorWidget isolates model decorations by editor lifetime', () => {
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const first = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	const second = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'aside'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	let firstId = '';
	let secondId = '';
	first.changeDecorations(accessor => {
		firstId = accessor.addDecoration(new Range(1, 1, 1, 3), { description: 'first editor' });
	});
	second.changeDecorations(accessor => {
		secondId = accessor.addDecoration(new Range(1, 3, 1, 5), { description: 'second editor' });
	});

	assert.deepEqual(model.getAllDecorations().map(decoration => decoration.id), [firstId, secondId]);
	first.dispose();
	assert.equal(model.getDecorationRange(firstId), null);
	assert.deepEqual(model.getDecorationRange(secondId), new Range(1, 3, 1, 5));
	second.removeDecorations([secondId]);
	assert.equal(model.getAllDecorations().length, 0);
	second.dispose();
	dom.window.close();
});

test('CodeEditorWidget owns decoration collections and reveals without moving selection', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\ntwo\nthree\nfour');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 240, height: 40 });
	const selection = Selection.fromPositions(new Position(1, 2));
	editor.setSelection(selection);
	const decorations = editor.createDecorationsCollection([{ range: new Range(2, 1, 2, 4), options: { description: 'owned collection' } }]);

	editor.revealRange(new Range(4, 1, 4, 5));

	assert.deepEqual(editor.getSelection(), selection);
	assert.deepEqual(decorations.getRange(0), new Range(2, 1, 2, 4));
	decorations.clear();
	assert.equal(model.getAllDecorations().length, 0);
	dom.window.close();
});

test('CodeEditorWidget owns content and glyph margin widget layout through the standard APIs', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\ntwo\nthree');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		glyphMargin: true,
	});
	editor.layout({ width: 240, height: 60 });

	const contentNode = h(dom.window.document, 'div');
	const contentWidget: IContentWidget = {
		suppressMouseDown: true,
		getId: () => 'test.content.widget',
		getDomNode: () => contentNode,
		getPosition: () => ({ position: new Position(2, 2), preference: [ContentWidgetPositionPreference.EXACT] }),
	};
	editor.addContentWidget(contentWidget);
	assert.equal(contentNode.getAttribute('widgetId'), 'test.content.widget');
	assert.equal(contentNode.style.display, 'block');
	const pointerDown = new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
	contentNode.dispatchEvent(pointerDown);
	assert.equal(pointerDown.defaultPrevented, true);

	const glyphNode = h(dom.window.document, 'button');
	let glyphPosition = { lane: GlyphMarginLane.Center, zIndex: 1, range: new Range(1, 1, 1, 1) };
	const glyphWidget: IGlyphMarginWidget = {
		getId: () => 'test.glyph.widget',
		getDomNode: () => glyphNode,
		getPosition: () => glyphPosition,
	};
	editor.addGlyphMarginWidget(glyphWidget);
	assert.equal(glyphNode.getAttribute('widgetId'), 'test.glyph.widget');
	assert.equal(glyphNode.style.display, 'block');
	assert.equal(glyphNode.style.top, '0px');

	glyphPosition = { lane: GlyphMarginLane.Center, zIndex: 2, range: new Range(2, 1, 2, 1) };
	editor.layoutGlyphMarginWidget(glyphWidget);
	assert.equal(glyphNode.style.top, '20px');
	editor.removeGlyphMarginWidget(glyphWidget);
	assert.equal(glyphNode.isConnected, false);
	editor.removeContentWidget(contentWidget);
	assert.equal(contentNode.isConnected, false);
	dom.window.close();
});

test('CodeEditorWidget reveals ranges through the ViewModel event contract', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 240, height: 40 });
	const target = new Range(10, 1, 10, 1);

	editor.revealRange(target, ScrollType.Immediate);
	assert.ok(editor.getScrollTop() > 0);
	assert.ok(editor.getTopForLineNumber(10) >= editor.getScrollTop());
	assert.ok(editor.getBottomForLineNumber(10) <= editor.getScrollTop() + 40);

	editor.setScrollTop(0, ScrollType.Immediate);
	editor._getViewModel()!.revealRange('test', false, target, VerticalRevealType.Center, ScrollType.Immediate);
	assert.equal(editor.getScrollTop(), 170);
	dom.window.close();
});

test('CodeEditorWidget runs in-place replacement through the registered contribution', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('value 1');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 7), new Position(1, 8)));

	const next = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '.', ctrlKey: true, shiftKey: true }) as unknown as KeyboardEvent;
	editor.controller.element.dispatchEvent(next);
	assert.equal(next.defaultPrevented, true);
	await waitForText(model, 'value 2');

	const previous = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ',', ctrlKey: true, shiftKey: true }) as unknown as KeyboardEvent;
	editor.controller.element.dispatchEvent(previous);
	assert.equal(previous.defaultPrevented, true);
	await waitForText(model, 'value 1');
	dom.window.close();
});

test("CodeEditorWidget owns padding, placeholder, and current-line presentation for embedded editors", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel();
	using editor = createTestCodeEditor({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		placeholder: "Ask Ash",
		presentation: "embedded",
		padding: { top: 20, bottom: 20 },
	});

	editor.layout({ width: 320, height: 40 });

	assert.equal(editor.getDomNode().querySelector(".view-line.active"), null);
	assert.ok(editor.getDomNode().querySelector(".stanza-editor-caret"));
	assert.equal(requiredElement<HTMLElement>(editor.getDomNode(), ".view-lines").style.top, "0px");
	assert.equal(requiredElement<HTMLElement>(editor.getDomNode(), ".view-lines").style.transform, "");
	assert.equal(requiredElement<HTMLElement>(editor.getDomNode(), ".view-line").style.top, "20px");
	assert.equal(editor.getDomNode().style.getPropertyValue("--stanza-editor-padding-left"), "12px");
	assert.equal(editor.getDomNode().style.getPropertyValue("--stanza-editor-padding-right"), "12px");
	assert.equal(requiredElement<HTMLElement>(editor.getDomNode(), ".stanza-editor-placeholder-text").style.top, "20px");
	assert.equal(editor.view.viewportLayout.contentSize.height, 60);
	dom.window.close();
});

test('ViewCursors follows view positions, configuration, focus, composition, and multicursor state', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const model = new TextModel('alpha beta gamma delta epsilon');
	const editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		lineWrapping: EditorLineWrapping.On,
		cursorBlinking: 'blink',
		cursorStyle: 'line',
		overtypeCursorStyle: 'block',
	});
	editor.layout({ width: 90, height: 100 });
	const targetPosition = editor._getViewModel()!.coordinatesConverter.convertViewPositionToModelPosition(new Position(3, 1));
	editor.setPosition(targetPosition);

	const layer = requiredElement<HTMLElement>(editor.getDomNode(), '.cursors-layer');
	const primary = requiredElement<HTMLElement>(layer, '.cursor');
	assert.equal(layer.getAttribute('role'), 'presentation');
	assert.equal(layer.getAttribute('aria-hidden'), 'true');
	const viewPosition = editor._getViewModel()!.coordinatesConverter.convertModelPositionToViewPosition(targetPosition);
	assert.equal(viewPosition.lineNumber, 3);
	assert.equal(primary.style.top, `${(viewPosition.lineNumber - 1) * 20}px`);
	assert.equal(primary.style.visibility, 'hidden');

	editor.focus();
	assert.equal(primary.style.visibility, 'inherit');
	editor.setSelections([new Selection(1, 1, 1, 2), new Selection(1, 3, 1, 3)]);
	assert.equal(layer.classList.contains('has-selection'), true);
	assert.equal(layer.querySelectorAll('.cursor').length, 2);
	assert.ok(layer.querySelector('.cursor-primary'));
	assert.ok(layer.querySelector('.cursor-secondary'));

	editor.controller.textArea!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Insert' }));
	assert.equal(editor.getDomNode().classList.contains('overtype'), true);
	assert.equal(layer.classList.contains('cursor-block-style'), true);

	editor._getViewModel()!.onCompositionStart();
	assert.equal(primary.style.visibility, 'hidden');
	editor._getViewModel()!.onCompositionEnd();
	assert.equal(primary.style.visibility, 'inherit');
	editor.controller.textArea!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Insert' }));
	assert.equal(editor.getDomNode().classList.contains('overtype'), false);
	assert.equal(layer.classList.contains('cursor-line-style'), true);

	editor.dispose();
	assert.equal(layer.isConnected, false);
	model.dispose();
	dom.window.close();
});

test("PlaceholderTextContribution follows model emptiness and editor layout", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel();
	using editor = createTestCodeEditor({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		placeholder: "Ask Ash",
		padding: { top: 8, bottom: 8 },
	});

	editor.layout({ width: 320, height: 80 });
	const placeholder = requiredElement<HTMLElement>(editor.getDomNode(), ".stanza-editor-placeholder-text");
	const layout = editor.getLayoutInfo();
	assert.strictEqual(PlaceholderTextContribution.get(editor), editor.getContribution(PlaceholderTextContribution.ID));
	assert.deepEqual({
		display: placeholder.style.display,
		left: placeholder.style.left,
		top: placeholder.style.top,
		width: placeholder.style.width,
		lineHeight: placeholder.style.lineHeight,
	}, {
		display: "block",
		left: `${layout.contentLeft}px`,
		top: "8px",
		width: `${layout.contentWidth - layout.verticalScrollbarWidth}px`,
		lineHeight: "20px",
	});

	model.reset("alpha");
	assert.equal(placeholder.style.display, "none");
	model.reset("");
	assert.equal(placeholder.style.display, "block");
	dom.window.close();
});

test("CodeEditorWidget stages and owns per-instance contributions", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("alpha");
	const events: string[] = [];
	let restoredState: unknown;
	class EagerContribution extends Disposable {
		constructor(editor: ICodeEditor) {
			super();
			assert.strictEqual(editor.getModel(), model);
			events.push('eager:create');
			this._register(toDisposable(() => events.push('eager:dispose')));
		}
		saveViewState(): unknown { return { marker: 'saved' }; }
		restoreViewState(state: unknown): void { restoredState = state; }
	}
	class LazyContribution extends Disposable {
		constructor(editor: ICodeEditor) {
			super();
			assert.strictEqual(editor.getModel(), model);
			events.push('lazy:create');
			this._register(toDisposable(() => events.push('lazy:dispose')));
		}
	}
	using editor = createTestCodeEditor({
		container,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		contributions: [
			{
				id: "test.eager",
				instantiation: EditorContributionInstantiation.Eager,
				ctor: EagerContribution,
			},
			{
				id: "test.lazy",
				instantiation: EditorContributionInstantiation.Lazy,
				ctor: LazyContribution,
			},
		],
	});

	assert.deepEqual(events, ["eager:create"]);
	const saved = editor.saveViewState();
	assert.ok(saved);
	assert.deepEqual(saved.contributionsState, { 'test.eager': { marker: 'saved' } });
	editor.restoreViewState({ ...saved, contributionsState: { 'test.eager': { marker: 'restored' } } });
	assert.deepEqual(restoredState, { marker: 'restored' });
	assert.ok(editor.getContribution("test.lazy"));
	assert.deepEqual(events, ["eager:create", "lazy:create"]);
	editor.dispose();
	assert.deepEqual(events, ["eager:create", "lazy:create", "lazy:dispose", "eager:dispose"]);
	dom.window.close();
});

test('CodeEditorWidget owns configured resources and deferred controllers across model switches', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	const modelService = createServiceIdentifier<TextModel>('test.editor.model');
	class Controller extends Disposable {
		constructor(context: TextEditorContributionContext, services: IInstantiationService, providedModel: TextModel) {
			super();
			assert.equal(services, context.instantiationService);
			assert.equal(providedModel, model);
			assert.equal(context.editor.getModel(), model);
			assert.equal(context.view.domNode.domNode.isConnected, true);
			events.push('create');
			this._register(toDisposable(() => events.push('dispose controller')));
		}
	}
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model, input: { resource: model.uri }, languageId: model.getLanguageId(),
			contributions: [{
				id: 'test.deferred',
				instantiation: EditorContributionInstantiation.Lazy,
				configure: context => {
					events.push('configure');
					context.provideService(modelService, context.model);
					context.register(toDisposable(() => events.push('dispose configuration')));
				},
				install: context => {
					if (context.kind !== 'text') return;
					events.push('install');
					context.register(toDisposable(() => events.push('dispose installation')));
					return context.instantiationService.createInstance(new ServiceConstructionDescriptor(Controller, { serviceDependencies: [IInstantiationService, modelService] }), context);
				},
			}],
		});
		assert.deepEqual(events, ['configure']);
		editor.setModel(null);
		assert.deepEqual(events, ['configure', 'dispose configuration']);
		editor.setModel(model);
		const controller = editor.getContribution('test.deferred');
		assert.ok(controller instanceof Controller);
		assert.equal(editor.getContribution('test.deferred'), controller);
		assert.deepEqual(events.slice(2), ['configure', 'install', 'create']);
		editor.setModel(null);
		assert.deepEqual(events.slice(5), ['dispose controller', 'dispose installation', 'dispose configuration']);
	} finally {
		dom.window.close();
	}
});

test('CodeEditorWidget keeps model sources alive after installation fails', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	const failure = new Error('installation failed');
	const errors: unknown[] = [];
	let sourceDisposed = false;
	let sourceReads = 0;
	let view: TextEditorContributionContext['view'] | undefined;
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model, input: { resource: model.uri }, languageId: model.getLanguageId(),
			onContributionError: error => errors.push(error),
			guides: { bracketPairs: true },
			dimension: { width: 400, height: 100 },
			contributions: [{
				id: 'test.failedHook',
				configure: context => {
					context.register(toDisposable(() => { sourceDisposed = true; events.push('configuration'); }));
					context.setBracketGuideSource({
						textModel: context.model,
						getBracketGuides: () => {
							assert.equal(sourceDisposed, false, 'the live View must retain its model source');
							sourceReads += 1;
							return [];
						},
					});
				},
				install: context => {
					if (context.kind !== 'text') return;
					view = context.view;
					context.register(toDisposable(() => events.push('installation')));
					throw failure;
				},
			}],
		});
		assert.equal(editor.getContribution('test.failedHook'), null);
		assert.deepEqual(errors, [failure]);
		assert.deepEqual(events, ['installation']);
		sourceReads = 0;
		editor.layout({ width: 400, height: 100 });
		model.reset('beta');
		assert.ok(view);
		view.render(true, true);
		assert.ok(sourceReads > 0);
		editor.setModel(null);
		assert.deepEqual(events, ['installation', 'configuration']);
	} finally {
		dom.window.close();
	}
});

test('CodeEditorWidget injects scoped services into contributions and releases them on model detach', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using parent = new ServiceContainer();
	using model = new TextModel('alpha');
	const instances: Contribution[] = [];
	class Contribution extends Disposable {
		constructor(readonly editor: ICodeEditor, @IInstantiationService readonly services: IInstantiationService) {
			super();
			instances.push(this);
		}
	}
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20,
			instantiationService: parent,
			contributions: [{ id: 'test.injected', ctor: Contribution, instantiation: EditorContributionInstantiation.Eager }],
		});
		assert.equal(instances.length, 1);
		assert.equal(instances[0].editor, editor);
		assert.notEqual(instances[0].services, parent);
		assert.equal(instances[0].services, editor.invokeWithinContext(accessor => accessor.get(IInstantiationService)));
		editor.setModel(null);
		assert.equal(instances[0].isDisposed, true);
		assert.throws(() => instances[0].services.get(IInstantiationService), /disposed/i);
		editor.setModel(model);
		assert.equal(instances.length, 2);
		assert.equal(instances[1].isDisposed, false);
		assert.notEqual(instances[1].services, instances[0].services);
		assert.equal(instances[1].services, editor.invokeWithinContext(accessor => accessor.get(IInstantiationService)));
	} finally {
		dom.window.close();
	}
	assert.equal(instances[1].isDisposed, true);
	assert.equal(parent.isDisposed, false);
});

test("CodeEditorWidget creates one selection controller for its model", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("alpha");
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	assert.equal(editor.getModel(), model);
	dom.window.close();
});

test('CodeEditorWidget keyboard navigation uses standard cursor movement state', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('12345\n1\n12345');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.setSelection(Selection.fromPositions(new Position(1, 5)));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();

	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.deepEqual(editor.getPosition(), new Position(2, 2));
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.deepEqual(editor.getPosition(), new Position(3, 5));
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
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
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

test("CodeEditorWidget leaves text drops available to its host", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("alpha");
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	const drop = textDropEvent(dom.window, "dropped");

	editor.getDomNode().dispatchEvent(drop);

	assert.equal(drop.defaultPrevented, false);
	assert.equal(model.getText(), "alpha");
	dom.window.close();
});

test('DropIntoEditorController inserts text through the canonical editor drop event', async () => {
	await import('../../../contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 40, width: 240, height: 40, toJSON: () => ({}) });
	const drop = textDropEvent(dom.window, ' dropped', 80, 10);

	editor.getDomNode().dispatchEvent(drop);

	assert.equal(drop.defaultPrevented, true);
	assert.equal(model.getText(), 'alpha dropped');
	assert.deepEqual(editor.getPosition(), new Position(1, 14));
	dom.window.close();
});

test('DropIntoEditorController leaves read-only and non-text drops to the host', async () => {
	await import('../../../contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using readOnlyModel = new TextModel('alpha');
	using readOnlyEditor = createTestCodeEditor({
		container,
		model: readOnlyModel,
		input: { resource: readOnlyModel.uri, readOnly: true },
		languageId: readOnlyModel.getLanguageId(),
		lineHeight: 20,
	});
	readOnlyEditor.layout({ width: 240, height: 40 });
	readOnlyEditor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const textDrop = textDropEvent(dom.window, 'dropped', 80, 10);
	readOnlyEditor.getDomNode().dispatchEvent(textDrop);
	assert.equal(textDrop.defaultPrevented, false);
	assert.equal(readOnlyModel.getText(), 'alpha');

	using model = new TextModel('beta');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const binaryDrop = transferDropEvent(dom.window, {
		types: ['Files'],
		files: [{ name: 'image.png', type: 'image/png', size: 16, text: async () => 'binary' } as File],
		getData: () => '',
	});
	editor.getDomNode().dispatchEvent(binaryDrop);
	assert.equal(binaryDrop.defaultPrevented, false);
	assert.equal(model.getText(), 'beta');
	dom.window.close();
});

test('DropIntoEditorController converts an HTML-only drop to inert text', async () => {
	await import('../../../contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const drop = transferDropEvent(dom.window, {
		types: ['text/html'],
		files: [],
		getData: type => type === 'text/html' ? '<div>first</div><script>ignored()</script><div>second<br>third</div>' : '',
	});

	editor.getDomNode().dispatchEvent(drop);

	assert.equal(drop.defaultPrevented, true);
	assert.equal(model.getText(), 'alphafirst\nsecond\nthird');
	dom.window.close();
});

test('DropIntoEditorController inserts one decoded text file at the captured position', async () => {
	await import('../../../contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const file = new DeferredTextFile('snippet.rs');
	const drop = transferDropEvent(dom.window, { types: ['Files'], files: [file as unknown as File], getData: () => '' });

	editor.getDomNode().dispatchEvent(drop);
	file.resolve(' file');
	await waitForText(model, 'alpha file');

	assert.equal(drop.defaultPrevented, true);
	dom.window.close();
});

for (const change of ['readonly', 'writableAgain', 'model', 'content', 'dispose'] as const) {
	test(`A pending file drop is cancelled after ${change}`, async () => {
		await import('../../../contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js');
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		using cleanup = { [Symbol.dispose]: () => dom.window.close() };
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using model = new TextModel('alpha');
		using other = new TextModel('other');
		using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, input: { resource: model.uri }, languageId: model.getLanguageId() });
		editor.layout({ width: 240, height: 40 });
		editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
		const file = new DeferredTextFile('snippet.rs');
		editor.getDomNode().dispatchEvent(transferDropEvent(dom.window, { types: ['Files'], files: [file as unknown as File], getData: () => '' }));
		if (change === 'readonly' || change === 'writableAgain') editor.updateOptions({ readOnly: true });
		if (change === 'writableAgain') editor.updateOptions({ readOnly: false });
		if (change === 'model') editor.setModel(other);
		if (change === 'content') model.setValue('changed');
		if (change === 'dispose') editor.dispose();
		const selection = change === 'dispose' ? null : editor.getSelection();
		file.resolve(' stale');
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(model.getText(), change === 'content' ? 'changed' : 'alpha');
		assert.equal(other.getText(), 'other');
		if (change !== 'dispose') assert.deepEqual(editor.getSelection(), selection);
	});
}

test('Suggest registration follows editor enablement and model disposal', async () => {
	await import('../../../contrib/suggest/browser/suggestController.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using cleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	for (const enabled of [false, true]) {
		using model = new TextModel('alpha');
		using editor = createTestCodeEditor({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), suggestions: enabled });
		assert.equal(editor.getContribution('editor.contrib.suggest') !== null, enabled);
		assert.equal(container.querySelectorAll('.stanza-editor-completion').length, enabled ? 1 : 0);
		editor.setModel(null);
		assert.equal(container.querySelectorAll('.stanza-editor-completion').length, 0);
	}
});

function textDropEvent(targetWindow: typeof browserEnvironment.window, text: string, clientX = 0, clientY = 0): DragEvent {
	return transferDropEvent(targetWindow, {
		types: ['text/plain'],
		files: [],
		getData: type => type === 'text/plain' ? text : '',
	}, clientX, clientY);
}

interface TestDataTransfer {
	readonly types: readonly string[];
	readonly files: readonly File[];
	getData(type: string): string;
}

function transferDropEvent(targetWindow: typeof browserEnvironment.window, dataTransfer: TestDataTransfer, clientX = 80, clientY = 10): DragEvent {
	const event = new targetWindow.Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		clientY: { value: clientY },
		dataTransfer: { value: dataTransfer },
	});
	return event as unknown as DragEvent;
}

function editorRectangle(width: number, height: number): DOMRect {
	return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
}

class DeferredTextFile {
	private readonly result: Promise<string>;
	private resolveResult: ((text: string) => void) | undefined;

	constructor(readonly name: string, readonly type = '', readonly size = 16) {
		this.result = new Promise(resolve => this.resolveResult = resolve);
	}

	text(): Promise<string> {
		return this.result;
	}

	resolve(text: string): void {
		this.resolveResult?.(text);
	}
}

async function waitForText(model: TextModel, expected: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (model.getText() === expected) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.equal(model.getText(), expected);
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

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

test('content events follow the attached model and retain edit, undo, redo, and reset details', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	using first = new TextModel('alpha');
	using second = new TextModel('beta');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model: first, input: { resource: first.uri }, languageId: first.getLanguageId() });
	const events: { text: string; undo: boolean; redo: boolean; flush: boolean; version: number }[] = [];
	using listener = editor.onDidChangeModelContent(event => events.push({ text: event.changes.map(change => change.text).join(''), undo: event.isUndoing, redo: event.isRedoing, flush: event.isFlush, version: event.versionId }));
	editor.pushUndoStop();
	editor.executeEdits('test', [{ range: new Range(1, 1, 1, 6), text: 'one' }]);
	editor.pushUndoStop();
	first.undo();
	first.redo();
	editor.setModel(second);
	first.setValue('detached');
	editor.setValue('two');
	assert.deepEqual(events, [
		{ text: 'one', undo: false, redo: false, flush: false, version: 2 },
		{ text: 'alpha', undo: true, redo: false, flush: false, version: 3 },
		{ text: 'one', undo: false, redo: true, flush: false, version: 4 },
		{ text: 'two', undo: false, redo: false, flush: true, version: 2 },
	]);
	editor.setModel(null);
	second.setValue('detached too');
	assert.equal(editor.saveViewState(), null);
	assert.equal(events.length, 4);
});

test('Contribution selection distinguishes defaults, an empty list, and an explicit subset', async () => {
	const { EditorExtensionsRegistry } = await import('../../../browser/editorExtensions.js');
	const { FindController } = await import('../../../contrib/find/browser/findController.js');
	await import('../../../contrib/find/browser/findController.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	try {
		for (const contributions of [undefined, [], EditorExtensionsRegistry.getSomeEditorContributions([FindController.ID])]) {
			using editor = createTestCodeEditor({
				container: requiredElement(dom.window.document, 'main'),
				model, input: { resource: model.uri }, languageId: model.getLanguageId(), contributions,
			});
			const find = editor.getContribution(FindController.ID);
			if (contributions?.length === 0) {
				assert.equal(find, null);
				assert.equal(editor.getContribution(PlaceholderTextContribution.ID), null);
				assert.equal(dom.window.document.querySelector('.stanza-editor-find-widget'), null);
				continue;
			}
			assert.ok(find instanceof FindController);
			assert.equal(editor.getContribution(FindController.ID), find);
			find.open();
			assert.equal(find.visible, true);
			find.close();
			assert.equal(find.visible, false);
			assert.equal(editor.getContribution(PlaceholderTextContribution.ID) !== null, contributions === undefined);
			editor.setModel(null);
			assert.equal(find.isDisposed, true);
			assert.equal(editor.getContribution(FindController.ID), null);
			editor.setModel(model);
			assert.ok(editor.getContribution(FindController.ID) instanceof FindController);
			assert.notEqual(editor.getContribution(FindController.ID), find);
		}
	} finally {
		dom.window.close();
	}
});

test('Disabled and configuration-only contributions do not expose placeholder instances', async () => {
	const { EditorExtensionsRegistry } = await import('../../../browser/editorExtensions.js');
	await import('../../../contrib/unicodeHighlighter/browser/unicodeHighlighter.contribution.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model, input: { resource: model.uri }, languageId: model.getLanguageId(), showUnicodeHighlights: false,
			contributions: [
				...EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.unicodeHighlighter']),
				{
					id: 'test.modelConfiguration',
					configure: context => {
						events.push('configure');
						context.register(toDisposable(() => events.push('dispose')));
					},
				},
			],
		});
		assert.equal(editor.getContribution('editor.contrib.unicodeHighlighter'), null);
		assert.equal(editor.getContribution('test.modelConfiguration'), null);
		assert.deepEqual(events, ['configure']);
		editor.setModel(null);
		assert.deepEqual(events, ['configure', 'dispose']);
	} finally {
		dom.window.close();
	}
});

test('Returning an already registered controller preserves dependent listener cleanup order', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	class Controller extends Disposable {
		constructor() {
			super();
			this._register(toDisposable(() => events.push('controller')));
		}
	}
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model, input: { resource: model.uri }, languageId: model.getLanguageId(),
			contributions: [{
				id: 'test.registeredController',
				install: context => {
					if (context.kind !== 'text') return;
					const controller = context.register(new Controller());
					context.register(toDisposable(() => {
						assert.equal(controller.isDisposed, false);
						events.push('listener');
					}));
					return controller;
				},
			}],
		});
		assert.ok(editor.getContribution('test.registeredController') instanceof Controller);
		editor.setModel(null);
		assert.deepEqual(events, ['listener', 'controller']);
	} finally {
		dom.window.close();
	}
});


test('CodeEditorWidget rejects missing shared services before creating its surface', () => {
	using configurations = createTestLanguageConfigurationService();
	using features = new LanguageFeaturesService();
	using theme = new TestThemeService(darkColorTheme);
	using model = new TextModel('text');
	using contextKeys = new ContextKeyService();
	for (const missing of [IThemeService, ILanguageConfigurationService, ILanguageFeaturesService, IContextKeyService]) {
		using services = new ServiceContainer();
		if (missing !== IContextKeyService) services.registerInstance(IContextKeyService, contextKeys);
		if (missing !== IThemeService) services.registerInstance(IThemeService, theme);
		if (missing !== ILanguageConfigurationService) services.registerInstance(ILanguageConfigurationService, configurations);
		if (missing !== ILanguageFeaturesService) services.registerInstance(ILanguageFeaturesService, features);
		const container = h(browserEnvironment.window.document, 'div');
		assert.throws(() => services.createInstance(CodeEditorWidget, {
			container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), contributions: [],
		}), error => error instanceof Error && error.message.includes(missing.description));
		assert.equal(container.childElementCount, 0);
	}
});

test('CodeEditorWidget shares host language services across contributions and model switches', () => {
	using configurations = createTestLanguageConfigurationService();
	using features = new LanguageFeaturesService();
	using theme = new TestThemeService(darkColorTheme);
	using services = new ServiceContainer();
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IThemeService, theme);
	services.registerInstance(ILanguageConfigurationService, configurations);
	services.registerInstance(ILanguageFeaturesService, features);
	using first = new TextModel('first');
	using second = new TextModel('second');
	const seen: ILanguageFeaturesService[] = [];
	class Contribution extends Disposable {
		constructor(_editor: ICodeEditor, @ILanguageFeaturesService service: ILanguageFeaturesService) {
			super();
			seen.push(service);
		}
	}
	const container = h(browserEnvironment.window.document, 'div');
	using editor = services.createInstance(CodeEditorWidget, {
		container, model: first, input: { resource: first.uri }, languageId: first.getLanguageId(),
		contributions: [
			{ id: 'test.shared.constructor', ctor: Contribution, instantiation: EditorContributionInstantiation.Eager },
			{ id: 'test.shared.hook', install: (context: TextEditorContributionContext) => { seen.push(context.languageFeaturesService); } },
		],
	});
	editor.setModel(second);
	assert.deepEqual(seen, [features, features, features, features]);
	editor.dispose();
	assert.equal(features.isDisposed, false);
	assert.equal(theme.isDisposed, false);
	assert.equal(services.get(ILanguageConfigurationService), configurations);
	assert.equal(first.isDisposed(), false);
	assert.equal(second.isDisposed(), false);
});

test('trigger dispatches actions and commands in the receiving editor with its context', async () => {
	const { EditorAction, EditorCommand, registerEditorAction, registerEditorCommand } = await import('../../../browser/editorExtensions.js');
	const calls: { editor: ICodeEditor; args: unknown }[] = [];
	const condition = ContextKeyExpr.has('test.trigger.enabled');
	registerEditorAction(class extends EditorAction {
		constructor() { super({ id: 'test.trigger.action', label: 'Test trigger', alias: 'Test trigger', precondition: condition }); }
		public run(_accessor: unknown, editor: ICodeEditor, args: unknown): void { calls.push({ editor, args }); }
	});
	registerEditorCommand(new class extends EditorCommand {
		constructor() { super({ id: 'test.trigger.command', precondition: condition }); }
		public runEditorCommand(_accessor: unknown, editor: ICodeEditor, args: unknown): void { calls.push({ editor, args }); }
	}());
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using otherModel = new TextModel('beta');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, input: { resource: model.uri }, languageId: model.getLanguageId(), contributions: [] });
	using other = createTestCodeEditor({ container: requiredElement(dom.window.document, 'aside'), model: otherModel, input: { resource: otherModel.uri }, languageId: otherModel.getLanguageId(), contributions: [] });
	const context = editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
	context.setContext('test.trigger.enabled', false);
	other.invokeWithinContext(accessor => accessor.get(IContextKeyService)).setContext('test.trigger.enabled', true);
	other.focus();
	const payload = Object.freeze({ value: 42 });
	for (const id of ['test.trigger.action', 'test.trigger.command']) editor.trigger('test', id, payload);
	assert.deepEqual(calls, []);
	context.setContext('test.trigger.enabled', true);
	for (const id of ['test.trigger.action', 'test.trigger.command']) editor.trigger('test', id, payload);
	assert.deepEqual(calls, [{ editor, args: payload }, { editor, args: { value: 42, source: 'test' } }]);
	assert.equal(dom.window.document.activeElement, other.controller.element);
	assert.deepEqual(payload, { value: 42 });
	editor.setModel(null);
	editor.trigger('test', 'test.trigger.command', payload);
	assert.equal(calls.length, 2);
	dom.window.close();
});

test('trigger reports synchronous command errors and rejected action promises', async () => {
	const { EditorAction, EditorCommand, registerEditorAction, registerEditorCommand } = await import('../../../browser/editorExtensions.js');
	const commandError = new Error('Command failed');
	const actionError = new Error('Action failed');
	registerEditorCommand(new class extends EditorCommand {
		constructor() { super({ id: 'test.trigger.failure.command', precondition: undefined }); }
		public runEditorCommand(): void { throw commandError; }
	}());
	registerEditorAction(class extends EditorAction {
		constructor() { super({ id: 'test.trigger.failure.action', label: 'Test failure', alias: 'Test failure', precondition: undefined }); }
		public async run(): Promise<void> { throw actionError; }
	});
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, input: { resource: model.uri }, languageId: model.getLanguageId(), contributions: [] });
	const previous = errorHandler.getUnexpectedErrorHandler();
	const errors: unknown[] = [];
	setUnexpectedErrorHandler(error => errors.push(error));
	try {
		editor.trigger('test', 'test.trigger.failure.command', {});
		editor.trigger('test', 'test.trigger.failure.action', {});
		await delay(dom.window, 0);
		assert.deepEqual(errors, [commandError, actionError]);
	} finally {
		setUnexpectedErrorHandler(previous);
		dom.window.close();
	}
});

test('formatting context keys follow registration, language changes, and model replacement', async () => {
	await import('../../../contrib/format/browser/formatActions.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha', { languageId: 'plaintext' });
	using next = new TextModel('beta', { languageId: 'typescript' });
	using services = new ServiceContainer();
	using rootContextKeys = new ContextKeyService();
	services.registerInstance(IContextKeyService, rootContextKeys);
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		instantiationService: services,
	});
	const action = editor.getAction('editor.action.formatDocument')!;
	const features = editor.invokeWithinContext(accessor => accessor.get(ILanguageFeaturesService));
	const read = () => editor.invokeWithinContext(accessor => {
		const context = accessor.get(IContextKeyService);
		return [context.getValue('editorHasDocumentFormattingProvider'), context.getValue('editorHasDocumentSelectionFormattingProvider'), action.isSupported()];
	});
	assert.deepEqual(read(), [false, false, false]);
	using registration = features.documentRangeFormattingEditProvider.register('typescript', { provideDocumentRangeFormattingEdits: () => [] });
	assert.deepEqual(read(), [false, false, false]);
	model.setLanguage('typescript');
	assert.deepEqual(read(), [true, true, true]);
	model.setLanguage('plaintext');
	assert.deepEqual(read(), [false, false, false]);
	editor.setModel(next);
	assert.deepEqual(read(), [true, true, true]);
	editor.updateOptions({ readOnly: true });
	assert.deepEqual(read(), [true, true, false]);
	editor.updateOptions({ readOnly: false });
	registration.dispose();
	assert.deepEqual(read(), [false, false, false]);
	dom.window.close();
});

test('selection formatting merges expanded edits repeatedly before one undoable commit', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha\nbeta\ngamma');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		contributions: [],
	});
	const { formatEditor, FormattingKind, FormattingConflicts } = await import('../../../contrib/format/browser/format.js');
	using selector = FormattingConflicts.setFormatterSelector(async providers => providers[0]);
	const features = editor.invokeWithinContext(accessor => accessor.get(ILanguageFeaturesService));
	const queried: string[] = [];
	using provider = features.documentRangeFormattingEditProvider.register('*', {
		provideDocumentRangeFormattingEdits(receivedModel, range) {
			assert.equal(receivedModel.getValue(), 'alpha\nbeta\ngamma');
			queried.push(range.toString());
			return [{ range: receivedModel.getFullModelRange(), text: range.endLineNumber === 3 ? 'ALPHA\nBETA\nGAMMA' : 'discard me' }];
		},
	});
	using worker = new VersionedEditorWorkerClient(model, () => new EditorWorker());
	editor.setSelections([new Selection(1, 1, 1, 6), new Selection(2, 1, 2, 5), new Selection(3, 1, 3, 6)]);
	await formatEditor(editor, features, worker, FormattingKind.Selection);
	assert.equal(model.getValue(), 'ALPHA\nBETA\nGAMMA');
	assert.deepEqual(queried, ['[1,1 -> 1,6]', '[2,1 -> 2,5]', '[1,1 -> 2,5]', '[3,1 -> 3,6]', '[1,1 -> 3,6]']);
	model.undo();
	assert.equal(model.getValue(), 'alpha\nbeta\ngamma');
	dom.window.close();
});

test('format actions share the model worker and release the save hook on detach', async () => {
	await import('../../../contrib/format/browser/formatActions.js');
	const { FormattingConflicts, FormattingMode } = await import('../../../contrib/format/browser/format.js');
	const { IVersionedEditorWorkerClient } = await import('../../../browser/services/editorWorkerService.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	model.updateOptions({ tabSize: 2, indentSize: 2, insertSpaces: false });
	let saveHook: (() => void | Promise<void>) | undefined;
	let worker: InstanceType<typeof VersionedEditorWorkerClient> | undefined;
	let mode: number | undefined;
	using selector = FormattingConflicts.setFormatterSelector(async (providers, _model, selectedMode) => {
		mode = selectedMode;
		return providers[0];
	});
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'), model,
		input: { resource: model.uri }, languageId: model.getLanguageId(),
		formatOnSave: true,
		onLanguageError: error => { throw error; },
		editorWorkerFactory: model => worker = new VersionedEditorWorkerClient(model, () => new EditorWorker()),
		registerBeforeSave: hook => {
			saveHook = hook;
			return toDisposable(() => { saveHook = undefined; });
		},
	});
	const features = editor.invokeWithinContext(accessor => accessor.get(ILanguageFeaturesService));
	using registration = features.documentFormattingEditProvider.register('*', {
		provideDocumentFormattingEdits(model, options) {
			assert.deepEqual(options, { tabSize: 2, insertSpaces: false });
			return [{ range: model.getFullModelRange(), text: 'ALPHA' }];
		},
	});
	assert.equal(editor.invokeWithinContext(accessor => accessor.get(IVersionedEditorWorkerClient)), worker);
	assert.equal(editor.getContribution('editor.contrib.format'), null);
	assert.ok(saveHook);
	await saveHook();
	assert.equal(model.getValue(), 'ALPHA');
	assert.equal(mode, FormattingMode.Silent);
	editor.setModel(null);
	assert.equal(saveHook, undefined);
	assert.equal(worker?.isDisposed, true);
	const { EditorExtensionsRegistry } = await import('../../../browser/editorExtensions.js');
	for (const id of ['editor.action.formatDocument', 'editor.action.formatSelection']) {
		const action = [...EditorExtensionsRegistry.getEditorActions()].find(action => action.id === id)!;
		await action.run({
			get: () => { throw new Error('Detached model service was requested'); },
			getOptional: () => { throw new Error('Detached model service was requested'); },
		}, editor, {});
	}
	dom.window.close();
});

import '../testEditorDom.js';

import { h, text } from '../../../../base/browser/dom.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Event as EditorEvent } from '../../../../base/common/event.js';
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IGlyphMarginWidget } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { TextModel } from "../../../common/model/textModel.js";
import { SyntaxProviderRegistry } from '../../../common/languageFeatureRegistry.js';
import { GlyphMarginLane } from '../../../common/model.js';
import { EditorLineWrapping, EditorOption, RenderLineNumbersType } from '../../../common/config/editorOptions.js';
import { ScrollType } from '../../../common/editorCommon.js';
import { VerticalRevealType } from '../../../common/viewEvents.js';
import { IContextKeyService, ContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { AccessibilitySupport, IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../base/common/errors.js';

const { CodeEditorWidget } = await import("../../../browser/widget/codeEditor/codeEditorWidget.js");
const { createTestCodeEditor } = await import('../testCodeEditor.js');
const { TextAreaEditContextRegistry } = await import('../../../browser/controller/editContext/textArea/textAreaEditContextRegistry.js');
const { ViewPart } = await import('../../../browser/view/viewPart.js');
const { ServiceContainer } = await import("../../../../platform/instantiation/common/instantiation.js");
const { ILogService, NullLoggerService } = await import('../../../../platform/log/common/log.js');
const { PlaceholderTextContribution } = await import("../../../contrib/placeholderText/browser/placeholderTextContribution.js");
const { VersionedEditorWorkerClient } = await import('../../../browser/services/editorWorkerService.js');
const { EditorWorker } = await import('../../../common/services/editorWebWorker.js');
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

function delay(targetWindow: Pick<Window, 'setTimeout'>, duration: number): Promise<void> {
	return new Promise(resolve => targetWindow.setTimeout(resolve, duration));
}

test('editor line-number width follows edits, undo, and model replacement before content events', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using cleanup = toDisposable(() => dom.window.close());
	using model = new TextModel(Array.from({ length: 9 }, () => 'line').join('\n'));
	using replacement = new TextModel('short');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineNumbersMinChars: 1,
		minimap: { enabled: false },
	});
	editor.layout({ width: 320, height: 80 });
	const digitWidth = editor.getOption(EditorOption.fontInfo).maxDigitWidth;
	const widths: number[] = [];
	using listener = editor.onDidChangeModelContent(() => widths.push(editor.getLayoutInfo().lineNumbersWidth));

	editor.executeEdits('test', [{ range: new Range(9, 5, 9, 5), text: '\nline' }]);
	editor.pushUndoStop();
	model.undo();
	model.setValue(Array.from({ length: 100 }, () => 'line').join('\n'));
	editor.setModel(replacement);
	widths.push(editor.getLayoutInfo().lineNumbersWidth);

	assert.deepEqual(widths, [2, 1, 3, 1].map(digits => Math.round(digits * digitWidth)));
});

test('editor reads long-line wrapping from each attached model and honors accessibility overrides', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using cleanup = toDisposable(() => dom.window.close());
	using longModel = new TextModel('x'.repeat(20000));
	using shortModel = new TextModel('short');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model: longModel,
		accessibilityService: enabledAccessibilityService,
		accessibilitySupport: 'auto',
		wordWrap: 'off',
		minimap: { enabled: false },
	});
	editor.layout({ width: 320, height: 80 });
	const states: boolean[] = [];
	const read = (): void => { states.push(editor.getLayoutInfo().isWordWrapMinified); };
	read();
	editor.updateOptions({ accessibilitySupport: 'off' });
	read();
	editor.updateOptions({ accessibilitySupport: 'auto', wordWrapOverride1: 'off' });
	read();
	editor.updateOptions({ wordWrapOverride1: 'inherit' });
	read();
	editor.setModel(null);
	read();
	editor.setModel(shortModel);
	read();
	editor.setModel(longModel);
	read();
	assert.deepEqual(states, [true, false, false, true, false, false, true]);
});

test("CodeEditorWidget owns one canonical browser editing surface", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("alpha");
	const editor = createTestCodeEditor({ container, model, lineHeight: 20, ariaLabel: "Code" });
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

test('force retokenize action refreshes the active model through its syntax provider', async () => {
	await import('../../../contrib/tokenization/browser/tokenization.js');
	using providers = new SyntaxProviderRegistry();
	let requests = 0;
	using registration = providers.register({
		id: 'test.retokenize',
		languageIds: ['retokenize'],
		provideTokens: () => ({ tokens: [{
			range: new Range(1, 1, 1, 6),
			tokenType: ++requests === 1 ? 'string' : 'comment',
			modifiers: [],
		}] }),
	});
	using model = new TextModel('value', { languageId: 'retokenize', tokenization: { syntaxProviderRegistry: providers } });
	for (let attempt = 0; attempt < 20 && !model.tokenization.hasAccurateTokensForLine(1); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.equal(model.tokenization.getLanguageTokens(0)[0]?.tokenType, 'string');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, contributions: [] });
	try {
		const action = editor.getAction('editor.action.forceRetokenize');
		assert.ok(action);
		await action.run();
		assert.equal(model.tokenization.hasAccurateTokensForLine(1), false);
		for (let attempt = 0; attempt < 20 && !model.tokenization.hasAccurateTokensForLine(1); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		assert.deepEqual([requests, model.tokenization.getLanguageTokens(0)[0]?.tokenType], [2, 'comment']);
		editor.setModel(null);
		await action.run();
		assert.equal(requests, 2);
	} finally {
		dom.window.close();
	}
});

test('move selected text actions update text, selection and undo through the editor', async () => {
	await import('../../../contrib/caretOperations/browser/caretOperations.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('012345');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, contributions: [] });
	try {
		const left = editor.getAction('editor.action.moveCarretLeftAction');
		const right = editor.getAction('editor.action.moveCarretRightAction');
		assert.ok(left && right);
		editor.setSelection(new Selection(1, 3, 1, 5));
		await left.run();
		assert.deepEqual([model.getValue(), editor.getSelection()?.toString()], ['023145', '[1,2 -> 1,4]']);
		model.undo();
		assert.equal(model.getValue(), '012345');

		editor.setSelection(new Selection(1, 3, 1, 5));
		await right.run();
		assert.deepEqual([model.getValue(), editor.getSelection()?.toString()], ['014235', '[1,4 -> 1,6]']);
		model.undo();
		assert.equal(model.getValue(), '012345');

		editor.setSelection(new Selection(1, 5, 1, 3));
		await left.run();
		assert.deepEqual([model.getValue(), editor.getSelection()?.toString()], ['023145', '[1,4 -> 1,2]']);
		model.undo();
		editor.setSelection(new Selection(1, 1, 1, 3));
		await left.run();
		assert.deepEqual([model.getValue(), editor.getSelection()?.toString()], ['012345', '[1,1 -> 1,3]']);
		editor.setSelection(new Selection(1, 5, 1, 7));
		await right.run();
		assert.deepEqual([model.getValue(), editor.getSelection()?.toString()], ['012345', '[1,5 -> 1,7]']);
		editor.updateOptions({ readOnly: true });
		assert.deepEqual([left.isSupported(), right.isSupported()], [false, false]);
		editor.updateOptions({ readOnly: false });
		model.setValue('012345\nabcdef');
		editor.setSelections([new Selection(1, 3, 1, 5), new Selection(2, 3, 2, 5)]);
		await left.run();
		assert.deepEqual([
			model.getValue(),
			(editor.getSelections() ?? []).map(selection => selection.toString()),
		], ['023145\nacdbef', ['[1,2 -> 1,4]', '[2,2 -> 2,4]']]);
		model.setValue('012345\nabcdef');
		editor.setSelection(new Selection(1, 2, 2, 3));
		await left.run();
		await right.run();
		assert.deepEqual([model.getValue(), editor.getSelection()?.toString()], ['012345\nabcdef', '[1,2 -> 2,3]']);
		editor.setSelection(new Selection(2, 1, 2, 1));
		await left.run();
		await right.run();
		assert.deepEqual([
			model.getValue(),
			(editor.getSelections() ?? []).map(selection => selection.toString()),
		], ['012345\nabcdef', ['[2,1 -> 2,1]']]);
	} finally {
		dom.window.close();
	}
});

test('insert final new line action appends the model EOL and keeps the selection', async () => {
	await import('../../../contrib/insertFinalNewLine/browser/insertFinalNewLine.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, contributions: [] });
	try {
		const action = editor.getAction('editor.action.insertFinalNewLine');
		assert.ok(action);
		editor.setSelection(new Selection(1, 4, 1, 2));
		await action.run();
		assert.deepEqual([model.getValue(), editor.getSelection()?.toString()], ['alpha\n', '[1,4 -> 1,2]']);
		model.undo();
		assert.equal(model.getValue(), 'alpha');
		editor.setModel(null);
		await action.run();
	} finally {
		dom.window.close();
	}
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
		readOnly: true, instantiationService: services,
	});
	using other = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'aside'), model: second,
		instantiationService: services,
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

test('editor configuration updates rerender line-number, selection, whitespace, and indent overlays', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\n    two\n\tthree');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
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

test('CodeEditorWidget exposes editor-owned scroll geometry', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\ntwo\nthree\nfour\nfive');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
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
		lineHeight: 20,
	});
	const second = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'aside'),
		model,
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
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
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

test('CodeEditorWidget selects the full replacement and keeps an empty caret column', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('flag true');
	using editor = createTestCodeEditor({ container, model, lineHeight: 20 });
	editor.setSelection(new Selection(1, 6, 1, 10));

	const replace = (key: string) => editor.controller.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
		bubbles: true, cancelable: true, key, ctrlKey: true, shiftKey: true,
	}));
	replace('.');
	await waitForText(model, 'flag false');
	assert.equal(editor.getSelection()?.toString(), '[1,6 -> 1,11]');
	replace(',');
	await waitForText(model, 'flag true');
	assert.equal(editor.getSelection()?.toString(), '[1,6 -> 1,10]');

	model.setValue('value 9');
	editor.setPosition(new Position(1, 8));
	replace('.');
	await waitForText(model, 'value 10');
	assert.equal(editor.getSelection()?.toString(), '[1,8 -> 1,8]');
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
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, contributions: [] });
	using other = createTestCodeEditor({ container: requiredElement(dom.window.document, 'aside'), model: otherModel, contributions: [] });
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
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, contributions: [] });
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

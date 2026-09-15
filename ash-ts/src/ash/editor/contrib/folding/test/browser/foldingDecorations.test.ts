import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { TextModel } from '../../../../common/model/textModel.js';
import { OperatingSystem, operatingSystem } from '../../../../../base/common/platform.js';

const browser = new JSDOM('<!doctype html><body></body>');
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
for (const [name, value] of Object.entries({
	window: browser.window,
	document: browser.window.document,
	Node: browser.window.Node,
	Element: browser.window.Element,
	HTMLElement: browser.window.HTMLElement,
	Event: browser.window.Event,
	InputEvent: browser.window.InputEvent,
	KeyboardEvent: browser.window.KeyboardEvent,
	ResizeObserver: TestResizeObserver,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

await import('../../browser/folding.js');
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { FoldingDecorationProvider } = await import('../../browser/foldingDecorations.js');

suiteTeardown(() => browser.window.close());

test('FoldingDecorationProvider selects controls, highlights, and editor-owned decoration lifetime', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('header\nbody\nend');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
		folding: false,
	});
	const provider = new FoldingDecorationProvider(editor);

	assert.match(provider.getDecorationOption(true, false, false).firstLineDecorationClassName ?? '', /folding-collapsed/);
	assert.equal(provider.getDecorationOption(true, false, false).className, 'folded-background');
	provider.showFoldingHighlights = false;
	assert.equal(provider.getDecorationOption(true, false, false).className, undefined);
	provider.showFoldingControls = 'never';
	assert.equal(provider.getDecorationOption(true, false, false).firstLineDecorationClassName, undefined);
	assert.equal(provider.getDecorationOption(false, true, false).description, 'folding-hidden-range');

	let decorationId = '';
	provider.changeDecorations(accessor => {
		decorationId = accessor.addDecoration(model.getFullModelRange(), provider.getDecorationOption(true, false, true));
	});
	assert.equal(model.getDecorationOptions(decorationId)?.description, 'folding-manually-collapsed');
	provider.removeDecorations([decorationId]);
	assert.equal(model.getDecorationRange(decorationId), null);
	dom.window.close();
});

test('Folding contribution projects model ranges through FoldingDecorationProvider', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('{\n  value\n}');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 320, height: 120 });

	const initial = model.getAllDecorations().find(decoration => decoration.options.description === 'folding-expanded');
	assert.ok(initial);
	const expandedMarker = editor.getDomNode().querySelector<HTMLElement>('.ash-icon-folding-expanded');
	assert.equal(expandedMarker?.title, 'Collapse range');
	expandedMarker?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
	assert.ok(model.getAllDecorations().some(decoration => decoration.options.description === 'folding-collapsed'));
	const pointerCollapsedMarker = editor.getDomNode().querySelector<HTMLElement>('.ash-icon-folding-collapsed');
	pointerCollapsedMarker?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
	assert.ok(model.getAllDecorations().some(decoration => decoration.options.description === 'folding-expanded'));
	const collapse = new dom.window.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		key: '[',
		...(operatingSystem === OperatingSystem.Macintosh ? { metaKey: true, altKey: true } : { ctrlKey: true, shiftKey: true }),
	}) as unknown as KeyboardEvent;
	editor.controller.element.dispatchEvent(collapse);
	assert.equal(collapse.defaultPrevented, true);
	const collapsed = model.getAllDecorations().find(decoration => decoration.options.description === 'folding-collapsed');
	assert.equal(collapsed?.options.afterContentClassName, 'inline-folded');
	const collapsedMarker = editor.getDomNode().querySelector<HTMLElement>('.ash-icon-folding-collapsed');
	assert.equal(collapsedMarker?.title, 'Expand folded range');
	dom.window.close();
});

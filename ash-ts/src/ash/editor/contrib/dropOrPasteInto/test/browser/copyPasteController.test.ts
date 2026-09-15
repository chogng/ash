import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';

const environment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	Node: environment.window.Node,
	Element: environment.window.Element,
	HTMLElement: environment.window.HTMLElement,
	Event: environment.window.Event,
	InputEvent: environment.window.InputEvent,
	KeyboardEvent: environment.window.KeyboardEvent,
	MouseEvent: environment.window.MouseEvent,
	ResizeObserver: class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) Object.defineProperty(globalThis, name, { configurable: true, value });

await import('../../browser/copyPasteContribution.js');
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { CopyPasteController } = await import('../../browser/copyPasteController.js');

suiteTeardown(() => environment.window.close());

test('CopyPasteController owns URI-list and bounded text-file paste extensions', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('replace');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.setSelection(new Selection(1, 1, 1, 8));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const uriData = new TestClipboardData();
	uriData.setData('text/uri-list', '# resources\nfile:///workspace/one.rs\nhttps://example.test/two');
	const uriPaste = clipboardEvent(dom.window, uriData);
	input.dispatchEvent(uriPaste);
	assert.equal(uriPaste.defaultPrevented, true);
	assert.equal(model.getText(), 'file:///workspace/one.rs\nhttps://example.test/two');

	editor.setSelection(new Selection(1, 1, 2, 25));
	const file = { name: 'snippet.ts', size: 13, type: 'text/plain', text: async () => 'const x = 1;' };
	const filePaste = clipboardEvent(dom.window, new TestClipboardData([file as unknown as File]));
	input.dispatchEvent(filePaste);
	assert.equal(filePaste.defaultPrevented, true);
	const controller = CopyPasteController.get(editor);
	assert.ok(controller);
	await controller.finishedPaste();
	assert.equal(model.getText(), 'const x = 1;');
	dom.window.close();
});

class TestClipboardData {
	private readonly values = new Map<string, string>();
	constructor(readonly files: readonly File[] = []) {}
	get types(): string[] { return [...this.values.keys()]; }
	getData(type: string): string { return this.values.get(type) ?? ''; }
	setData(type: string, value: string): void { this.values.set(type, value); }
}

function clipboardEvent(targetWindow: typeof environment.window, clipboardData: TestClipboardData): ClipboardEvent {
	const event = new targetWindow.Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
	return event as unknown as ClipboardEvent;
}

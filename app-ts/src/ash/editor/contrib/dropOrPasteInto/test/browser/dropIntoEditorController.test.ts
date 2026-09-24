import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
import { Position } from '../../../../common/core/position.js';
import { type DocumentDropEditProvider } from '../../../../common/languages.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import type { browserEnvironment } from '../../../../test/browser/testEditorDom.js';

await import('../../browser/dropIntoEditorContribution.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');

test('CodeEditorWidget leaves text drops available to its host without the contribution', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		contributions: [],
	});
	const drop = textDropEvent(dom.window, 'dropped');

	editor.getDomNode().dispatchEvent(drop);

	assert.deepEqual({ handled: drop.defaultPrevented, value: model.getText() }, { handled: false, value: 'alpha' });
});

test('DropIntoEditorController inserts plain text at the hit position', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const drop = textDropEvent(dom.window, ' dropped', 80, 10);

	editor.getDomNode().dispatchEvent(drop);
	await waitFor(() => model.getText() === 'alpha dropped');

	assert.deepEqual({ handled: drop.defaultPrevented, value: model.getText(), position: editor.getPosition() }, {
		handled: true,
		value: 'alpha dropped',
		position: new Position(1, 14),
	});
});

test('Disabled drop-into-editor leaves text drops to the host', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		dropIntoEditor: { enabled: false },
	});
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const dataTransfer = { types: ['text/plain'], files: [], getData: () => ' dropped' };
	const dragOver = transferDropEvent(dom.window, dataTransfer, 80, 10, 'dragover');
	const drop = transferDropEvent(dom.window, dataTransfer);

	editor.getDomNode().dispatchEvent(dragOver);
	editor.getDomNode().dispatchEvent(drop);

	assert.deepEqual({ dragOverHandled: dragOver.defaultPrevented, dropHandled: drop.defaultPrevented, value: model.getText() }, {
		dragOverHandled: false,
		dropHandled: false,
		value: 'alpha',
	});
});

test('Read-only editors leave text drops to the host', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		readOnly: true,
		lineHeight: 20,
	});
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const drop = textDropEvent(dom.window, 'dropped', 80, 10);

	editor.getDomNode().dispatchEvent(drop);

	assert.deepEqual({ handled: drop.defaultPrevented, value: model.getText() }, { handled: false, value: 'alpha' });
});

test('File and HTML-only drops remain available to the host', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	let fileReads = 0;
	const file = {
		name: 'snippet.rs',
		type: 'text/plain',
		size: 8,
		text: async () => {
			fileReads += 1;
			return 'content';
		},
	};
	const fileTransfer = { types: ['Files'], files: [file as unknown as File], getData: () => '' };
	const fileDragOver = transferDropEvent(dom.window, fileTransfer, 80, 10, 'dragover');
	const fileDrop = transferDropEvent(dom.window, fileTransfer);
	const htmlDrop = transferDropEvent(dom.window, {
		types: ['text/html'],
		files: [],
		getData: type => type === 'text/html' ? '<div>ignored</div>' : '',
	});

	editor.getDomNode().dispatchEvent(fileDragOver);
	editor.getDomNode().dispatchEvent(fileDrop);
	editor.getDomNode().dispatchEvent(htmlDrop);

	assert.deepEqual({
		fileDragOverHandled: fileDragOver.defaultPrevented,
		fileDropHandled: fileDrop.defaultPrevented,
		htmlDropHandled: htmlDrop.defaultPrevented,
		value: model.getText(),
		fileReads,
	}, {
		fileDragOverHandled: false,
		fileDropHandled: false,
		htmlDropHandled: false,
		value: 'alpha',
		fileReads: 0,
	});
});

test('URI-list drop inserts file paths and external URIs before duplicate plain text', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const dataTransfer = {
		types: ['text/uri-list', 'text/plain'],
		files: [],
		getData: (type: string) => type === 'text/uri-list'
			? '# resources\nfile:///workspace/one.rs\nhttps://example.test/two'
			: 'duplicate',
	};
	const drop = transferDropEvent(dom.window, dataTransfer);

	editor.getDomNode().dispatchEvent(drop);
	await waitFor(() => model.getText() === 'alpha/workspace/one.rs https://example.test/two');

	assert.deepEqual({ handled: drop.defaultPrevented, value: model.getText() }, {
		handled: true,
		value: 'alpha/workspace/one.rs https://example.test/two',
	});
});

test('A language drop provider participates in sorting and the post-drop selector', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.custom');
	let disposedSessions = 0;
	const provider: DocumentDropEditProvider = {
		dropMimeTypes: ['text/plain'],
		providedDropEditKinds: [kind],
		provideDocumentDropEdits() {
			return { edits: [{ title: 'Insert Custom Drop', kind, insertText: 'pending', yieldTo: [{ mimeType: 'text/plain' }] }], dispose() { disposedSessions += 1; } };
		},
		async resolveDocumentDropEdit(edit) {
			return { ...edit, insertText: 'CUSTOM' };
		},
	};
	using registration = features.documentDropEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, languageFeaturesService: features, lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	const drop = textDropEvent(dom.window, 'raw', 80, 10);
	editor.getDomNode().dispatchEvent(drop);
	await waitFor(() => model.getText() !== 'alpha');
	assert.equal(model.getText(), 'alpharaw');
	await waitFor(() => dom.window.document.querySelector('.stanza-editor-post-edit-selector') !== null);
	const selector = dom.window.document.querySelector<HTMLSelectElement>('.stanza-editor-post-edit-selector');
	assert.ok(selector);
	assert.equal(drop.defaultPrevented, true);
	assert.equal(selector.options.length, 2);
	const custom = [...selector.options].find(option => option.textContent === 'Insert Custom Drop');
	assert.ok(custom);
	selector.value = custom.value;
	selector.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await waitFor(() => model.getText() === 'alphaCUSTOM');
	assert.equal(model.getText(), 'alphaCUSTOM');
	assert.equal(disposedSessions, 1);
});

test('A dropped snippet selects its placeholder and Tab reaches its final stop', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.snippet');
	const provider: DocumentDropEditProvider = {
		dropMimeTypes: ['text/plain'], providedDropEditKinds: [kind],
		provideDocumentDropEdits() {
			return { edits: [{ title: 'Insert Snippet', kind, insertText: { snippet: '(${1:name})$0' } }], dispose() {} };
		},
	};
	using registration = features.documentDropEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model, languageFeaturesService: features, lineHeight: 20 });
	editor.layout({ width: 240, height: 40 });
	editor.getDomNode().getBoundingClientRect = () => editorRectangle(240, 40);
	editor.getDomNode().dispatchEvent(textDropEvent(dom.window, 'raw', 80, 10));
	await waitFor(() => model.getText() === 'alpha(name)');
	assert.equal(model.getValueInRange(editor.getSelection()!), 'name');
	const input = editor.controller.editContext.domNode.domNode;
	const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
	input.dispatchEvent(tab);
	assert.deepEqual({ handled: tab.defaultPrevented, position: editor.getPosition() }, { handled: true, position: new Position(1, 12) });
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

function transferDropEvent(targetWindow: typeof browserEnvironment.window, dataTransfer: TestDataTransfer, clientX = 80, clientY = 10, type = 'drop'): DragEvent {
	const items = [
		...dataTransfer.types.filter(mimeType => mimeType !== 'Files').map(mimeType => ({
			kind: 'string',
			type: mimeType,
			getAsString: (callback: (value: string) => void) => callback(dataTransfer.getData(mimeType)),
			getAsFile: () => null,
		})),
		...dataTransfer.files.map(file => ({
			kind: 'file',
			type: file.type,
			getAsString: (_callback: (value: string) => void) => {},
			getAsFile: () => file,
		})),
	];
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		clientY: { value: clientY },
		dataTransfer: { value: { ...dataTransfer, items } },
	});
	return event as unknown as DragEvent;
}

async function waitFor(condition: () => boolean): Promise<void> {
	const timeout = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() >= timeout) assert.fail('Drop did not complete');
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

function editorRectangle(width: number, height: number): DOMRect {
	return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

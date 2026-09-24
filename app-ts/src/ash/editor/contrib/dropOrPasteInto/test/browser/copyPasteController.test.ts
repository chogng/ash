import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
import { createStringDataTransferItem, VSDataTransfer } from '../../../../../base/common/dataTransfer.js';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { type DocumentPasteEditProvider } from '../../../../common/languages.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import { SnippetController2 } from '../../../snippet/browser/snippetController2.js';
import type { browserEnvironment } from '../../../../test/browser/testEditorDom.js';

await import('../../browser/copyPasteContribution.js');
const { CopyPasteController } = await import('../../browser/copyPasteController.js');
const { createTestCodeEditor, registerCodeEditorServices } = await import('../../../../test/browser/testCodeEditor.js');

test('URI-list paste inserts paths before duplicate plain text', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('replace');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
	editor.setSelection(new Selection(1, 1, 1, 8));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/uri-list', '# resources\nfile:///workspace/one.rs\nhttps://example.test/two');
	data.setData('text/plain', 'duplicate');
	const paste = clipboardEvent(dom.window, data);

	input.dispatchEvent(paste);
	await waitFor(() => model.getText() === '/workspace/one.rs https://example.test/two');

	assert.deepEqual({ value: model.getText(), handled: paste.defaultPrevented }, {
		value: '/workspace/one.rs https://example.test/two',
		handled: true,
	});
});

test('Plain text and file-name paste use the default input path', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
	editor.setPosition({ lineNumber: 1, column: 6 });
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const plain = new TestClipboardData();
	plain.setData('text/plain', ' ');
	input.dispatchEvent(clipboardEvent(dom.window, plain));
	let fileReads = 0;
	const file = {
		name: 'snippet.ts',
		size: 13,
		type: 'text/plain',
		text: async () => {
			fileReads += 1;
			return 'const x = 1;';
		},
	};
	input.dispatchEvent(clipboardEvent(dom.window, new TestClipboardData([file as unknown as File])));

	assert.deepEqual({ value: model.getText(), fileReads }, { value: 'alpha snippet.ts', fileReads: 0 });
});

test('HTML-only paste does not insert markup or derived text', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/html', '<div>ignored</div>');

	input.dispatchEvent(clipboardEvent(dom.window, data));

	assert.equal(model.getText(), 'alpha');
});

test('Disabled paste-as leaves URI-list paste unchanged', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		pasteAs: { enabled: false },
	});
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/uri-list', 'file:///workspace/snippet.ts');

	input.dispatchEvent(clipboardEvent(dom.window, data));

	assert.equal(model.getText(), 'alpha');
});

test('A language paste provider can replace text and the selector switches to plain text', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('old');
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.custom');
	let disposedSessions = 0;
	const provider: DocumentPasteEditProvider = {
		copyMimeTypes: [],
		pasteMimeTypes: ['text/plain'],
		providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			return {
				edits: [{ title: 'Insert Custom Text', kind, insertText: 'pending' }],
				dispose() { disposedSessions += 1; },
			};
		},
		async resolveDocumentPasteEdit(edit) {
			assert.equal(disposedSessions, 0);
			return { ...edit, insertText: 'CUSTOM' };
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	editor.setSelection(new Selection(1, 1, 1, 4));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/plain', 'raw');
	const paste = clipboardEvent(dom.window, data);
	input.dispatchEvent(paste);
	await waitFor(() => model.getText() === 'CUSTOM');
	await waitFor(() => dom.window.document.querySelector('.stanza-editor-post-edit-selector') !== null);
	const selector = dom.window.document.querySelector<HTMLSelectElement>('.stanza-editor-post-edit-selector');
	assert.ok(selector);
	assert.equal(paste.defaultPrevented, true);
	assert.equal(disposedSessions, 1);
	assert.equal(selector.options.length, 2);
	assert.equal(selector.getAttribute('aria-label'), 'Paste options');
	const plainOption = [...selector.options].find(option => option.textContent === 'Insert Plain Text');
	assert.ok(plainOption);
	selector.value = plainOption.value;
	selector.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await waitFor(() => model.getText() === 'raw');
	assert.equal(model.getText(), 'raw');
});

test('A provider paste switches its insertion and additional text edit together', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('old\ntrail');
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.withAdditionalEdit');
	const provider: DocumentPasteEditProvider = {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			return {
				edits: [{
					title: 'Insert with another edit', kind, insertText: 'MAIN',
					additionalEdit: { edits: [{ resource: model.uri, textEdit: { range: new Range(2, 1, 2, 6), text: 'EXTRA' } }] },
				}],
				dispose() {},
			};
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	editor.setSelection(new Selection(1, 1, 1, 4));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/plain', 'raw');
	input.dispatchEvent(clipboardEvent(dom.window, data));
	await waitFor(() => model.getText() === 'MAIN\nEXTRA');
	const selector = dom.window.document.querySelector<HTMLSelectElement>('.stanza-editor-post-edit-selector');
	assert.ok(selector);
	const plainOption = [...selector.options].find(option => option.textContent === 'Insert Plain Text');
	assert.ok(plainOption);
	selector.value = plainOption.value;
	selector.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await waitFor(() => model.getText() === 'raw\ntrail');
	assert.equal(model.getText(), 'raw\ntrail');
});

test('A pasted snippet keeps its tabstops after the workspace edit applies', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('prefix\nold', { resource: URI.file('/workspace/main.ts') });
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.snippet');
	const provider: DocumentPasteEditProvider = {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			return {
				edits: [{
					title: 'Insert Snippet', kind,
					insertText: { snippet: '${TM_FILENAME_BASE}: function ${1:name}(${2:value}) {$0}' },
					additionalEdit: { edits: [{ resource: model.uri, textEdit: { range: new Range(1, 1, 1, 7), text: 'LONGPREFIX' } }] },
				}],
				dispose() {},
			};
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	editor.setSelection(new Selection(2, 1, 2, 4));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/plain', 'raw');
	input.dispatchEvent(clipboardEvent(dom.window, data));
	await waitFor(() => model.getText() === 'LONGPREFIX\nmain: function name(value) {}');
	assert.equal(model.getValueInRange(editor.getSelection()!), 'name');

	const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
	input.dispatchEvent(tab);
	assert.deepEqual({ handled: tab.defaultPrevented, selected: model.getValueInRange(editor.getSelection()!) }, { handled: true, selected: 'value' });
	const back = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
	input.dispatchEvent(back);
	assert.deepEqual({ handled: back.defaultPrevented, selected: model.getValueInRange(editor.getSelection()!) }, { handled: true, selected: 'name' });
	const snippets = SnippetController2.get(editor)!;
	snippets.next();
	snippets.next();
	snippets.next();
	assert.equal(snippets.isInSnippet(), false);
});

test('Switching a paste choice reverts additional edits in another open resource', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using services = new ServiceContainer();
	registerCodeEditorServices(services);
	using model = new TextModel('old', { resource: URI.file('/workspace/main.ts') });
	using otherModel = new TextModel('trail', { resource: URI.file('/workspace/other.ts') });
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.multiResource');
	const provider: DocumentPasteEditProvider = {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			return {
				edits: [{
					title: 'Insert Both', kind, insertText: 'MAIN',
					additionalEdit: { edits: [{ resource: otherModel.uri, textEdit: { range: new Range(1, 1, 1, 6), text: 'EXTRA' } }] },
				}],
				dispose() {},
			};
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using otherEditor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('aside')!, model: otherModel,
		instantiationService: services, languageFeaturesService: features,
	});
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!, model,
		instantiationService: services, languageFeaturesService: features,
	});
	editor.setSelection(new Selection(1, 1, 1, 4));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/plain', 'raw');
	input.dispatchEvent(clipboardEvent(dom.window, data));
	await waitFor(() => model.getText() === 'MAIN' && otherModel.getText() === 'EXTRA');
	const selector = dom.window.document.querySelector<HTMLSelectElement>('.stanza-editor-post-edit-selector');
	assert.ok(selector);
	const plainOption = [...selector.options].find(option => option.textContent === 'Insert Plain Text');
	assert.ok(plainOption);
	selector.value = plainOption.value;
	selector.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await waitFor(() => model.getText() === 'raw' && otherModel.getText() === 'trail');
	assert.deepEqual([model.getText(), otherModel.getText()], ['raw', 'trail']);
});

test('A snippet paste tracks placeholders at every cursor', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('a\nb');
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.snippet');
	const provider: DocumentPasteEditProvider = {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			return { edits: [{ title: 'Insert Snippet', kind, insertText: { snippet: '${1:x}$0' } }], dispose() {} };
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	editor.setSelections([new Selection(1, 1, 1, 1), new Selection(2, 1, 2, 1)]);
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/plain', 'raw');
	input.dispatchEvent(clipboardEvent(dom.window, data));
	await waitFor(() => model.getText() === 'xa\nxb');
	assert.deepEqual(editor.getSelections()!.map(selection => model.getValueInRange(selection)), ['x', 'x']);
	const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
	input.dispatchEvent(tab);
	assert.deepEqual(editor.getSelections()!.map(selection => selection.getPosition()), [new Position(1, 2), new Position(2, 2)]);
});

test('A delayed paste provider cannot apply after the document changes', async () => {
	const dom = new JSDOM('<!doctype html><body><main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('old');
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.delayed');
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const provider: DocumentPasteEditProvider = {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			await gate;
			return { edits: [{ title: 'Delayed', kind, insertText: 'late' }], dispose() {} };
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	data.setData('text/plain', 'raw');
	input.dispatchEvent(clipboardEvent(dom.window, data));
	model.setValue('changed');
	release();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(model.getText(), 'changed');
});

test('Paste As requests the selected HTML kind from the rich clipboard', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	Object.defineProperty(dom.window.navigator, 'clipboard', {
		configurable: true,
		value: {
			read: async () => [{
				types: ['text/html'],
				getType: async () => new Blob(['<b>markup</b>'], { type: 'text/html' }),
			}],
		},
	});
	using model = new TextModel('old');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
	editor.setSelection(new Selection(1, 1, 1, 4));

	await CopyPasteController.get(editor)!.pasteAs(new HierarchicalKind('html'));

	assert.equal(model.getText(), '<b>markup</b>');
});

test('Paste As asks which provider edit to apply when no kind is specified', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	Object.defineProperty(dom.window.navigator, 'clipboard', {
		configurable: true,
		value: {
			read: async () => [{
				types: ['text/plain', 'text/html'],
				getType: async (type: string) => new Blob([type === 'text/html' ? '<b>markup</b>' : 'plain'], { type }),
			}],
		},
	});
	using model = new TextModel('old');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
	editor.setSelection(new Selection(1, 1, 1, 4));

	const paste = CopyPasteController.get(editor)!.pasteAs();
	await waitFor(() => dom.window.document.querySelector('.ash-quick-pick') !== null);
	assert.equal(model.getText(), 'old');
	const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick input');
	assert.ok(input);
	input.value = 'HTML';
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await paste;

	assert.equal(model.getText(), '<b>markup</b>');
});

test('Copy preparation data reaches the matching paste provider', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('source');
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('text.prepared');
	let prepared = 0;
	let provided = 0;
	const provider: DocumentPasteEditProvider = {
		copyMimeTypes: ['application/x-ash-prepared'],
		pasteMimeTypes: ['application/x-ash-prepared'],
		providedPasteEditKinds: [kind],
		async prepareDocumentPaste() {
			prepared += 1;
			const transfer = new VSDataTransfer();
			transfer.append('application/x-ash-prepared', createStringDataTransferItem('prepared value'));
			return transfer;
		},
		async provideDocumentPasteEdits(_model, _ranges, transfer) {
			provided += 1;
			const value = await transfer.get('application/x-ash-prepared')!.asString();
			return { edits: [{ title: 'Insert Prepared', kind, insertText: value }], dispose() {} };
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	editor.setSelection(new Selection(1, 1, 1, 7));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	const copy = new dom.window.Event('copy', { bubbles: true, cancelable: true });
	Object.defineProperty(copy, 'clipboardData', { value: data });
	input.dispatchEvent(copy);
	assert.equal(data.getData('text/plain'), 'source');
	input.dispatchEvent(clipboardEvent(dom.window, data));
	await waitFor(() => model.getText() === 'prepared value');
	assert.deepEqual({ prepared, provided }, { prepared: 1, provided: 1 });

	editor.setSelection(new Selection(1, 1, 1, 15));
	const external = new TestClipboardData();
	external.setData('text/plain', 'source');
	input.dispatchEvent(clipboardEvent(dom.window, external));
	assert.deepEqual({ text: model.getText(), provided }, { text: 'source', provided: 1 });

	Object.defineProperty(dom.window.navigator, 'clipboard', {
		configurable: true,
		value: {
			read: async () => [{
				types: data.types,
				getType: async (type: string) => new Blob([data.getData(type)], { type }),
			}],
		},
	});
	editor.setSelection(new Selection(1, 1, 1, 7));
	await CopyPasteController.get(editor)!.pasteAs(kind);
	assert.deepEqual({ text: model.getText(), provided }, { text: 'prepared value', provided: 2 });
});

class TestClipboardData {
	private readonly values = new Map<string, string>();
	constructor(readonly files: readonly File[] = []) {}
	get types(): string[] { return [...this.values.keys(), ...(this.files.length ? ['Files'] : [])]; }
	get items(): readonly {
		readonly kind: string;
		readonly type: string;
		getAsString(callback: (value: string) => void): void;
		getAsFile(): File | null;
	}[] {
		return [
			...[...this.values].map(([type, value]) => ({
				kind: 'string',
				type,
				getAsString: (callback: (value: string) => void) => callback(value),
				getAsFile: () => null,
			})),
			...this.files.map(file => ({
				kind: 'file',
				type: file.type,
				getAsString: (_callback: (value: string) => void) => {},
				getAsFile: () => file,
			})),
		];
	}
	getData(type: string): string { return this.values.get(type) ?? ''; }
	setData(type: string, value: string): void { this.values.set(type, value); }
}

async function waitFor(condition: () => boolean): Promise<void> {
	const timeout = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() >= timeout) assert.fail('Paste did not complete');
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

function clipboardEvent(targetWindow: typeof browserEnvironment.window, clipboardData: TestClipboardData): ClipboardEvent {
	const event = new targetWindow.Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
	return event as unknown as ClipboardEvent;
}

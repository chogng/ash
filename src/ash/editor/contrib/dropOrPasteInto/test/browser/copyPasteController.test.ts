import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { BrowserClipboardService } from '../../../../../platform/clipboard/browser/clipboardService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { QuickInputController } from '../../../../../platform/quickinput/browser/quickInputController.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { registerWindow } from '../../../../../base/browser/window.js';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
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

const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
suiteTeardown(() => { if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard); else Reflect.deleteProperty(navigator, 'clipboard'); });
await import('../../../clipboard/browser/clipboard.js');
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

test('Plain text and file-name paste use the default input path', async () => {
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
	await CopyPasteController.get(editor)!.finishedPaste();
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
	await CopyPasteController.get(editor)!.finishedPaste();

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
	const selector = dom.window.document.querySelector<HTMLElement>('.stanza-editor-post-edit-selector');
	assert.ok(selector);
	assert.equal(paste.defaultPrevented, true);
	assert.equal(disposedSessions, 1);
	selector.querySelector<HTMLButtonElement>('button')!.click();
	assert.equal(dom.window.document.querySelectorAll('[role=menuitem]').length, 2);
	assert.equal(selector.querySelector('button')!.getAttribute('aria-label'), 'Paste options');
	const plainOption = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(option => option.textContent === 'Insert Plain Text');
	assert.ok(plainOption);
	plainOption.click();
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
				dispose() { },
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
	const selector = dom.window.document.querySelector<HTMLElement>('.stanza-editor-post-edit-selector');
	assert.ok(selector);
	selector.querySelector<HTMLButtonElement>('button')!.click();
	const plainOption = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(option => option.textContent === 'Insert Plain Text');
	assert.ok(plainOption);
	plainOption.click();
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
				dispose() { },
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
	using services = new InstantiationService();
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
				dispose() { },
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
	const selector = dom.window.document.querySelector<HTMLElement>('.stanza-editor-post-edit-selector');
	assert.ok(selector);
	selector.querySelector<HTMLButtonElement>('button')!.click();
	const plainOption = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(option => option.textContent === 'Insert Plain Text');
	assert.ok(plainOption);
	plainOption.click();
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
			return { edits: [{ title: 'Insert Snippet', kind, insertText: { snippet: '${1:x}$0' } }], dispose() { } };
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
			return { edits: [{ title: 'Delayed', kind, insertText: 'late' }], dispose() { } };
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
	using registeredWindow = registerWindow(dom.window as unknown as Window);
	using services = new InstantiationService();
	using clipboard = new EventClipboard(dom);
	services.registerInstance(IClipboardService, clipboard);
	using quickInput = new QuickInputController(dom.window.document.body);
	services.registerInstance(IQuickInputService, quickInput);
	registerCodeEditorServices(services);

	using model = new TextModel('old');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model });
	editor.setSelection(new Selection(1, 1, 1, 4));

	clipboard.data.setData('text/html', '<b>markup</b>');
	await CopyPasteController.get(editor)!.pasteAs({ only: new HierarchicalKind('html') });

	assert.equal(model.getText(), '<b>markup</b>');
});

test('Paste As asks which provider edit to apply when no kind is specified', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using registeredWindow = registerWindow(dom.window as unknown as Window);
	using services = new InstantiationService();
	using clipboard = new EventClipboard(dom);
	services.registerInstance(IClipboardService, clipboard);
	using quickInput = new QuickInputController(dom.window.document.body);
	services.registerInstance(IQuickInputService, quickInput);
	registerCodeEditorServices(services);

	using model = new TextModel('old');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model });
	editor.setSelection(new Selection(1, 1, 1, 4));

	clipboard.data.setData('text/plain', 'plain');
	clipboard.data.setData('text/html', '<b>markup</b>');
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
	using registeredWindow = registerWindow(dom.window as unknown as Window);
	using services = new InstantiationService();
	using clipboard = new EventClipboard(dom);
	services.registerInstance(IClipboardService, clipboard);
	using quickInput = new QuickInputController(dom.window.document.body);
	services.registerInstance(IQuickInputService, quickInput);
	registerCodeEditorServices(services);
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
			return { edits: [{ title: 'Insert Prepared', kind, insertText: value }], dispose() { } };
		},
	};
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, provider);
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model, languageFeaturesService: features });
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
	await CopyPasteController.get(editor)!.finishedPaste();
	assert.deepEqual({ text: model.getText(), provided }, { text: 'source', provided: 1 });


	editor.setSelection(new Selection(1, 1, 1, 7));
	clipboard.data = data;
	await CopyPasteController.get(editor)!.pasteAs({ preferences: [kind] });
	assert.deepEqual({ text: model.getText(), provided }, { text: 'prepared value', provided: 2 });
});

test('Paste as Text ignores URI metadata added during copy preparation', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using registeredWindow = registerWindow(dom.window as unknown as Window);
	using services = new InstantiationService();
	using clipboard = new EventClipboard(dom);
	services.registerInstance(IClipboardService, clipboard);
	using quickInput = new QuickInputController(dom.window.document.body);
	services.registerInstance(IQuickInputService, quickInput);
	registerCodeEditorServices(services);
	using model = new TextModel('source');
	using features = new LanguageFeaturesService();
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, {
		copyMimeTypes: ['text/uri-list'], pasteMimeTypes: [], providedPasteEditKinds: [],
		async prepareDocumentPaste() {
			const transfer = new VSDataTransfer();
			transfer.append('text/uri-list', createStringDataTransferItem('file:///workspace/source.txt'));
			return transfer;
		},
	});
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model, languageFeaturesService: features,
	});
	editor.setSelection(new Selection(1, 1, 1, 7));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const data = new TestClipboardData();
	const copy = new dom.window.Event('copy', { bubbles: true, cancelable: true });
	Object.defineProperty(copy, 'clipboardData', { value: data });
	input.dispatchEvent(copy);

	model.reset('destination');
	editor.setSelection(new Selection(1, 1, 1, 12));
	clipboard.data = data;
	await editor.getAction('editor.action.pasteAsText')!.run();
	assert.equal(model.getText(), 'source');
});

class TestClipboardData {
	private readonly values = new Map<string, string>();
	constructor(readonly files: readonly File[] = []) { }
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
				getAsString: (_callback: (value: string) => void) => { },
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

class EventClipboard extends BrowserClipboardService {
	public data = new TestClipboardData();
	public resources: readonly URI[] = [];
	constructor(private readonly dom: JSDOM) { super(undefined); }
	override async triggerPaste(): Promise<void> {
		this.dom.window.document.activeElement!.dispatchEvent(clipboardEvent(this.dom.window, this.data));
	}
	override async readResources(): Promise<{ resources: readonly URI[]; operation: 'copy'; }> {
		return { resources: this.resources, operation: 'copy' };
	}
	override async readText(): Promise<string> { throw new Error('The command must preserve the paste event formats'); }
}

test('Paste As merges service resources without replacing event URI data', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using registeredWindow = registerWindow(dom.window as unknown as Window);
	using services = new InstantiationService();
	using clipboard = new EventClipboard(dom);
	services.registerInstance(IClipboardService, clipboard);
	using quickInput = new QuickInputController(dom.window.document.body);
	services.registerInstance(IQuickInputService, quickInput);
	registerCodeEditorServices(services);
	using model = new TextModel('');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, instantiationService: services });
	clipboard.data.setData('text/plain', 'file path fallback');
	clipboard.resources = [URI.file('/workspace/service.ts')];
	await CopyPasteController.get(editor)!.pasteAs({ only: new HierarchicalKind('uri') });
	assert.equal(model.getText(), '/workspace/service.ts');
	model.setValue('');
	clipboard.data.setData('text/uri-list', 'file:///workspace/event.ts');
	await CopyPasteController.get(editor)!.pasteAs({ only: new HierarchicalKind('uri') });
	assert.equal(model.getText(), '/workspace/event.ts');
});

test('Paste command resolves after delayed provider edits', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using registeredWindow = registerWindow(dom.window as unknown as Window);
	using services = new InstantiationService();
	using clipboard = new EventClipboard(dom);
	services.registerInstance(IClipboardService, clipboard);
	registerCodeEditorServices(services);
	using features = new LanguageFeaturesService();
	const started = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	const kind = new HierarchicalKind('text.waiting');
	let disposed = 0;
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			await started.complete();
			await release.p;
			return { edits: [{ title: 'Delayed edit', kind, insertText: 'provided' }], dispose() { disposed++; } };
		},
	});
	using model = new TextModel('');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, instantiationService: services, languageFeaturesService: features });
	editor.focus();
	clipboard.data.setData('text/plain', 'raw');
	let complete = false;
	const commands = services.get((await import('../../../../../platform/commands/common/commands.js')).ICommandService);
	const paste = commands.executeCommand('editor.action.clipboardPasteAction').then(() => { complete = true; });
	await started.p;
	assert.deepEqual({ text: model.getText(), complete }, { text: '', complete: false });
	await release.complete();
	await paste;
	assert.deepEqual({ text: model.getText(), complete, disposed }, { text: 'provided', complete: true, disposed: 1 });
});

test('Cancelling a paste ends the command before an uncooperative provider returns and releases its late session', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using registeredWindow = registerWindow(dom.window as unknown as Window);
	using services = new InstantiationService();
	using clipboard = new EventClipboard(dom);
	services.registerInstance(IClipboardService, clipboard);
	registerCodeEditorServices(services);
	using features = new LanguageFeaturesService();
	const started = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	const disposed = new DeferredPromise<void>();
	const kind = new HierarchicalKind('text.delayed');
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, {
		copyMimeTypes: [], pasteMimeTypes: ['text/plain'], providedPasteEditKinds: [kind],
		async provideDocumentPasteEdits() {
			await started.complete();
			await release.p;
			return { edits: [{ title: 'Delayed edit', kind, insertText: 'stale' }], dispose() { void disposed.complete(); } };
		},
	});
	using model = new TextModel('');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, instantiationService: services, languageFeaturesService: features });
	editor.focus();
	clipboard.data.setData('text/plain', 'raw');
	const commands = services.get((await import('../../../../../platform/commands/common/commands.js')).ICommandService);
	const paste = commands.executeCommand('editor.action.clipboardPasteAction');
	await started.p;
	model.setValue('changed');
	await paste;
	assert.equal(model.getText(), 'changed');
	await release.complete();
	await disposed.p;
	assert.equal(model.getText(), 'changed');
});


for (const preference of ['html', 'text', 'picker']) {
	test(`command Paste As uses rich service data for ${preference} when a paste event cannot be triggered`, async () => {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		using closeWindow = toDisposable(() => dom.window.close());
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using registeredWindow = registerWindow(dom.window as unknown as Window);
		using services = new InstantiationService();
		using clipboard = new BrowserClipboardService({
			read: async () => [{ types: ['text/plain', 'text/html'], getType: async (type: string) => new Blob([type === 'text/html' ? '<b>rich</b>' : 'plain']) }],
			readText: async () => { throw new Error('Paste As must use all MIME types'); },
		} as unknown as Clipboard);
		services.registerInstance(IClipboardService, clipboard);
		using quickInput = new QuickInputController(dom.window.document.body);
		services.registerInstance(IQuickInputService, quickInput);
		registerCodeEditorServices(services);
		using model = new TextModel('old');
		using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model });
		editor.setSelection(new Selection(1, 1, 1, 4));
		const paste = editor.getAction(preference === 'text' ? 'editor.action.pasteAsText' : 'editor.action.pasteAs')!.run(preference === 'html' ? { kind: 'html' } : undefined);
		if (preference === 'picker') {
			await waitFor(() => dom.window.document.querySelector('.ash-quick-pick') !== null);
			assert.equal(model.getText(), 'old');
			const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick input')!;
			input.value = 'HTML';
			input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
			input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		}
		await paste;
		assert.equal(model.getText(), preference === 'text' ? 'plain' : '<b>rich</b>');
		model.undo();
		assert.equal(model.getText(), 'old');
	});
}

for (const change of ['selection', 'content', 'focus', 'readOnly', 'dispose']) {
	test(`command Paste As cancels a delayed rich read on ${change}`, async () => {
		const dom = new JSDOM('<!doctype html><body><main></main><input></body>');
		using closeWindow = toDisposable(() => dom.window.close());
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using services = new InstantiationService();
		const started = new DeferredPromise<void>();
		const release = new DeferredPromise<ClipboardItem[]>();
		using clipboard = new BrowserClipboardService({ read: () => { void started.complete(); return release.p; } } as Clipboard);
		services.registerInstance(IClipboardService, clipboard);
		registerCodeEditorServices(services);
		using model = new TextModel('old');
		using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model });
		const paste = editor.getAction('editor.action.pasteAs')!.run({ kind: 'html' });
		await started.p;
		if (change === 'selection') editor.setPosition({ lineNumber: 1, column: 2 });
		if (change === 'content') model.setValue('changed');
		if (change === 'focus') dom.window.document.querySelector('input')!.focus();
		if (change === 'readOnly') editor.updateOptions({ readOnly: true });
		if (change === 'dispose') editor.dispose();
		await paste;
		await release.complete([{ types: ['text/html'], getType: async () => new Blob(['<b>late</b>']) } as unknown as ClipboardItem]);
		await Promise.resolve();
		assert.equal(model.getText(), change === 'content' ? 'changed' : 'old');
	});
}


test('command Paste As matches copied preparation metadata read from a byte snapshot', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using services = new InstantiationService();
	const copied = new TestClipboardData();
	using clipboard = new BrowserClipboardService({
		read: async () => [{ types: copied.types, getType: async (type: string) => new Blob([copied.getData(type)]) }],
	} as unknown as Clipboard);
	services.registerInstance(IClipboardService, clipboard);
	registerCodeEditorServices(services);
	using features = new LanguageFeaturesService();
	const kind = new HierarchicalKind('prepared');
	let metadataRemoved = false;
	using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, {
		copyMimeTypes: ['application/x-test-prepared'], pasteMimeTypes: ['application/x-test-prepared'], providedPasteEditKinds: [kind],
		async prepareDocumentPaste() {
			const transfer = new VSDataTransfer();
			transfer.append('application/x-test-prepared', createStringDataTransferItem('prepared text'));
			return transfer;
		},
		async provideDocumentPasteEdits(_model, _ranges, transfer) {
			metadataRemoved = !transfer.has('application/x-ash-paste-provider-id') && !transfer.matches('files');
			return { edits: [{ title: 'Insert prepared text', kind, insertText: await transfer.get('application/x-test-prepared')!.asString() }], dispose() { } };
		},
	});
	using model = new TextModel('source');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model, languageFeaturesService: features });
	editor.setSelection(new Selection(1, 1, 1, 7));
	const input = editor.controller.editContext.domNode.domNode;
	input.focus();
	const copy = new dom.window.Event('copy', { bubbles: true, cancelable: true });
	Object.defineProperty(copy, 'clipboardData', { value: copied });
	input.dispatchEvent(copy);
	await editor.getAction('editor.action.pasteAs')!.run({ kind: 'prepared' });
	assert.deepEqual({ text: model.getText(), metadataRemoved }, { text: 'prepared text', metadataRemoved: true });
	model.undo();
	assert.equal(model.getText(), 'source');
});

for (const mime of ['image/png', 'application/pdf', 'application/x-test-binary', 'application/x-test-paste', 'application/json', 'application/vnd.test+xml']) {
	test(`command Paste As supplies ${mime} to its registered provider`, async () => {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		using closeWindow = toDisposable(() => dom.window.close());
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using services = new InstantiationService();
		const isCustomText = ['application/x-test-paste', 'application/json', 'application/vnd.test+xml'].includes(mime);
		const bytes = isCustomText ? new TextEncoder().encode('custom metadata') : Uint8Array.of(255, 128, 0, 80, 68, 70);
		using clipboard = new BrowserClipboardService({
			read: async () => [{ types: [mime], getType: async () => new Blob([bytes]) }],
		} as unknown as Clipboard);
		services.registerInstance(IClipboardService, clipboard);
		registerCodeEditorServices(services);
		using features = new LanguageFeaturesService();
		const kind = new HierarchicalKind('custom');
		let received: unknown;
		using registration = features.documentPasteEditProvider.register({ language: 'plaintext', hasAccessToAllModels: true }, {
			copyMimeTypes: [], pasteMimeTypes: [isCustomText ? mime : 'files'], providedPasteEditKinds: [kind],
			async provideDocumentPasteEdits(_model, _ranges, transfer) {
				const item = transfer.get(mime)!;
				if (isCustomText) {
					received = await item.asString();
				} else {
					const file = item.asFile()!;
					received = { bytes: await file.data(), name: file.name, value: item.value, text: await item.asString() };
				}
				return { edits: [{ title: 'Insert custom data', kind, insertText: 'provided' }], dispose() { } };
			},
		});
		using model = new TextModel('');
		using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model, languageFeaturesService: features });
		await editor.getAction('editor.action.pasteAs')!.run({ kind: 'custom' });
		const expectedExtension = mime === 'image/png' ? '.png' : mime === 'application/pdf' ? '.pdf' : '.bin';
		assert.deepEqual({ received, text: model.getText() }, {
			received: isCustomText ? 'custom metadata' : { bytes, name: `clipboard${expectedExtension}`, value: undefined, text: '' },
			text: 'provided',
		});
	});
}

test('command Paste As ends quietly when its clipboard read returns empty', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeWindow = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using services = new InstantiationService();
	using clipboard = new BrowserClipboardService({ read: async () => [] } as unknown as Clipboard);
	services.registerInstance(IClipboardService, clipboard);
	registerCodeEditorServices(services);
	using model = new TextModel('old');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, instantiationService: services, model });
	await editor.getAction('editor.action.pasteAs')!.run();
	assert.deepEqual({ text: model.getText(), notifications: services.get(INotificationService).getNotifications() }, { text: 'old', notifications: [] });
});

import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import type { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IOutputService, type IOutputChannel, type OutputChannelKind } from '../../../../services/output/common/output.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { OutputViewPane } from '../../browser/outputView.js';

interface OutputViewTestEnvironment {
	readonly channel: IOutputChannel;
	readonly output: IOutputService;
	readonly pane: OutputViewPane;
	readonly editor: CodeEditorWidget;
	readonly services: InstantiationService;
	filter(text: string): void;
	visibleLines(): readonly string[];
}

async function createOutputView(resources: DisposableStore, kind: OutputChannelKind = 'output', storage?: IStorageService): Promise<OutputViewTestEnvironment> {
	const container = browserEnvironment.window.document.createElement('section');
	browserEnvironment.window.document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	const outputScope = workbenchInstantiationService(resources, storage);
	const output = outputScope.get(IOutputService);
	const channel = resources.add(output.createChannel({ id: 'first', label: 'First', kind }));
	const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
	const services = createCodeEditorServices(resources, outputScope);
	services.registerInstance(IAccessibleViewService, {
		...toDisposable(() => undefined),
		show: () => false,
		getOpenAriaHint: () => undefined,
		disableHint: async () => undefined,
		showAccessibleViewHelp: () => undefined,
	});
	const pane = resources.add(services.createInstance(OutputViewPane, container, { id: 'ash.output.test', title: 'Output' }));
	container.append(pane.element);
	pane.setVisible(true);
	const editor = services.get(ICodeEditorService).listCodeEditors()[0];
	assert.ok(editor instanceof CodeEditorWidget);
	await waitForChannel(editor, channel);
	const input = pane.element.querySelector<HTMLInputElement>('.ash-output-filter-input');
	assert.ok(input);
	return {
		channel, output, pane, editor, services,
		filter(text: string): void {
			input.value = text;
			input.dispatchEvent(new browserEnvironment.window.Event('input'));
		},
		visibleLines(): readonly string[] {
			const model = editor.getModel();
			const viewModel = editor._getViewModel();
			if (!model || !viewModel) {
				return [];
			}
			const hidden = viewModel.getHiddenAreas();
			return model.getLinesContent().filter((text, index) => text.length > 0 && !hidden.some(range => index + 1 >= range.startLineNumber && index + 1 <= range.endLineNumber));
		},
	};
}

async function waitForChannel(editor: CodeEditorWidget, channel: IOutputChannel): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (editor.getModel()?.uri.toString() !== channel.uri.toString()) {
		assert.ok(Date.now() < deadline, `Output did not bind channel ${channel.id}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

test('ordinary Output filters individual lines without changing the shared text model', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	const text = 'keep first\ndrop\nkeep banned\nlast keep';
	view.channel.append({ text });
	using reference = await view.services.get(ITextModelService).createModelReference(view.channel.uri);
	view.filter('keep,!banned');
	assert.deepEqual({ visible: view.visibleLines(), retained: view.channel.getText(), shared: reference.object.textEditorModel.getValue() }, {
		visible: ['keep first', 'last keep'], retained: text, shared: text,
	});
	view.filter('!banned');
	assert.deepEqual(view.visibleLines(), ['keep first', 'drop', 'last keep']);
	view.filter('absent');
	assert.deepEqual(view.visibleLines(), []);
	assert.equal(view.editor.getModel(), null);
	view.filter('');
	assert.deepEqual(view.visibleLines(), ['keep first', 'drop', 'keep banned', 'last keep']);
	assert.equal(view.editor.getModel(), reference.object.textEditorModel);
});

test('ordinary Output matches split writes, split CRLF and an unfinished last line on every append', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.filter('keep');
	view.channel.append({ text: 'kee' });
	assert.deepEqual(view.visibleLines(), []);
	view.channel.append({ text: 'p first\r' });
	assert.deepEqual(view.visibleLines(), ['keep first']);
	view.channel.append({ text: '\ndrop\r' });
	view.channel.append({ text: '\nkee' });
	assert.deepEqual(view.visibleLines(), ['keep first']);
	view.channel.append({ text: 'p second' });
	assert.deepEqual(view.visibleLines(), ['keep first', 'keep second']);
	view.filter('keep,!second');
	assert.deepEqual(view.visibleLines(), ['keep first']);
	assert.equal(view.channel.getText(), 'keep first\r\ndrop\r\nkeep second');
});

test('Output keeps severity and category filters and preserves multiline log records', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources, 'log');
	view.channel.append({ text: 'keep first\ncontinuation\n', severity: 'warning', category: 'build' });
	view.channel.append({ text: 'other record\n', severity: 'information', category: 'server' });
	view.filter('keep');
	assert.deepEqual(view.visibleLines(), ['keep first', 'continuation']);
	view.output.filters.setSeverityVisible('warning', false);
	assert.deepEqual(view.visibleLines(), []);
	view.output.filters.setSeverityVisible('warning', true);
	view.output.filters.setCategoryVisible('build', false);
	assert.deepEqual(view.visibleLines(), []);
	view.output.filters.reset();
	view.filter('!continuation');
	assert.deepEqual(view.visibleLines(), ['other record']);
});

test('Output filters follow channel switching, inactive appends, clearing and disposal', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.channel.append({ text: 'keep first\ndrop\n' });
	const second = resources.add(view.output.createChannel({ id: 'second', label: 'Second' }));
	second.append({ text: 'other\nkeep second' });
	view.filter('keep');
	view.output.selectChannel(second.id);
	await waitForChannel(view.editor, second);
	assert.deepEqual(view.visibleLines(), ['keep second']);
	view.channel.append({ text: 'keep appended\n' });
	assert.deepEqual(view.visibleLines(), ['keep second']);
	view.output.selectChannel(view.channel.id);
	await waitForChannel(view.editor, view.channel);
	assert.deepEqual(view.visibleLines(), ['keep first', 'keep appended']);
	view.channel.clear();
	assert.deepEqual(view.visibleLines(), []);
	view.channel.append({ text: 'keep replacement' });
	assert.deepEqual(view.visibleLines(), ['keep replacement']);
	view.channel.dispose();
	await waitForChannel(view.editor, second);
	assert.deepEqual(view.visibleLines(), ['keep second']);
	second.dispose();
	assert.equal(view.editor.getModel(), null);
	view.pane.dispose();
	assert.equal(view.services.get(ICodeEditorService).listCodeEditors().length, 0);
});


test('Output presents comma alternatives and literal quoted text from the actual filter input', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.channel.append({ text: 'keep one\nother two\nkeep banned\n"a,b"\na,b', category: 'metadata' });
	view.filter('keep,other,!banned');
	assert.deepEqual(view.visibleLines(), ['keep one', 'other two']);
	view.filter('"a,b"');
	assert.deepEqual(view.visibleLines(), ['"a,b"']);
	view.filter('metadata');
	assert.deepEqual(view.visibleLines(), []);
	const input = view.pane.element.querySelector<HTMLInputElement>('.ash-output-filter-input')!;
	assert.equal(input.hasAttribute('title'), false);
	assert.equal(input.hasAttribute('aria-description'), false);
});

test('Output announces a restored saved query and leaves it on input, Escape or reset', async () => {
	for (const action of ['input', 'escape', 'reset']) {
		using resources = new DisposableStore();
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		const storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'restored-output', backend: browser.window.localStorage, flushInterval: 0 }));
		resources.add(toDisposable(() => browser.window.close()));
		storage.store('output.filterState', JSON.stringify({ text: 'keep !banned', hiddenSeverities: [], hiddenCategories: [] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const view = await createOutputView(resources, 'output', storage);
		view.channel.append({ text: 'keep one\ndrop\nkeep banned' });
		const input = view.pane.element.querySelector<HTMLInputElement>('.ash-output-filter-input')!;
		assert.deepEqual(view.visibleLines(), ['keep one']);
		assert.match(input.title, /Saved filter restored/);
		assert.equal(input.getAttribute('aria-description'), input.title);
		view.output.filters.setSeverityVisible('trace', false);
		assert.deepEqual(view.visibleLines(), ['keep one']);
		assert.match(input.title, /Saved filter restored/);
		if (action === 'input') { view.filter('keep !banned'); }
		else if (action === 'escape') { input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
		else { view.output.filters.reset(); }
		assert.deepEqual(view.visibleLines(), action === 'input' ? [] : ['keep one', 'drop', 'keep banned']);
		assert.equal(input.hasAttribute('title'), false);
		assert.equal(input.hasAttribute('aria-description'), false);
		assert.equal(JSON.parse(storage.get('output.filterState', StorageScope.WORKSPACE)!).syntaxVersion, 2);
	}
});

test('Output explains unsupported saved queries without replacing their storage', async () => {
	using resources = new DisposableStore();
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'future-output', backend: browser.window.localStorage, flushInterval: 0 }));
	resources.add(toDisposable(() => browser.window.close()));
	const raw = JSON.stringify({ syntaxVersion: 3, text: 'future', future: true });
	storage.store('output.filterState', raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const view = await createOutputView(resources, 'output', storage);
	view.channel.append({ text: 'keep one\ndrop' });
	view.filter('keep');
	assert.deepEqual(view.visibleLines(), ['keep one']);
	const input = view.pane.element.querySelector<HTMLInputElement>('.ash-output-filter-input')!;
	assert.match(input.title, /Changes in this window are not saved/);
	assert.equal(input.getAttribute('aria-description'), input.title);
	assert.equal(storage.get('output.filterState', StorageScope.WORKSPACE), raw);
});


test('ordinary Output keeps hidden line numbers and raw text across CR, empty chunks and standalone LF', async () => {
	for (const emptyChunks of [false, true]) {
		using resources = new DisposableStore();
		const view = await createOutputView(resources);
		using reference = await view.services.get(ITextModelService).createModelReference(view.channel.uri);
		view.filter('keep');
		let raw = '';
		const append = (text: string, visible: readonly string[], hidden: readonly number[], modelText: string): void => {
			view.channel.append({ text });
			raw += text;
			const model = reference.object.textEditorModel;
			const areas = view.editor._getViewModel()!.getHiddenAreas();
			const hiddenLines = model.getLinesContent().flatMap((line, index) => line && areas.some(range => index + 1 >= range.startLineNumber && index + 1 <= range.endLineNumber) ? [index + 1] : []);
			assert.deepEqual({ visible: view.visibleLines(), hidden: hiddenLines, retained: view.channel.getText(), shared: model.getValue().replaceAll('\r\n', '\n') }, {
				visible, hidden, retained: raw, shared: modelText,
			});
		};
		append('keep first\r', ['keep first'], [], 'keep first\n');
		if (emptyChunks) { append('', ['keep first'], [], 'keep first\n'); }
		append('\n', ['keep first'], [], 'keep first\n');
		append('drop\r', ['keep first'], [2], 'keep first\ndrop\n');
		if (emptyChunks) { append('', ['keep first'], [2], 'keep first\ndrop\n'); }
		append('\n', ['keep first'], [2], 'keep first\ndrop\n');
		append('kee', ['keep first'], [2, 3], 'keep first\ndrop\nkee');
		if (emptyChunks) { append('', ['keep first'], [2, 3], 'keep first\ndrop\nkee'); }
		append('p second', ['keep first', 'keep second'], [2], 'keep first\ndrop\nkeep second');
		view.filter('keep,!first');
		assert.deepEqual(view.visibleLines(), ['keep second']);
		assert.equal(view.channel.getText(), 'keep first\r\ndrop\r\nkeep second');
		assert.equal(reference.object.textEditorModel.getValue().replaceAll('\r\n', '\n'), 'keep first\ndrop\nkeep second');
	}
});

for (const action of ['empty-input', 'same-input', 'empty-reset']) {
	test(`Output updates the accessible future-schema notice after no-op input or reset (${action})`, async () => {
		using resources = new DisposableStore();
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		const storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'later-future-output', backend: browser.window.localStorage, flushInterval: 0 }));
		resources.add(toDisposable(() => browser.window.close()));
		const view = await createOutputView(resources, 'output', storage);
		view.channel.append({ text: 'keep one\ndrop' });
		const query = action === 'same-input' ? 'keep' : '';
		view.filter(query);
		const raw = JSON.stringify({ syntaxVersion: 3, text: 'future', future: { untouched: true } });
		storage.store('output.filterState', raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (action === 'empty-reset') { view.output.filters.reset(); }
		else { view.filter(query); }
		const input = view.pane.element.querySelector<HTMLInputElement>('.ash-output-filter-input')!;
		assert.match(input.title, /Changes in this window are not saved/);
		assert.equal(input.getAttribute('aria-description'), input.title);
		assert.deepEqual(view.visibleLines(), query ? ['keep one'] : ['keep one', 'drop']);
		assert.equal(storage.get('output.filterState', StorageScope.WORKSPACE), raw);
	});
}

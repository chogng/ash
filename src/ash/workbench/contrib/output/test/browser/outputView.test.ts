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
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import '../../browser/output.contribution.js';
import { DefaultSettings } from '../../../../services/preferences/common/settingsModels.js';
import { createSettingsLayout } from '../../../preferences/browser/settingsLayout.js';

interface OutputViewTestEnvironment {
	readonly channel: IOutputChannel;
	readonly output: IOutputService;
	readonly pane: OutputViewPane;
	readonly editor: CodeEditorWidget;
	readonly services: InstantiationService;
	filter(text: string): void;
	visibleLines(): Promise<readonly string[]>;
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
		async visibleLines(): Promise<readonly string[]> {
			// Channel refreshes yield to the event loop; inspect the rendered result.
			await new Promise<void>(resolve => setTimeout(resolve, 0));
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

test('Output keeps nested channel changes guarded until the outer editor operation returns', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.channel.appendLine({ text: 'keep first' });
	await view.visibleLines();
	const second = resources.add(view.output.createChannel({ id: 'nested', label: 'Nested' }));
	second.appendLine({ text: 'keep second' });
	const input = view.pane.element.querySelector<HTMLInputElement>('.ash-output-filter-input')!;
	const setModel = view.editor.setModel.bind(view.editor);
	const setHiddenAreas = view.editor.setHiddenAreas.bind(view.editor);
	let insideOuterOperation = false;
	let nestedModelChanges = 0;
	let observedFilter: string | undefined;
	view.editor.setModel = (...args) => {
		if (insideOuterOperation) nestedModelChanges++;
		return setModel(...args);
	};
	view.editor.setHiddenAreas = (...args) => {
		const result = setHiddenAreas(...args);
		if (observedFilter === undefined) {
			insideOuterOperation = true;
			try {
				// Selecting a channel detaches the editor inside the current render.
				view.output.selectChannel(second.id);
				view.output.filters.setText('second');
				// This independent service event must still observe the outer guard.
				resources.add(view.output.createChannel({ id: 'during-render', label: 'During Render' }));
				observedFilter = input.value;
			} finally { insideOuterOperation = false; }
		}
		return result;
	};
	resources.add(toDisposable(() => {
		view.editor.setModel = setModel;
		view.editor.setHiddenAreas = setHiddenAreas;
	}));
	view.filter('keep');
	assert.ok(nestedModelChanges > 0, 'The production channel switch nested an editor model operation');
	assert.equal(observedFilter, 'keep', 'Nested filter input must wait for the outer editor operation');
	await waitForChannel(view.editor, second);
	assert.deepEqual({ visible: await view.visibleLines(), input: input.value, retained: second.getText() }, {
		visible: ['keep second'], input: 'second', retained: 'keep second\n',
	});
});

test('Output yields between continuous editor diagnostics and retains every write once', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources, 'log');
	const count = 128;
	let emitted = 0;
	let firstRender!: () => void;
	const rendered = new Promise<void>(resolve => { firstRender = resolve; });
	const setHiddenAreas = view.editor.setHiddenAreas.bind(view.editor);
	view.editor.setHiddenAreas = (...args) => {
		const result = setHiddenAreas(...args);
		if (emitted < count) {
			view.channel.appendLine({ text: `diagnostic ${emitted++}`, category: 'lifecycle' });
		}
		firstRender();
		return result;
	};
	resources.add(toDisposable(() => { view.editor.setHiddenAreas = setHiddenAreas; }));
	view.channel.appendLine({ text: 'seed' });
	await rendered;
	assert.equal(emitted, 1, 'The next diagnostic render must not drain on the same stack');
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	assert.ok(emitted < count, 'An unrelated event-loop task can run before continuous logging completes');
	const deadline = Date.now() + 5_000;
	while (emitted < count) {
		assert.ok(Date.now() < deadline, 'Output did not consume the finite diagnostic stream');
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	const expected = ['seed', ...Array.from({ length: count }, (_, index) => `diagnostic ${index}`)];
	using reference = await view.services.get(ITextModelService).createModelReference(view.channel.uri);
	assert.deepEqual({ visible: await view.visibleLines(), retained: view.channel.getText(), shared: reference.object.textEditorModel.getValue() }, {
		visible: expected, retained: expected.join('\n') + '\n', shared: expected.join('\n') + '\n',
	});
});

test('Output disposal cancels a queued diagnostic render and leaves its channel alive', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	let renders = 0;
	let firstRender!: () => void;
	const rendered = new Promise<void>(resolve => { firstRender = resolve; });
	const setHiddenAreas = view.editor.setHiddenAreas.bind(view.editor);
	view.editor.setHiddenAreas = (...args) => {
		const result = setHiddenAreas(...args);
		if (++renders === 1) view.channel.appendLine({ text: 'queued diagnostic' });
		firstRender();
		return result;
	};
	resources.add(toDisposable(() => { view.editor.setHiddenAreas = setHiddenAreas; }));
	view.channel.appendLine({ text: 'seed' });
	await rendered;
	assert.equal(renders, 1);
	view.pane.dispose();
	view.channel.appendLine({ text: 'after view disposal' });
	await new Promise<void>(resolve => setTimeout(resolve, 10));
	assert.deepEqual({ renders, retained: view.channel.getText(), editors: view.services.get(ICodeEditorService).listCodeEditors().length }, {
		renders: 1, retained: 'seed\nqueued diagnostic\nafter view disposal\n', editors: 0,
	});
});

test('ordinary Output filters individual lines without changing the shared text model', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	const text = 'keep first\ndrop\nkeep banned\nlast keep';
	view.channel.append({ text });
	using reference = await view.services.get(ITextModelService).createModelReference(view.channel.uri);
	view.filter('keep,!banned');
	assert.deepEqual({ visible: await view.visibleLines(), retained: view.channel.getText(), shared: reference.object.textEditorModel.getValue() }, {
		visible: ['keep first', 'last keep'], retained: text, shared: text,
	});
	view.filter('!banned');
	assert.deepEqual(await view.visibleLines(), ['keep first', 'drop', 'last keep']);
	view.filter('absent');
	assert.deepEqual(await view.visibleLines(), []);
	assert.equal(view.editor.getModel(), null);
	view.filter('');
	assert.deepEqual(await view.visibleLines(), ['keep first', 'drop', 'keep banned', 'last keep']);
	assert.equal(view.editor.getModel(), reference.object.textEditorModel);
});

test('ordinary Output matches split writes, split CRLF and an unfinished last line on every append', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.filter('keep');
	view.channel.append({ text: 'kee' });
	assert.deepEqual(await view.visibleLines(), []);
	view.channel.append({ text: 'p first\r' });
	assert.deepEqual(await view.visibleLines(), ['keep first']);
	view.channel.append({ text: '\ndrop\r' });
	view.channel.append({ text: '\nkee' });
	assert.deepEqual(await view.visibleLines(), ['keep first']);
	view.channel.append({ text: 'p second' });
	assert.deepEqual(await view.visibleLines(), ['keep first', 'keep second']);
	view.filter('keep,!second');
	assert.deepEqual(await view.visibleLines(), ['keep first']);
	assert.equal(view.channel.getText(), 'keep first\r\ndrop\r\nkeep second');
});

test('Output keeps severity and category filters and preserves multiline log records', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources, 'log');
	view.channel.append({ text: 'keep first\ncontinuation\n', severity: 'warning', category: 'build' });
	view.channel.append({ text: 'other record\n', severity: 'information', category: 'server' });
	view.filter('keep');
	assert.deepEqual(await view.visibleLines(), ['keep first', 'continuation']);
	view.output.filters.setSeverityVisible('warning', false);
	assert.deepEqual(await view.visibleLines(), []);
	view.output.filters.setSeverityVisible('warning', true);
	view.output.filters.setCategoryVisible('build', false, view.channel.id);
	assert.deepEqual(await view.visibleLines(), []);
	view.output.filters.reset();
	view.filter('!continuation');
	assert.deepEqual(await view.visibleLines(), ['other record']);
});

function categoryMenuItem(view: OutputViewTestEnvironment, category: string): HTMLButtonElement {
	const button = view.pane.partTitleProjection!.actions!.querySelector<HTMLButtonElement>('[data-action-id="ash.output.filter"] button');
	assert.ok(button);
	button.click();
	const item = [...browserEnvironment.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find(item => item.getAttribute('aria-label') === category);
	assert.ok(item, `Category menu item is available: ${category}`);
	return item;
}

for (const restored of [false, true]) {
	test(`Output category menu applies explicit choices to its channel and retains other legacy choices (${restored ? 'restored' : 'fresh'})`, async () => {
		using resources = new DisposableStore();
		const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		const storage = resources.add(new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'channel-categories', backend: browser.window.localStorage, flushInterval: 0 }));
		resources.add(toDisposable(() => browser.window.close()));
		const saved = JSON.stringify({ syntaxVersion: 2, text: '', hiddenSeverities: [], hiddenCategories: ['lifecycle', 'build'] });
		if (restored) storage.store('output.filterState', saved, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const view = await createOutputView(resources, 'log', storage);
		const second = resources.add(view.output.createChannel({ id: 'second', label: 'Second', kind: 'log' }));
		for (const [channel, label] of [[view.channel, 'first'], [second, 'second']] as const) {
			channel.appendLine({ text: `${label} lifecycle`, category: 'lifecycle' });
			channel.appendLine({ text: `${label} build`, category: 'build' });
			channel.appendLine({ text: `${label} other` });
		}
		using reference = await view.services.get(ITextModelService).createModelReference(view.channel.uri);
		assert.deepEqual(await view.visibleLines(), restored ? ['first other'] : ['first lifecycle', 'first build', 'first other']);
		if (restored) assert.equal(storage.get('output.filterState', StorageScope.WORKSPACE), saved);
		const firstChoice = categoryMenuItem(view, 'lifecycle');
		assert.equal(firstChoice.getAttribute('aria-checked'), String(!restored));
		firstChoice.click();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.deepEqual(await view.visibleLines(), restored ? ['first lifecycle', 'first other'] : ['first build', 'first other']);
		assert.equal(reference.object.textEditorModel.getValue(), 'first lifecycle\nfirst build\nfirst other\n');
		view.output.selectChannel(second.id);
		await waitForChannel(view.editor, second);
		assert.deepEqual(await view.visibleLines(), restored ? ['second lifecycle', 'second other'] : ['second lifecycle', 'second build', 'second other']);
		const secondChoice = categoryMenuItem(view, 'lifecycle');
		assert.equal(secondChoice.getAttribute('aria-checked'), 'true');
		secondChoice.click();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.deepEqual(await view.visibleLines(), restored ? ['second other'] : ['second build', 'second other']);
		view.output.selectChannel(view.channel.id);
		await waitForChannel(view.editor, view.channel);
		assert.deepEqual(await view.visibleLines(), restored ? ['first lifecycle', 'first other'] : ['first build', 'first other']);
		view.output.filters.reset();
		assert.deepEqual(await view.visibleLines(), ['first lifecycle', 'first build', 'first other']);
		assert.equal(second.getText(), 'second lifecycle\nsecond build\nsecond other\n');
	});
}

test('Output filters follow channel switching, inactive appends, clearing and disposal', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.channel.append({ text: 'keep first\ndrop\n' });
	const second = resources.add(view.output.createChannel({ id: 'second', label: 'Second' }));
	second.append({ text: 'other\nkeep second' });
	view.filter('keep');
	view.output.selectChannel(second.id);
	await waitForChannel(view.editor, second);
	assert.deepEqual(await view.visibleLines(), ['keep second']);
	view.channel.append({ text: 'keep appended\n' });
	assert.deepEqual(await view.visibleLines(), ['keep second']);
	view.output.selectChannel(view.channel.id);
	await waitForChannel(view.editor, view.channel);
	assert.deepEqual(await view.visibleLines(), ['keep first', 'keep appended']);
	view.channel.clear();
	assert.deepEqual(await view.visibleLines(), []);
	view.channel.append({ text: 'keep replacement' });
	assert.deepEqual(await view.visibleLines(), ['keep replacement']);
	view.channel.dispose();
	await waitForChannel(view.editor, second);
	assert.deepEqual(await view.visibleLines(), ['keep second']);
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
	assert.deepEqual(await view.visibleLines(), ['keep one', 'other two']);
	view.filter('"a,b"');
	assert.deepEqual(await view.visibleLines(), ['"a,b"']);
	view.filter('metadata');
	assert.deepEqual(await view.visibleLines(), []);
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
		assert.deepEqual(await view.visibleLines(), ['keep one']);
		assert.match(input.title, /Saved filter restored/);
		assert.equal(input.getAttribute('aria-description'), input.title);
		view.output.filters.setSeverityVisible('trace', false);
		assert.deepEqual(await view.visibleLines(), ['keep one']);
		assert.match(input.title, /Saved filter restored/);
		if (action === 'input') { view.filter('keep !banned'); }
		else if (action === 'escape') { input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
		else { view.output.filters.reset(); }
		assert.deepEqual(await view.visibleLines(), action === 'input' ? [] : ['keep one', 'drop', 'keep banned']);
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
	assert.deepEqual(await view.visibleLines(), ['keep one']);
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
		const append = async (text: string, visible: readonly string[], hidden: readonly number[], modelText: string): Promise<void> => {
			view.channel.append({ text });
			raw += text;
			const rendered = await view.visibleLines();
			const model = reference.object.textEditorModel;
			const areas = view.editor._getViewModel()!.getHiddenAreas();
			const hiddenLines = model.getLinesContent().flatMap((line, index) => line && areas.some(range => index + 1 >= range.startLineNumber && index + 1 <= range.endLineNumber) ? [index + 1] : []);
			assert.deepEqual({ visible: rendered, hidden: hiddenLines, retained: view.channel.getText(), shared: model.getValue().replaceAll('\r\n', '\n') }, {
				visible, hidden, retained: raw, shared: modelText,
			});
		};
		await append('keep first\r', ['keep first'], [], 'keep first\n');
		if (emptyChunks) { await append('', ['keep first'], [], 'keep first\n'); }
		await append('\n', ['keep first'], [], 'keep first\n');
		await append('drop\r', ['keep first'], [2], 'keep first\ndrop\n');
		if (emptyChunks) { await append('', ['keep first'], [2], 'keep first\ndrop\n'); }
		await append('\n', ['keep first'], [2], 'keep first\ndrop\n');
		await append('kee', ['keep first'], [2, 3], 'keep first\ndrop\nkee');
		if (emptyChunks) { await append('', ['keep first'], [2, 3], 'keep first\ndrop\nkee'); }
		await append('p second', ['keep first', 'keep second'], [2], 'keep first\ndrop\nkeep second');
		view.filter('keep,!first');
		assert.deepEqual(await view.visibleLines(), ['keep second']);
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
		assert.deepEqual(await view.visibleLines(), query ? ['keep one'] : ['keep one', 'drop']);
		assert.equal(storage.get('output.filterState', StorageScope.WORKSPACE), raw);
	});
}

test('Output pauses on an explicit cursor move to a visible older line without scrolling and resumes on the last line', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.editor.layout({ width: 640, height: 200 });
	view.channel.append({ text: 'first\nsecond\nlast' });
	view.editor.setPosition({ lineNumber: 3, column: 1 });
	const before = view.editor.getScrollTop();
	pressOutputKey(view, 'ArrowUp');
	assert.deepEqual({ line: view.editor.getPosition()!.lineNumber, scroll: view.editor.getScrollTop(), following: followsOutput(view) }, { line: 2, scroll: before, following: false });
	pressOutputKey(view, 'ArrowDown');
	assert.deepEqual({ line: view.editor.getPosition()!.lineNumber, scroll: view.editor.getScrollTop(), following: followsOutput(view) }, { line: 3, scroll: before, following: true });
});

function autoScrollButton(view: OutputViewTestEnvironment): HTMLButtonElement {
	const button = view.pane.partTitleProjection!.actions!.querySelector<HTMLButtonElement>('[data-action-id="ash.output.autoScroll"] button');
	assert.ok(button);
	return button;
}

function followsOutput(view: OutputViewTestEnvironment): boolean {
	return autoScrollButton(view).getAttribute('aria-pressed') === 'true';
}

function pressOutputKey(view: OutputViewTestEnvironment, key: string, options: KeyboardEventInit = {}): void {
	const input = view.editor.controller.editContext.domNode.domNode;
	input.focus();
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
}

test('Output smart scrolling uses the primary selection end and includes the final empty line', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.editor.layout({ width: 640, height: 200 });
	view.channel.append({ text: 'first\nsecond\n' });
	view.editor.setSelection(new Selection(3, 1, 1, 1));
	pressOutputKey(view, 'ArrowDown', { shiftKey: true });
	assert.deepEqual({ anchor: view.editor.getSelection()!.selectionStartLineNumber, caret: view.editor.getPosition()!.lineNumber, following: followsOutput(view) }, { anchor: 3, caret: 2, following: false });
	view.editor.setSelection(new Selection(1, 1, 2, 1));
	pressOutputKey(view, 'ArrowDown', { shiftKey: true });
	assert.deepEqual({ anchor: view.editor.getSelection()!.selectionStartLineNumber, caret: view.editor.getPosition()!.lineNumber, following: followsOutput(view) }, { anchor: 1, caret: 3, following: true });
	assert.equal(view.editor.getModel()!.getLineContent(3), '');
});

test('Output smart scrolling follows the primary cursor independently of secondary cursors', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.editor.layout({ width: 640, height: 200 });
	view.channel.append({ text: 'first\nsecond\nlast' });
	view.editor.setSelections([new Selection(2, 1, 2, 1), new Selection(3, 1, 3, 1)]);
	pressOutputKey(view, 'ArrowUp');
	assert.deepEqual({ lines: view.editor.getSelections()!.map(selection => selection.positionLineNumber), following: followsOutput(view) }, { lines: [1, 2], following: false });
	view.editor.setSelections([new Selection(3, 1, 3, 1), new Selection(1, 1, 1, 1)]);
	pressOutputKey(view, 'End');
	assert.deepEqual({ lines: view.editor.getSelections()!.map(selection => selection.positionLineNumber), following: followsOutput(view) }, { lines: [3, 1], following: true });
});

test('Output programmatic cursor restoration and model updates preserve the current scrolling choice', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.editor.layout({ width: 640, height: 200 });
	view.channel.append({ text: 'first\nsecond\nlast' });
	view.editor.setPosition({ lineNumber: 2, column: 1 }, 'keyboard');
	assert.equal(followsOutput(view), true);
	view.editor.setPosition({ lineNumber: 3, column: 1 });
	const saved = view.editor.saveViewState();
	pressOutputKey(view, 'ArrowUp');
	assert.equal(followsOutput(view), false);
	view.editor.restoreViewState(saved);
	assert.deepEqual({ line: view.editor.getPosition()!.lineNumber, following: followsOutput(view) }, { line: 3, following: false });
	view.channel.replace({ text: 'replacement\nlast' });
	view.channel.append({ text: '\nnext' });
	assert.deepEqual({ following: followsOutput(view), text: view.editor.getModel()!.getValue(), retained: view.channel.getText() }, { following: false, text: 'replacement\nlast\nnext', retained: 'replacement\nlast\nnext' });
});

test('Output reads live smart scrolling configuration on the next explicit cursor gesture', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.editor.layout({ width: 640, height: 200 });
	view.channel.append({ text: 'first\nsecond\nlast' });
	const configuration = view.services.get(IConfigurationService);
	assert.equal(configuration.getValue('output.smartScroll.enabled'), true);
	await assert.rejects(configuration.updateValue('output.smartScroll.enabled', 'false', ConfigurationTarget.USER), /must be a boolean/);
	view.editor.setPosition({ lineNumber: 3, column: 1 });
	pressOutputKey(view, 'ArrowUp');
	assert.equal(followsOutput(view), false);
	await configuration.updateValue('output.smartScroll.enabled', false, ConfigurationTarget.USER);
	assert.equal(followsOutput(view), false);
	pressOutputKey(view, 'ArrowDown');
	assert.deepEqual({ line: view.editor.getPosition()!.lineNumber, following: followsOutput(view) }, { line: 3, following: false });
	await configuration.updateValue('output.smartScroll.enabled', true, ConfigurationTarget.USER);
	assert.equal(followsOutput(view), false);
	pressOutputKey(view, 'ArrowUp');
	pressOutputKey(view, 'ArrowDown');
	assert.equal(followsOutput(view), true);
	await configuration.updateValue('output.smartScroll.enabled', false, ConfigurationTarget.USER);
	pressOutputKey(view, 'ArrowUp');
	assert.deepEqual({ line: view.editor.getPosition()!.lineNumber, following: followsOutput(view) }, { line: 2, following: true });
});

test('Output retains manual scroll pausing and resuming when smart scrolling is disabled', async () => {
	using resources = new DisposableStore();
	const view = await createOutputView(resources);
	view.editor.layout({ width: 640, height: 100 });
	await view.services.get(IConfigurationService).updateValue('output.smartScroll.enabled', false, ConfigurationTarget.USER);
	view.channel.append({ text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') });
	await view.visibleLines();
	assert.ok(view.editor.getScrollTop() > 0);
	view.editor.setScrollTop(0);
	assert.equal(followsOutput(view), false);
	view.editor.setScrollTop(view.editor.getContentHeight());
	assert.equal(followsOutput(view), true);
});


test('Output smart scrolling is editable in the existing Settings interaction group', () => {
	const defaults = new DefaultSettings();
	const layout = createSettingsLayout(defaults.all);
	const setting = layout.find(category => category.id === 'general')?.groups.find(group => group.id === 'interaction')?.settings.find(setting => setting.id === 'output.smartScroll.enabled');
	assert.ok(setting);
	assert.deepEqual({ type: setting.valueType, defaultValue: setting.configuration.defaultValue, title: setting.title }, { type: 'boolean', defaultValue: true, title: 'Output smart scrolling' });
});

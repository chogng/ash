import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../../../platform/clipboard/browser/clipboardService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { SelectionClipboard } from '../../electron-browser/selectionClipboard.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { localize2, resetNlsResolver } from '../../../../../nls.js';

class RecordingClipboard extends BrowserClipboardService {
	public readonly writes: [string, string | undefined][] = [];
	constructor() { super(undefined); }
	public override async writeText(text: string, type?: string): Promise<void> {
		this.writes.push([text, type]);
		await super.writeText(text, type);
	}
}

function createFixture(clipboard: IClipboardService, text = 'alpha beta gamma') {
	const resources = new DisposableStore();
	try {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		resources.add(toDisposable(() => dom.window.close()));
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		const services = resources.add(new InstantiationService());
		services.registerInstance(IClipboardService, clipboard);
		const model = resources.add(new TextModel(text));
		const editor = resources.add(createTestCodeEditor({
			container: dom.window.document.querySelector<HTMLElement>('main')!,
			model,
			instantiationService: services,
			contributions: [],
		}));
		editor.layout({ width: 600, height: 120 });
		const contribution = resources.add(editor.invokeWithinContext(accessor => accessor.get(IInstantiationService)).createInstance(SelectionClipboard, editor));
		return { dom, editor, model, contribution, [Symbol.dispose]: () => resources.dispose() };
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

test('selection clipboard writes sorted nonempty selections and leaves the normal clipboard separate', async () => {
	using clipboard = new RecordingClipboard();
	using fixture = createFixture(clipboard);
	fixture.editor.setSelections([new Selection(1, 12, 1, 17), new Selection(1, 1, 1, 6)]);
	await waitFor(() => clipboard.writes.length === 1);
	assert.deepEqual(clipboard.writes, [['alpha\ngamma', 'selection']]);
});

test('selection clipboard cancels pending writes on disable, model switch, restore, and disposal, and skips large or empty selections', async () => {
	for (const change of ['disable', 'model', 'restore', 'dispose', 'empty', 'large']) {
		using clipboard = new RecordingClipboard();
		using fixture = createFixture(clipboard, change === 'large' ? 'x'.repeat(65_537) : undefined);
		fixture.editor.setSelection(new Selection(1, 1, 1, 6));
		if (change === 'disable') { fixture.editor.updateOptions({ selectionClipboard: false }); }
		if (change === 'model') { fixture.editor.setModel(null); }
		if (change === 'restore') { fixture.editor.setSelections([new Selection(1, 7, 1, 11)], 'restoreState'); }
		if (change === 'dispose') { fixture.contribution.dispose(); }
		if (change === 'empty') { fixture.editor.setSelections([new Selection(1, 1, 1, 6), new Selection(1, 7, 1, 7)]); }
		if (change === 'large') { fixture.editor.setSelection(new Selection(1, 1, 1, 65_538)); }
		// This independent editor's write runs after the cancelled task would have run.
		using control = createFixture(clipboard, 'sentinel');
		control.editor.setSelection(new Selection(1, 1, 1, 9));
		await waitFor(() => clipboard.writes.length > 0);
		assert.deepEqual(clipboard.writes, [['sentinel', 'selection']], change);
	}
});

test('middle-click paste reads the selection type and rejects delayed results after editor state changes', async () => {
	for (const change of ['none', 'selection', 'model', 'readonly', 'disable', 'blur', 'close']) {
		let resolve!: (text: string) => void;
		const reads: (string | undefined)[] = [];
		class DeferredSelection extends BrowserClipboardService {
			public override readText(type?: string): Promise<string> {
				reads.push(type);
				return new Promise(done => { resolve = done; });
			}
		}
		using clipboard = new DeferredSelection(undefined);
		using fixture = createFixture(clipboard, 'alpha');
		fixture.editor.focus();
		fixture.editor.setSelection(new Selection(1, 6, 1, 6));
		const input = fixture.editor.controller.editContext.domNode.domNode;
		const event = new fixture.dom.window.MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true });
		input.dispatchEvent(event);
		assert.deepEqual(reads, ['selection']);
		assert.equal(event.defaultPrevented, true);
		if (change === 'selection') { fixture.editor.setSelection(new Selection(1, 1, 1, 1)); }
		if (change === 'model') { fixture.editor.setModel(null); }
		if (change === 'readonly') { fixture.editor.updateOptions({ readOnly: true }); }
		if (change === 'disable') { fixture.editor.updateOptions({ selectionClipboard: false }); }
		if (change === 'blur') { input.blur(); }
		if (change === 'close') { fixture.editor.dispose(); }
		resolve('!');
		if (change === 'none') { await waitFor(() => fixture.model.getText() === 'alpha!'); }
		else await Promise.resolve();
		assert.equal(fixture.model.getText(), change === 'none' ? 'alpha!' : 'alpha', change);
	}
});

test('the selection clipboard command has a Chinese label', () => {
	try {
		initializeTestLocalization('zh-CN');
		assert.equal(localize2('actions.pasteSelectionClipboard', 'Paste Selection Clipboard').value, '粘贴选区剪贴板');
	} finally {
		resetNlsResolver();
	}
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) { throw new Error('Selection clipboard did not reach the expected state'); }
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
}

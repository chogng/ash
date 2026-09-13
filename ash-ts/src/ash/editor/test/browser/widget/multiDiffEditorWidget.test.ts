import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../base/browser/dom.js';
import { type DiffComputationRequest, type IDiffComputationService } from '../../../common/diff/diffComputationService.js';
import { LineDiffKind, type LineDiff } from '../../../common/diff/lineDiff.js';
import { TextModel } from '../../../common/model/textModel.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { DiffModel } = await import('../../../common/diff/diffModel.js');
const { MultiDiffEditorWidget } = await import('../../../browser/widget/multiDiffEditor/multiDiffEditorWidget.js');

test('MultiDiffEditorWidget presents ordered file sections with one outer viewport', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using firstOriginal = new TextModel('old\nsame');
	using firstModified = new TextModel('new\nsame');
	using secondOriginal = new TextModel(lines('before', 100));
	using secondModified = new TextModel(lines('after', 100));
	using computationService = new MultiDiffTestComputationService();
	using firstModel = new DiffModel({ original: firstOriginal, modified: firstModified, computationService });
	using secondModel = new DiffModel({ original: secondOriginal, modified: secondModified, computationService });
	await Promise.all([waitForReady(firstModel), waitForReady(secondModel)]);
	let disposedItemActions = 0;
	using editor = new MultiDiffEditorWidget({
		container,
		items: [
			{ id: 'first', label: 'src/first.ts', originalLabel: 'HEAD', modifiedLabel: 'Working Tree', model: firstModel },
			{ id: 'second', label: 'src/second.ts', originalLabel: 'HEAD', modifiedLabel: 'Working Tree', model: secondModel },
		],
		lineHeight: 20,
		overscanRowCount: 1,
		showLineNumbers: false,
		createItemActions: (container, item) => {
			const button = h(container.ownerDocument, 'button');
			button.type = 'button';
			button.textContent = `Open ${item.label}`;
			container.append(button);
			let disposed = false;
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				disposedItemActions += 1;
			};
			return { dispose, [Symbol.dispose]: dispose };
		},
	});
	editor.layout({ width: 480, height: 80 });

	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-section').length, 2);
	assert.ok([...editor.domNode.querySelectorAll<HTMLElement>('.stanza-multi-diff-editor-section')].every((section) => section.style.transform === ''));
	assert.ok([...editor.domNode.querySelectorAll<HTMLElement>('.stanza-multi-diff-editor-rows')].every((rows) => rows.style.transform === ''));
	assert.deepEqual(
		[...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-title')].map((element) => element.textContent),
		['src/first.ts', 'src/second.ts'],
	);
	assert.equal(editor.domNode.classList.contains('hide-line-numbers'), true);
	assert.ok(editor.domNode.querySelectorAll('.stanza-diff-editor-row').length < 102);
	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-file-actions').length, 2);
	assert.equal(editor.domNode.querySelectorAll('button button').length, 0);
	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-chevron.expanded-icon').length, 2);
	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-chevron.collapsed-icon').length, 2);

	const firstHeader = requiredElement<HTMLButtonElement>(editor.domNode, '.stanza-multi-diff-editor-header-toggle');
	requiredElement<HTMLButtonElement>(editor.domNode, '.stanza-multi-diff-editor-file-actions button').click();
	assert.equal(firstHeader.getAttribute('aria-expanded'), 'true');
	editor.collapseAll();
	assert.ok([...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every((header) => header.getAttribute('aria-expanded') === 'false'));
	editor.expandAll();
	assert.ok([...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every((header) => header.getAttribute('aria-expanded') === 'true'));
	firstHeader.click();
	assert.equal(firstHeader.getAttribute('aria-expanded'), 'false');
	assert.equal(editor.nextChange()?.itemId, 'first');
	assert.equal(firstHeader.getAttribute('aria-expanded'), 'true');
	assert.equal(editor.currentChange?.rowIndex, 0);
	const keyboardNavigation = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'F7' });
	editor.domNode.dispatchEvent(keyboardNavigation);
	assert.equal(keyboardNavigation.defaultPrevented, true);
	assert.equal(editor.currentChange?.itemId, 'second');
	assert.match(editor.domNode.querySelector('.stanza-multi-diff-editor-accessibility-status')?.textContent ?? '', /Change 2 of 101/);
	editor.dispose();
	assert.equal(disposedItemActions, 2);
	dom.window.close();
});

class MultiDiffTestComputationService implements IDiffComputationService {
	async compute(request: DiffComputationRequest, signal: AbortSignal): Promise<LineDiff> {
		signal.throwIfAborted();
		const originalLines = request.original.text.split('\n');
		const modifiedLines = request.modified.text.split('\n');
		const rows = Array.from({ length: Math.max(originalLines.length, modifiedLines.length) }, (_, index) => {
			const original = originalLines[index];
			const modified = modifiedLines[index];
			if (original === modified) return Object.freeze({ kind: LineDiffKind.Unchanged, originalLineIndex: index, modifiedLineIndex: index, originalChanges: Object.freeze([]), modifiedChanges: Object.freeze([]) });
			return Object.freeze({ kind: LineDiffKind.Modified, originalLineIndex: index, modifiedLineIndex: index, originalChanges: Object.freeze([]), modifiedChanges: Object.freeze([]) });
		});
		return Object.freeze({ rows: Object.freeze(rows), hunks: Object.freeze([]) });
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function lines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n');
}

function requiredElement<T extends Element>(owner: ParentNode, selector: string): T {
	const element = owner.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}

function waitForReady(model: InstanceType<typeof DiffModel>): Promise<void> {
	if (model.state.kind === 'ready') return Promise.resolve();
	return new Promise((resolve, reject) => {
		const listener = model.onDidChange((state) => {
			if (state.kind === 'loading') return;
			listener.dispose();
			if (state.kind === 'error') reject(state.error);
			else resolve();
		});
	});
}

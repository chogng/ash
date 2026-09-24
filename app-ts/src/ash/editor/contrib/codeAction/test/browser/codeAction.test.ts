import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';

await import('../../browser/codeActionContributions.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');


test('CodeActionController resolves an action with its original provider before applying it', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('const value = 1;', { languageId: 'typescript' });
	const resource = model.uri;
	using features = new LanguageFeaturesService();
	const providers = features.codeActionProvider;
	const originalAction = { title: 'Rename value', data: { id: 1 } };
	using provider = providers.register('typescript', {
		provideCodeActions: () => [originalAction],
		resolveCodeAction: action => {
			assert.equal(action, originalAction);
			return { ...action, edit: { entries: [{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 7, 1, 12), text: 'result' }] }] } };
		},
	});
	using unrelated = providers.register('typescript', {
		provideCodeActions: () => [],
		resolveCodeAction: () => { throw new Error('Unrelated provider must not resolve this action'); },
	});
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const errors: unknown[] = [];
	using editor = createTestCodeEditor({
		container, model, ariaLabel: 'test.ts',
		languageFeaturesService: features, dimension: { width: 320, height: 80 }, onLanguageError: error => errors.push(error),
	});
	editor.setSelection(Selection.fromPositions(new Position(1, 7), new Position(1, 12)));
	const input = container.querySelector<HTMLElement>('.stanza-editor-input')!;

	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '.', ctrlKey: true }));
	await flushPromises();
	const action = container.querySelector<HTMLButtonElement>('.stanza-editor-code-action button');
	assert.ok(action);
	action.click();
	await flushPromises();

	assert.equal(model.getText(), 'const result = 1;');
	model.undo();
	assert.equal(model.getText(), 'const value = 1;');
	assert.deepEqual(errors, []);
	dom.window.close();
});

test('Code actions without a resolver never use another provider resolver', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('value', { languageId: 'typescript' });
	using features = new LanguageFeaturesService();
	const providers = features.codeActionProvider;
	using owner = providers.register('typescript', { provideCodeActions: () => [{ title: 'Unresolved action' }] });
	using unrelated = providers.register('typescript', {
		provideCodeActions: () => [],
		resolveCodeAction: () => { throw new Error('Unrelated resolver called'); },
	});
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const errors: unknown[] = [];
	using editor = createTestCodeEditor({
		container, model, ariaLabel: 'test.ts',
		languageFeaturesService: features, dimension: { width: 320, height: 80 }, onLanguageError: error => errors.push(error),
	});
	const input = container.querySelector<HTMLElement>('.stanza-editor-input')!;
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '.', ctrlKey: true }));
	await flushPromises();
	const action = container.querySelector<HTMLButtonElement>('.stanza-editor-code-action button');
	assert.ok(action);
	action.click();
	await flushPromises();
	assert.equal(model.getText(), 'value');
	assert.equal(container.querySelector<HTMLElement>('.stanza-editor-code-action')!.hidden, true);
	assert.deepEqual(errors, []);
	dom.window.close();
});

for (const outcome of ['complete', 'error'] as const) {
	test(`a dispatched workspace edit can ${outcome} without closing a newer code action menu`, async () => {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		using model = new TextModel('value', { languageId: 'typescript' });
		using features = new LanguageFeaturesService();
		using provider = features.codeActionProvider.register('typescript', {
			provideCodeActions: () => [{
				title: 'Workspace edit',
				edit: { entries: [{ kind: 'textDocument', resource: model.uri, edits: [{ range: model.getFullModelRange(), text: 'result' }] }] },
			}],
		});
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const errors: unknown[] = [];
		let calls = 0;
		const container = dom.window.document.querySelector<HTMLElement>('main')!;
		using editor = createTestCodeEditor({
			container, model, ariaLabel: 'test.ts',
			languageFeaturesService: features, dimension: { width: 320, height: 80 }, onLanguageError: error => errors.push(error),
			onApplyWorkspaceEdit: async () => {
				calls++;
				await pending;
				if (outcome === 'error') throw new Error('Workspace edit failed after dispatch');
			},
		});
		const input = container.querySelector<HTMLElement>('.stanza-editor-input')!;
		try {
			input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '.', ctrlKey: true }));
			await flushPromises();
			const menu = container.querySelector<HTMLElement>('.stanza-editor-code-action')!;
			const action = menu.querySelector<HTMLButtonElement>('button')!;
			action.click();
			action.click();
			assert.equal(calls, 1);
			menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
			input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '.', ctrlKey: true }));
			await flushPromises();
			assert.equal(menu.hidden, false);
			release();
			await flushPromises();
			assert.equal(menu.hidden, false);
			assert.deepEqual(errors.map(error => (error as Error).message), outcome === 'error' ? ['Workspace edit failed after dispatch'] : []);
		} finally {
			release();
			dom.window.close();
		}
	});
}

test('a failing code action provider does not prevent another provider from returning actions', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('value', { languageId: 'typescript' });
	using features = new LanguageFeaturesService();
	using healthy = features.codeActionProvider.register('typescript', {
		provideCodeActions: () => [{ title: 'Healthy action' }],
	});
	using broken = features.codeActionProvider.register('typescript', {
		provideCodeActions: () => { throw new Error('Provider failed'); },
	});
	const errors: unknown[] = [];
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using editor = createTestCodeEditor({
		container, model, ariaLabel: 'test.ts',
		languageFeaturesService: features, dimension: { width: 320, height: 80 }, onLanguageError: error => errors.push(error),
	});
	const input = container.querySelector<HTMLElement>('.stanza-editor-input')!;
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '.', ctrlKey: true }));
	await flushPromises();
	assert.equal(container.querySelector('.stanza-editor-code-action button')?.textContent, 'Healthy action');
	assert.deepEqual(errors.map(error => (error as Error).message), ['Provider failed']);
	dom.window.close();
});

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../../base/browser/dom.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type LanguageDiagnostic } from '../../../../common/languages.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { CodeActionService, type LanguageCodeActionProvider } from '../../common/languageCodeActions.js';
import { type TextMeasurer } from '../../../../common/viewModel.js';

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

const { TestView: View } = await import('../../../../test/browser/viewModel/testViewModel.js');
const { CodeActionController } = await import('../../browser/codeActionController.js');

suiteTeardown(() => browserEnvironment.window.close());

test('CodeActionController resolves an action with its original provider before applying it', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using model = new TextModel('const value = 1;', { languageId: 'typescript' });
	const resource = model.uri;
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 7), new Position(1, 12))]);
	using viewport = new View({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: selections,
	});
	viewport.layout({ width: 320, height: 80 });
	const input = h(dom.window.document, 'textarea');
	viewport.domNode.domNode.append(input);
	const providers = new LanguageFeatureRegistry<LanguageCodeActionProvider>();
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
	using service = new CodeActionService(model, resource, providers);
	using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(model);
	const sources: Array<string | null | undefined> = [];
	const editor = {
		getModel: () => model,
		getSelection: () => selections.getSelection(),
		pushUndoStop: () => { selections.pushUndoStop(); return true; },
		executeEdits: (source: string | null | undefined, edits: Parameters<TextModel['applyEdits']>[0]) => {
			sources.push(source);
			model.applyEdits(edits);
			return true;
		},
	} as unknown as ICodeEditor;
	using controller = new CodeActionController(input, editor, viewport, service, diagnostics, 'typescript', resource, undefined);

	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '.', ctrlKey: true }));
	await flushPromises();
	const action = viewport.domNode.domNode.querySelector<HTMLButtonElement>('.stanza-editor-code-action button');
	assert.ok(action);
	action.click();
	await flushPromises();

	assert.equal(model.getText(), 'const result = 1;');
	assert.deepEqual(sources, ['editor.action.codeAction']);
	dom.window.close();
});

test('Code actions without a resolver never use another provider resolver', async () => {
	using model = new TextModel('value', { languageId: 'typescript' });
	const providers = new LanguageFeatureRegistry<LanguageCodeActionProvider>();
	using owner = providers.register('typescript', { provideCodeActions: () => [{ title: 'Unresolved action' }] });
	using unrelated = providers.register('typescript', {
		provideCodeActions: () => [],
		resolveCodeAction: () => { throw new Error('Unrelated resolver called'); },
	});
	using service = new CodeActionService(model, model.uri, providers);
	const range = model.getFullModelRange();
	const [action] = await service.provideCodeActions('typescript', range);
	assert.ok(action);
	assert.equal(await service.resolveCodeAction('typescript', range, action), action);
});

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;
	refresh(): boolean { return false; }
	measureLineWidth(text: string): number { return text.length * 10; }
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

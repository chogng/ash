import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { type EditorCommandExecutor } from '../../../../browser/editorExtensions.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type LanguageRenameProvider, RenameService } from '../../common/languageRename.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
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
const { RenameCommandId, RenameController } = await import('../../browser/renameController.js');

suiteTeardown(() => browserEnvironment.window.close());

test('Rename reports its command after applying the provider edit', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const resource = URI.file('C:\\project\\rename.ts');
	using model = new TextModel('abc', { languageId: 'typescript' });
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (1) + 1))]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.layout({ width: 200, height: 40 });
	const editorInput = h(dom.window.document, 'textarea');
	container.append(editorInput);
	const providers = new LanguageFeatureRegistry<LanguageRenameProvider>();
	providers.register('typescript', {
		prepareRename: () => ({ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)), placeholder: 'abc' }),
		provideRenameEdits: () => ({ entries: [{ kind: 'textDocument', resource, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)), text: 'xyz' }] }] }),
	});
	using service = new RenameService(model, resource, providers);
	const executedCommands: string[] = [];
	const executeCommand: EditorCommandExecutor = (commandId, operation) => {
		executedCommands.push(commandId);
		return operation();
	};
	const errors: unknown[] = [];
	const editor = {
		getModel: () => model,
		getSelections: () => selections.getSelections(),
		pushUndoStop: () => {
			model.pushStackElement();
			return true;
		},
		executeEdits: (_source: string | null | undefined, edits: Parameters<TextModel['applyEdits']>[0]) => {
			model.applyEdits(edits);
			return true;
		},
	};
	using controller = new RenameController(
		editorInput,
		editor,
		viewport,
		service,
		'typescript',
		resource,
		undefined,
		error => errors.push(error),
		executeCommand,
	);

	editorInput.dispatchEvent(keydown(dom.window, 'F2'));
	await flushPromises();
	const renameInput = viewport.domNode.domNode.querySelector<HTMLInputElement>('.stanza-editor-rename-input');
	assert.ok(renameInput);
	assert.equal(renameInput.value, 'abc');
	renameInput.value = 'xyz';
	renameInput.dispatchEvent(keydown(dom.window, 'Enter'));
	await flushPromises();
	assert.equal(model.getText(), 'xyz');
	assert.deepEqual(executedCommands, [RenameCommandId]);
	assert.deepEqual(errors, []);

	dom.window.close();
});

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return text.length * 10;
	}
}

function keydown(targetWindow: typeof browserEnvironment.window, key: string): KeyboardEvent {
	return new targetWindow.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }) as unknown as KeyboardEvent;
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

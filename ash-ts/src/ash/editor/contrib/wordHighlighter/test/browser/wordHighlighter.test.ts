import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { DocumentHighlightKind } from '../../../../common/languages.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { TestLanguageFeaturesService } from '../../../../test/common/testLanguageFeaturesService.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: TestResizeObserver,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { TextualMultiDocumentHighlightFeature } = await import('../../browser/textualHighlightProvider.js');
const { WordHighlighterContribution } = await import('../../browser/wordHighlighter.contribution.js');

test('Word highlighter uses the textual provider for complete Unicode words', async () => {
	using languages = new TestLanguageFeaturesService();
	using harness = createHarness('café caféine café\nCafé', languages, URI.parse('file:///one.ts'), 'singleFile');

	harness.controller.restoreViewState(true);
	await settleHighlights();

	assert.deepEqual(decorationRanges(harness.decorations), [
		Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
		Range.fromPositions(new Position((0) + 1, (13) + 1), new Position((0) + 1, (17) + 1)),
	]);
});

test('Word highlighter prefers semantic providers and renders read and write kinds independently', async () => {
	using languages = new TestLanguageFeaturesService();
	using semanticProvider = languages.documentHighlightProvider.register('typescript', {
		provideDocumentHighlights: () => [
			{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)), kind: DocumentHighlightKind.Read },
			{ range: Range.fromPositions(new Position((0) + 1, (5) + 1), new Position((0) + 1, (9) + 1)), kind: DocumentHighlightKind.Write },
		],
	});
	using harness = createHarness('item item', languages, URI.parse('file:///semantic.ts'), 'singleFile');

	harness.controller.restoreViewState(true);
	await settleHighlights();

	assert.deepEqual(harness.decorations.decorations.map(decoration => decoration.metadata), [DocumentHighlightKind.Read, DocumentHighlightKind.Write]);
	assert.deepEqual(harness.model.getAllDecorations().map(decoration => decoration.options.className), ['word-highlight', 'word-highlight-strong']);
});

test('Multi-file word highlighting updates every open editor sharing the language service', async () => {
	using languages = new TestLanguageFeaturesService();
	using first = createHarness('item one item', languages, URI.parse('file:///one.ts'), 'multiFile');
	using second = createHarness('item two', languages, URI.parse('file:///two.ts'), 'multiFile');

	first.controller.restoreViewState(true);
	await settleHighlights();

	assert.deepEqual([first.decorations.size, second.decorations.size], [2, 1]);
});

test('Word highlighter cancels a stale provider request when the selection changes', async () => {
	using languages = new TestLanguageFeaturesService();
	let aborted = false;
	using semanticProvider = languages.documentHighlightProvider.register('typescript', {
		provideDocumentHighlights: (_model, _position, token) => new Promise(resolve => {
			token.onCancellationRequested(() => {
				aborted = true;
				resolve([]);
			});
		}),
	});
	using harness = createHarness('item other', languages, URI.parse('file:///cancel.ts'), 'singleFile');

	harness.controller.restoreViewState(true);
	await new Promise(resolve => setTimeout(resolve, 1));
	harness.editor.setSelections([Selection.fromPositions(new Position((0) + 1, (6) + 1))]);
	await settleHighlights();

	assert.equal(aborted, true);
	assert.equal(harness.decorations.size, 0);
});

test('Word highlighter obeys the off mode and navigates existing highlights', async () => {
	using languages = new TestLanguageFeaturesService();
	using disabled = createHarness('item item', languages, URI.parse('file:///disabled.ts'), 'off');
	disabled.controller.restoreViewState(true);
	await settleHighlights();
	assert.equal(disabled.decorations.size, 0);

	using enabled = createHarness('item item', languages, URI.parse('file:///enabled.ts'), 'singleFile');
	enabled.controller.restoreViewState(true);
	await settleHighlights();
	enabled.controller.moveNext();
	assert.deepEqual(enabled.editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (5) + 1)));
	enabled.controller.moveBack();
	assert.deepEqual(enabled.editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (0) + 1)));
});

function createHarness(text: string, languages: TestLanguageFeaturesService, resource: URI, mode: 'off' | 'singleFile' | 'multiFile') {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const model = new TextModel(text, { languageId: 'typescript', resource });
	const editor = createTestCodeEditor({
		container, model, input: { resource }, languageId: 'typescript', languageFeaturesService: languages,
		contributions: [], dimension: { width: 240, height: 60 },
	});
	editor.setSelection(new Selection(1, 2, 1, 2));
	const textualProvider = new TextualMultiDocumentHighlightFeature(languages);
	const decorations = new TextDecorationCollection<DocumentHighlightKind | undefined>(model);
	const controller = new WordHighlighterContribution(editor.controller, editor, decorations, {
		resource, languageFeaturesService: languages, mode, delay: 0,
	});
	return {
		model, editor, decorations, controller,
		[Symbol.dispose]: () => {
			controller.dispose(); textualProvider.dispose(); decorations.dispose();
			editor.dispose(); model.dispose(); dom.window.close();
		},
	};
}

function decorationRanges(decorations: TextDecorationCollection<DocumentHighlightKind | undefined>): readonly Range[] {
	return decorations.decorations.map(decoration => decoration.range);
}

async function settleHighlights(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 10));
}

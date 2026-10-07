import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { DocumentHighlightKind, type DocumentHighlight } from '../../../../common/languages.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { TestLanguageFeaturesService } from '../../../../test/common/testLanguageFeaturesService.js';

const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { TextualMultiDocumentHighlightFeature } = await import('../../browser/textualHighlightProvider.js');
const { WordHighlighterContribution, getOccurrencesAtPosition, getOccurrencesAcrossMultipleModels } = await import('../../browser/wordHighlighter.contribution.js');

test('Word highlighter uses the textual provider for complete Unicode words', async () => {
	using languages = new TestLanguageFeaturesService();
	using harness = createHarness('café caféine café\nCafé', languages, URI.parse('file:///one.ts'), 'singleFile');

	const highlighted = waitForDecorations(harness.decorations);
	harness.controller.restoreViewState(true);
	await highlighted;

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

	const highlighted = waitForDecorations(harness.decorations);
	harness.controller.restoreViewState(true);
	await highlighted;

	assert.deepEqual(harness.decorations.decorations.map(decoration => decoration.metadata), [DocumentHighlightKind.Read, DocumentHighlightKind.Write]);
	assert.deepEqual(harness.model.getAllDecorations().map(decoration => decoration.options.className), ['word-highlight', 'word-highlight-strong']);
});

test('Multi-file word highlighting updates every open editor sharing the language service', async () => {
	using languages = new TestLanguageFeaturesService();
	using first = createHarness('item one item', languages, URI.parse('file:///one.ts'), 'multiFile');
	using second = createHarness('item two', languages, URI.parse('file:///two.ts'), 'multiFile');

	const highlighted = Promise.all([waitForDecorations(first.decorations), waitForDecorations(second.decorations)]);
	first.controller.restoreViewState(true);
	await highlighted;

	assert.deepEqual([first.decorations.size, second.decorations.size], [2, 1]);
});

for (const mode of ['singleFile', 'multiFile'] as const) {
	for (const failure of ['synchronous failure', 'asynchronous failure', 'invalid result', 'provider cancellation'] as const) {
		test(`Word highlighter recovers from ${failure} in ${mode} mode`, async () => {
			using languages = new TestLanguageFeaturesService();
			const errors: unknown[] = [];
			using first = createHarness('item item', languages, URI.parse('file:///one.ts'), mode, error => errors.push(error));
			using second = createHarness('item item', languages, URI.parse('file:///two.ts'), mode);
			let successfulCalls = 0;
			let failedCalls = 0;
			const highlight = { range: new Range(1, 1, 1, 5), kind: DocumentHighlightKind.Write };
			const provideHighlights = (): DocumentHighlight[] | Promise<DocumentHighlight[]> => {
				failedCalls++;
				if (failure === 'synchronous failure') throw new Error(failure);
				if (failure === 'asynchronous failure') return Promise.reject(new Error(failure));
				if (failure === 'provider cancellation') throw new CancellationError();
				return [{ ...highlight, kind: 99 as DocumentHighlightKind }];
			};
			using successfulProvider = mode === 'singleFile'
				? languages.documentHighlightProvider.register('*', { provideDocumentHighlights: () => { successfulCalls++; return [highlight]; } })
				: languages.multiDocumentHighlightProvider.register('*', {
					selector: '*',
					provideMultiDocumentHighlights: (model, _position, otherModels) => {
						successfulCalls++;
						return new Map([model, ...otherModels].map(target => [target.uri, [highlight]]));
					},
				});
			using failedProvider = mode === 'singleFile'
				? languages.documentHighlightProvider.register('typescript', { provideDocumentHighlights: provideHighlights })
				: languages.multiDocumentHighlightProvider.register('typescript', {
					selector: 'typescript',
					provideMultiDocumentHighlights: model => {
						const highlights = provideHighlights();
						return Promise.resolve(highlights).then(answer => new Map([[model.uri, answer]]));
					},
				});

			const highlighted = mode === 'singleFile'
				? waitForDecorations(first.decorations)
				: Promise.all([waitForDecorations(first.decorations), waitForDecorations(second.decorations)]);
			first.controller.restoreViewState(true);
			await highlighted;

			assert.deepEqual({
				failedCalls, successfulCalls,
				errors: errors.map(error => error instanceof Error ? error.message : error),
				first: first.decorations.decorations.map(decoration => decoration.metadata),
				second: second.decorations.decorations.map(decoration => decoration.metadata),
			}, {
				failedCalls: 1, successfulCalls: 1,
				errors: failure === 'provider cancellation' ? [] : [failure === 'invalid result' ? 'Document highlight kind is invalid' : failure],
				first: [DocumentHighlightKind.Write],
				second: mode === 'singleFile' ? [] : [DocumentHighlightKind.Write],
			});
		});
	}

	for (const invalidation of ['cancellation', 'model edit'] as const) {
		test(`Word highlighter stops provider recovery after ${invalidation} in ${mode} mode`, async () => {
			using languages = new TestLanguageFeaturesService();
			using model = new TextModel('item item', { languageId: 'typescript', resource: URI.parse('file:///one.ts') });
			using request = new CancellationTokenSource();
			const errors: unknown[] = [];
			let fallbackCalls = 0;
			let reject!: (error: Error) => void;
			const answer = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
			using fallback = mode === 'singleFile'
				? languages.documentHighlightProvider.register('*', { provideDocumentHighlights: () => { fallbackCalls++; return []; } })
				: languages.multiDocumentHighlightProvider.register('*', { selector: '*', provideMultiDocumentHighlights: () => { fallbackCalls++; return new Map(); } });
			using failing = mode === 'singleFile'
				? languages.documentHighlightProvider.register('typescript', { provideDocumentHighlights: () => answer })
				: languages.multiDocumentHighlightProvider.register('typescript', { selector: 'typescript', provideMultiDocumentHighlights: () => answer });
			const target = { model, resource: model.uri, languageId: model.getLanguageId(), snapshot: model.createVersionedSnapshot() };
			const pending = mode === 'singleFile'
				? getOccurrencesAtPosition(languages.documentHighlightProvider, target, new Position(1, 2), request.token, error => errors.push(error))
				: getOccurrencesAcrossMultipleModels(languages.multiDocumentHighlightProvider, target, new Position(1, 2), request.token, [], error => errors.push(error));

			if (invalidation === 'cancellation') request.cancel();
			else model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'x' }]);
			reject(new Error('Late provider failure'));
			const result = await pending;

			assert.deepEqual({ fallbackCalls, errors, resources: result.size }, { fallbackCalls: 0, errors: [], resources: 0 });
		});
	}

	test(`Word highlighter accepts an empty answer without trying lower-priority providers in ${mode} mode`, async () => {
		using languages = new TestLanguageFeaturesService();
		using model = new TextModel('item item', { languageId: 'typescript', resource: URI.parse('file:///one.ts') });
		using request = new CancellationTokenSource();
		let fallbackCalls = 0;
		using fallback = mode === 'singleFile'
			? languages.documentHighlightProvider.register('*', { provideDocumentHighlights: () => { fallbackCalls++; return []; } })
			: languages.multiDocumentHighlightProvider.register('*', { selector: '*', provideMultiDocumentHighlights: () => { fallbackCalls++; return new Map(); } });
		using empty = mode === 'singleFile'
			? languages.documentHighlightProvider.register('typescript', { provideDocumentHighlights: () => [] })
			: languages.multiDocumentHighlightProvider.register('typescript', { selector: 'typescript', provideMultiDocumentHighlights: () => new Map([[model.uri, []]]) });
		const target = { model, resource: model.uri, languageId: model.getLanguageId(), snapshot: model.createVersionedSnapshot() };

		const result = mode === 'singleFile'
			? await getOccurrencesAtPosition(languages.documentHighlightProvider, target, new Position(1, 2), request.token)
			: await getOccurrencesAcrossMultipleModels(languages.multiDocumentHighlightProvider, target, new Position(1, 2), request.token, []);

		assert.deepEqual({ fallbackCalls, highlights: result.get(model.uri) }, { fallbackCalls: 0, highlights: [] });
	});
}

test('Word highlighter cancels a stale provider request when the selection changes', async () => {
	using languages = new TestLanguageFeaturesService();
	let aborted = false;
	let markStarted!: () => void;
	const started = new Promise<void>(resolve => { markStarted = resolve; });
	using semanticProvider = languages.documentHighlightProvider.register('typescript', {
		provideDocumentHighlights: (_model, _position, token) => new Promise(resolve => {
			markStarted();
			token.onCancellationRequested(() => {
				aborted = true;
				resolve([]);
			});
		}),
	});
	using harness = createHarness('item other', languages, URI.parse('file:///cancel.ts'), 'singleFile');

	harness.controller.restoreViewState(true);
	await started;
	harness.editor.setSelections([Selection.fromPositions(new Position((0) + 1, (6) + 1))]);

	assert.equal(aborted, true);
	assert.equal(harness.decorations.size, 0);
});

test('Word highlighter obeys the off mode and navigates existing highlights', async () => {
	using languages = new TestLanguageFeaturesService();
	using disabled = createHarness('item item', languages, URI.parse('file:///disabled.ts'), 'off');
	disabled.controller.restoreViewState(true);
	assert.equal(disabled.decorations.size, 0);

	using enabled = createHarness('item item', languages, URI.parse('file:///enabled.ts'), 'singleFile');
	const highlighted = waitForDecorations(enabled.decorations);
	enabled.controller.restoreViewState(true);
	await highlighted;
	enabled.controller.moveNext();
	assert.deepEqual(enabled.editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (5) + 1)));
	enabled.controller.moveBack();
	assert.deepEqual(enabled.editor.getSelections()![0]!, Selection.fromPositions(new Position((0) + 1, (0) + 1)));
});

function createHarness(text: string, languages: TestLanguageFeaturesService, resource: URI, mode: 'off' | 'singleFile' | 'multiFile', onError?: (error: unknown) => void) {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const model = new TextModel(text, { languageId: 'typescript', resource });
	const editor = createTestCodeEditor({
		container, model, languageFeaturesService: languages,
		contributions: [], occurrencesHighlight: mode, occurrencesHighlightDelay: 0, dimension: { width: 240, height: 60 },
	});
	editor.setSelection(new Selection(1, 2, 1, 2));
	const textualProvider = new TextualMultiDocumentHighlightFeature(languages);
	const decorations = new TextDecorationCollection<DocumentHighlightKind | undefined>(model);
	const controller = new WordHighlighterContribution(editor.controller, editor, decorations, {
		resource, languageFeaturesService: languages, onError,
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

function waitForDecorations(decorations: TextDecorationCollection<DocumentHighlightKind | undefined>): Promise<void> {
	return new Promise(resolve => {
		const listener = decorations.onDidChange(() => {
			listener.dispose();
			resolve();
		});
	});
}

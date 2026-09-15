import assert from 'node:assert/strict';
import { test } from 'mocha';
import { errorHandler, isCancellationError } from '../../../../../base/common/errors.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { TestLanguageFeaturesService } from '../../../../test/common/testLanguageFeaturesService.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type DocumentFormattingEditProvider } from '../../../../common/languages.js';
import { getDocumentFormattingEditsUntilResult, getRealAndSyntheticDocumentFormattersOrdered } from '../../browser/format.js';

const options = { tabSize: 4, insertSpaces: true };

test('document formatters precede range formatters and deduplicate extension identity ignoring case', async () => {
	using model = new TextModel('alpha');
	using features = new TestLanguageFeaturesService();
	using document = features.documentFormattingEditProvider.register('*', { extensionId: new ExtensionIdentifier('Acme.Format'), provideDocumentFormattingEdits: () => [] });
	using duplicate = features.documentRangeFormattingEditProvider.register('*', { extensionId: new ExtensionIdentifier('acme.format'), provideDocumentRangeFormattingEdits: () => { throw new Error('duplicate formatter invoked'); } });
	using range = features.documentRangeFormattingEditProvider.register('*', {
		extensionId: new ExtensionIdentifier('Other.Format'),
		provideDocumentRangeFormattingEdits(receivedModel, receivedRange, receivedOptions, token) {
			assert.equal(receivedModel, model);
			assert.deepEqual(receivedRange, model.getFullModelRange());
			assert.deepEqual(receivedOptions, options);
			assert.equal(token, CancellationToken.None);
			return [{ range: receivedRange, text: 'ALPHA' }];
		},
	});
	assert.deepEqual(getRealAndSyntheticDocumentFormattersOrdered(features.documentFormattingEditProvider, features.documentRangeFormattingEditProvider, model).map(provider => provider.extensionId?.value), ['Acme.Format', 'Other.Format']);
	assert.deepEqual(await getDocumentFormattingEditsUntilResult(features, model, options, CancellationToken.None), [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
});

test('formatting reports provider failures and continues to the next provider', async () => {
	using model = new TextModel('alpha');
	using features = new TestLanguageFeaturesService();
	using success = features.documentFormattingEditProvider.register('*', { provideDocumentFormattingEdits: () => [{ range: model.getFullModelRange(), text: 'ALPHA' }] });
	const failure = new Error('provider failed');
	using throwing = features.documentFormattingEditProvider.register('*', { provideDocumentFormattingEdits: () => { throw failure; } });
	const errors: unknown[] = [];
	const previous = errorHandler.getUnexpectedErrorHandler();
	errorHandler.setUnexpectedErrorHandler(error => errors.push(error));
	try {
		assert.deepEqual(await getDocumentFormattingEditsUntilResult(features, model, options, CancellationToken.None), [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
		assert.deepEqual(errors, [failure]);
	} finally {
		errorHandler.setUnexpectedErrorHandler(previous);
	}
});

test('document formatting accepts null and undefined results before the next provider', async () => {
	using model = new TextModel('alpha');
	using features = new TestLanguageFeaturesService();
	const providers = features.documentFormattingEditProvider;
	using edits = providers.register('*', { provideDocumentFormattingEdits: () => [{ range: model.getFullModelRange(), text: 'ALPHA' }] });
	using absent = providers.register('*', { provideDocumentFormattingEdits: () => Promise.resolve(undefined) });
	using empty = providers.register('*', { provideDocumentFormattingEdits: () => null });
	assert.deepEqual(await getDocumentFormattingEditsUntilResult(features, model, options, CancellationToken.None), [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
});

test('format cancellation settles even when the provider ignores its signal', async () => {
	using model = new TextModel('alpha');
	using features = new TestLanguageFeaturesService();
	const providers = features.documentFormattingEditProvider;
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => new Promise(() => {}) });
	using abort = new CancellationTokenSource();
	const result = getDocumentFormattingEditsUntilResult(features, model, options, abort.token);
	abort.cancel();
	await assert.rejects(result, isCancellationError);
});

test('an already cancelled format request never invokes a provider', async () => {
	using model = new TextModel('alpha');
	using features = new TestLanguageFeaturesService();
	const providers = features.documentFormattingEditProvider;
	let calls = 0;
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => { calls++; return []; } });
	await assert.rejects(getDocumentFormattingEditsUntilResult(features, model, options, CancellationToken.Cancelled));
	assert.equal(calls, 0);
});

test('disposing the model discards a pending formatting result', async () => {
	using model = new TextModel('alpha');
	const range = model.getFullModelRange();
	using features = new TestLanguageFeaturesService();
	const providers = features.documentFormattingEditProvider;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	using registration = providers.register('*', { provideDocumentFormattingEdits: async () => {
		await gate;
		return [{ range, text: 'ALPHA' }];
	} });
	const result = getDocumentFormattingEditsUntilResult(features, model, options, CancellationToken.None);
	model.dispose();
	release();
	assert.equal(await result, undefined);
});

test('formatting preserves provider order, receiver, resource, and options', async () => {
	using model = new TextModel('alpha', { languageId: 'typescript', resource: URI.file('/project/main.ts') });
	using features = new TestLanguageFeaturesService();
	const providers = features.documentFormattingEditProvider;
	const calls: string[] = [];
	using last = providers.register('typescript', { provideDocumentFormattingEdits: () => { calls.push('last'); return []; } });
	const selected: DocumentFormattingEditProvider = {
		provideDocumentFormattingEdits(receivedModel, receivedOptions, token) {
			assert.equal(this, selected);
			assert.equal(receivedModel, model);
			assert.equal(receivedModel.uri.toString(), URI.file('/project/main.ts').toString());
			assert.equal(token, CancellationToken.None);
			assert.deepEqual(receivedOptions, options);
			assert.equal(receivedModel.getValue(), 'alpha');
			calls.push('selected');
			return [{ range: model.getFullModelRange(), text: 'ALPHA' }];
		},
	};
	using middle = providers.register('typescript', selected);
	using first = providers.register('typescript', { provideDocumentFormattingEdits: () => { calls.push('empty'); return []; } });
	const edits = await getDocumentFormattingEditsUntilResult(features, model, options, CancellationToken.None);
	assert.deepEqual(calls, ['empty', 'selected']);
	assert.deepEqual(edits, [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
});

test('model changes discard late edits without querying another formatter', async () => {
	using model = new TextModel('alpha');
	using features = new TestLanguageFeaturesService();
	const providers = features.documentFormattingEditProvider;
	let laterCalls = 0;
	using later = providers.register('*', { provideDocumentFormattingEdits: () => { laterCalls++; return []; } });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	using first = providers.register('*', { provideDocumentFormattingEdits: async () => {
		await gate;
		return [{ range: model.getFullModelRange(), text: 'ALPHA' }];
	} });
	const result = getDocumentFormattingEditsUntilResult(features, model, options, CancellationToken.None);
	model.setValue('changed');
	release();
	assert.equal(await result, undefined);
	assert.equal(laterCalls, 0);
});

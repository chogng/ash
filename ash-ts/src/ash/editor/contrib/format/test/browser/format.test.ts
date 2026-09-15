import assert from 'node:assert/strict';
import { test } from 'mocha';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type DocumentFormattingEditProvider } from '../../../../common/languages.js';
import { getDocumentFormattingEditsUntilResult } from '../../browser/format.js';

const options = { tabSize: 4, insertSpaces: true };

test('document formatting accepts null and undefined results before the next provider', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<DocumentFormattingEditProvider>();
	using edits = providers.register('*', { provideDocumentFormattingEdits: () => [{ range: model.getFullModelRange(), text: 'ALPHA' }] });
	using absent = providers.register('*', { provideDocumentFormattingEdits: () => Promise.resolve(undefined) });
	using empty = providers.register('*', { provideDocumentFormattingEdits: () => null });
	assert.deepEqual(await getDocumentFormattingEditsUntilResult(providers, model, options, CancellationToken.None), [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
});

test('format cancellation settles even when the provider ignores its signal', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<DocumentFormattingEditProvider>();
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => new Promise(() => {}) });
	using abort = new CancellationTokenSource();
	const result = getDocumentFormattingEditsUntilResult(providers, model, options, abort.token);
	abort.cancel();
	await assert.rejects(result, isCancellationError);
});

test('an already cancelled format request never invokes a provider', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<DocumentFormattingEditProvider>();
	let calls = 0;
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => { calls++; return []; } });
	await assert.rejects(getDocumentFormattingEditsUntilResult(providers, model, options, CancellationToken.Cancelled));
	assert.equal(calls, 0);
});

test('disposing the model discards a pending formatting result', async () => {
	using model = new TextModel('alpha');
	const range = model.getFullModelRange();
	const providers = new LanguageFeatureRegistry<DocumentFormattingEditProvider>();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	using registration = providers.register('*', { provideDocumentFormattingEdits: async () => {
		await gate;
		return [{ range, text: 'ALPHA' }];
	} });
	const result = getDocumentFormattingEditsUntilResult(providers, model, options, CancellationToken.None);
	model.dispose();
	release();
	assert.deepEqual(await result, []);
});

test('formatting preserves provider order, receiver, resource, and options', async () => {
	using model = new TextModel('alpha', { languageId: 'typescript', resource: URI.file('/project/main.ts') });
	const providers = new LanguageFeatureRegistry<DocumentFormattingEditProvider>();
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
	const edits = await getDocumentFormattingEditsUntilResult(providers, model, options, CancellationToken.None);
	assert.deepEqual(calls, ['empty', 'selected']);
	assert.deepEqual(edits, [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
});

test('model changes discard late edits without querying another formatter', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<DocumentFormattingEditProvider>();
	let laterCalls = 0;
	using later = providers.register('*', { provideDocumentFormattingEdits: () => { laterCalls++; return []; } });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	using first = providers.register('*', { provideDocumentFormattingEdits: async () => {
		await gate;
		return [{ range: model.getFullModelRange(), text: 'ALPHA' }];
	} });
	const result = getDocumentFormattingEditsUntilResult(providers, model, options, CancellationToken.None);
	model.setValue('changed');
	release();
	assert.deepEqual(await result, []);
	assert.equal(laterCalls, 0);
});

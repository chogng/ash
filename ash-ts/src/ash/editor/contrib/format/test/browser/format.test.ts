import assert from 'node:assert/strict';
import { test } from 'mocha';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { URI } from '../../../../../base/common/uri.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type LanguageFormattingProvider } from '../../../../common/languages.js';
import { getDocumentFormattingEditsUntilResult } from '../../browser/format.js';

const options = { tabSize: 4, insertSpaces: true };

test('format cancellation settles even when the provider ignores its signal', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => new Promise(() => {}) });
	const abort = new AbortController();
	const result = getDocumentFormattingEditsUntilResult(providers, model, 'plaintext', options, abort.signal);
	abort.abort();
	await assert.rejects(result, isCancellationError);
});

test('an already cancelled format request never invokes a provider', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	let calls = 0;
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => { calls++; return []; } });
	await assert.rejects(getDocumentFormattingEditsUntilResult(providers, model, 'plaintext', options, AbortSignal.abort()));
	assert.equal(calls, 0);
});

test('disposing the model discards a pending formatting result', async () => {
	using model = new TextModel('alpha');
	const range = model.getFullModelRange();
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	using registration = providers.register('*', { provideDocumentFormattingEdits: async () => {
		await gate;
		return [{ range, text: 'ALPHA' }];
	} });
	const result = getDocumentFormattingEditsUntilResult(providers, model, 'plaintext', options, new AbortController().signal);
	model.dispose();
	release();
	assert.deepEqual(await result, []);
});

test('formatting preserves provider order, receiver, resource, and options', async () => {
	using model = new TextModel('alpha', { languageId: 'typescript' });
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	const resource = URI.file('/project/main.ts');
	const calls: string[] = [];
	using last = providers.register('typescript', { provideDocumentFormattingEdits: () => { calls.push('last'); return []; } });
	const selected: LanguageFormattingProvider = {
		provideDocumentFormattingEdits(request, signal) {
			assert.equal(this, selected);
			assert.equal(request.resource, resource);
			assert.equal(request.signal, signal);
			assert.deepEqual(request.options, options);
			assert.equal(request.snapshot.getText(), 'alpha');
			calls.push('selected');
			return [{ range: model.getFullModelRange(), text: 'ALPHA' }];
		},
	};
	using middle = providers.register('typescript', selected);
	using first = providers.register('typescript', { provideDocumentFormattingEdits: () => { calls.push('empty'); return []; } });
	const edits = await getDocumentFormattingEditsUntilResult(providers, model, 'typescript', options, new AbortController().signal, resource);
	assert.deepEqual(calls, ['empty', 'selected']);
	assert.deepEqual(edits, [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
});

test('model changes discard late edits without querying another formatter', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	let laterCalls = 0;
	using later = providers.register('*', { provideDocumentFormattingEdits: () => { laterCalls++; return []; } });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	using first = providers.register('*', { provideDocumentFormattingEdits: async () => {
		await gate;
		return [{ range: model.getFullModelRange(), text: 'ALPHA' }];
	} });
	const result = getDocumentFormattingEditsUntilResult(providers, model, 'plaintext', options, new AbortController().signal);
	model.setValue('changed');
	release();
	assert.deepEqual(await result, []);
	assert.equal(laterCalls, 0);
});

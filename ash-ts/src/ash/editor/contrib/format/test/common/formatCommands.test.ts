import assert from 'node:assert/strict';
import { test } from 'mocha';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { FormatService, type LanguageFormattingProvider } from '../../common/formatCommands.js';

const options = { tabSize: 4, insertSpaces: true };

test('format cancellation settles even when the provider ignores its signal', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => new Promise(() => {}) });
	using service = new FormatService(model, providers, providers, providers);
	const abort = new AbortController();
	const result = service.provideDocumentFormattingEdits('plaintext', options, abort.signal);
	abort.abort();
	await assert.rejects(result, isCancellationError);
});

test('an already cancelled format request never invokes a provider', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	let calls = 0;
	using registration = providers.register('*', { provideDocumentFormattingEdits: () => { calls++; return []; } });
	using service = new FormatService(model, providers, providers, providers);
	await assert.rejects(service.provideDocumentFormattingEdits('plaintext', options, AbortSignal.abort()));
	assert.equal(calls, 0);
});

test('disposing the formatting service rejects a pending result', async () => {
	using model = new TextModel('alpha');
	const providers = new LanguageFeatureRegistry<LanguageFormattingProvider>();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	using registration = providers.register('*', { provideDocumentFormattingEdits: async () => {
		await gate;
		return [{ range: model.getFullModelRange(), text: 'ALPHA' }];
	} });
	using service = new FormatService(model, providers, providers, providers);
	const result = service.provideDocumentFormattingEdits('plaintext', options);
	service.dispose();
	release();
	assert.deepEqual(await result, []);
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../common/core/range.js';
import { createLanguageFeatureEditor, flushLanguageRequests } from './testLanguageFeatureEditor.js';
await import('../../contrib/symbolIcons/browser/symbolIcons.contribution.js');

const symbol = { name: 'root', kind: 'function', range: new Range(1, 1, 1, 19), selectionRange: new Range(1, 10, 1, 14) };

test('symbol icons follow provider registration, current language and removal', async () => {
	using fixture = createLanguageFeatureEditor();
	const languages: string[] = [];
	using provider = fixture.features.documentSymbolProvider.register('*', {
		provideDocumentSymbols: request => { languages.push(request.languageId); return [symbol]; },
	});
	const icons = () => fixture.model.getAllDecorations().filter(decoration => decoration.options.description === 'symbol-icon');
	await flushLanguageRequests();
	assert.equal(icons().length, 1);
	fixture.model.setLanguage('javascript');
	assert.equal(icons().length, 0);
	await flushLanguageRequests();
	assert.equal(icons().length, 1);
	assert.deepEqual(languages, ['typescript', 'javascript']);
	provider.dispose();
	assert.equal(icons().length, 0);
	assert.deepEqual(fixture.errors, []);
});

for (const change of ['language', 'provider', 'dispose'] as const) {
	test(`symbol icons cancel on ${change} and discard the old response`, async () => {
		using fixture = createLanguageFeatureEditor();
		let signal!: AbortSignal;
		let finish!: () => void;
		using provider = fixture.features.documentSymbolProvider.register('typescript', {
			provideDocumentSymbols: (_request, cancellation) => {
				signal = cancellation;
				return new Promise(resolve => { finish = () => resolve([symbol]); });
			},
		});
		if (change === 'language') fixture.model.setLanguage('javascript');
		if (change === 'provider') provider.dispose();
		if (change === 'dispose') fixture.editor.dispose();
		assert.equal(signal.aborted, true);
		finish();
		await flushLanguageRequests();
		assert.equal(fixture.model.getAllDecorations().filter(decoration => decoration.options.description === 'symbol-icon').length, 0);
		assert.deepEqual(fixture.errors, []);
	});
}

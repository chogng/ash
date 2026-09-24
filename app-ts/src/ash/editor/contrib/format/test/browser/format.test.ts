import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { TestLanguageFeaturesService } from '../../../../test/common/testLanguageFeaturesService.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type DocumentFormattingEditProvider } from '../../../../common/languages.js';
import { FormattingConflicts, FormattingKind, FormattingMode, getRealAndSyntheticDocumentFormattersOrdered } from '../../browser/format.js';

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
	assert.deepEqual(await getRealAndSyntheticDocumentFormattersOrdered(features.documentFormattingEditProvider, features.documentRangeFormattingEditProvider, model)[1].provideDocumentFormattingEdits(model, options, CancellationToken.None), [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
});

test('formatter selectors use the latest registration and restore the previous policy on disposal', async () => {
	using model = new TextModel('alpha');
	const providers: DocumentFormattingEditProvider[] = [
		{ provideDocumentFormattingEdits: () => [] },
		{ provideDocumentFormattingEdits: () => [] },
	];
	using first = FormattingConflicts.setFormatterSelector(async choices => choices[0]);
	using second = FormattingConflicts.setFormatterSelector(async (choices, document, mode, kind) => {
		assert.equal(document, model);
		assert.equal(mode, FormattingMode.Silent);
		assert.equal(kind, FormattingKind.File);
		return choices[1];
	});
	assert.equal(await FormattingConflicts.select(providers, model, FormattingMode.Silent, FormattingKind.File), providers[1]);
	second.dispose();
	assert.equal(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.Selection), providers[0]);
});

test('declining formatter selection does not consult an older policy', async () => {
	using model = new TextModel('alpha');
	const providers: DocumentFormattingEditProvider[] = [{ provideDocumentFormattingEdits: () => [] }];
	let calls = 0;
	using first = FormattingConflicts.setFormatterSelector(async choices => { calls++; return choices[0]; });
	using second = FormattingConflicts.setFormatterSelector(async () => undefined);
	assert.equal(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File), undefined);
	assert.equal(calls, 0);
});

test('an empty formatter list never opens the selector', async () => {
	using model = new TextModel('alpha');
	using selector = FormattingConflicts.setFormatterSelector(async () => { throw new Error('unexpected selector'); });
	assert.equal(await FormattingConflicts.select([], model, FormattingMode.Explicit, FormattingKind.File), undefined);
});

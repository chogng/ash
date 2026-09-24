import { createLanguageFeatureRequest } from '../../../../../editor/common/languages.js';
import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LanguageCompletionService } from '../../../../../editor/contrib/suggest/browser/suggest.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { TestLanguageConfigurationService } from '../../../../../editor/test/common/modes/testLanguageConfigurationService.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { WorkbenchLanguageFeatures } from '../../browser/workbenchLanguageFeatures.js';
import { SyntaxProviderWorker } from '../../../../../editor/common/services/editorWebWorker.js';

test('Workbench installs JSON providers without registering language definitions', async () => {
	using languageService = new LanguageService();
	using languageConfigurations = new TestLanguageConfigurationService();
	using languageFeatures = new LanguageFeaturesService();
	using services = new ServiceContainer();
	services.registerInstance(ILanguageFeaturesService, languageFeatures);
	using workbenchLanguages = services.createInstance(WorkbenchLanguageFeatures);
	using model = new TextModel('const answer = 42;');
	using syntax = new SyntaxProviderWorker(languageFeatures.syntaxProvider);
	using completions = new LanguageCompletionService(model, languageFeatures.completionProvider);

	assert.equal(languageService.resolveLanguageId({ resource: URI.file('C:\\project\\source.ts') }), undefined);
	assert.equal(languageConfigurations.getLanguageConfiguration('typescript').comments?.lineCommentToken, undefined);
	using jsonModel = new TextModel('{}', { languageId: 'json' });
	assert.equal(languageFeatures.hoverProvider.ordered(jsonModel).length, 1);
	assert.equal(languageFeatures.documentFormattingEditProvider.ordered(jsonModel).length, 1);
	assert.equal((await syntax.run({ requestId: 1, lane: 'tokens', payload: { languageId: 'typescript' }, snapshot: model.createVersionedSnapshot() }, new AbortController().signal)).lane, 'tokens');
	assert.equal(completions.textModel, model);
});

test('Language features service atomically owns a replaceable cross-kind provider batch', async () => {
	using languageConfigurations = new TestLanguageConfigurationService();
	using languageFeatures = new LanguageFeaturesService();
	using model = new TextModel('answer', { languageId: 'typescript' });
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), position: new Position(1, 2) };
	const registration = languageFeatures.registerProviderBatch({ hovers: [{ selector: 'typescript', provider: { provideHover: () => ({ contents: ['first'] }) } }] });

	assert.deepEqual(await languageFeatures.hoverProvider.ordered(model)[0]?.provideHover(request, signal), { contents: ['first'] });
	registration.replace({ hovers: [{ selector: 'typescript', provider: { provideHover: () => ({ contents: ['second'] }) } }] });
	assert.deepEqual(await languageFeatures.hoverProvider.ordered(model)[0]?.provideHover(request, signal), { contents: ['second'] });

	registration.dispose();
	assert.equal(await languageFeatures.hoverProvider.ordered(model)[0]?.provideHover(request, signal), undefined);
	assert.throws(() => registration.replace({}), /disposed/);
});

test('Language features service keeps document, range, and on-type formatting registries independent', async () => {
	using languageConfigurations = new TestLanguageConfigurationService();
	using languageFeatures = new LanguageFeaturesService();
	using model = new TextModel('answer', { languageId: 'typescript' });
	const formattingOptions = { tabSize: 4, insertSpaces: true };
	const range = new Range(1, 1, 1, 7);
	const registration = languageFeatures.registerProviderBatch({
		formatting: [{
			selector: 'typescript',
			provider: {
				provideDocumentFormattingEdits: () => [{ range, text: 'document' }],
				provideDocumentRangeFormattingEdits: () => [{ range, text: 'range' }],
				autoFormatTriggerCharacters: [';'],
				provideOnTypeFormattingEdits(receivedModel, position, ch, options, token) {
					assert.equal(receivedModel, model);
					assert.deepEqual(position, new Position(1, 7));
					assert.equal(ch, ';');
					assert.deepEqual(options, formattingOptions);
					assert.equal(token, CancellationToken.None);
					return [{ range, text: 'onType' }];
				},
			},
		}],
	});

	assert.equal(
		(await languageFeatures.documentFormattingEditProvider.ordered(model)[0]?.provideDocumentFormattingEdits(model, formattingOptions, CancellationToken.None))?.[0]?.text,
		'document',
	);
	assert.equal(
		(await languageFeatures.documentRangeFormattingEditProvider.ordered(model)[0]?.provideDocumentRangeFormattingEdits(model, range, formattingOptions, CancellationToken.None))?.[0]?.text,
		'range',
	);
	assert.equal(
		(await languageFeatures.onTypeFormattingEditProvider.ordered(model)[0]?.provideOnTypeFormattingEdits(model, new Position(1, 7), ';', formattingOptions, CancellationToken.None))?.[0]?.text,
		'onType',
	);

	registration.replace({
		formatting: [{
			selector: 'typescript',
			provider: {
				provideDocumentFormattingEdits: () => [{ range, text: 'replacement' }],
			},
		}],
	});
	assert.equal(
		(await languageFeatures.documentFormattingEditProvider.ordered(model)[0]?.provideDocumentFormattingEdits(model, formattingOptions, CancellationToken.None))?.[0]?.text,
		'replacement',
	);
	assert.deepEqual(languageFeatures.documentRangeFormattingEditProvider.ordered(model), []);
	assert.deepEqual(languageFeatures.onTypeFormattingEditProvider.ordered(model), []);

	registration.replace({
		formatting: [{
			selector: 'typescript',
			provider: {
				provideDocumentRangeFormattingEdits(receivedModel, receivedRange, options, token) {
					assert.equal(receivedModel, model);
					assert.equal(receivedRange, range);
					assert.deepEqual(options, formattingOptions);
					assert.equal(token, CancellationToken.None);
					return [{ range, text: 'range only' }];
				},
			},
		}],
	});
	assert.deepEqual(languageFeatures.documentFormattingEditProvider.ordered(model), []);
	assert.deepEqual(languageFeatures.onTypeFormattingEditProvider.ordered(model), []);
	assert.deepEqual(await languageFeatures.documentRangeFormattingEditProvider.ordered(model)[0]!.provideDocumentRangeFormattingEdits(model, range, formattingOptions, CancellationToken.None), [{ range, text: 'range only' }]);

	registration.dispose();
	assert.deepEqual(languageFeatures.documentFormattingEditProvider.ordered(model), []);
	assert.deepEqual(languageFeatures.documentRangeFormattingEditProvider.ordered(model), []);
});

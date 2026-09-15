import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { LanguageCompletionService } from '../../../../../editor/common/languages/completion/languageCompletionService.js';
import { LanguageRequestStatus } from '../../../../../editor/common/languages/languageRequestCoordinator.js';
import { SyntaxService } from '../../../../../editor/common/languages/syntax/syntaxService.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { TestLanguageConfigurationService } from '../../../../../editor/test/common/modes/testLanguageConfigurationService.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { LanguageHoverService } from '../../../../../editor/contrib/hover/common/hover.js';
import { createLanguageFeatureRequest } from '../../../../../editor/common/languages/languageFeatureRequest.js';
import { WorkbenchLanguageFeatures } from '../../browser/workbenchLanguageFeatures.js';

test('Workbench installs product languages while Editor owns provider registries', async () => {
	using languageService = new LanguageService();
	using languageConfigurations = new TestLanguageConfigurationService();
	using languageFeatures = new LanguageFeaturesService(languageConfigurations);
	using workbenchLanguages = new WorkbenchLanguageFeatures(languageService, languageConfigurations, languageFeatures);
	using model = new TextModel('const answer = 42;');
	using syntax = new SyntaxService(model, languageFeatures.syntaxProvider);
	using completions = new LanguageCompletionService(model, languageFeatures.completionProvider);

	assert.equal(languageService.resolveLanguageId({ resource: URI.file('C:\\project\\source.ts') }), 'typescript');
	assert.equal(languageConfigurations.getLanguageConfiguration('typescript').comments?.lineCommentToken, '//');
	assert.equal((await syntax.requestAll('typescript')).tokens.status, LanguageRequestStatus.Applied);
	assert.equal(completions.textModel, model);
});

test('Language features service atomically owns a replaceable cross-kind provider batch', async () => {
	using languageConfigurations = new TestLanguageConfigurationService();
	using languageFeatures = new LanguageFeaturesService(languageConfigurations);
	using model = new TextModel('answer', { languageId: 'typescript' });
	using hover = new LanguageHoverService(model, languageFeatures.hoverProvider);
	const registration = languageFeatures.registerProviderBatch({ hovers: [{ selector: 'typescript', provider: { provideHover: () => ({ contents: ['first'] }) } }] });

	assert.deepEqual(await hover.provideHover('typescript', new Position((0) + 1, (1) + 1)), { contents: ['first'] });
	registration.replace({ hovers: [{ selector: 'typescript', provider: { provideHover: () => ({ contents: ['second'] }) } }] });
	assert.deepEqual(await hover.provideHover('typescript', new Position((0) + 1, (1) + 1)), { contents: ['second'] });

	registration.dispose();
	assert.equal(await hover.provideHover('typescript', new Position((0) + 1, (1) + 1)), undefined);
	assert.throws(() => registration.replace({}), /disposed/);
});

test('Language features service keeps document, range, and on-type formatting registries independent', async () => {
	using languageConfigurations = new TestLanguageConfigurationService();
	using languageFeatures = new LanguageFeaturesService(languageConfigurations);
	using model = new TextModel('answer', { languageId: 'typescript' });
	const signal = new AbortController().signal;
	const request = { ...createLanguageFeatureRequest(model, 'typescript', signal), options: { tabSize: 4, insertSpaces: true } };
	const range = new Range(1, 1, 1, 7);
	const registration = languageFeatures.registerProviderBatch({
		formatting: [{
			selector: 'typescript',
			provider: {
				provideDocumentFormattingEdits: () => [{ range, text: 'document' }],
				provideDocumentRangeFormattingEdits: () => [{ range, text: 'range' }],
				provideOnTypeFormattingEdits: () => [{ range, text: 'onType' }],
			},
		}],
	});

	assert.equal(
		(await languageFeatures.documentFormattingEditProvider.ordered(model)[0]?.provideDocumentFormattingEdits(model, request.options, CancellationToken.None))?.[0]?.text,
		'document',
	);
	assert.equal(
		(await languageFeatures.documentRangeFormattingEditProvider.ordered(model)[0]?.provideDocumentRangeFormattingEdits(model, range, request.options, CancellationToken.None))?.[0]?.text,
		'range',
	);
	assert.equal(
		(await languageFeatures.onTypeFormattingEditProvider.ordered(model)[0]?.provideOnTypeFormattingEdits?.({ ...request, position: new Position(1, 7), ch: ';' }, signal))?.[0]?.text,
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
		(await languageFeatures.documentFormattingEditProvider.ordered(model)[0]?.provideDocumentFormattingEdits(model, request.options, CancellationToken.None))?.[0]?.text,
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
					assert.deepEqual(options, request.options);
					assert.equal(token, CancellationToken.None);
					return [{ range, text: 'range only' }];
				},
			},
		}],
	});
	assert.deepEqual(languageFeatures.documentFormattingEditProvider.ordered(model), []);
	assert.deepEqual(languageFeatures.onTypeFormattingEditProvider.ordered(model), []);
	assert.deepEqual(await languageFeatures.documentRangeFormattingEditProvider.ordered(model)[0]!.provideDocumentRangeFormattingEdits(model, range, request.options, CancellationToken.None), [{ range, text: 'range only' }]);

	registration.dispose();
	assert.deepEqual(languageFeatures.documentFormattingEditProvider.ordered(model), []);
	assert.deepEqual(languageFeatures.documentRangeFormattingEditProvider.ordered(model), []);
});

import { strict as assert } from 'node:assert';
import { test } from 'mocha';
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
import { FormatService } from '../../../../../editor/contrib/format/common/formatCommands.js';
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
	using formatting = new FormatService(
		model,
		languageFeatures.documentFormattingEditProvider,
		languageFeatures.documentRangeFormattingEditProvider,
		languageFeatures.onTypeFormattingEditProvider,
	);
	const range = new Range(1, 1, 1, 7);
	const registration = languageFeatures.registerProviderBatch({
		formatting: [{
			selector: 'typescript',
			provider: {
				provideDocumentFormattingEdits: () => [{ range, text: 'document' }],
				provideRangeFormattingEdits: () => [{ range, text: 'range' }],
				provideOnTypeFormattingEdits: () => [{ range, text: 'onType' }],
			},
		}],
	});

	assert.equal(
		(await formatting.provideDocumentFormattingEdits('typescript', { tabSize: 4, insertSpaces: true }))[0]?.text,
		'document',
	);
	assert.equal(
		(await formatting.provideRangeFormattingEdits('typescript', range, { tabSize: 4, insertSpaces: true }))[0]?.text,
		'range',
	);
	assert.equal(
		(await formatting.provideOnTypeFormattingEdits('typescript', new Position(1, 7), ';', { tabSize: 4, insertSpaces: true }))[0]?.text,
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
		(await formatting.provideDocumentFormattingEdits('typescript', { tabSize: 4, insertSpaces: true }))[0]?.text,
		'replacement',
	);
	assert.deepEqual(await formatting.provideRangeFormattingEdits('typescript', range, { tabSize: 4, insertSpaces: true }), []);
	assert.deepEqual(await formatting.provideOnTypeFormattingEdits('typescript', new Position(1, 7), ';', { tabSize: 4, insertSpaces: true }), []);

	registration.dispose();
	assert.deepEqual(await formatting.provideDocumentFormattingEdits('typescript', { tabSize: 4, insertSpaces: true }), []);
});

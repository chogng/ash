import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../base/common/uri.js';
import { LanguageFeatureRegistry } from '../../common/languageFeatureRegistry.js';
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { TextModel } from '../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';
import { LanguageService } from '../../common/services/languageService.js';

test('language identity, configuration, and feature providers have separate owners', () => {
	using languageService = new LanguageService();
	using languageConfigurationService = new TestLanguageConfigurationService();
	using languageFeaturesService = new LanguageFeaturesService();
	using model = new TextModel('', { languageId: 'demo' });

	assert.equal(languageService.resolveLanguageId({ resource: URI.file('C:\\project\\source.ts') }), undefined);
	assert.equal(languageConfigurationService.getLanguageConfiguration('typescript').comments?.lineCommentToken, undefined);
	assert.deepEqual(languageFeaturesService.hoverProvider.ordered(model), []);

	using language = languageService.registerLanguage({ id: 'demo', extensions: ['.demo'] });
	using configuration = languageConfigurationService.register('demo', { comments: { lineComment: '//' } });
	using hover = languageFeaturesService.hoverProvider.register('demo', { provideHover: () => undefined });

	assert.equal(languageService.resolveLanguageId({ resource: URI.file('C:\\project\\source.demo') }), 'demo');
	assert.equal(languageConfigurationService.getLanguageConfiguration('demo').comments?.lineCommentToken, '//');
	assert.equal(languageFeaturesService.hoverProvider.ordered(model).length, 1);
});

test('the language service starts with plain text and follows explicit language registration', () => {
	using service = new LanguageService();
	const resource = URI.file('/project/main.ts');
	const selection = service.createByFilepathOrFirstLine(resource);
	const changes: string[] = [];
	using listener = selection.onDidChange(languageId => changes.push(languageId));
	assert.deepEqual(service.getRegisteredLanguageIds(), ['plaintext']);
	assert.equal(service.guessLanguageIdByFilepathOrFirstLine(URI.file('/project/readme.txt')), 'plaintext');
	assert.equal(selection.languageId, 'plaintext');
	const registration = service.registerLanguage({ id: 'typescript', extensions: ['.ts'] });
	assert.equal(selection.languageId, 'typescript');
	registration.dispose();
	assert.equal(selection.languageId, 'plaintext');
	assert.deepEqual(changes, ['typescript', 'plaintext']);
});

test('language feature registries report effective provider changes', () => {
	using languageConfigurationService = new TestLanguageConfigurationService();
	using languageFeaturesService = new LanguageFeaturesService();
	let changes = 0;
	using listener = languageFeaturesService.colorProvider.onDidChange(() => changes += 1);
	assert.equal(changes, 0);
	const registration = languageFeaturesService.colorProvider.register('css', {
		provideDocumentColors: () => [],
		provideColorPresentations: () => [],
	});
	assert.equal(changes, 1);
	registration.dispose();
	assert.equal(changes, 2);
	registration.dispose();
	assert.equal(changes, 2);
});

test('language feature registries preserve canonical selector ordering and candidate invalidation', () => {
	using model = new TextModel('value', { languageId: 'typescript', resource: URI.parse('file:///workspace/value.ts') });
	const registry = new LanguageFeatureRegistry<string>();
	const counts: number[] = [];
	using listener = registry.onDidChange(count => counts.push(count));

	registry.register('*', 'wildcard');
	registry.register('typescript', 'first');
	const second = registry.register('typescript', 'second');
	registry.register({ language: 'typescript', isBuiltin: true }, 'builtin');
	assert.deepEqual(registry.ordered(model), ['second', 'first', 'builtin', 'wildcard']);
	assert.deepEqual(registry.orderedGroups(model), [['second', 'first', 'builtin'], ['wildcard']]);
	assert.equal(registry.has(model), true);
	assert.deepEqual([...registry.registeredLanguageIds], ['typescript', '*']);

	second.dispose();
	assert.deepEqual(registry.ordered(model), ['first', 'builtin', 'wildcard']);
	assert.deepEqual(counts, [1, 2, 3, 4, 3]);
});

test('exclusive language feature selectors replace ordinary matches except during recursive lookup', () => {
	using model = new TextModel('value', { languageId: 'typescript' });
	const registry = new LanguageFeatureRegistry<string>();
	registry.register('*', 'wildcard');
	registry.register('typescript', 'language');
	registry.register({ language: 'typescript', exclusive: true }, 'exclusive');

	assert.deepEqual(registry.ordered(model), ['exclusive']);
	assert.deepEqual(registry.ordered(model, true), ['language', 'wildcard']);
});

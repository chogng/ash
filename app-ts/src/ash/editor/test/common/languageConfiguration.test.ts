import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IndentAction, StandardAutoClosingPairConditional } from '../../common/languages/languageConfiguration.js';
import { LanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { LanguageService } from '../../common/services/languageService.js';
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { StandardTokenType } from '../../common/encodedTokenAttributes.js';

test('language configuration contributions compose by priority and unregister independently', () => {
	using service = new TestLanguageConfigurationService();
	using base = service.register('demo', {
		comments: { lineComment: '//' },
		brackets: [['(', ')']],
	});
	const changes: Array<string | undefined> = [];
	using listener = service.onDidChange(event => changes.push(event.languageId));
	const override = service.register('demo', {
		comments: { lineComment: '#' },
		folding: { markers: { start: /^region$/u, end: /^endregion$/u } },
	}, 10);

	let resolved = service.getLanguageConfiguration('demo');
	assert.equal(resolved.comments?.lineCommentToken, '#');
	assert.deepEqual(resolved.underlyingConfig.brackets, [['(', ')']]);
	assert.equal(resolved.foldingRules.markers?.start.source, '^region$');

	override.dispose();
	resolved = service.getLanguageConfiguration('demo');
	assert.equal(resolved.comments?.lineCommentToken, '//');
	assert.deepEqual(changes, ['demo', 'demo']);
});

test('resolved language configuration exposes canonical pair and enter supports', () => {
	using service = new TestLanguageConfigurationService();
	using registration = service.register('demo', {
		comments: { blockComment: ['/*', '*/'] },
		brackets: [['{', '}']],
		autoClosingPairs: [{ open: '"', close: '"', notIn: ['string'] }],
		surroundingPairs: [{ open: '<', close: '>' }],
		autoCloseBefore: ';',
		onEnterRules: [{
			beforeText: /\{$/u,
			action: { indentAction: IndentAction.Indent, appendText: 'next' },
		}],
	});
	const resolved = service.getLanguageConfiguration('demo');

	assert.equal(resolved.comments?.blockCommentStartToken, '/*');
	assert.equal(resolved.comments?.blockCommentEndToken, '*/');
	assert.equal(resolved.characterPair.getAutoClosingPairs()[0]?.open, '"');
	assert.deepEqual(resolved.getSurroundingPairs(), [{ open: '<', close: '>' }]);
	assert.equal(resolved.getAutoCloseBeforeSet(false), ';');
	assert.equal(resolved.brackets?.brackets.length, 1);
});

test('language configuration service applies per-language bracket overrides', async () => {
	using configuration = new InMemoryConfigurationService();
	using languages = new LanguageService();
	using language = languages.registerLanguage({ id: 'demo' });
	using service = new LanguageConfigurationService(configuration, languages);
	using registration = service.register('demo', { brackets: [['(', ')']] });
	const changes: Array<string | undefined> = [];
	using listener = service.onDidChange(event => changes.push(event.languageId));

	await configuration.updateValue('editor.language.brackets', [['[', ']']], { overrideIdentifiers: ['demo'] });
	assert.deepEqual(service.getLanguageConfiguration('demo').underlyingConfig.brackets, [['[', ']']]);
	assert.deepEqual(changes, ['demo']);
});

test('standard auto-closing pairs honor token exclusions', () => {
	const pair = new StandardAutoClosingPairConditional({ open: '"', close: '"', notIn: ['string', 'comment'] });
	assert.equal(pair.isOK(StandardTokenType.Other), true);
	assert.equal(pair.isOK(StandardTokenType.String), false);
	assert.equal(pair.isOK(StandardTokenType.Comment), false);
	assert.equal(pair.isOK(StandardTokenType.RegEx), true);
});

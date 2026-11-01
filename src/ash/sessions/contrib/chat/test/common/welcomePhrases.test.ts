import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { NEW_SESSION_WELCOME_MESSAGES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_PHRASES_SETTING } from '../../common/constants.js';
import { getNewSessionWelcomePhrases, NEW_SESSION_WELCOME_NAME_PLACEHOLDER, resolveWelcomePhraseTemplate } from '../../common/welcomePhrases.js';
import '../../browser/chat.contribution.js';

suite('New session welcome phrases', () => {
	test('provides the default rotation with optional names', () => {
		assert.deepEqual(getNewSessionWelcomePhrases(undefined, undefined), [
			'What are we building?', 'What\u2019s the move?', 'Let\u2019s cook', 'Time to lock in', 'Let\u2019s ship something',
		]);
		assert.deepEqual(getNewSessionWelcomePhrases(undefined, 'Ash'), [
			'What are we building, Ash?', 'What\u2019s the move, Ash?', 'Let\u2019s cook, Ash', 'Time to lock in, Ash', 'Let\u2019s ship something, Ash',
		]);
	});

	test('resolves literal names and removes absent names without dangling separators', () => {
		assert.equal(NEW_SESSION_WELCOME_NAME_PLACEHOLDER, '${name}');
		const templates = ['${name}, ready?', 'Ready, ${name}', 'Hello ${name}!', 'Before {name} after', '${name}'];
		assert.deepEqual(templates.map(value => resolveWelcomePhraseTemplate(value, undefined)), ['Ready?', 'Ready', 'Hello!', 'Before after', '']);
		assert.equal(resolveWelcomePhraseTemplate('Hello ${name}, {name}!', 'A$&B'), 'Hello A$&B, A$&B!');
		assert.equal(resolveWelcomePhraseTemplate('  A plain phrase  ', undefined), 'A plain phrase');
		assert.equal(resolveWelcomePhraseTemplate('- Keep ${name} safe -', undefined), '- Keep safe -');
	});

	test('appends or replaces custom phrases and drops empty results', () => {
		const phrases = ['  Welcome, ${name}  ', ' ', '${name}'];
		assert.deepEqual(getNewSessionWelcomePhrases({ mode: 'replace', phrases }, undefined), ['Welcome']);
		assert.deepEqual(getNewSessionWelcomePhrases({ phrases }, 'Ash').slice(5), ['Welcome, Ash', 'Ash']);
		assert.deepEqual(getNewSessionWelcomePhrases({ mode: 'replace', phrases: [] }, 'Ash'), []);
	});

	test('registers application settings and rejects invalid persisted values', () => {
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		for (const key of [NEW_SESSION_WELCOME_PHRASES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_MESSAGES_SETTING, 'accessibility.verbosity.newSessionWelcome']) {
			assert.equal(registry.getConfiguration(key)?.scope, ConfigurationScope.APPLICATION);
		}
		const parse = registry.getConfiguration(NEW_SESSION_WELCOME_MESSAGES_SETTING)!.parse;
		for (const value of [null, [], { mode: 'random' }, { phrases: [5] }, { extra: true }]) {
			assert.throws(() => parse(value), TypeError);
		}
		assert.deepEqual(parse({ phrases: ['Hello'] }), { phrases: ['Hello'] });
	});
});

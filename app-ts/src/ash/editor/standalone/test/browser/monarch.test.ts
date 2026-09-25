import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ServiceContainer } from '../../../../platform/instantiation/common/instantiation.js';
import { TokenMetadata } from '../../../common/encodedTokenAttributes.js';
import { TokenizationRegistry, type IState, type ITokenizationSupport } from '../../../common/languages.js';
import { ILanguageService } from '../../../common/languages/language.js';
import { LanguageService } from '../../../common/services/languageService.js';
import { StandaloneThemeService } from '../../browser/standaloneThemeService.js';
import { compile } from '../../common/monarch/monarchCompile.js';
import { MonarchTokenizer } from '../../common/monarch/monarchLexer.js';
import type { IMonarchLanguage } from '../../common/monarch/monarchTypes.js';
import { IStandaloneThemeService } from '../../common/standaloneTheme.js';
import '../../../common/config/editorConfigurationSchema.js';

function createTokenizer(resources: DisposableStore, definition: IMonarchLanguage) {
	const services = resources.add(new ServiceContainer());
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const media = Object.assign(new EventTarget(), { matches: false });
	const ownerWindow = { document: dom.window.document, matchMedia: () => media } as unknown as Window;
	services.registerSingleton(ILanguageService, () => new LanguageService());
	services.registerSingleton(IStandaloneThemeService, () => new StandaloneThemeService(ownerWindow));
	services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	const languages = services.get(ILanguageService);
	resources.add(languages.registerLanguage({ id: 'monarch-test' }));
	const tokenizer = resources.add(services.createInstance(MonarchTokenizer, 'monarch-test', compile('monarch-test', definition)));
	return { tokenizer, languages, configuration: services.get(IConfigurationService) };
}

test('Monarch carries nested comments across lines and leaves incoming states unchanged', () => {
	using resources = new DisposableStore();
	const definition: IMonarchLanguage = {
		ignoreCase: true,
		keywords: ['let'],
		tokenizer: {
			root: [
				{ include: '@space' },
				[/[a-z]+/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
				[/\/\*/, 'comment', '@comment'],
				[/[{}]/, '@brackets'],
			],
			space: [[/\s+/, '']],
			comment: [[/\/\*/, 'comment', '@push'], [/\*\//, 'comment', '@pop'], [/./, 'comment']],
		},
	};
	const { tokenizer } = createTokenizer(resources, definition);
	const initial = tokenizer.getInitialState();
	const first = tokenizer.tokenize('LET x /* one', true, initial);
	assert.deepEqual(first.tokens.map(token => [token.offset, token.type]), [
		[0, 'keyword.monarch-test'], [3, ''], [4, 'identifier.monarch-test'], [5, ''], [6, 'comment.monarch-test'],
	]);
	const second = tokenizer.tokenize('/* two */ end */ x', false, first.endState);
	assert.deepEqual(second.tokens.map(token => [token.offset, token.type]), [
		[0, 'comment.monarch-test'], [16, ''], [17, 'identifier.monarch-test'],
	]);
	assert.equal(initial.equals(tokenizer.getInitialState()), true);
	assert.equal(second.endState.equals(initial), true);
	definition.keywords.push('x');
	assert.equal(tokenizer.tokenize('x', false, initial).tokens[0]!.type, 'identifier.monarch-test');
	const encoded = tokenizer.tokenizeEncoded('LET', false, initial).tokens;
	assert.equal(TokenMetadata.getLanguageId(encoded[1]!), TokenMetadata.getLanguageId(tokenizer.tokenizeEncoded('x', false, initial).tokens[1]!));
	assert.notEqual(TokenMetadata.getForeground(encoded[1]!), TokenMetadata.getForeground(tokenizer.tokenizeEncoded('x', false, initial).tokens[1]!));
});

test('Monarch handles captures, rematching, regex macros and literal state parameters', () => {
	using resources = new DisposableStore();
	const { tokenizer } = createTokenizer(resources, {
		word: /[a-z]+/,
		tokenizer: {
			root: [
				[/(@word)(=)(\d+)/, ['identifier', 'operator', 'number']],
				[/R"([^ ]*)\(/, { token: 'string', next: '@raw.$1' }],
				[/(?=<)/, { token: '@rematch', next: '@tag' }],
				[/ +/, ''],
			],
			raw: [[/\)$S2"/, 'string', '@pop'], [/./, 'string']],
			tag: [[/<[^>]+>/, 'tag', '@pop']],
		},
	});
	const initial = tokenizer.getInitialState();
	const groups = tokenizer.tokenize('name=12 <node>', false, initial);
	assert.deepEqual(groups.tokens.map(token => [token.offset, token.type]), [
		[0, 'identifier.monarch-test'], [4, 'operator.monarch-test'], [5, 'number.monarch-test'], [7, ''], [8, 'tag.monarch-test'],
	]);
	const raw = tokenizer.tokenize('R"[+(body', true, initial);
	const closed = tokenizer.tokenize('text)[+" name=1', false, raw.endState);
	assert.deepEqual(closed.tokens.map(token => [token.offset, token.type]), [
		[0, 'string.monarch-test'], [8, ''], [9, 'identifier.monarch-test'], [13, 'operator.monarch-test'], [14, 'number.monarch-test'],
	]);
	assert.equal(closed.endState.equals(initial), true);
});

test('Monarch advances empty-line and line-feed transitions and rejects non-progressing grammars', () => {
	using resources = new DisposableStore();
	const { tokenizer } = createTokenizer(resources, {
		includeLF: true,
		tokenizer: {
			root: [[/!/, '', '@line'], [/x/, 'identifier']],
			line: [[/\n|$/, '', '@pop'], [/[^\n]+/, 'comment']],
		},
	});
	const initial = tokenizer.getInitialState();
	const line = tokenizer.tokenize('! note', true, initial);
	assert.equal(line.endState.equals(initial), true);
	assert.deepEqual(tokenizer.tokenize('', true, initial).tokens, []);
	assert.equal(tokenizer.tokenize('x', false, line.endState).tokens[0]!.type, 'identifier.monarch-test');
	assert.throws(() => compile('bad', { tokenizer: { root: [{ include: '@root' }] } }), /Cyclic tokenizer include/);
	const stalled = createTokenizer(resources, { tokenizer: { root: [[/x/, '@rematch']] } }).tokenizer;
	assert.throws(() => stalled.tokenize('x', false, stalled.getInitialState()), /do not advance/);
});

test('Monarch reads the current tokenization line limit and detaches configuration listeners on disposal', async () => {
	using resources = new DisposableStore();
	const { tokenizer, configuration } = createTokenizer(resources, { tokenizer: { root: [[/\w+/, 'identifier']] } });
	const changes: string[] = [];
	resources.add(TokenizationRegistry.onDidChange(event => changes.push(...event.changedLanguages)));
	await configuration.updateValue('editor.maxTokenizationLineLength', 4);
	const initial = tokenizer.getInitialState();
	assert.equal(tokenizer.tokenize('cat', false, initial).tokens[0]!.type, 'identifier.monarch-test');
	assert.equal(tokenizer.tokenize('longer', false, initial).tokens[0]!.type, '');
	assert.deepEqual([...changes], ['monarch-test']);
	tokenizer.dispose();
	await configuration.updateValue('editor.maxTokenizationLineLength', 8);
	assert.deepEqual(changes, ['monarch-test']);
});

test('Monarch activates embedded languages and retains their metadata until a case exits to the host', async () => {
	using resources = new DisposableStore();
	const { tokenizer, languages } = createTokenizer(resources, {
		tokenizer: {
			root: [[/\[\[/, { token: 'delimiter', next: '@code', nextEmbedded: 'embedded-test' }], [/\w+/, 'identifier']],
			code: [[/\]\]/, { cases: { '@default': { token: 'delimiter', next: '@pop', nextEmbedded: '@pop' } } }]],
		},
	});
	resources.add(languages.registerLanguage({ id: 'embedded-test' }));
	const encounters: string[] = [];
	resources.add(languages.onDidRequestBasicLanguageFeatures(language => encounters.push(language)));
	const state: IState = { clone: () => state, equals: other => other === state };
	const languageId = languages.languageIdCodec.encodeLanguageId('embedded-test');
	let resolve!: (support: ITokenizationSupport) => void;
	resources.add(TokenizationRegistry.registerFactory('embedded-test', { tokenizationSupport: new Promise(done => { resolve = done; }) }));
	tokenizer.tokenize('[[12]]host', false, tokenizer.getInitialState());
	assert.deepEqual(encounters, ['embedded-test']);
	assert.equal(tokenizer.getLoadStatus().loaded, false);
	resolve({
		getInitialState: () => state,
		tokenize: () => ({ endState: state, tokens: [{ offset: 0, type: 'number', language: 'embedded-test' }] }),
		tokenizeEncoded: () => ({ endState: state, tokens: new Uint32Array([0, languageId | (3 << 15) | (2 << 24)]) }),
	});
	await tokenizer.embeddedLoaded;
	assert.equal(tokenizer.getLoadStatus().loaded, true);
	const plain = tokenizer.tokenize('[[12]]host', false, tokenizer.getInitialState());
	assert.deepEqual(plain.tokens.map(token => [token.offset, token.type, token.language]), [
		[0, 'delimiter.monarch-test', 'monarch-test'], [2, 'number', 'embedded-test'],
		[4, 'delimiter.monarch-test', 'monarch-test'], [6, 'identifier.monarch-test', 'monarch-test'],
	]);
	const encoded = tokenizer.tokenizeEncoded('[[12]]host', false, tokenizer.getInitialState());
	assert.equal(TokenMetadata.getLanguageId(encoded.tokens[3]!), languageId);
	assert.equal(TokenMetadata.getForeground(encoded.tokens[3]!), 3);
	assert.equal(plain.endState.equals(tokenizer.getInitialState()), true);
});

test('Monarch rematches a capture into an embedded language across line boundaries', () => {
	using resources = new DisposableStore();
	const { tokenizer, languages } = createTokenizer(resources, {
		tokenizer: {
			root: [[/(<%)(calc)/, ['delimiter', { token: '@rematch', next: '@code', nextEmbedded: 'calculation' }]]],
			code: [[/%>/, { token: 'delimiter', next: '@pop', nextEmbedded: '@pop' }]],
		},
	});
	resources.add(languages.registerLanguage({ id: 'calculation' }));
	const state: IState = { clone: () => state, equals: other => other === state };
	resources.add(TokenizationRegistry.register('calculation', {
		getInitialState: () => state,
		tokenize: () => ({ tokens: [{ offset: 0, type: 'expression', language: 'calculation' }], endState: state }),
	}));
	const initial = tokenizer.getInitialState();
	const first = tokenizer.tokenize('prefix <%calc 2 +', true, initial);
	const second = tokenizer.tokenize(' 3%> suffix', false, first.endState);
	assert.deepEqual([first, second].map(result => result.tokens.map(token => [token.offset, token.type, token.language])), [
		[[0, 'source.monarch-test', 'monarch-test'], [7, 'delimiter.monarch-test', 'monarch-test'], [9, 'expression', 'calculation']],
		[[0, 'expression', 'calculation'], [2, 'delimiter.monarch-test', 'monarch-test'], [4, 'source.monarch-test', 'monarch-test']],
	]);
	assert.equal(second.endState.equals(initial), true);
});

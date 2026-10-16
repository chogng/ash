import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { StandardTokenType } from '../../../../../editor/common/encodedTokenAttributes.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'mocha';
import * as treeSitterNamespace from '@vscode/tree-sitter-wasm';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { TreeSitterTokenizationRuntime } from '../../../../../editor/common/model/tokens/treeSitter/treeSitterTree.js';
import { TreeSitterWorker } from '../../../../../editor/common/services/treeSitter/treeSitterWorker.js';
import type { ITreeSitterLibraryService } from '../../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { editorLanguageForSyntaxLanguage, syntaxLanguageForEditorLanguage, syntaxLanguages } from '../../../../../platform/syntax/common/syntaxApi.js';
import { getWorkbenchColorTheme } from '../../../../common/theme.js';
import { createTreeSitterSyntaxTokenBackend } from '../../browser/treeSitterLibraryService.js';
import { getLanguageFoldingRules } from '../../../../../platform/language/common/languageFolding.generated.js';

const runtime = (treeSitterNamespace as unknown as { default?: typeof treeSitterNamespace; }).default ?? treeSitterNamespace;
interface Grammar { name: string; wasm: { path?: string; package?: string; }; languages: { id: string; }[]; highlights: string[]; tags: string[]; folds: string[]; injections: string[]; }
const grammars = new Map<string, { directory: string; grammar: Grammar; }>();
for (const directory of readdirSync('extensions')) {
	const file = resolve('extensions', directory, 'tree-sitter/grammars.json');
	if (!existsSync(file)) continue;
	for (const grammar of JSON.parse(readFileSync(file, 'utf8')) as Grammar[]) {
		for (const language of grammar.languages) grammars.set(language.id, { directory, grammar });
	}
}
const loaded = new Map<string, Promise<TreeSitterTokenizationRuntime>>();
before(async () => { await runtime.Parser.init(); });
after(async () => {
	for (const result of await Promise.allSettled(loaded.values())) {
		if (result.status === 'fulfilled') { result.value.query.delete(); result.value.symbols?.delete(); result.value.folds?.delete(); result.value.injections?.delete(); }
	}
});

async function load(id: string): Promise<TreeSitterTokenizationRuntime | undefined> {
	const language = syntaxLanguageForEditorLanguage(id);
	if (!language) return undefined;
	let pending = loaded.get(language);
	if (!pending) {
		pending = (async () => {
			const { directory, grammar } = grammars.get(language)!;
			const resource = (file: string) => file.startsWith('@') ? resolve('extensions', file.slice(1)) : resolve('extensions', directory, file);
			const queries = (files: string[]) => files.map(file => readFileSync(resource(file), 'utf8')).join('\n');
			const wasm = grammar.wasm.package ? resolve('node_modules', grammar.wasm.package) : resource(grammar.wasm.path!);
			const highlights = queries(grammar.highlights), tags = queries(grammar.tags), folds = queries(grammar.folds), injections = queries(grammar.injections);
			const parserLanguage = await runtime.Language.load(new Uint8Array(readFileSync(wasm)));
			return { Parser: runtime.Parser, language: parserLanguage, languageId: editorLanguageForSyntaxLanguage(language), foldingRules: getLanguageFoldingRules(editorLanguageForSyntaxLanguage(language)), query: new runtime.Query(parserLanguage, highlights), folds: new runtime.Query(parserLanguage, folds), ...(tags ? { symbols: new runtime.Query(parserLanguage, tags) } : {}), ...(injections ? { injections: new runtime.Query(parserLanguage, injections) } : {}), loadEmbeddedLanguage: load };
		})();
		loaded.set(language, pending);
	}
	return pending;
}

const library: ITreeSitterLibraryService = {
	_serviceBrand: undefined,
	onDidChange: Event.None,
	supportsLanguage: id => syntaxLanguageForEditorLanguage(id) !== undefined,
	createSession(model) {
		const worker = new TreeSitterWorker(async language => (await load(language))!);
		worker.handleNotification({ kind: 'open', document: 1, text: model.getValue(), eol: model.getEOL(), revision: model.version, language: model.getLanguageId() });
		const edits = model.onDidChangeContent(change => worker.handleNotification({ kind: 'update', document: 1, change }));
		return {
			...toDisposable(() => { edits.dispose(); worker.dispose(); }),
			setTabSize: tabSize => worker.handleNotification({ kind: 'options', document: 1, tabSize }),
			update: () => { /* The model listener synchronizes this in-process session. */ },
			request: (operation, data, signal) => worker.handleRequest({ ...data, document: 1, revision: model.version, operation }, signal),
		};
	},
};
const configuration = { getValue: () => false } as unknown as IConfigurationService;

async function highlighted(language: string, text: string, themeId = 'ash-dark') {
	using model = new TextModel(text, { languageId: language });
	using themeService = new TestThemeService(getWorkbenchColorTheme(themeId));
	using backend = createTreeSitterSyntaxTokenBackend(model, configuration, library, themeService)!;
	backend.setVisibleLines([{ startLineNumber: 1, endLineNumber: model.getLineCount() }]);
	await backend.whenReady(new AbortController().signal);
	return backend.lines.flatMap(row => row.tokens.map(token => ({ ...token, text: model.getTextInRange(token.range) })));
}

for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
	test(`Markdown Tree-sitter preserves authored styles in ${id}`, async () => {
		const tokens = await highlighted('markdown', '# Heading\n\n**strong** *emphasis* ~~removed~~ `inline` [link](https://example.com)\n\n- item\n> quote\n\n```\ncode block\n```', id);
		for (const text of ['Heading', 'inline', 'https://example.com', 'code block', '-', '>']) {
			const token = tokens.find(token => token.text.includes(text));
			assert.ok(token?.presentation?.foreground, `${id}: ${text} has a syntax color`);
			assert.notEqual(token.presentation.foreground.toLowerCase(), getWorkbenchColorTheme(id).getColorCss('editor.foreground')?.toLowerCase(), `${id}: ${text} differs from prose`);
		}
		assert.ok(tokens.find(token => token.text.includes('strong'))?.presentation?.fontStyle?.includes('bold'));
		assert.ok(tokens.find(token => token.text.includes('emphasis'))?.presentation?.fontStyle?.includes('italic'));
		assert.ok(tokens.find(token => token.text.includes('removed'))?.presentation?.fontStyle?.includes('strikethrough'));
		assert.ok(tokens.find(token => token.text.includes('https://example.com'))?.presentation?.fontStyle?.includes('underline'));
		assert.ok(tokens.find(token => token.text.includes('Heading'))?.presentation?.fontStyle?.includes('bold'));
	});
	test(`Git and INI Tree-sitter preserve meaningful colors in ${id}`, async () => {
		for (const [language, text, lexeme] of [
			['ignore', '# comment', '# comment'], ['ignore', '!keep.log', '!'], ['ignore', '*.log', '*'],
			['ignore', String.raw`\#literal`, String.raw`\#`], ['git-rebase', 'pick abc1234 Fix', 'pick'],
			['git-rebase', 'pick abc1234 Fix', 'abc1234'], ['git-rebase', 'exec echo "hello"', 'hello'],
			['git-commit', 'Fix\n\n#\tnew file: file', 'new file: file'],
			['properties', '[core]\neditor = "ash"', 'editor'], ['ini', '[core]\neditor = "ash"', 'editor'],
			['diff', '@@ -1 +1 @@\n-old\n+new', 'old'], ['diff', '@@ -1 +1 @@\n-old\n+new', 'new'],
		]) {
			const tokens = await highlighted(language, text, id);
			const token = tokens.find(token => token.text.includes(lexeme));
			assert.ok(token?.presentation?.foreground, `${id}: ${language} ${lexeme} has a syntax color`);
			assert.notEqual(token.presentation.foreground.toLowerCase(), getWorkbenchColorTheme(id).getColorCss('editor.foreground')?.toLowerCase(), `${id}: ${language} ${lexeme} differs from plain text`);
		}
	});
}


test('Git commit WASM matches the unmodified parser on all 64 upstream corpus examples', async () => {
	const corpus = JSON.parse(readFileSync('test/fixtures/tree-sitter/gitcommit.json', 'utf8')) as { cases: { name: string; source: string; tree: string; }[]; };
	assert.equal(corpus.cases.length, 64);
	const grammar = (await load('gitcommit'))!;
	const parser = new grammar.Parser();
	parser.setLanguage(grammar.language);
	try {
		for (const sample of corpus.cases) {
			const tree = parser.parse(sample.source)!;
			try { assert.equal(tree.rootNode.toString(), sample.tree, sample.name); }
			finally { tree.delete(); }
		}
	} finally { parser.delete(); }
});

test('CoffeeScript parses the official-compiler-validated corpus through edits and undo', async () => {
	const corpus = JSON.parse(readFileSync('test/fixtures/tree-sitter/coffeescript.json', 'utf8')) as { cases: { name: string; source: string; topLevelStatements: number; }[]; };
	assert.equal(corpus.cases.length, 41);
	const grammar = (await load('coffeescript'))!;
	const parser = new grammar.Parser();
	parser.setLanguage(grammar.language);
	try {
		for (const sample of corpus.cases) {
			let tree = parser.parse(sample.source)!;
			const check = () => {
				assert.equal(tree.rootNode.hasError, false, sample.name);
				const sequence = tree.rootNode.namedChildren.find(node => node?.type === 'statement_sequence');
				assert.equal(sequence?.namedChildren.filter(node => node?.type === 'statement').length ?? 0, sample.topLevelStatements, sample.name);
			};
			try {
				check();
				tree.edit({ startIndex: 0, oldEndIndex: 0, newEndIndex: 1, startPosition: { row: 0, column: 0 }, oldEndPosition: { row: 0, column: 0 }, newEndPosition: { row: 1, column: 0 } });
				const edited = parser.parse('\n' + sample.source, tree)!;
				tree.delete();
				tree = edited;
				check();
				tree.edit({ startIndex: 0, oldEndIndex: 1, newEndIndex: 0, startPosition: { row: 0, column: 0 }, oldEndPosition: { row: 1, column: 0 }, newEndPosition: { row: 0, column: 0 } });
				const restored = parser.parse(sample.source, tree)!;
				tree.delete();
				tree = restored;
				check();
			} finally { tree.delete(); }
		}
	} finally { parser.delete(); }
});

test('CoffeeScript recovers from an incomplete parameter list and excessive indentation', async () => {
	const grammar = (await load('coffeescript'))!;
	const parser = new grammar.Parser();
	parser.setLanguage(grammar.language);
	try {
		const source = 'greet = (name) ->\n  name\nfollowing = yes\n';
		let tree = parser.parse(source)!;
		try {
			tree.edit({ startIndex: 13, oldEndIndex: 14, newEndIndex: 13, startPosition: { row: 0, column: 13 }, oldEndPosition: { row: 0, column: 14 }, newEndPosition: { row: 0, column: 13 } });
			const incomplete = parser.parse(source.slice(0, 13) + source.slice(14), tree)!;
			tree.delete();
			tree = incomplete;
			assert.equal(tree.rootNode.hasError, true);
			tree.edit({ startIndex: 13, oldEndIndex: 13, newEndIndex: 14, startPosition: { row: 0, column: 13 }, oldEndPosition: { row: 0, column: 13 }, newEndPosition: { row: 0, column: 14 } });
			const restored = parser.parse(source, tree)!;
			tree.delete();
			tree = restored;
			assert.equal(tree.rootNode.hasError, false);
		} finally { tree.delete(); }
		// Beyond the scanner's serialized-state budget, malformed trees must remain recoverable.
		const deep = parser.parse(Array.from({ length: 520 }, (_, depth) => '  '.repeat(depth) + 'if yes\n').join('') + '  '.repeat(520) + 'value = 1\n')!;
		try { assert.equal(deep.rootNode.hasError, true); }
		finally { deep.delete(); }
		const clean = parser.parse(source)!;
		try { assert.equal(clean.rootNode.hasError, false); }
		finally { clean.delete(); }
	} finally { parser.delete(); }
});

test('Git ignore distinguishes escaped prefixes, operators and complete character classes', async () => {
	for (const text of [String.raw`\#literal`, String.raw`\!literal`, String.raw`\*literal`, 'prefix#!literal']) {
		const tokens = await highlighted('ignore', text);
		assert.equal(tokens.some(token => token.tokenType === 'operator' || token.tokenType === 'comment'), false, text);
	}
	const operators = await highlighted('ignore', '!**/file[0-9]?.txt');
	assert.deepEqual(operators.filter(token => token.tokenType === 'operator').map(token => token.text), ['!', '**', '?']);
	for (const text of ['[[:digit:]]', '[!a-z]', '[]a]']) {
		const tokens = await highlighted('ignore', text);
		assert.ok(tokens.some(token => token.tokenType === 'constant' && token.text === text), text);
	}
});

test('An unterminated rebase exec string cannot consume the following operation', async () => {
	const tokens = await highlighted('git-rebase', 'exec echo "unfinished\npick abc1234 Fix');
	assert.ok(tokens.some(token => token.tokenType === 'string' && token.text.includes('unfinished')));
	assert.ok(tokens.some(token => token.tokenType === 'keyword' && token.text === 'pick'));
});

test('Embedded script preserves language identity through unstyled text and supplies bracket pairs', async () => {
	using model = new TextModel('<script>const value = { unknown };</script>', { languageId: 'html' });
	using themeService = new TestThemeService(getWorkbenchColorTheme('ash-dark'));
	using backend = createTreeSitterSyntaxTokenBackend(model, configuration, library, themeService)!;
	await backend.whenReady(new AbortController().signal);
	const unknown = model.getValue().indexOf('unknown') + 1;
	assert.ok(backend.getLanguageTokens(1).some(token => token.languageId === 'javascript' && token.range.startColumn <= unknown && token.range.endColumn > unknown));
	assert.ok(backend.getBracketPairs(new Range(1, 1, 1, model.getLineMaxColumn(1))).some(pair => pair.text === '{' && pair.closeText === '}'));
	const preview = await backend.tokenizeLinesAtAsync(1, ['<script>const value = "changed";</script>'], new AbortController().signal);
	assert.ok(preview[0]!.some(token => token.languageId === 'javascript' && token.tokenType === 'string'));
	assert.equal(model.getValue(), '<script>const value = { unknown };</script>');
});

test('Multiline embedded strings cannot consume Diff change markers', async () => {
	const tokens = await highlighted('diff', 'diff --git a/main.js b/main.js\n--- a/main.js\n+++ b/main.js\n@@ -1,2 +1,2 @@\n-const old = `one\n-two`;\n+const value = `three\n+four`;\n');
	assert.ok(tokens.some(token => token.languageId === 'javascript' && token.tokenType === 'string' && token.text.includes('four')));
	assert.equal(tokens.some(token => token.languageId === 'javascript' && /^[+-]/.test(token.text)), false);
});

test('Markdown hypothetical edits preserve embedded language and relative Unicode coordinates', async () => {
	using model = new TextModel('# Title\r\n\r\n```python\r\nprint("你好🙂")\r\n```\r\n', { languageId: 'markdown' });
	using themeService = new TestThemeService(getWorkbenchColorTheme('ash-dark'));
	using backend = createTreeSitterSyntaxTokenBackend(model, configuration, library, themeService)!;
	await backend.whenReady(new AbortController().signal);
	const preview = await backend.tokenizeLinesAtAsync(4, ['print("更新🙂")'], new AbortController().signal);
	assert.ok(preview[0]!.some(token => token.languageId === 'python' && token.tokenType === 'string' && token.range.startLineNumber === 1 && token.range.endColumn <= 14));
	assert.equal(model.getLineContent(4), 'print("你好🙂")');
});


test('token inspection reads current UTF-16 captures from the shared backend and excludes stale revisions', async () => {
	using model = new TextModel('/* 😀 */ function demo() {}', { languageId: 'javascript' });
	using themeService = new TestThemeService(getWorkbenchColorTheme('ash-dark'));
	using backend = createTreeSitterSyntaxTokenBackend(model, configuration, library, themeService)!;
	assert.deepEqual(backend.getTokenCaptures(1), []);
	await backend.whenReady(new AbortController().signal);
	const before = backend.getTokenCaptures(1);
	assert.ok(before.some(token => token.name === 'function' && model.getValue().slice(token.start, token.end) === 'demo'));
	const start = model.getValue().indexOf('demo') + 1;
	model.applyEdits([{ range: new Range(1, start, 1, start + 4), text: 'renamed' }]);
	assert.deepEqual(backend.getTokenCaptures(1), []);
	await backend.whenReady(new AbortController().signal);
	assert.ok(backend.getTokenCaptures(1).some(token => token.name === 'function' && model.getValue().slice(token.start, token.end) === 'renamed'));
	assert.notEqual(before, backend.getTokenCaptures(1));
});


test('Every declared syntax language loads its real WASM grammar and themeable captures', async () => {
	for (const id of syntaxLanguages) {
		const grammar = (await load(id))!;
		for (const capture of grammar.query.captureNames) {
			if (!capture.startsWith('_')) assert.match(capture, /^[A-Za-z][\w]*(?:\.[\w]+)*$/u, `${id}: ${capture} must be usable as a theme selector`);
		}
		const parser = new grammar.Parser();
		parser.setLanguage(grammar.language);
		try {
			const tree = parser.parse('');
			assert.ok(tree, id);
			tree.delete();
		} finally { parser.delete(); }
	}
});


test('Hypothetical tokenization uses the shared parser without a legacy token provider', async () => {
	using themeService = new TestThemeService(getWorkbenchColorTheme('ash-dark'));
	using model = new TextModel('fn main() {}', {
		languageId: 'rs',
		tokenization: { createSyntaxTokenBackend: value => createTreeSitterSyntaxTokenBackend(value, configuration, library, themeService) },
	});
	await model.tokenization.whenReady(new AbortController().signal);
	const tokens = await model.tokenization.tokenizeLinesAtAsync(1, ['fn preview() { "preview"; }'], new AbortController().signal);
	assert.ok(tokens);
	assert.ok(Array.from({ length: tokens[0]!.getCount() }, (_, index) => tokens[0]!.getStandardTokenType(index)).includes(StandardTokenType.String));
	assert.equal(model.getValue(), 'fn main() {}');
});

interface StructureFixture { language: string; text: string; symbols: string[]; folds: [number, number][]; noFolds?: boolean; exactSymbols?: boolean; }
const structureFixtures = JSON.parse(readFileSync('test/fixtures/tree-sitter/structure.json', 'utf8')) as StructureFixture[];

interface FoldingFixture { language: string; offSide: boolean; text: string; regions: [number, number][]; indentFold?: [number, number]; }
const foldingFixtures: FoldingFixture[] = JSON.parse(readFileSync('test/fixtures/languages/folding.json', 'utf8'));
for (const [index, fixture] of foldingFixtures.entries()) test(`Folding ${fixture.language} fixture ${index} follows package rules through edits and undo`, async () => {
	using model = new TextModel(fixture.text, { languageId: fixture.language });
	using worker = new TreeSitterWorker(async id => (await load(id))!);
	worker.handleNotification({ kind: 'open', document: 1, text: fixture.text, eol: '\n', revision: model.version, language: fixture.language });
	using changes = model.onDidChangeContent(change => worker.handleNotification({ kind: 'update', document: 1, change }));
	assert.equal(getLanguageFoldingRules(fixture.language)?.offSide ?? false, fixture.offSide);
	for (let revision = 1; revision <= 3; revision++) {
		const facts = (await worker.handleRequest({ document: 1, revision: model.version, operation: 'facts' }, new AbortController().signal)).facts!;
		const shift = revision === 2 ? 1 : 0;
		assert.deepEqual(facts.folds.filter(fold => fold.kind === 'region').map(fold => [fold.startLineIndex, fold.endLineIndex]), fixture.regions.map(([start, end]) => [start + shift, end + shift]));
		if (fixture.indentFold) {
			const [start, end] = fixture.indentFold.map(row => row + shift);
			assert.ok(facts.folds.some(fold => fold.startLineIndex === start && fold.endLineIndex === end), `Missing ${start}..${end}: ${JSON.stringify(facts.folds)}`);
		}
		if (revision === 1) model.applyEdits([{ range: new Range(1, 1, 1, 1), text: '\n' }]);
		else if (revision === 2) model.applyEdits([{ range: new Range(1, 1, 2, 1), text: '' }]);
	}
});

for (const [index, fixture] of structureFixtures.entries()) test(`Structure ${fixture.language} fixture ${index}: folds and outline survive edits and undo`, async () => {
	using model = new TextModel(fixture.text, { languageId: editorLanguageForSyntaxLanguage(fixture.language as typeof syntaxLanguages[number]) });
	const worker = new TreeSitterWorker(async id => (await load(id))!);
	try {
		worker.handleNotification({ kind: 'open', document: 1, text: fixture.text, eol: '\n', revision: model.version, language: fixture.language });
		using changes = model.onDidChangeContent(change => worker.handleNotification({ kind: 'update', document: 1, change }));
		const facts = async () => (await worker.handleRequest({ document: 1, revision: model.version, operation: 'facts' }, new AbortController().signal)).facts!;
		const original = await facts();
		for (const name of fixture.symbols) assert.ok(original.symbols.some(symbol => symbol.name === name), `${fixture.language}: missing ${name}; got ${original.symbols.map(symbol => symbol.name)}`);
		for (const [start, end] of fixture.folds) assert.ok(original.folds.some(fold => fold.startLineIndex === start && fold.endLineIndex === end), `${fixture.language}: missing ${start}..${end}; got ${JSON.stringify(original.folds)}`);
		if (fixture.exactSymbols) assert.deepEqual(original.symbols.map(symbol => symbol.name), fixture.symbols);
		if (fixture.noFolds) assert.deepEqual(original.folds, []);
		model.applyEdits([{ range: new Range(1, 1, 1, 1), text: '\n' }]);
		const shifted = await facts();
		const fresh = new TreeSitterWorker(async id => (await load(id))!);
		try {
			fresh.handleNotification({ kind: 'open', document: 1, text: model.getValue(), eol: '\n', revision: model.version, language: fixture.language });
			const cold = await fresh.handleRequest({ document: 1, revision: model.version, operation: 'facts' }, new AbortController().signal);
			assert.deepEqual(shifted, cold.facts);
		} finally { fresh.dispose(); }
		model.applyEdits([{ range: new Range(1, 1, 2, 1), text: '' }]);
		assert.deepEqual(await facts(), original);
	} finally { worker.dispose(); }
});

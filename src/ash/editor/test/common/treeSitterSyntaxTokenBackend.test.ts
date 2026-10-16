import { Event } from '../../../base/common/event.js';
import type { TreeSitterTokenizationMeasure } from '../../common/services/treeSitter/treeSitterLibraryService.js';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, after, test } from 'mocha';
import * as treeSitterNamespace from '@vscode/tree-sitter-wasm';
import { TextModel } from '../../common/model/textModel.js';
import { Range } from '../../common/core/range.js';
import { TreeSitterTree, type TreeSitterTokenizationRuntime } from '../../common/model/tokens/treeSitter/treeSitterTree.js';

const runtime = (treeSitterNamespace as unknown as { default?: typeof treeSitterNamespace; }).default ?? treeSitterNamespace;
const grammars = new Map<string, TreeSitterTokenizationRuntime>();
const signal = () => new AbortController().signal;

before(async () => {
	await runtime.Parser.init({ locateFile: () => resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm') });
	for (const language of ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'rust', 'python']) {
		const grammarName = language === 'javascriptreact' ? 'javascript' : language === 'typescriptreact' ? 'tsx' : language;
		const grammar = await runtime.Language.load(resolve(`node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammarName}.wasm`));
		const query = (name: string) => readFileSync(resolve(`extensions/${name === 'python' ? 'python' : name === 'rust' ? 'rust' : name === 'typescript' ? 'typescript-basics' : 'javascript'}/queries/${name}.scm`), 'utf8');
		const queries = language === 'python' ? ['python'] : language === 'rust' ? ['rust'] : ['javascript', ...(language.endsWith('react') ? ['jsx'] : []), ...(language.startsWith('typescript') ? ['typescript'] : [])];
		grammars.set(language, { Parser: runtime.Parser, language: grammar, query: new runtime.Query(grammar, queries.map(query).join('\n')) });
	}
});

after(() => { for (const grammar of grammars.values()) grammar.query.delete(); });

function backend(model: TextModel, language = 'javascript', samples?: TreeSitterTokenizationMeasure[]): TreeSitterTree {
	return new TreeSitterTree(model, Promise.resolve(grammars.get(language)!), capture => ({ tokenType: capture, foreground: '#123456' }), sample => samples?.push(sample));
}

function tokens(value: TreeSitterTree, model: TextModel) {
	value.refreshRange(1, model.getLineCount());
	return value.lines.map(line => ({ row: line.lineIndex, tokens: line.tokens.map(token => ({ range: token.range, type: token.tokenType, text: model.getTextInRange(token.range) })) }));
}

async function assertFresh(incremental: TreeSitterTree, model: TextModel, language = 'javascript'): Promise<void> {
	await incremental.whenReady(signal());
	using freshModel = new TextModel(model.getValue());
	using fresh = backend(freshModel, language);
	await fresh.whenReady(signal());
	assert.deepEqual(tokens(incremental, model), tokens(fresh, freshModel));
}

test('Tree-sitter reuses the tree and queries only the edited scope while retaining other cached rows', async () => {
	using model = new TextModel('// comment\n' + Array.from({ length: 1000 }, (_, index) => `function item${index}() { return "value"; }`).join('\n'));
	const samples: TreeSitterTokenizationMeasure[] = [];
	using value = backend(model, 'javascript', samples);
	await value.whenReady(signal());
	tokens(value, model);
	samples.length = 0;
	const changed: { fromLineNumber: number; toLineNumber: number; }[] = [];
	using listener = value.onDidChangeTokens(ranges => changed.push(...ranges));
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: ' ' }]);
	await value.whenReady(signal());
	assert.ok(samples.filter(sample => sample.operation === 'parse').every(sample => sample.incremental));
	assert.deepEqual(changed, [{ fromLineNumber: 1, toLineNumber: 1 }]);
	assert.ok(samples.filter(sample => sample.operation === 'query').reduce((sum, sample) => sum + sample.lines, 0) <= 2);
	await assertFresh(value, model);
});

test('Tree-sitter invalidates multiline syntax and shifted rows, including error recovery and undo', async () => {
	using model = new TextModel('const first = "😀";\nfunction value() {\n  return first;\n}\nconst tail = 42;\n');
	using value = backend(model);
	await value.whenReady(signal());
	tokens(value, model);
	for (const edit of [
		{ range: new Range(2, 1, 2, 1), text: '/*\n' },
		{ range: new Range(5, 2, 5, 2), text: '*/' },
		{ range: new Range(3, 1, 5, 4), text: 'function changed() {}\n' },
		{ range: new Range(1, 16, 1, 16), text: '中文' },
	]) {
		model.applyEdits([edit]);
		await assertFresh(value, model);
	}
	model.undo();
	await assertFresh(value, model);
});

test('Tree-sitter composes TypeScript and JavaScript queries and preserves Unicode columns', async () => {
	using model = new TextModel('const label: string = "😀中文";\nfunction answer(value: number): number { return value + 42; }');
	using value = backend(model, 'typescript');
	await value.whenReady(signal());
	const all = tokens(value, model).flatMap(row => row.tokens);
	assert.ok(all.some(token => token.type === 'keyword' && token.text === 'return'));
	assert.ok(all.some(token => token.type.startsWith('function') && token.text === 'answer'));
	assert.ok(all.some(token => token.type === 'number' && token.text === '42'));
	assert.ok(all.some(token => token.type === 'string' && token.text === '"😀中文"'));
	model.applyEdits([{ range: new Range(1, 26, 1, 26), text: 'x' }]);
	await assertFresh(value, model, 'typescript');
});

test('Tree-sitter hypothetical input and theme changes preserve the document and parse tree', async () => {
	using model = new TextModel('pub fn answer() -> i32 { 42 }\n');
	const samples: TreeSitterTokenizationMeasure[] = [];
	using value = backend(model, 'rust', samples);
	await value.whenReady(signal());
	const original = tokens(value, model);
	samples.length = 0;
	const preview = value.tokenizeLinesAt(1, ['pub fn preview() { "preview"; }']);
	assert.ok(preview[0]!.some(token => token.tokenType === 'string'));
	value.resetStyles();
	assert.deepEqual(tokens(value, model), original);
	assert.equal(model.version, 1);
	assert.equal(samples.filter(sample => sample.operation === 'parse').length, 0);
});

test('Tree-sitter cancels pending preparation and releases a parser loaded after document disposal', async () => {
	using model = new TextModel('const value = 1;');
	let release!: (value: TreeSitterTokenizationRuntime) => void;
	using value = new TreeSitterTree(model, new Promise(resolve => release = resolve), capture => ({ tokenType: capture }));
	const controller = new AbortController();
	const pending = value.whenReady(controller.signal);
	controller.abort();
	await assert.rejects(pending);
	value.dispose();
	release(grammars.get('javascript')!);
	await Promise.resolve();
});


test('Tree-sitter handles CRLF, disjoint edit batches and deletion through EOF', async () => {
	using model = new TextModel('const first = "😀";\r\nconst middle = 2;\r\nconst last = 3;\r\n');
	using value = backend(model);
	await value.whenReady(signal());
	tokens(value, model);
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: '// prefix\r\n' }, { range: new Range(3, 14, 3, 15), text: '4' }]);
	await assertFresh(value, model);
	model.applyEdits([{ range: new Range(2, 1, model.getLineCount(), model.getLineMaxColumn(model.getLineCount())), text: 'const remaining = "中文";\r\n' }]);
	await assertFresh(value, model);
	assert.equal(value.tokenCount, value.lines.reduce((sum, line) => sum + line.tokens.length, 0));
});


test('Tree-sitter batches pending edits before parsing and recolors a closed multiline comment', async () => {
	using model = new TextModel('// prefix\nconst value = "value";\n// */');
	const samples: TreeSitterTokenizationMeasure[] = [];
	using value = backend(model, 'javascript', samples);
	await value.whenReady(signal());
	tokens(value, model);
	samples.length = 0;
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: ' ' }]);
	assert.notEqual(value.modelVersion, model.version);
	await value.whenReady(signal());
	assert.ok(samples.some(sample => sample.operation === 'parse' && sample.completed && sample.incremental));
	model.applyEdits([{ range: new Range(1, 1, 1, 2), text: '/*' }]);
	await value.whenReady(signal());
	value.refreshRange(2, 2);
	assert.ok(value.getLanguageTokens(2).every(token => token.tokenType === 'comment'));
	assert.ok(value.getLanguageTokens(2).length > 0);
	await assertFresh(value, model);
});

test('Tree-sitter composes JSX/TSX queries and retains code inside JSX expressions', async () => {
	for (const language of ['javascriptreact', 'typescriptreact']) {
		using model = new TextModel('const view = <panel title="hello">{answer(42)}</panel>;');
		using value = backend(model, language);
		await value.whenReady(signal());
		const all = tokens(value, model).flatMap(row => row.tokens);
		assert.ok(all.some(token => token.text === 'panel' && token.type.startsWith('tag')));
		assert.ok(all.some(token => token.text === 'answer' && token.type.startsWith('function')));
		assert.ok(all.some(token => token.text === '42' && token.type === 'number'));
		model.applyEdits([{ range: new Range(1, 27, 1, 32), text: 'changed' }]);
		await assertFresh(value, model, language);
	}
});

test('Tree-sitter reads long strings across UTF-16 chunk boundaries without losing astral characters', async () => {
	const text = 'const value = "' + 'a'.repeat(4095 - 'const value = "'.length) + '😀中文' + 'b'.repeat(4200) + '";';
	using model = new TextModel(text);
	using value = backend(model);
	await value.whenReady(signal());
	const string = tokens(value, model).flatMap(row => row.tokens).find(token => token.type === 'string');
	assert.equal(string?.text, text.slice(text.indexOf('"'), -1));
	model.applyEdits([{ range: new Range(1, 4096, 1, 4096), text: 'x' }]);
	await assertFresh(value, model);
});


test('Tree-sitter parses and edits through buffer chunks without materializing a full-document string', async () => {
	using model = new TextModel(Array.from({ length: 10000 }, (_, index) => `const item${index} = "value";`).join('\n'));
	const originalGetValue = model.getValue;
	const originalGetValueLength = model.getValueLength;
	model.getValue = () => { throw new Error('Full-document materialization in parser input'); };
	model.getValueLength = () => { throw new Error('Full-document materialization in parser length check'); };
	using value = backend(model);
	try {
		await value.whenReady(signal());
		model.applyEdits([{ range: new Range(1, 1, 1, 1), text: '// ' }]);
		await value.whenReady(signal());
		assert.equal(value.modelVersion, model.version);
	} finally {
		model.getValue = originalGetValue;
		model.getValueLength = originalGetValueLength;
	}
	await assertFresh(value, model);
});


test('Tree-sitter publishes newly visible rows once so view token caches refresh on scroll', async () => {
	using model = new TextModel('const first = 1;\nconst second = 2;\nconst third = 3;');
	using value = backend(model);
	await value.whenReady(signal());
	assert.deepEqual(value.getLanguageTokens(3), []);
	const changed: { fromLineNumber: number; toLineNumber: number; }[] = [];
	using listener = value.onDidChangeTokens(ranges => changed.push(...ranges));
	value.setVisibleLines([{ startLineNumber: 3, endLineNumber: 3 }]);
	assert.deepEqual(changed, [{ fromLineNumber: 3, toLineNumber: 3 }]);
	assert.ok(value.getLanguageTokens(3).length > 0);
	value.setVisibleLines([{ startLineNumber: 3, endLineNumber: 3 }]);
	assert.equal(changed.length, 1);
});

// Exercise the Worker boundary against real grammars, not a second fake parser.
import { TreeSitterWorker } from '../../common/services/treeSitter/treeSitterWorker.js';
import { getLanguageFoldingRules } from '../../../platform/language/common/languageFolding.generated.js';
import { TreeSitterSyntaxTokenBackend } from '../../common/model/tokens/treeSitter/treeSitterSyntaxTokenBackend.js';

test('a changed viewport preempts structure work without rejecting its shared consumers', async () => {
	using model = new TextModel('function first() {}\nfunction second() {}');
	const calls: string[] = [];
	const signals: AbortSignal[] = [];
	let release!: () => void;
	const blocked = new Promise<void>(resolve => release = resolve);
	const facts = { folds: [], symbols: [], diagnostics: [] };
	using value = new TreeSitterSyntaxTokenBackend(model, {
		execution: 'rust',
		update() { }, setTabSize() { }, dispose() { }, [Symbol.dispose]() { },
		async request(operation, _data, signal) {
			calls.push(operation);
			if (operation === 'facts') {
				signals.push(signal);
				if (signals.length === 1) await blocked;
				return { revision: model.version, facts, measures: [] };
			}
			return { revision: model.version, rows: [], measures: [] };
		},
	}, () => undefined);
	const first = value.getFacts(signal()), second = value.getFacts(signal());
	assert.deepEqual(calls, ['highlight', 'facts']);
	value.setVisibleLines([{ startLineNumber: 1, endLineNumber: 2 }]);
	await Promise.resolve();
	assert.equal(signals[0]!.aborted, true);
	assert.deepEqual(calls, ['highlight', 'facts', 'highlight']);
	// Even a transport that resolves an already-cancelled response must cause a
	// retry. Both providers keep joining the original current-revision request.
	release();
	assert.equal(await first, facts);
	assert.equal(await second, facts);
	assert.deepEqual(calls, ['highlight', 'facts', 'highlight', 'facts']);
});

test('disposing preempted structure work cancels consumers and prevents its retry', async () => {
	using model = new TextModel('const first = 1;\nconst second = 2;');
	const calls: string[] = [];
	const value = new TreeSitterSyntaxTokenBackend(model, {
		execution: 'rust',
		update() { }, setTabSize() { }, dispose() { }, [Symbol.dispose]() { },
		async request(operation, _data, signal) {
			calls.push(operation);
			if (operation === 'facts') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
			return { revision: model.version, rows: [], measures: [] };
		},
	}, () => undefined);
	const facts = value.getFacts(signal());
	value.setVisibleLines([{ startLineNumber: 1, endLineNumber: 2 }]);
	await Promise.resolve();
	value.dispose();
	await assert.rejects(facts, /aborted|cancelled/i);
	assert.equal(calls.filter(operation => operation === 'facts').length, 1);
});

function workerFor(language: string): TreeSitterWorker {
	return new TreeSitterWorker(async () => {
		const grammar = grammars.get(language)!;
		const query = (name: string) => readFileSync(resolve(`extensions/${name === 'python' ? 'python' : name === 'rust' ? 'rust' : name === 'typescript' ? 'typescript-basics' : 'javascript'}/queries/${name}.tags.scm`), 'utf8');
		const tags = language === 'python' ? query('python') : language === 'rust' ? query('rust') : query('javascript') + (language.startsWith('typescript') ? '\n' + query('typescript') : '');
		const symbols = new runtime.Query(grammar.language, tags);
		const foldName = language === 'python' ? 'python' : language === 'rust' ? 'rust' : language === 'typescriptreact' ? 'tsx' : language;
		const folder = language === 'python' ? 'python' : language === 'rust' ? 'rust' : language.startsWith('typescript') ? 'typescript-basics' : 'javascript';
		const folds = new runtime.Query(grammar.language, readFileSync(resolve(`extensions/${folder}/queries/${foldName}.folds.scm`), 'utf8'));
		ownedQueries.push(symbols, folds);
		return { ...grammar, symbols, folds, foldingRules: getLanguageFoldingRules(language) };
	});
}
const ownedQueries: import('@vscode/tree-sitter-wasm').Query[] = [];
after(() => { for (const query of ownedQueries) query.delete(); });

for (const language of ['javascript', 'typescript', 'rust']) test(`shared Worker ${language}: highlighting, folding, outline, diagnostics and selection reuse one incremental tree`, async () => {
	using model = new TextModel(language === 'rust' ? 'fn hello() {\n  let label = "😀中文";\n}\n' : 'function hello() {\n  const label = "😀中文";\n}\n');
	using worker = workerFor(language);
	worker.handleNotification({ kind: 'open', document: 1, revision: model.version, language, text: model.getValue(), eol: model.getEOL() });
	const request = (operation: string, data = {}) => worker.handleRequest({ document: 1, revision: model.version, operation, ...data }, signal());
	const [highlight, facts, selection] = await Promise.all([request('highlight', { ranges: [{ startLineNumber: 1, endLineNumber: 4 }] }), request('facts'), request('selection', { ranges: [new Range(2, 17, 2, 17)] })]);
	assert.ok(highlight.rows?.some(row => row.tokens.some(token => token.name === 'string')));
	assert.ok(highlight.brackets?.some(pair => pair.text === '{' && pair.closing?.startLineNumber === 3));
	assert.ok(facts.facts?.symbols.some(symbol => symbol.name === 'hello'));
	assert.ok(facts.facts?.folds.some(fold => fold.startLineIndex === 0 && fold.endLineIndex >= 2));
	assert.deepEqual(facts.facts?.diagnostics, []);
	assert.ok(selection.selections?.some(range => range.startLineNumber === 1 && range.endLineNumber === 3));
	assert.equal([...highlight.measures, ...facts.measures, ...selection.measures].filter(measure => measure.operation === 'parse' && measure.completed).length, 1);
	const again = await request('facts');
	assert.equal(again.measures.length, 0, 'facts are cached for all feature consumers');
	using listener = model.onDidChangeContent(change => worker.handleNotification({ kind: 'update', document: 1, change }));
	model.applyEdits([{ range: new Range(1, language === 'rust' ? 4 : 10, 1, language === 'rust' ? 9 : 15), text: '世界' }]);
	const changed = await request('facts');
	assert.equal(changed.revision, model.version);
	assert.ok(changed.facts?.symbols.some(symbol => symbol.name === '世界'));
	assert.ok(changed.measures.some(measure => measure.operation === 'parse' && measure.incremental));
	await assert.rejects(worker.handleRequest({ document: 1, revision: model.version - 1, operation: 'facts' }, signal()), /Obsolete/);
	worker.handleNotification({ kind: 'close', document: 1 });
	await assert.rejects(request('facts'), /Unknown/);
});

test('Worker validates mirror deltas before mutation and handles EOL changes', async () => {
	using model = new TextModel('function hello() {\n  return "中文";\n}\n');
	using worker = workerFor('javascript');
	worker.handleNotification({ kind: 'open', document: 1, revision: model.version, language: 'javascript', text: model.getValue(), eol: model.getEOL() });
	await worker.handleRequest({ document: 1, revision: model.version, operation: 'facts' }, signal());
	using listener = model.onDidChangeContent(change => worker.handleNotification({ kind: 'update', document: 1, change }));
	model.setEOL(1);
	const value = await worker.handleRequest({ document: 1, revision: model.version, operation: 'facts' }, signal());
	assert.ok(value.facts?.symbols.some(symbol => symbol.name === 'hello'));
	assert.throws(() => worker.handleNotification({ kind: 'update', document: 1, change: { version: model.version + 1, eol: '\r\n', isEolChange: false, changes: [{ range: new Range(1, 1, 1, 1), rangeOffset: 99, rangeLength: 0, text: 'x' }] } }), /does not match/);
});

test('renderer proxy ignores stale work, supports cancellation and does not run a parser during input', async () => {
	using model = new TextModel('function hello() {\n  return 1;\n}');
	using worker = workerFor('javascript');
	worker.handleNotification({ kind: 'open', document: 1, revision: model.version, language: 'javascript', text: model.getValue(), eol: model.getEOL() });
	let updates = 0;
	using value = new TreeSitterSyntaxTokenBackend(model, {
		update(change) { updates++; worker.handleNotification({ kind: 'update', document: 1, change }); },
		setTabSize(tabSize) { worker.handleNotification({ kind: 'options', document: 1, tabSize }); },
		async request(operation, data, signal) { await new Promise(resolve => setTimeout(resolve, 1)); signal.throwIfAborted(); return worker.handleRequest({ ...data, document: 1, revision: model.version, operation }, signal); },
		dispose() { }, [Symbol.dispose]() { },
	}, name => ({ tokenType: name }));
	value.setVisibleLines([{ startLineNumber: 1, endLineNumber: 3 }]);
	await value.whenReady(signal());
	assert.ok(value.hasAccurateTokensForLine(2));
	model.applyOperations([{ range: new Range(2, 10, 2, 10), text: '0' }]);
	assert.equal(value.modelVersion, model.version - 1, 'input only schedules asynchronous syntax');
	await model.undo();
	await value.whenReady(signal());
	assert.equal(updates, 2);
	assert.equal(value.modelVersion, model.version);
	assert.ok(value.hasAccurateTokensForLine(2));
	assert.ok((await value.getFacts(signal())).symbols.some(symbol => symbol.name === 'hello'));
	const controller = new AbortController(); controller.abort();
	await assert.rejects(value.getFacts(controller.signal));
});

import { createTestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { Position } from '../../common/core/position.js';

test('model bracket matching, coloring and guides consume the shared Worker tree and ignore string contents', async () => {
	using configurations = createTestLanguageConfigurationService();
	using worker = workerFor('javascript');
	using model = new TextModel('function f() {\n  const value = "[ignored]";\n  return (1);\n}\n', {
		languageId: 'javascript', languageConfigurationService: configurations,
		tokenization: {
			createSyntaxTokenBackend: document => {
				worker.handleNotification({ kind: 'open', document: 1, revision: document.version, language: 'javascript', text: document.getValue(), eol: document.getEOL() });
				return new TreeSitterSyntaxTokenBackend(document, {
					update(change) { worker.handleNotification({ kind: 'update', document: 1, change }); },
					setTabSize(tabSize) { worker.handleNotification({ kind: 'options', document: 1, tabSize }); },
					request(operation, data, signal) { return worker.handleRequest({ ...data, document: 1, revision: document.version, operation }, signal); },
					dispose() { worker.handleNotification({ kind: 'close', document: 1 }); }, [Symbol.dispose]() { this.dispose(); },
				}, name => ({ tokenType: name }));
			}
		},
	});
	model.tokenization.setVisibleLines([{ startLineNumber: 1, endLineNumber: 5 }]);
	await model.tokenization.whenReady(signal());
	assert.equal(model.bracketPairs.getBracketsInRange(model.getFullModelRange()).toArray().length, 6);
	assert.deepEqual(model.bracketPairs.matchBracket(new Position(1, 14)), [new Range(1, 14, 1, 15), new Range(4, 1, 4, 2)]);
	assert.deepEqual(model.bracketPairs.findEnclosingBrackets(new Position(2, 3)), [new Range(1, 14, 1, 15), new Range(4, 1, 4, 2)]);
	assert.equal(model.bracketPairs.getBracketPairsInRangeWithMinIndentation(model.getFullModelRange()).toArray().length, 3);
	assert.equal(model.getLineDecorations(2).filter(value => value.options.description === 'BracketPairColorization').length, 0);
	model.applyOperations([{ range: new Range(1, 10, 1, 11), text: 'renamed' }]);
	await model.tokenization.whenReady(signal());
	assert.equal((await model.tokenization.syntaxTree!.getFacts(signal())).symbols[0]?.name, 'renamed');
});

test('shared folds retain closing rows for multiline imports, exports and destructuring', async () => {
	using worker = workerFor('javascript');
	const text = 'import {\n  value\n} from "module";\nexport {\n  value\n};\nconst {\n  field\n} = value;\nconst [\n  first\n] = value;';
	worker.handleNotification({ kind: 'open', document: 1, revision: 1, language: 'javascript', text, eol: '\n' });
	const result = await worker.handleRequest({ document: 1, revision: 1, operation: 'facts' }, signal());
	assert.deepEqual(result.facts?.folds.map(range => [range.startLineIndex, range.endLineIndex]), [[0, 2], [3, 5], [6, 8], [9, 11]]);
});

import { createAppServerTreeSitterSession } from '../../../workbench/services/treeSitter/browser/appServerTreeSitterSession.js';
import type { ISyntaxApi, SyntaxQueryResult } from '../../../platform/syntax/common/syntaxApi.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';
import { createLanguageFeatureRequest } from '../../common/languages.js';
import { TreeSitterSyntaxProviders } from '../../../workbench/services/treeSitter/browser/treeSitterLibraryService.js';

test('large shared symbols yield to input while keeping concurrent consumers cancellation independent', async () => {
	const facts = { folds: [], diagnostics: [], symbols: Array.from({ length: 8192 }, (_, index) => ({ name: `item${index}`, kind: 'function', range: new Range(index + 1, 1, index + 1, 2), selectionRange: new Range(index + 1, 1, index + 1, 2) })) };
	using model = new TextModel('x\n'.repeat(8192), {
		languageId: 'javascript', tokenization: {
			createSyntaxTokenBackend: document => new TreeSitterSyntaxTokenBackend(document, {
				execution: 'rust', update() { }, setTabSize() { }, dispose() { }, [Symbol.dispose]() { },
				async request() { return { revision: document.version, facts, rows: [], measures: [] }; },
			}, () => undefined),
		},
	});
	using features = new LanguageFeaturesService();
	using providers = new TreeSitterSyntaxProviders(features);
	const provider = features.documentSymbolProvider.ordered(model)[0];
	const cancelled = new AbortController(), live = new AbortController();
	const timer = setTimeout(() => cancelled.abort(), 0);
	try {
		const first = provider.provideDocumentSymbols(createLanguageFeatureRequest(model, 'javascript', cancelled.signal), cancelled.signal);
		const second = provider.provideDocumentSymbols(createLanguageFeatureRequest(model, 'javascript', live.signal), live.signal);
		await assert.rejects(Promise.resolve(first));
		const symbols = await second;
		assert.equal(symbols.length, 8192);
		assert.equal(symbols.at(-1)?.name, 'item8191');
		assert.strictEqual(await provider.provideDocumentSymbols(createLanguageFeatureRequest(model, 'javascript', live.signal), live.signal), symbols);
	} finally { clearTimeout(timer); }
});

test('Rust session sends one snapshot followed by ordered UTF-16 deltas, including EOL changes', async () => {
	using model = new TextModel('function café() {\n  return "😀";\n}');
	model.setLanguage('javascript');
	const calls: { kind: string; params?: unknown; }[] = [];
	let release!: () => void;
	const opened = new Promise<void>(resolve => release = resolve);
	const result = (revision: number): SyntaxQueryResult => ({ revision, rows: [], facts: null, brackets: [], parseMs: 1, queryMs: 1, incremental: true });
	const api: ISyntaxApi = {
		isAvailable: true, onDidChangeConnection: Event.None,
		generation: 1,
		async open(params, analysis) { calls.push({ kind: 'open', params: { ...params, analysis } }); await opened; },
		async update(params) { calls.push({ kind: 'update', params }); },
		async query(params, signal) { signal.throwIfAborted(); calls.push({ kind: 'query', params }); return result(params.revision); },
		async analyze() { throw new Error('shared sessions never request complete analysis'); },
		async selectionRanges(params) { return { revision: params.revision, ranges: [] }; },
		async close(params) { calls.push({ kind: 'close', params }); },
	};
	const session = createAppServerTreeSitterSession(api, model, 'one-tree');
	using listener = model.onDidChangeContent(change => session.update(change));
	model.applyOperations([{ range: new Range(1, 14, 1, 14), text: '新' }]);
	model.applyOperations([{ range: new Range(2, 11, 2, 11), text: 'x' }]);
	const highlighted = session.request('highlight', { ranges: [{ startLineNumber: 1, endLineNumber: 3 }] }, signal());
	assert.equal(calls.length, 1, 'deltas wait for the initial document to exist');
	release();
	assert.equal((await highlighted).revision, model.version);
	assert.deepEqual(calls.map(call => call.kind), ['open', 'update', 'query']);
	assert.deepEqual(calls[1]!.params, {
		documentId: 'one-tree', previousRevision: 1, revision: model.version,
		edits: [{ startOffset: 13, endOffset: 13, text: '新' }, { startOffset: 28, endOffset: 28, text: 'x' }],
	});
	assert.equal(session.execution, 'rust');
	const oldLength = model.getValueLength();
	model.setEOL(1);
	await session.request('facts', {}, signal());
	const eol = calls.filter(call => call.kind === 'update').at(-1)!.params as { edits: { startOffset: number; endOffset: number; text: string; }[]; };
	assert.deepEqual(eol.edits, [{ startOffset: 0, endOffset: oldLength, text: model.getValue() }]);
	session.dispose();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(calls.at(-1)!.kind, 'close');
});

test('Rust session fails a replaced connection without replaying the old document', async () => {
	using model = new TextModel('const value = 1;');
	let generation = 1;
	let closed = 0;
	const api: ISyntaxApi = {
		isAvailable: true, onDidChangeConnection: Event.None,
		get generation() { return generation; },
		async open() { }, async update() { },
		async query() { throw new Error('must not query a replaced connection'); },
		async analyze() { throw new Error('unused'); },
		async selectionRanges() { throw new Error('unused'); },
		async close() { closed++; },
	};
	const session = createAppServerTreeSitterSession(api, model, 'old-generation');
	generation++;
	await assert.rejects(session.request('facts', {}, signal()), /unavailable/);
	session.dispose();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(closed, 0, 'an old session cannot close a new connection document');
});

test('Rust session composes an input burst and pipelines its query without waiting for an acknowledgement', async () => {
	using model = new TextModel('function item() {}');
	const calls: string[] = [];
	const releases: (() => void)[] = [];
	const api: ISyntaxApi = {
		isAvailable: true, onDidChangeConnection: Event.None,
		generation: 1,
		async open() { },
		update(params) { calls.push(`update-${params.revision}`); return new Promise<void>(resolve => releases.push(resolve)); },
		async query(params) { calls.push(`query-${params.revision}`); return { revision: params.revision, rows: [], facts: null, brackets: [], parseMs: 0, queryMs: 0, incremental: true }; },
		async analyze() { throw new Error('unused'); },
		async selectionRanges() { throw new Error('unused'); },
		async close() { calls.push('close'); },
	};
	const session = createAppServerTreeSitterSession(api, model, 'burst');
	using listener = model.onDidChangeContent(change => session.update(change));
	await session.request('highlight', {}, signal());
	calls.length = 0;
	for (let index = 0; index < 10; index++) model.applyOperations([{ range: new Range(1, 14, 1, 14), text: 'x' }]);
	await session.request('facts', {}, signal());
	assert.deepEqual(calls, ['update-11', 'query-11']);
	session.dispose();
	for (const release of releases) release();
});

test('Rust input batches preserve Unicode, overlapping edits, multiple cursors, EOL and undo', async () => {
	using model = new TextModel('# 😀é\n\n正文\n');
	let text = '', revision = 0;
	const updates: number[] = [];
	const api: ISyntaxApi = {
		isAvailable: true, onDidChangeConnection: Event.None, generation: 1,
		async open(params) { text = params.text; revision = params.revision; },
		async update(params) {
			assert.equal(params.previousRevision, revision);
			assert.ok(params.edits.length <= 1024);
			for (const edit of [...params.edits].reverse()) text = text.slice(0, edit.startOffset) + edit.text + text.slice(edit.endOffset);
			revision = params.revision;
			updates.push(revision);
		},
		async query(params) {
			assert.equal(revision, params.revision);
			assert.equal(text, model.getValue());
			return { revision, rows: [], facts: null, brackets: [], parseMs: 0, queryMs: 0, incremental: true };
		},
		async analyze() { throw new Error('unused'); }, async selectionRanges() { throw new Error('unused'); }, async close() { },
	};
	using session = createAppServerTreeSitterSession(api, model, 'composed');
	using listener = model.onDidChangeContent(change => session.update(change));
	await session.request('highlight', {}, signal());
	for (const piece of [' ', 'PERF', '_', 'MARK']) {
		const column = model.getLineLength(1) + 1;
		model.applyOperations([{ range: new Range(1, column, 1, column), text: piece }]);
	}
	model.applyOperations([{ range: new Range(1, 8, 1, 12), text: '新🦀\n行' }]);
	model.applyOperations([{ range: new Range(1, 1, 1, 1), text: '前' }, { range: new Range(4, 1, 4, 1), text: '后' }]);
	model.setEOL(1);
	model.applyOperations([{ range: new Range(2, 1, 2, 1), text: '尾' }]);
	await session.request('facts', {}, signal());
	assert.deepEqual(updates, [model.version], 'one update covers the entire synchronous burst');
	model.pushStackElement();
	model.undo();
	assert.equal(updates.length, 2, 'history reaches the backend before synchronous editor listeners finish');
	await session.request('facts', {}, signal());
	assert.equal(updates.length, 2);
	model.setValue('x\n'.repeat(1025));
	await session.request('facts', {}, signal());
	const cursors = Array.from({ length: 1025 }, (_, index) => ({ range: new Range(index + 1, 1, index + 1, 1), text: '前' }));
	model.applyOperations(cursors.filter((_, index) => index % 2 === 0));
	model.applyOperations(cursors.filter((_, index) => index % 2 !== 0));
	await session.request('facts', {}, signal());
	assert.deepEqual(updates.slice(-2), [model.version - 1, model.version], 'disjoint edits split at the transport limit without losing their base');
});

test('Rust session drops cancelled intermediate queries and unsent edits on disposal', async () => {
	using model = new TextModel('abc');
	const calls: string[] = [];
	const api: ISyntaxApi = {
		isAvailable: true, onDidChangeConnection: Event.None, generation: 1,
		async open() { }, async update() { calls.push('update'); },
		async query(params) { calls.push(`query-${params.revision}`); return { revision: params.revision, rows: [], facts: null, brackets: [], parseMs: 0, queryMs: 0, incremental: true }; },
		async analyze() { throw new Error('unused'); }, async selectionRanges() { throw new Error('unused'); }, async close() { calls.push('close'); },
	};
	using session = createAppServerTreeSitterSession(api, model, 'cancelled');
	using listener = model.onDidChangeContent(change => session.update(change));
	await session.request('highlight', {}, signal());
	const controller = new AbortController();
	model.applyOperations([{ range: new Range(1, 4, 1, 4), text: 'x' }]);
	const obsolete = session.request('facts', {}, controller.signal);
	const superseded = session.request('selection', { ranges: [new Range(1, 1, 1, 2)] }, signal());
	controller.abort();
	model.applyOperations([{ range: new Range(1, 5, 1, 5), text: 'y' }]);
	await assert.rejects(obsolete);
	await assert.rejects(superseded, /Obsolete syntax query/);
	await session.request('facts', {}, signal());
	assert.deepEqual(calls, ['query-1', 'update', 'query-3']);
	model.applyOperations([{ range: new Range(1, 6, 1, 6), text: 'z' }]);
	session.dispose();
	await Promise.resolve();
	assert.deepEqual(calls, ['query-1', 'update', 'query-3', 'close']);
});

test('Rust facts apply text shifts and splices, and recover from a cancelled unobserved revision', async () => {
	using model = new TextModel('function a() {}\nfunction b() {}');
	const replies: SyntaxQueryResult[] = [];
	const requested: (number | undefined)[] = [];
	const r = (row: number, start: number, end: number) => ({ start: { lineIndex: row, columnIndex: start }, end: { lineIndex: row, columnIndex: end } });
	const sym = (name: string, row: number) => ({ name, kind: 'function' as const, range: r(row, 0, 15), selectionRange: r(row, 9, 10) });
	const delta = (revision: number, facts: NonNullable<SyntaxQueryResult['facts']>): SyntaxQueryResult => ({ revision, facts, rows: [], brackets: [], parseMs: 0, queryMs: 0, incremental: true });
	const empty = { start: 0, deleteCount: 0, items: [] };
	const api: ISyntaxApi = {
		isAvailable: true, onDidChangeConnection: Event.None,
		generation: 1, async open() { }, async update() { }, async close() { },
		async query(params, signal) { requested.push(params.factsRevision); await Promise.resolve(); signal.throwIfAborted(); return replies.shift()!; },
		async analyze() { throw new Error('unused'); }, async selectionRanges() { throw new Error('unused'); },
	};
	const session = createAppServerTreeSitterSession(api, model, 'deltas');
	replies.push(delta(1, { baseRevision: null, edits: [], symbols: { ...empty, items: [sym('a', 0), sym('b', 1)] }, folds: { ...empty, items: [{ startLineIndex: 0, endLineIndex: 1 }] }, diagnostics: empty }));
	const initial = (await session.request('facts', {}, signal())).facts!;
	replies.push(delta(2, { baseRevision: 1, edits: [{ range: r(0, 0, 0), end: { lineIndex: 1, columnIndex: 0 } }], symbols: { ...empty, start: 0, deleteCount: 1, items: [sym('aNew', 1)] }, folds: empty, diagnostics: empty }));
	const next = (await session.request('facts', {}, signal())).facts!;
	assert.deepEqual(next.symbols.map(symbol => [symbol.name, symbol.range.startLineNumber]), [['aNew', 2], ['b', 3]]);
	assert.deepEqual(next.folds, [{ startLineIndex: 1, endLineIndex: 2 }]);
	assert.equal(initial.symbols[1]!.range.startLineNumber, 2, 'a captured base is immutable');

	replies.push(delta(3, { baseRevision: 2, edits: [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 2, columnIndex: 0 } }, end: { lineIndex: 2, columnIndex: 0 } }], symbols: empty, folds: empty, diagnostics: empty }));
	const replaced = (await session.request('facts', {}, signal())).facts!;
	assert.deepEqual(replaced.folds, [{ startLineIndex: 0, endLineIndex: 2 }], 'a multiline replacement can move interior starts even with zero net line delta');

	const controller = new AbortController();
	const cancelled = session.request('facts', {}, controller.signal);
	controller.abort();
	await assert.rejects(cancelled);
	// The backend may have advanced without the consumer observing its result.
	// Its full response resets the baseline to the current revision.
	replies.push(delta(4, { baseRevision: null, edits: [], symbols: { ...empty, items: [sym('fresh', 0)] }, folds: empty, diagnostics: empty }));
	const recovered = (await session.request('facts', {}, signal())).facts!;
	assert.deepEqual(recovered.symbols.map(symbol => symbol.name), ['fresh']);
	replies.push(delta(5, { baseRevision: 4, edits: [], symbols: empty, folds: empty, diagnostics: empty }));
	const unchanged = (await session.request('facts', {}, signal())).facts!;
	assert.equal(unchanged.symbols, recovered.symbols, 'unchanged revisions preserve symbol identities');
	assert.equal(unchanged.folds, recovered.folds);
	assert.equal(unchanged.diagnostics, recovered.diagnostics);
	assert.deepEqual(requested, [undefined, 1, 2, 3, 4]);
	session.dispose();
});

test('Python default queries highlight decorators, functions and Unicode strings after an edit', async () => {
	using model = new TextModel('@decorator\ndef greet(name):\n    return "你好🙂"\n');
	using value = backend(model, 'python');
	await value.whenReady(signal());
	const captures = tokens(value, model).flatMap(row => row.tokens);
	assert.ok(captures.some(token => token.text === 'def' && token.type === 'keyword'));
	assert.ok(captures.some(token => token.text === 'greet' && token.type === 'function'));
	assert.ok(captures.some(token => token.text.includes('你好🙂') && token.type === 'string'));
	model.applyEdits([{ range: new Range(3, 13, 3, 13), text: 'updated ' }]);
	await value.whenReady(signal());
	await assertFresh(value, model, 'python');
});

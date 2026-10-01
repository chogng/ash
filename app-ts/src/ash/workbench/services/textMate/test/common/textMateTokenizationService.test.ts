import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "mocha";
import * as onigurumaNamespace from "vscode-oniguruma";
import { type IOnigLib } from "vscode-textmate";
import { TokenizationRegistry } from '../../../../../editor/common/languages.js';
import { SyntaxProviderRegistry } from '../../../../../editor/common/languageFeatureRegistry.js';
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { createTextMateSyntaxProvider, TEXTMATE_SYNTAX_PROVIDER_ID } from "../../common/textMateSyntaxProvider.js";
import { TextMateGrammarRegistry } from "../../common/textMateGrammarRegistry.js";
import { TextMateTokenizationService, type TextMateTokenizationCacheUpdate } from "../../common/textMateTokenizationService.js";
import { SyntaxProviderWorker } from '../../../../../editor/common/services/editorWebWorker.js';
import { getWorkbenchColorTheme } from '../../../../common/theme.js';
import { createTextMateScopeThemeResolver } from '../../common/textMateScopeTheme.js';
import { projectColorThemeTokens } from '../../common/textMateThemeProjection.js';

const onigurumaRuntime = (onigurumaNamespace as unknown as { readonly default?: typeof onigurumaNamespace }).default ?? onigurumaNamespace;
const { createOnigScanner, createOnigString, loadWASM } = onigurumaRuntime;
const onigLib = initializeOnigLib();

test("TextMate grammar registry publishes immutable root and injection snapshots", () => {
	using registry = new TextMateGrammarRegistry();
	const revisions: number[] = [];
	using listener = registry.onDidChange(snapshot => revisions.push(snapshot.revision));
	const initial = registry.currentSnapshot;
	const root = registry.register({
		languageId: "demo",
		scopeName: "source.demo",
		loadGrammar: () => demoGrammar(),
	});
	using injection = registry.register({
		scopeName: "source.demo.todo",
		injectTo: ["source.demo"],
		loadGrammar: () => injectionGrammar(),
	});
	const populated = registry.currentSnapshot;

	assert.equal(initial.revision, 0);
	assert.deepEqual(populated.languageIds, ["demo"]);
	assert.equal(populated.getDefinitionForLanguage("demo")?.scopeName, "source.demo");
	assert.deepEqual(populated.getInjections("source.demo"), ["source.demo.todo"]);
	assert.equal(Object.isFrozen(populated.languageIds), true);
	assert.throws(() => registry.register({ languageId: "demo", scopeName: "source.other", loadGrammar: demoGrammar }), /already has/);
	assert.throws(() => registry.register({ scopeName: "source.demo", loadGrammar: demoGrammar }), /already registered/);
	assert.throws(() => registry.register({ scopeName: "bad scope", loadGrammar: demoGrammar }), /scope/);

	root.dispose();
	assert.equal(registry.currentSnapshot.getDefinitionForLanguage("demo"), undefined);
	assert.equal(populated.getDefinitionForLanguage("demo")?.scopeName, "source.demo");
	assert.deepEqual(revisions, [1, 2, 3]);
});

test("TextMate tokenization uses real Oniguruma scopes across lines", async () => {
	using registry = grammarRegistry();
	const updates: TextMateTokenizationCacheUpdate[] = [];
	using tokenization = new TextMateTokenizationService(registry, onigLib, { onDidUpdateCache: update => updates.push(update) });
	using model = new TextModel("if value = \"hello\nworld\";\n42");

	const result = await tokenization.tokenize("demo", model.createVersionedSnapshot(), new AbortController().signal);

	assert.deepEqual(project(result), [
		[1, 1, 3, "keyword"],
		[1, 4, 9, "variable"],
		[1, 10, 11, "operator"],
		[1, 12, 18, "string"],
		[2, 1, 7, "string"],
		[3, 1, 3, "number"],
	]);
	assert.deepEqual(updates, [{
		modelVersion: 1,
		languageId: "demo",
		kind: "full",
		scannedLineCount: 3,
		reusedLineCount: 0,
	}]);
});

test("vendored VS Code JSON grammar tokenizes through the common service", async () => {
	const content = await readFile(resolve("../extensions/json/syntaxes/JSON.tmLanguage.json"), "utf8");
	using registry = new TextMateGrammarRegistry();
	using registration = registry.register({
		languageId: "json",
		scopeName: "source.json",
		loadGrammar: () => content,
	});
	using tokenization = new TextMateTokenizationService(registry, onigLib);
	using model = new TextModel("{\"name\": \"alpha\", \"enabled\": true, \"count\": 42}");

	const result = await tokenization.tokenize("json", model.createVersionedSnapshot(), new AbortController().signal);
	const tokenTypes = result!.tokens.map(token => token.tokenType);

	assert.equal(tokenTypes.includes("string"), true);
	assert.equal(tokenTypes.includes("constant"), true);
	assert.equal(tokenTypes.includes("number"), true);
});

test('bundled Markdown grammar preserves authored styles in every Ash theme', async () => {
	const content = await readFile(resolve('../extensions/markdown-basics/syntaxes/markdown.tmLanguage.json'), 'utf8');
	using registry = new TextMateGrammarRegistry();
	using registration = registry.register({ languageId: 'markdown', scopeName: 'text.html.markdown', loadGrammar: () => content });
	using model = new TextModel('# Heading\n\n**strong** *emphasis* ~~removed~~ `inline` [link](https://example.com)\n\n- item\n> quote\n\n```\ncode block\n```');
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		const theme = getWorkbenchColorTheme(id);
		using tokenization = new TextMateTokenizationService(registry, onigLib, { scopeResolver: createTextMateScopeThemeResolver(projectColorThemeTokens(theme, 1)) });
		const result = await tokenization.tokenize('markdown', model.createVersionedSnapshot(), new AbortController().signal);
		const presentationFor = (text: string) => result!.tokens.find(token => model.getTextInRange(token.range).includes(text))?.presentation;
		assert.deepEqual([
			presentationFor('Heading')?.fontStyle,
			presentationFor('strong')?.fontStyle,
			presentationFor('emphasis')?.fontStyle,
			presentationFor('removed')?.fontStyle,
			presentationFor('https://example.com')?.fontStyle,
		], [['bold'], ['bold'], ['italic'], ['strikethrough'], ['underline']], id);
		for (const text of ['Heading', 'inline', 'code block', '-', '>']) {
			const color = presentationFor(text)?.foreground;
			assert.ok(color, `${id}: ${text} has a syntax color`);
			assert.notEqual(color.toLowerCase(), theme.getColorCss('editor.foreground')?.toLowerCase(), `${id}: ${text} differs from prose`);
		}
	}
});

test('raw tokenizer exposes Markdown scopes and reflects replaced grammars', async () => {
	using registry = new TextMateGrammarRegistry();
	const content = await readFile(resolve('../extensions/markdown-basics/syntaxes/markdown.tmLanguage.json'), 'utf8');
	const registration = registry.register({ languageId: 'markdown', scopeName: 'text.html.markdown', loadGrammar: () => content });
	using tokenization = new TextMateTokenizationService(registry, onigLib);
	const grammar = (await tokenization.createTokenizer('markdown'))!;
	assert.ok(grammar.tokenizeLine('# Heading', null).tokens.some(token => token.scopes.includes('markup.heading.markdown')));
	registration.dispose();
	assert.equal(await tokenization.createTokenizer('markdown'), null);
	using replacement = registry.register({ languageId: 'demo', scopeName: 'source.demo', loadGrammar: () => demoGrammar('string.quoted.demo') });
	assert.ok((await tokenization.createTokenizer('demo'))!.tokenizeLine('if', null).tokens.some(token => token.scopes.includes('string.quoted.demo')));
});

test('bundled Git grammars preserve pattern boundaries and colors in every Ash theme', async () => {
	using registry = new TextMateGrammarRegistry();
	for (const directory of ['git-base', 'ini', 'diff', 'shellscript']) {
		const manifest = JSON.parse(await readFile(resolve(`../extensions/${directory}/package.json`), 'utf8')) as { contributes: { grammars: { language: string; scopeName: string; path: string }[] } };
		for (const grammar of manifest.contributes.grammars) {
			const content = await readFile(resolve(`../extensions/${directory}`, grammar.path), 'utf8');
			registry.register({ languageId: grammar.language, scopeName: grammar.scopeName, loadGrammar: () => content });
		}
	}
	using rawTokenization = new TextMateTokenizationService(registry, onigLib);
	const ignore = (await rawTokenization.createTokenizer('ignore'))!;
	for (const [line, scopes] of [
		['# comment', ['comment.line.number-sign.ignore']],
		[String.raw`\#literal`, ['constant.character.escape.ignore', 'source.ignore']],
		[String.raw`\!literal`, ['constant.character.escape.ignore', 'source.ignore']],
		[String.raw`\*literal`, ['constant.character.escape.ignore', 'source.ignore']],
		['prefix#!literal', ['source.ignore']],
		['!**/file[0-9]?.txt', ['keyword.operator.negation.ignore', 'keyword.operator.wildcard.ignore', 'punctuation.separator.directory.ignore', 'source.ignore', 'constant.other.character-class.ignore', 'keyword.operator.wildcard.ignore', 'source.ignore']],
		['[[:digit:]]', ['constant.other.character-class.ignore']],
		['[!a-z]', ['constant.other.character-class.ignore']],
		['[]a]', ['constant.other.character-class.ignore']],
	] as const) {
		assert.deepEqual(ignore.tokenizeLine(line, null).tokens.map(token => token.scopes.at(-1)), scopes, line);
	}
	const rebase = (await rawTokenization.createTokenizer('git-rebase'))!;
	const shell = rebase.tokenizeLine('exec echo "unfinished', null);
	assert.ok(shell.tokens.some(token => token.scopes.includes('string.quoted.double.shell')));
	assert.ok(rebase.tokenizeLine('pick abc1234 Fix', shell.ruleStack).tokens.some(token => token.scopes.includes('support.function.git-rebase')));
	const samples = [
		['ignore', '# comment', '# comment'],
		['ignore', '!keep.log', '!'],
		['ignore', '*.log', '*'],
		['ignore', 'file[0-9].log', '[0-9]'],
		['ignore', String.raw`\#literal`, String.raw`\#`],
		['git-rebase', 'pick abc1234 Fix', 'pick'],
		['git-rebase', 'pick abc1234 Fix', 'abc1234'],
		['git-rebase', 'exec echo "hello"', 'hello'],
		['git-commit', 'Fix\n\n#\tnew file: file', 'new file: file'],
		['git-commit', 'Fix\n\n# message\ndiff --git a/file b/file\n@@ -1 +1 @@\n-old\n+new', 'new'],
		['properties', '[core]\neditor = "ash"', 'editor'],
		['ini', '[core]\neditor = "ash"', 'editor'],
		['diff', '@@ -1 +1 @@\n-old\n+new', 'old'],
		['diff', '@@ -1 +1 @@\n-old\n+new', 'new'],
	] as const;
	for (const id of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		const theme = getWorkbenchColorTheme(id);
		for (const [languageId, text, lexeme] of samples) {
			using tokenization = new TextMateTokenizationService(registry, onigLib, { scopeResolver: createTextMateScopeThemeResolver(projectColorThemeTokens(theme, 1)) });
			using model = new TextModel(text);
			const result = await tokenization.tokenize(languageId, model.createVersionedSnapshot(), new AbortController().signal);
			const token = result!.tokens.find(token => model.getTextInRange(token.range).includes(lexeme));
			assert.ok(token?.presentation?.foreground, `${id}: ${languageId} ${lexeme} has a syntax color`);
			assert.notEqual(token.presentation.foreground.toLowerCase(), theme.getColorCss('editor.foreground')?.toLowerCase(), `${id}: ${languageId} ${lexeme} differs from plain text`);
		}
	}
});

test("TextMate grammar metadata reaches runtime configuration and token projection", async () => {
	using registry = new TextMateGrammarRegistry();
	using registration = registry.register({
		languageId: "demo",
		scopeName: "source.demo",
		embeddedLanguages: { "meta.embedded.demo": "javascript" },
		tokenTypes: { "variable.other.demo": "string" },
		balancedBracketScopes: ["*"],
		unbalancedBracketScopes: ["string.quoted"],
		loadGrammar: () => metadataGrammar(),
	});
	const definition = registry.currentSnapshot.getDefinitionForLanguage("demo")!;
	assert.deepEqual(definition.embeddedLanguages, { "meta.embedded.demo": "javascript" });
	assert.deepEqual(definition.tokenTypes, { "variable.other.demo": "string" });
	assert.deepEqual(definition.balancedBracketScopes, ["*"]);
	assert.deepEqual(definition.unbalancedBracketScopes, ["string.quoted"]);
	using tokenization = new TextMateTokenizationService(registry, onigLib);
	using model = new TextModel("embedded value \"quoted\"");

	const tokens = (await tokenization.tokenize("demo", model.createVersionedSnapshot(), new AbortController().signal))!.tokens;
	assert.equal(tokens.find(token => token.languageId === "javascript")?.languageId, "javascript");
	assert.equal(tokens.find(token => token.tokenType === "string" && token.languageId === undefined)?.tokenType, "string");
	assert.equal(tokens.find(token => model.getTextInRange(token.range).includes("quoted"))?.balancedBrackets, false);
});

test("TextMate runtime loads registered injection grammars", async () => {
	using registry = grammarRegistry();
	using injection = registry.register({
		scopeName: "source.demo.todo",
		injectTo: ["source.demo"],
		loadGrammar: () => injectionGrammar(),
	});
	using tokenization = new TextMateTokenizationService(registry, onigLib);
	using model = new TextModel("/* TODO */");

	const result = await tokenization.tokenize("demo", model.createVersionedSnapshot(), new AbortController().signal);

	assert.deepEqual(project(result), [
		[1, 1, 4, "comment"],
		[1, 4, 8, "keyword"],
		[1, 8, 11, "comment"],
	]);
});

test("TextMate cache rescans until multiline state converges", async () => {
	using registry = grammarRegistry();
	const updates: TextMateTokenizationCacheUpdate[] = [];
	using tokenization = new TextMateTokenizationService(registry, onigLib, { onDidUpdateCache: update => updates.push(update) });
	const lines = Array.from({ length: 50 }, (_, index) => index === 10 ? "/* open" : index === 20 ? "close */" : "value");
	using model = new TextModel(lines.join("\n"));
	const signal = new AbortController().signal;

	await tokenization.tokenize("demo", model.createVersionedSnapshot(), signal);
	replaceLine(model, 5, "other");
	await tokenization.tokenize("demo", model.createVersionedSnapshot(), signal);
	replaceLine(model, 10, "value");
	await tokenization.tokenize("demo", model.createVersionedSnapshot(), signal);

	assert.deepEqual(updates.map(update => [update.kind, update.scannedLineCount, update.reusedLineCount]), [
		["full", 50, 0],
		["incremental", 1, 49],
		["incremental", 11, 39],
	]);
});

test("TextMate grammar revisions replace same-version runtime state", async () => {
	using registry = new TextMateGrammarRegistry();
	const registration = registry.register({
		languageId: "demo",
		scopeName: "source.demo",
		loadGrammar: () => demoGrammar("keyword.control.demo"),
	});
	using tokenization = new TextMateTokenizationService(registry, onigLib);
	using model = new TextModel("if");
	const signal = new AbortController().signal;

	assert.equal((await tokenization.tokenize("demo", model.createVersionedSnapshot(), signal))!.tokens[0]!.tokenType, "keyword");
	registration.dispose();
	using replacement = registry.register({
		languageId: "demo",
		scopeName: "source.demo",
		loadGrammar: () => demoGrammar("string.quoted.demo"),
	});
	assert.equal((await tokenization.tokenize("demo", model.createVersionedSnapshot(), signal))!.tokens[0]!.tokenType, "string");
});

test("TextMate Syntax provider overrides lexical fallback by explicit priority", async () => {
	using grammars = grammarRegistry();
	using tokenization = new TextMateTokenizationService(grammars, onigLib);
	using providers = new SyntaxProviderRegistry();
	using fallback = providers.register({
		id: "fallback.lexical",
		languageIds: ["demo"],
		provideTokens: () => ({ tokens: [{
			range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)),
			tokenType: "variable",
			modifiers: [],
		}] }),
	});
	using textmate = providers.register(createTextMateSyntaxProvider(tokenization));
	using model = new TextModel("if");
	using syntax = new SyntaxProviderWorker(providers);

	const outcome = await syntax.run({ requestId: 1, lane: "tokens", payload: { languageId: "demo" }, snapshot: model.createVersionedSnapshot() }, new AbortController().signal);

	assert.equal(outcome.lane, "tokens");
	if (outcome.lane !== "tokens") throw new Error("Unexpected lane");
	assert.equal(providers.getTokenProvider("demo")?.id, TEXTMATE_SYNTAX_PROVIDER_ID);
	assert.equal(outcome.value.tokens[0]!.tokenType, "keyword");
});

test("TextMate rejects mismatched grammars, cancellation, and use after disposal", async () => {
	using registry = new TextMateGrammarRegistry();
	using registration = registry.register({
		languageId: "demo",
		scopeName: "source.demo",
		loadGrammar: () => demoGrammar().replace("\"source.demo\"", "\"source.other\""),
	});
	const tokenization = new TextMateTokenizationService(registry, onigLib);
	using model = new TextModel("if");

	await assert.rejects(tokenization.tokenize("demo", model.createVersionedSnapshot(), new AbortController().signal), /different root scope/);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(tokenization.tokenize("missing", model.createVersionedSnapshot(), cancelled.signal), error => (error as Error).name === "AbortError");
	tokenization.dispose();
	await assert.rejects(tokenization.tokenize("demo", model.createVersionedSnapshot(), new AbortController().signal), /already disposed/);
	assert.equal(registry.currentSnapshot.languageIds[0], "demo");
});

function grammarRegistry(): TextMateGrammarRegistry {
	const registry = new TextMateGrammarRegistry();
	registry.register({
		languageId: "demo",
		scopeName: "source.demo",
		loadGrammar: () => demoGrammar(),
	});
	return registry;
}

function demoGrammar(keywordScope = "keyword.control.demo"): string {
	return JSON.stringify({
		scopeName: "source.demo",
		patterns: [
			{ include: "#comment" },
			{ include: "#string" },
			{ match: "\\b(if|else)\\b", name: keywordScope },
			{ match: "\\b[0-9]+\\b", name: "constant.numeric.demo" },
			{ match: "\\b[A-Za-z_][A-Za-z0-9_]*\\b", name: "variable.other.demo" },
			{ match: "=", name: "keyword.operator.assignment.demo" },
		],
		repository: {
			comment: { begin: "/\\*", end: "\\*/", name: "comment.block.demo" },
			string: { begin: "\"", end: "\"", name: "string.quoted.double.demo" },
		},
	});
}

function injectionGrammar(): string {
	return JSON.stringify({
		scopeName: "source.demo.todo",
		injectionSelector: "L:comment.block.demo",
		patterns: [{ match: "\\bTODO\\b", name: "keyword.other.todo.demo" }],
		repository: {},
	});
}

function metadataGrammar(): string {
	return JSON.stringify({
		scopeName: "source.demo",
		patterns: [
			{ match: "embedded", name: "meta.embedded.demo" },
			{ match: "value", name: "variable.other.demo" },
			{ begin: "\"", end: "\"", name: "string.quoted.demo" },
		],
		repository: {},
	});
}

function project(result: Awaited<ReturnType<TextMateTokenizationService["tokenize"]>>): unknown[] {
	return (result?.tokens ?? []).map(token => [
		token.range.getStartPosition().lineNumber,
		token.range.getStartPosition().column,
		token.range.getEndPosition().column,
		token.tokenType,
	]);
}

function replaceLine(model: TextModel, lineIndex: number, text: string): void {
	model.applyEdits([{
		range: Range.fromPositions(new Position((lineIndex) + 1, (0) + 1), new Position((lineIndex) + 1, (model.getLineContent((lineIndex) + 1).length) + 1)),
		text,
	}]);
}

async function initializeOnigLib(): Promise<IOnigLib> {
	const mainUrl = import.meta.resolve("vscode-oniguruma");
	const bytes = await readFile(new URL("onig.wasm", mainUrl));
	const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	await loadWASM(data);
	return Object.freeze({ createOnigScanner, createOnigString });
}


test('TextMate hypothetical lines inherit multiline state without publishing or retaining their tokens', async () => {
	using registry = grammarRegistry();
	const updates: TextMateTokenizationCacheUpdate[] = [];
	using tokenization = new TextMateTokenizationService(registry, onigLib, { onDidUpdateCache: update => updates.push(update) });
	using model = new TextModel('"hello\nworld";\n42');
	const signal = new AbortController().signal;
	const snapshot = model.createVersionedSnapshot();
	const original = await tokenization.tokenize('demo', snapshot, signal);
	const preview = await tokenization.tokenizeLinesAt('demo', snapshot, 2, ['new [)"', 'if'], signal);
	assert.deepEqual(project(preview), [[1, 1, 8, 'string'], [2, 1, 3, 'keyword']]);
	assert.equal(await tokenization.tokenize('demo', snapshot, signal), original);
	assert.equal(updates.length, 1);
	const second = await tokenization.tokenizeLinesAt('demo', snapshot, 3, ['if'], signal);
	assert.deepEqual(project(second), [[1, 1, 3, 'keyword']]);
	assert.equal(await tokenization.tokenizeLinesAt('missing', snapshot, 1, ['('], signal), undefined);
});


test('shared TextMate line support keeps document states independent and converges after edits', async () => {
	let loads = 0;
	using registry = new TextMateGrammarRegistry();
	using grammar = registry.register({ languageId: 'demo', scopeName: 'source.demo', loadGrammar: () => { loads++; return demoGrammar(); } });
	using runtime = new TextMateTokenizationService(registry, onigLib);
	using support = await runtime.createTokenizationSupport('demo');
	using registration = TokenizationRegistry.register('demo', support!);
	using first = new TextModel('if "open\ninside\nend"\n42', { languageId: 'demo' });
	using second = new TextModel('if other\n42', { languageId: 'demo' });
	first.tokenization.forceTokenization(4);
	second.tokenization.forceTokenization(2);
	assert.deepEqual([loads, first.tokenization.getLanguageTokens(1)[0]?.tokenType, second.tokenization.getLanguageTokens(1)[0]?.tokenType], [1, 'string', 'number']);
	const edits = [
		[{ range: new Range(1, 4, 1, 5), text: '' }],
		[{ range: new Range(1, 1, 1, 1), text: 'if "start\n' }],
		[{ range: new Range(1, 1, 2, 1), text: '' }],
		[{ range: new Range(1, 1, 1, 3), text: 'if' }],
	];
	for (const change of edits) {
		first.applyEdits(change);
		first.tokenization.forceTokenization(first.getLineCount());
		const expected = await runtime.tokenize('demo', first.createVersionedSnapshot(), new AbortController().signal);
		assert.deepEqual(first.tokenization.lines.flatMap(line => line.tokens.map(token => [token.range.toString(), token.tokenType])), expected!.tokens.map(token => [token.range.toString(), token.tokenType]));
		assert.equal(first.tokenization.tokenCount, expected!.tokens.length);
	}
	assert.equal(loads, 1);
});

test('distant view tokens acquire multiline context and both attached ranges survive a reset', async () => {
	using registry = grammarRegistry();
	using runtime = new TextMateTokenizationService(registry, onigLib);
	using support = await runtime.createTokenizationSupport('demo');
	using registration = TokenizationRegistry.register('demo', support!);
	using model = new TextModel('"open\n' + 'inside\n'.repeat(300) + 'end"\nif', { languageId: 'demo' });
	const firstView = model.onBeforeAttached();
	const secondView = model.onBeforeAttached();
	try {
		firstView.setVisibleLines([{ startLineNumber: 1, endLineNumber: 2 }], true);
		secondView.setVisibleLines([{ startLineNumber: 250, endLineNumber: 260 }], true);
		model.tokenization.resetTokenization();
		assert.equal(model.tokenization.hasAccurateTokensForLine(2), true);
		assert.equal(model.tokenization.hasAccurateTokensForLine(250), false);
		assert.equal(model.tokenization.getLanguageTokens(249)[0]?.tokenType, 'variable');
		model.tokenization.forceTokenization(model.getLineCount());
		assert.equal(model.tokenization.hasAccurateTokensForLine(250), true);
		assert.equal(model.tokenization.getLanguageTokens(249)[0]?.tokenType, 'string');
	} finally {
		model.onBeforeDetached(firstView);
		model.onBeforeDetached(secondView);
	}
	model.applyEdits([{ range: new Range(1, 1, 1, 2), text: '' }]);
	model.applyEdits([{ range: new Range(200, 1, 201, 1), text: '"new\ninside\n' }]);
	model.tokenization.forceTokenization(model.getLineCount());
	const expected = await runtime.tokenize('demo', model.createVersionedSnapshot(), new AbortController().signal);
	assert.deepEqual(model.tokenization.lines.flatMap(line => line.tokens.map(token => [token.range.toString(), token.tokenType])), expected!.tokens.map(token => [token.range.toString(), token.tokenType]));
});

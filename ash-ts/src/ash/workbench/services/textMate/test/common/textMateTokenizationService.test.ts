import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import * as onigurumaNamespace from "vscode-oniguruma";
import { type IOnigLib } from "vscode-textmate";
import { SyntaxProviderRegistry } from "../../../../../editor/common/languages/syntax/syntaxProviders.js";
import { SyntaxService } from "../../../../../editor/common/languages/syntax/syntaxService.js";
import { LanguageRequestStatus } from "../../../../../editor/common/languages/languageRequestCoordinator.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { createTextMateSyntaxProvider, TEXTMATE_SYNTAX_PROVIDER_ID } from "../../common/textMateSyntaxProvider.js";
import { createTextMateSyntaxModule, TEXTMATE_SYNTAX_MODULE_ID } from "../../common/textMateSyntaxModule.js";
import { TextMateGrammarRegistry } from "../../common/textMateGrammarRegistry.js";
import { TextMateTokenizationService, type TextMateTokenizationCacheUpdate } from "../../common/textMateTokenizationService.js";

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
	using syntax = new SyntaxService(model, providers);

	const outcome = await syntax.requestTokens("demo");

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	assert.equal(providers.getTokenProvider("demo")?.id, TEXTMATE_SYNTAX_PROVIDER_ID);
	assert.equal(syntax.tokens.result!.value.tokens[0]!.tokenType, "keyword");
	assert.equal(createTextMateSyntaxModule(tokenization).id, TEXTMATE_SYNTAX_MODULE_ID);
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

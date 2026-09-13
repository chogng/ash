import { strict as assert } from "node:assert";
import { test } from "mocha";
import { registerBuiltinLanguageConfigurations } from "../../common/languages/languageBuiltinConfigurations.js";
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { type SyntaxProviderRequest } from "../../common/languages/syntax/syntaxProviders.js";
import { createLanguageLexicalSyntaxProvider } from "../../common/languages/languageLexicalSyntaxProvider.js";
import { TextModel } from "../../common/model/textModel.js";

test("Lexical caches remain isolated by language identity at one model version", async () => {
	using model = new TextModel("// comment\n`value`");
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	const provider = createLanguageLexicalSyntaxProvider({ languageConfigurations: configurations });
	const snapshot = model.createVersionedSnapshot();

	assert.deepEqual(await tokenTypes(provider, request(1, "typescript", snapshot)), ["comment", "string"]);
	assert.deepEqual(await tokenTypes(provider, request(2, "json", snapshot)), ["operator", "variable", "variable"]);
	assert.deepEqual(await tokenTypes(provider, request(3, "jsonc", snapshot)), ["comment", "variable"]);
	assert.deepEqual(await tokenTypes(provider, request(4, "typescript", snapshot)), ["comment", "string"]);
});

test("A language configuration revision replaces same-version lexical state", async () => {
	using model = new TextModel("# comment\n<% value");
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	const provider = createLanguageLexicalSyntaxProvider({ languageConfigurations: configurations });
	const snapshot = model.createVersionedSnapshot();

	assert.deepEqual(await tokenTypes(provider, request(1, "json", snapshot)), ["variable", "operator", "variable"]);
	using custom = configurations.register("json", {
		comments: { lineComment: "#" },
		brackets: [["<%", "%>"]],
	}, 10);

	assert.deepEqual(await tokenTypes(provider, request(2, "json", snapshot)), ["comment", "variable"]);
	const diagnostics = await provider.provideDiagnostics!(request(3, "json", snapshot), new AbortController().signal);
	assert.deepEqual(diagnostics?.diagnostics.map(diagnostic => diagnostic.message), ["Unclosed bracket '<%'"]);
});

test("Built-in lexical configuration registrations release without owning the registry", () => {
	using configurations = new TestLanguageConfigurationService();
	const registrations = registerBuiltinLanguageConfigurations(configurations);

	assert.equal(configurations.getLanguageConfiguration("typescript").comments?.lineCommentToken, "//");
	assert.equal(configurations.getLanguageConfiguration("json").comments?.lineCommentToken, undefined);
	assert.equal(configurations.getLanguageConfiguration("jsonc").comments?.lineCommentToken, "//");
	assert.equal(configurations.getLanguageConfiguration("rust").comments?.lineCommentToken, "//");
	assert.deepEqual(
		configurations.getLanguageConfiguration("rust").characterPair.getAutoClosingPairs().map(pair => pair.open),
		["(", "[", "{", "\""],
	);

	registrations.dispose();
	assert.equal(configurations.getLanguageConfiguration("typescript").comments, null);
	assert.equal(configurations.getLanguageConfiguration("typescript").underlyingConfig.brackets, undefined);
});

test("Rust lexical analysis recognizes Rust comments, keywords, strings, and structural diagnostics", async () => {
	using model = new TextModel("/// docs\nfn main() { let value = \"ok\"; }");
	const provider = createLanguageLexicalSyntaxProvider();
	const snapshot = model.createVersionedSnapshot();

	assert.deepEqual(
		await tokenTypes(provider, request(1, "rust", snapshot)),
		["comment", "keyword", "variable", "keyword", "variable", "operator", "string"],
	);
	const diagnostics = await provider.provideDiagnostics!(request(2, "rust", snapshot), new AbortController().signal);
	assert.deepEqual(diagnostics?.diagnostics, []);
});

test("Rust lexical analysis recognizes hash-delimited raw strings and character literals", async () => {
	using model = new TextModel("let raw = r##\"{\ninside } \"##;\nlet character = '\\n';\nlet lifetime = 'a;");
	const provider = createLanguageLexicalSyntaxProvider();
	const snapshot = model.createVersionedSnapshot();

	assert.deepEqual(
		await tokenTypes(provider, request(1, "rust", snapshot)),
		["keyword", "variable", "operator", "string", "string", "keyword", "variable", "operator", "string", "keyword", "variable", "operator", "variable"],
	);
	const diagnostics = await provider.provideDiagnostics!(request(2, "rust", snapshot), new AbortController().signal);
	assert.deepEqual(diagnostics?.diagnostics, []);
});

test("ECMAScript lexical analysis recognizes regular expressions without mistaking division for a literal", async () => {
	using model = new TextModel("const matcher = /\\{(?<name>[a-z]+)\\}/giu;\nconst ratio = total / count;\nreturn /[{}]/.test(value);");
	const provider = createLanguageLexicalSyntaxProvider();
	const snapshot = model.createVersionedSnapshot();

	assert.deepEqual(
		await tokenTypes(provider, request(1, "typescript", snapshot)),
		["keyword", "variable", "operator", "regexp", "keyword", "variable", "operator", "variable", "operator", "variable", "keyword", "regexp", "variable", "variable"],
	);
	const diagnostics = await provider.provideDiagnostics!(request(2, "typescript", snapshot), new AbortController().signal);
	assert.deepEqual(diagnostics?.diagnostics, []);
});

function request(requestId: number, languageId: string, snapshot: ReturnType<TextModel['createVersionedSnapshot']>): SyntaxProviderRequest {
	return Object.freeze({ requestId, languageId, snapshot });
}

async function tokenTypes(provider: ReturnType<typeof createLanguageLexicalSyntaxProvider>, analysisRequest: SyntaxProviderRequest): Promise<readonly string[]> {
	const result = await provider.provideTokens!(analysisRequest, new AbortController().signal);
	return result?.tokens.map(token => token.tokenType) ?? [];
}

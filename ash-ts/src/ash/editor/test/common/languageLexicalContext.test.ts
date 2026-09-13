import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Event } from "../../../base/common/event.js";
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { LanguageLexicalContextIndex, TokenAwareLanguageLexicalContext } from "../../common/languages/languageLexicalContext.js";
import { type LanguageToken } from "../../common/tokens/languageTokens.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Lexical context removes only structural brackets inside strings and comments", () => {
	using model = new TextModel("const code = { value: \"}\" }; // {\n/* {\nstill }\n*/ const after = {};");
	using configurations = new TestLanguageConfigurationService();
	using language = configurations.register("typescript", {
		comments: {
			lineComment: "//",
			blockComment: ["/*", "*/"],
		},
		brackets: [
			["{", "}"],
			["[", "]"],
			["(", ")"],
		],
	});
	using context = new LanguageLexicalContextIndex(model, "typescript", configurations);

	assert.equal(context.getStructuralLineContent(0), "const code = { value: \"\" }; // ");
	assert.equal(context.getStructuralLineContent(1), "/* ");
	assert.equal(context.getStructuralLineContent(2), "still ");
	assert.equal(context.getStructuralLineContent(3), "*/ const after = {};");
	const stringStart = model.getLineContent((0) + 1).indexOf("\"");
	assert.equal(context.getStructuralLineContent(0, stringStart, stringStart + 3), "\"\"");
	assert.equal(context.getTokenTypeAt(new Position((0) + 1, (stringStart + 1) + 1)), "string");
	assert.equal(context.getTokenTypeAt(new Position((0) + 1, (model.getLineContent((0) + 1).length) + 1)), "comment");
	assert.equal(context.getTokenTypeAt(new Position((0) + 1, (13) + 1)), undefined);
	assert.equal(context.getTokenTypeAt(new Position((2) + 1, (0) + 1)), "comment");
});

test("Lexical context invalidates changed suffixes and recomputes multiline state", () => {
	using model = new TextModel("/*\n{\n*/\n{");
	using configurations = new TestLanguageConfigurationService();
	using language = configurations.register("typescript", {
		comments: { blockComment: ["/*", "*/"] },
		brackets: [["{", "}"]],
	});
	using context = new LanguageLexicalContextIndex(model, "typescript", configurations);

	assert.equal(context.getStructuralLineContent(1), "");
	assert.equal(context.getStructuralLineContent(3), "{");
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)),
		text: "",
	}]);
	assert.equal(context.getStructuralLineContent(1), "{");
});

test("Lexical context recompiles when the language configuration revision changes", () => {
	using model = new TextModel("\"<\" \"{\"");
	using configurations = new TestLanguageConfigurationService();
	using base = configurations.register("demo", {
		brackets: [["{", "}"]],
	});
	using context = new LanguageLexicalContextIndex(model, "demo", configurations);
	assert.equal(context.getStructuralLineContent(0), "\"<\" \"\"");

	using override = configurations.register("demo", {
		brackets: [["<", ">"]],
	}, 1);
	assert.equal(context.getStructuralLineContent(0), "\"\" \"{\"");
});

test("Lexical context validates slices and disposal without owning borrowed state", () => {
	using model = new TextModel("value");
	using configurations = new TestLanguageConfigurationService();
	const context = new LanguageLexicalContextIndex(model, "plaintext", configurations);

	assert.throws(() => context.getStructuralLineContent(1), /outside/);
	assert.throws(() => context.getStructuralLineContent(0, 4, 2), /columns/);
	context.dispose();
	assert.throws(() => context.getStructuralLineContent(0), ReferenceError);
	assert.equal(model.getText(), "value");
	assert.equal(configurations.getLanguageConfiguration("plaintext").languageId, "plaintext");
});

test("Lexical context distinguishes closed and unterminated string boundaries", () => {
	using model = new TextModel("\"closed\"\n\"open");
	using configurations = new TestLanguageConfigurationService();
	using context = new LanguageLexicalContextIndex(model, "typescript", configurations);

	assert.equal(context.getTokenTypeAt(new Position((0) + 1, (4) + 1)), "string");
	assert.equal(context.getTokenTypeAt(new Position((0) + 1, (8) + 1)), undefined);
	assert.equal(context.getTokenTypeAt(new Position((1) + 1, (5) + 1)), "string");
});

test("Lexical context retains multiline identity on empty continuation lines", () => {
	using commentModel = new TextModel("/*\n\n");
	using stringModel = new TextModel("`\n\n");
	using configurations = new TestLanguageConfigurationService();
	using builtins = configurations.register("typescript", {
		comments: { blockComment: ["/*", "*/"] },
		brackets: [["{", "}"]],
	});
	using commentContext = new LanguageLexicalContextIndex(commentModel, "typescript", configurations);
	using stringContext = new LanguageLexicalContextIndex(stringModel, "typescript", configurations);

	assert.equal(commentContext.getTokenTypeAt(new Position((1) + 1, (0) + 1)), "comment");
	assert.equal(stringContext.getTokenTypeAt(new Position((1) + 1, (0) + 1)), "string");
});

test("Lexical context distinguishes line-comment and closed block-comment ends", () => {
	using model = new TextModel("// value\n/* value */");
	using configurations = new TestLanguageConfigurationService();
	using language = configurations.register("typescript", {
		comments: {
			lineComment: "//",
			blockComment: ["/*", "*/"],
		},
	});
	using context = new LanguageLexicalContextIndex(model, "typescript", configurations);

	assert.equal(context.getTokenTypeAt(new Position((0) + 1, (8) + 1)), "comment");
	assert.equal(context.getTokenTypeAt(new Position((1) + 1, (11) + 1)), undefined);
});

test("Rust raw strings do not contribute structural brackets", () => {
	using model = new TextModel("let raw = r#\"{\n} \"#;\n{");
	using configurations = new TestLanguageConfigurationService();
	using language = configurations.register("rust", {
		brackets: [["{", "}"]],
	});
	using context = new LanguageLexicalContextIndex(model, "rust", configurations);

	assert.equal(context.getStructuralLineContent(0), "let raw = r#\"");
	assert.equal(context.getStructuralLineContent(1), " \"#;");
	assert.equal(context.getStructuralLineContent(2), "{");
	assert.equal(context.getTokenTypeAt(new Position((1) + 1, (1) + 1)), "string");
});

test("ECMAScript regular-expression literals do not contribute structural brackets", () => {
	using model = new TextModel("const matcher = /[{]/;\n{");
	using configurations = new TestLanguageConfigurationService();
	using language = configurations.register("typescript", {
		brackets: [["{", "}"]],
	});
	using context = new LanguageLexicalContextIndex(model, "typescript", configurations);

	assert.equal(context.getStructuralLineContent(0), "const matcher = /[]/;");
	assert.equal(context.getTokenTypeAt(new Position((0) + 1, (17) + 1)), "regexp");
	assert.equal(context.getStructuralLineContent(1), "{");
});

test("Token-aware lexical context selects embedded languages and their structural brackets", () => {
	using model = new TextModel("<script>{ value }</script>");
	using configurations = new TestLanguageConfigurationService();
	using html = configurations.register("html", { brackets: [["<", ">"]] });
	using javascript = configurations.register("javascript", { comments: { lineComment: "//" }, brackets: [["{", "}"]] });
	using fallback = new LanguageLexicalContextIndex(model, "html", configurations);
	const embedded = token(model, 0, 8, 17, "source", { languageId: "javascript" });
	const tokenization = { textModel: model, modelVersion: model.version, onDidChange: Event.None, getLineTokens: () => [embedded] };
	using context = new TokenAwareLanguageLexicalContext(fallback, tokenization, configurations);

	assert.equal(context.getLanguageIdAt(new Position((0) + 1, (10) + 1)), "javascript");
	assert.equal(context.getLanguageIdAt(new Position((0) + 1, (2) + 1)), "html");
	assert.deepEqual(context.getStructuralBracketEvents(0).filter(event => event.token === "{" || event.token === "}").map(event => [event.action, event.startColumn]), [["open", 8], ["close", 16]]);
});

test("Token-aware lexical context excludes grammar-declared unbalanced ranges", () => {
	using model = new TextModel("{ ignored } real {}");
	using configurations = new TestLanguageConfigurationService();
	using language = configurations.register("demo", { brackets: [["{", "}"]] });
	using fallback = new LanguageLexicalContextIndex(model, "demo", configurations);
	const excluded = token(model, 0, 0, 11, "source", { balancedBrackets: false });
	using context = new TokenAwareLanguageLexicalContext(fallback, { textModel: model, modelVersion: model.version, onDidChange: Event.None, getLineTokens: () => [excluded] }, configurations);

	assert.deepEqual(context.getStructuralBracketEvents(0).map(event => event.startColumn), [17, 18]);
});

function token(model: TextModel, lineIndex: number, startColumn: number, endColumn: number, tokenType: string, metadata: Pick<LanguageToken, "languageId" | "balancedBrackets"> = {}): LanguageToken {
	return Object.freeze({ range: Range.fromPositions(new Position((lineIndex) + 1, (startColumn) + 1), new Position((lineIndex) + 1, (endColumn) + 1)), tokenType, modifiers: Object.freeze([]), ...metadata });
}

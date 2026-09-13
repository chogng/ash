import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { projectStanzaSemanticTokenLine } from "../../browser/viewParts/viewLines/viewLine.js";
import { LanguageTokenStylingResolver, resolveSemanticTokenModifiers, resolveSemanticTokenPresentation } from '../../common/services/languageTokenStylingResolver.js';
import { SemanticTokenModifier, SemanticTokenPresentation, type ResolvedSemanticToken } from '../../common/services/resolvedSemanticTokens.js';
import { ResolvedSemanticTokensService } from '../../common/services/resolvedSemanticTokensService.js';
import { LanguageResultAcceptance } from "../../common/languages/languageResultStore.js";
import { LanguageTokenLineIndex } from "../../common/tokens/languageTokenLineIndex.js";
import { createLanguageTokenStore, type LanguageToken } from "../../common/languages/languageResults.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Default resolver maps only Stanza's explicit semantic vocabulary", () => {
	assert.equal(resolveSemanticTokenPresentation(token(0, 0, 1, "keyword")), SemanticTokenPresentation.Keyword);
	assert.equal(resolveSemanticTokenPresentation(token(0, 0, 1, "method")), SemanticTokenPresentation.Function);
	assert.equal(resolveSemanticTokenPresentation(token(0, 0, 1, "plugin-controlled-class")), undefined);
});

test("Semantic token modifiers use Stanza's closed presentation vocabulary", () => {
	assert.deepEqual(
		resolveSemanticTokenModifiers(token(0, 0, 1, "variable", ["declaration", "readonly", "unknown-plugin-modifier", "definition"])),
		[SemanticTokenModifier.Declaration, SemanticTokenModifier.Readonly],
	);

	const dom = new JSDOM("<!doctype html><body><code></code></body>");
	const element = requiredElement<HTMLElement>(dom.window.document, "code");
	projectStanzaSemanticTokenLine(element, "name", [presented(
		0,
		4,
		SemanticTokenPresentation.Variable,
		[SemanticTokenModifier.Declaration, SemanticTokenModifier.Readonly],
	)]);
	const rendered = requiredElement<HTMLElement>(element, ".stanza-editor-token");
	assert.equal(rendered.classList.contains(SemanticTokenModifier.Declaration), true);
	assert.equal(rendered.classList.contains(SemanticTokenModifier.Readonly), true);
	assert.equal(rendered.textContent, "name");
	dom.window.close();
});

test("syntax token presentation applies exact theme styling without a semantic class", () => {
	const dom = new JSDOM("<!doctype html><body><code></code></body>");
	const element = requiredElement<HTMLElement>(dom.window.document, "code");
	projectStanzaSemanticTokenLine(element, "note", [{ startColumn: 0, endColumn: 4, syntaxPresentation: { foreground: "#6A9955", background: "#10101080", fontStyle: ["italic", "bold", "underline"] } }]);
	const rendered = requiredElement<HTMLElement>(element, ".stanza-editor-token");
	assert.equal(rendered.style.color, "rgb(106, 153, 85)");
	assert.equal(rendered.style.fontStyle, "italic");
	assert.equal(rendered.style.fontWeight, "bold");
	assert.equal(rendered.style.textDecorationLine, "underline");
	dom.window.close();
});

test("Semantic token source resolves immutable named lines without owning common state", () => {
	using model = new TextModel("const value");
	using store = createLanguageTokenStore(model);
	using styling = new ResolvedSemanticTokensService();
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: {
			tokens: [
				token(0, 0, 5, "keyword"),
				token(0, 6, 11, "plugin-variable"),
			],
		},
	}), LanguageResultAcceptance.Applied);
	using index = new LanguageTokenLineIndex(store);
	const source = styling.createSource(index, new LanguageTokenStylingResolver(entry => (
		entry.tokenType === "plugin-variable"
			? SemanticTokenPresentation.Variable
			: resolveSemanticTokenPresentation(entry)
	)));

	assert.equal(source.textModel, model);
	assert.deepEqual(source.lines, [{
		lineIndex: 0,
		tokens: [{
			startColumn: 0,
			endColumn: 5,
			presentation: SemanticTokenPresentation.Keyword,
		}, {
			startColumn: 6,
			endColumn: 11,
			presentation: SemanticTokenPresentation.Variable,
		}],
	}]);

	styling.dispose();
	assert.throws(() => source.lines, /already disposed/);
	assert.equal(index.getLineTokens(0).length, 2);
	index.dispose();
	assert.equal(store.result!.value.tokens.length, 2);
});

test("server semantic tokens replace intersecting syntax presentation and preserve uncovered syntax", () => {
	using model = new TextModel("const value");
	using lexicalStore = createLanguageTokenStore(model);
	using semanticStore = createLanguageTokenStore(model);
	using styling = new ResolvedSemanticTokensService();
	lexicalStore.accept({
		requestId: 1,
		textModel: model,
		modelVersion: model.version,
		value: { tokens: [
			{ ...token(0, 0, 5, "keyword"), presentation: { foreground: "#111111" } },
			{ ...token(0, 6, 11, "variable"), presentation: { foreground: "#222222" } },
		] },
	});
	semanticStore.accept({ requestId: 1, textModel: model, modelVersion: model.version, value: { tokens: [token(0, 6, 11, "function", ["declaration"])] } });
	using lexicalIndex = new LanguageTokenLineIndex(lexicalStore);
	using semanticIndex = new LanguageTokenLineIndex(semanticStore);
	const source = styling.createOverlay(styling.createSource(lexicalIndex), styling.createSource(semanticIndex));

	assert.deepEqual(source.getLineTokens(0), [{
		startColumn: 0,
		endColumn: 5,
		presentation: SemanticTokenPresentation.Keyword,
		syntaxPresentation: { foreground: "#111111" },
	}, {
		startColumn: 6,
		endColumn: 11,
		presentation: SemanticTokenPresentation.Function,
		modifiers: [SemanticTokenModifier.Declaration],
	}]);
});

test("Semantic line projection is HTML-safe and preserves exact text", () => {
	const dom = new JSDOM("<!doctype html><body><code>old</code></body>");
	const element = requiredElement<HTMLElement>(dom.window.document, "code");
	const lineText = "const <tag> = 42";
	projectStanzaSemanticTokenLine(element, lineText, [
		presented(0, 5, SemanticTokenPresentation.Keyword),
		presented(6, 11, SemanticTokenPresentation.Variable),
		presented(14, 16, SemanticTokenPresentation.Number),
	]);

	assert.equal(element.textContent, lineText);
	assert.equal(element.querySelector("tag"), null);
	assert.deepEqual([...element.querySelectorAll(".stanza-editor-token")].map(tokenElement => ({
		className: tokenElement.className,
		text: tokenElement.textContent,
	})), [{
		className: "stanza-editor-token token-keyword",
		text: "const",
	}, {
		className: "stanza-editor-token token-variable",
		text: "<tag>",
	}, {
		className: "stanza-editor-token token-number",
		text: "42",
	}]);
	dom.window.close();
});

test("Semantic line projection composes lexical bracket colors without changing token text", () => {
	const dom = new JSDOM("<!doctype html><body><code></code></body>");
	const element = requiredElement<HTMLElement>(dom.window.document, "code");
	projectStanzaSemanticTokenLine(element, "fn(a)", [presented(0, 2, SemanticTokenPresentation.Function)], [
		{ startColumn: 2, endColumn: 3, level: 1 },
		{ startColumn: 4, endColumn: 5, level: 1 },
	]);
	assert.equal(element.textContent, "fn(a)");
	assert.deepEqual([...element.querySelectorAll(".stanza-editor-bracket-level-1")].map(entry => entry.textContent), ["(", ")"]);
	dom.window.close();
});

test("Invalid semantic line input fails before replacing existing DOM", () => {
	const dom = new JSDOM("<!doctype html><body><code><b>stable</b></code></body>");
	const element = requiredElement<HTMLElement>(dom.window.document, "code");
	const existing = element.firstElementChild;

	assert.throws(() => projectStanzaSemanticTokenLine(element, "abcd", [
		presented(0, 3, SemanticTokenPresentation.Keyword),
		presented(2, 4, SemanticTokenPresentation.String),
	]), /sorted, non-overlapping/);
	assert.equal(element.firstElementChild, existing);
	assert.equal(element.innerHTML, "<b>stable</b>");

	assert.throws(() => projectStanzaSemanticTokenLine(element, "abcd", [
		presented(0, 1, "worker-css" as SemanticTokenPresentation),
	]), /Unknown Stanza semantic token presentation/);
	assert.equal(element.innerHTML, "<b>stable</b>");
	dom.window.close();
});

function token(lineIndex: number, startColumn: number, endColumn: number, tokenType: string, modifiers: readonly string[] = []): LanguageToken {
	return {
		range: Range.fromPositions(
			new Position((lineIndex) + 1, (startColumn) + 1),
			new Position((lineIndex) + 1, (endColumn) + 1),
		),
		tokenType,
		modifiers,
	};
}

function presented(startColumn: number, endColumn: number, presentation: SemanticTokenPresentation, modifiers?: readonly SemanticTokenModifier[]): ResolvedSemanticToken {
	return { startColumn, endColumn, presentation, ...(modifiers ? { modifiers } : {}) };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

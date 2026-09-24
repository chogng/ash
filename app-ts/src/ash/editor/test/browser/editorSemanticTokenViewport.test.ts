import './testEditorDom.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { SemanticTokenPresentation, createLanguageTokenStore, type LanguageToken } from '../../common/tokens/languageTokens.js';
import { LanguageTokenLineIndex, StyledTokenSource } from '../../common/tokens/languageTokenLineIndex.js';
import { LanguageResultAcceptance } from '../../common/model/languageResultStore.js';
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { type TextMeasurer } from '../../common/viewModel.js';

const { TestView: View } = await import("./viewModel/testViewModel.js");
const { EditorLineWrapping } = await import("../../common/config/editorOptions.js");

test("Viewport projects tokens only for virtualized lines and preserves overlapping rows", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using model = new TextModel(lines(12).join("\n"));
	using store = createLanguageTokenStore(model);
	acceptTokens(store, model, 1, [
		token(0, 0, 4, "keyword"),
		token(3, 0, 4, "string"),
		token(10, 0, 4, "number"),
	]);
	using index = new LanguageTokenLineIndex(store);
	using source = new StyledTokenSource(index);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		semanticTokenSource: source,
	});
	viewport.layout({ width: 200, height: 40 });

	assert.deepEqual(renderedTokenLines(viewport.domNode.domNode), ["0"]);
	viewport.scrollTo({ left: 0, top: 40 });
	const line3 = requiredLine(viewport.domNode.domNode, 3);
	const line3Token = requiredElement(line3, ".stanza-editor-token");
	assert.deepEqual(renderedTokenLines(viewport.domNode.domNode), ["3"]);

	viewport.scrollTo({ left: 0, top: 60 });
	assert.equal(requiredLine(viewport.domNode.domNode, 3), line3);
	assert.equal(requiredElement(line3, ".stanza-editor-token"), line3Token);
	assert.equal(viewport.domNode.domNode.querySelector('[data-line-index="10"]'), null);
	dom.window.close();
});

test("Same-version token replacement rerenders visible text and model edits clear stale spans", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using model = new TextModel("<tag> value");
	using store = createLanguageTokenStore(model);
	acceptTokens(store, model, 1, [token(0, 0, 5, "string")]);
	using index = new LanguageTokenLineIndex(store);
	using source = new StyledTokenSource(index);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		semanticTokenSource: source,
	});
	viewport.layout({ width: 200, height: 20 });
	const textElement = requiredElement<HTMLElement>(requiredLine(viewport.domNode.domNode, 0), ".stanza-editor-line-text");
	assert.equal(textElement.textContent, "<tag> value");
	assert.equal(textElement.querySelector("tag"), null);
	assert.equal(requiredElement(textElement, ".stanza-editor-token").classList.contains(SemanticTokenPresentation.String), true);

	acceptTokens(store, model, 2, [token(0, 6, 11, "variable")]);
	assert.equal(textElement.textContent, "<tag> value");
	assert.deepEqual([...textElement.querySelectorAll(".stanza-editor-token")].map(element => ({
		className: element.className,
		text: element.textContent,
	})), [{
		className: "stanza-editor-token token-variable",
		text: "value",
	}]);

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1)),
		text: "X",
	}]);
	assert.equal(store.result, undefined);
	assert.equal(textElement.textContent, "X<tag> value");
	assert.equal(textElement.querySelector(".stanza-editor-token"), null);
	dom.window.close();
});

test("Viewport clips semantic token spans to every soft-wrapped text fragment", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using model = new TextModel("abcdef");
	using store = createLanguageTokenStore(model);
	acceptTokens(store, model, 1, [{
		...token(0, 1, 5, "keyword"),
		presentation: { foreground: "#123456", fontStyle: ["italic"] },
	}]);
	using index = new LanguageTokenLineIndex(store);
	using source = new StyledTokenSource(index);
	using viewport = new View({
		container,
		model,
		glyphMargin: false,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		semanticTokenSource: source,
		lineWrapping: EditorLineWrapping.On,
		minimap: { enabled: false },
	});
	viewport.layout({ width: 70, height: 60 });

	assert.deepEqual(lineTokenFragments(viewport.domNode.domNode), [{
		lineIndex: "0",
		text: "b",
	}, {
		lineIndex: "1",
		text: "cd",
	}, {
		lineIndex: "2",
		text: "e",
	}]);
	assert.deepEqual([...viewport.domNode.domNode.querySelectorAll<HTMLElement>(".stanza-editor-token")].map(element => ({
		color: element.style.getPropertyValue('--ash-editor-token-foreground'),
		fontStyle: element.style.fontStyle,
	})), Array.from({ length: 3 }, () => ({ color: "#123456", fontStyle: "italic" })));

	dom.window.close();
});

test("Viewport rejects cross-model token sources and owns none of their common state", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using model = new TextModel("alpha");
	using otherModel = new TextModel("other");
	using store = createLanguageTokenStore(model);
	using otherStore = createLanguageTokenStore(otherModel);
	using index = new LanguageTokenLineIndex(store);
	using otherIndex = new LanguageTokenLineIndex(otherStore);
	using source = new StyledTokenSource(index);
	using otherSource = new StyledTokenSource(otherIndex);

	assert.throws(() => new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		semanticTokenSource: otherSource,
	}), /must share one text model/);
	const viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		semanticTokenSource: source,
	});
	viewport.dispose();

	acceptTokens(store, model, 1, [token(0, 0, 5, "keyword")]);
	assert.equal(index.getLineTokens(0).length, 1);
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (5) + 1)),
		text: "!",
	}]);
	assert.equal(model.getText(), "alpha!");
	dom.window.close();
});

test("Viewport resolves semantic tokens only for virtualized lines", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using model = new TextModel(lines(1_000).join("\n"));
	using store = createLanguageTokenStore(model);
	acceptTokens(store, model, 1, Array.from({ length: 1_000 }, (_, lineIndex) => token(lineIndex, 0, 4, "keyword")));
	using index = new LanguageTokenLineIndex(store);
	let requestedLines = 0;
	using source = new StyledTokenSource({
		textModel: index.textModel,
		onDidChange: index.onDidChange,
		get lines() { return index.lines; },
		getLineTokens: lineIndex => {
			requestedLines += 1;
			return index.getLineTokens(lineIndex);
		},
	});
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		semanticTokenSource: source,
	});

	viewport.layout({ width: 200, height: 20 });
	assert.equal(requestedLines, 1);
	viewport.scrollTo({ left: 0, top: 500 * 20 });
	assert.equal(requestedLines, 2);
	acceptTokens(store, model, 2, Array.from({ length: 1_000 }, (_, lineIndex) => token(lineIndex, 0, 4, "keyword")));
	assert.equal(requestedLines, 3);
	dom.window.close();
});

function acceptTokens(
	store: ReturnType<typeof createLanguageTokenStore>,
	model: TextModel,
	requestId: number,
	tokens: readonly LanguageToken[],
): void {
	assert.equal(store.accept({
		requestId,
		textModel: model,
		modelVersion: model.version,
		value: { tokens },
	}), LanguageResultAcceptance.Applied);
}

function token(lineIndex: number, startColumn: number, endColumn: number, tokenType: string): LanguageToken {
	return {
		range: Range.fromPositions(
			new Position((lineIndex) + 1, (startColumn) + 1),
			new Position((lineIndex) + 1, (endColumn) + 1),
		),
		tokenType,
		modifiers: [],
	};
}

function lines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `line${index}`);
}

function renderedTokenLines(root: ParentNode): string[] {
	return [...root.querySelectorAll(".stanza-editor-token")].map(element => (
		(element.parentElement?.parentElement as HTMLElement).dataset.lineIndex!
	));
}

function lineTokenFragments(root: ParentNode): { readonly lineIndex: string | undefined; readonly text: string | null }[] {
	return [...root.querySelectorAll<HTMLElement>(".stanza-editor-token")].map(element => ({
		lineIndex: element.parentElement?.parentElement?.dataset.lineIndex,
		text: element.textContent,
	}));
}

function requiredLine(root: ParentNode, lineIndex: number): HTMLElement {
	return requiredElement(root, `[data-line-index="${lineIndex}"]`);
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return text.length * 10;
	}
}

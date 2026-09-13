import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { TextDecorationCollection } from "../../../../common/model/decorationCollection.js";
import { LanguageDiagnosticSeverity, type LanguageDiagnostic } from "../../../../common/languages/languageResults.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";

import { h } from "../../../../../base/browser/dom.js";
import { TrackedRangeStickiness } from '../../../../common/model.js';

const environment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({ window: environment.window, document: environment.window.document, Node: environment.window.Node, Element: environment.window.Element, HTMLElement: environment.window.HTMLElement, Event: environment.window.Event, KeyboardEvent: environment.window.KeyboardEvent })) Object.defineProperty(globalThis, name, { configurable: true, value });
const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { DiagnosticNavigationController } = await import("../../browser/gotoError.js");

test("F8 navigates current diagnostics in both directions", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("one\ntwo\nthree");
	using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(model);
	diagnostics.add({ range: Range.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (2) + 1)), stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges, metadata: diagnostic("first") });
	diagnostics.add({ range: Range.fromPositions(new Position((2) + 1, (1) + 1), new Position((2) + 1, (3) + 1)), stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges, metadata: diagnostic("last") });
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.testViewModel.setSelections('test', [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new DiagnosticNavigationController(input, viewport, viewport.testViewModel, diagnostics);
	const next = key(dom.window, false);
	input.dispatchEvent(next);
	assert.equal(next.defaultPrevented, true);
	assert.deepEqual(
		viewport.testViewModel.getSelections()[0]!,
		Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (2) + 1)),
	);
	assert.equal(viewport.domNode.domNode.querySelector(".stanza-editor-accessibility-status")?.textContent, "warning: first");
	input.dispatchEvent(key(dom.window, false));
	assert.deepEqual(
		viewport.testViewModel.getSelections()[0]!,
		Selection.fromPositions(new Position((2) + 1, (1) + 1), new Position((2) + 1, (3) + 1)),
	);
	const previous = key(dom.window, true);
	assert.equal(previous.shiftKey, true);
	input.dispatchEvent(previous);
	assert.equal(previous.defaultPrevented, true);
	assert.deepEqual(
		viewport.testViewModel.getSelections()[0]!,
		Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (2) + 1)),
	);
	dom.window.close();
});

function diagnostic(message: string): LanguageDiagnostic { return { range: Range.fromPositions(new Position((0) + 1, (0) + 1)), severity: LanguageDiagnosticSeverity.Warning, message }; }
function key(window: typeof environment.window, shiftKey: boolean): KeyboardEvent { return new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F8", shiftKey }) as unknown as KeyboardEvent; }
class FixedTextMeasurer implements TextMeasurer { readonly horizontalPadding = 24; readonly contentLeftPadding = 12; refresh(): boolean { return false; } measureLineWidth(text: string): number { return text.length * 10; } }

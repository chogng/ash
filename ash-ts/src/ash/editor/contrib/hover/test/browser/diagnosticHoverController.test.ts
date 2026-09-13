import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { DiagnosticHoverController } from "../../browser/diagnosticHoverController.js";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { TextModel } from "../../../../common/model/textModel.js";


class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return [...text].length * 10;
	}
}

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");

test("Diagnostic hover presents current gutter-marker messages and hides on pointer exit", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("const value");
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	using controller = new DiagnosticHoverController(viewport);
	viewport.layout({ width: 160, height: 20 });
	const marker = dom.window.document.createElement('span');
	marker.className = 'stanza-editor-diagnostic-marker';
	marker.dataset.diagnosticHoverText = 'Use let instead';
	viewport.domNode.domNode.append(marker);
	marker.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
	const hover = dom.window.document.body.querySelector<HTMLElement>(".stanza-editor-diagnostic-hover")!;
	assert.equal(hover.hidden, false);
	assert.equal(hover.textContent, "Use let instead");

	marker.dispatchEvent(new dom.window.Event("pointerout", { bubbles: true }));
	assert.equal(hover.hidden, true);
	dom.window.close();
});

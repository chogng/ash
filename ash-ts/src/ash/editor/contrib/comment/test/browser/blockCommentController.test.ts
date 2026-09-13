import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { h } from "../../../../../base/browser/dom.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { BlockCommentController } = await import("../../browser/blockCommentController.js");

test("Block comment shortcut toggles the active language pair locally", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("alpha beta", { languageId: 'typescript' });
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (6) + 1), new Position((0) + 1, (10) + 1))]);
	using configurations = new TestLanguageConfigurationService();
	using registration = configurations.register("typescript", {
		comments: { blockComment: ["/*", "*/"] },
	});
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.layout({ width: 200, height: 20 });
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new BlockCommentController(input, viewport, selections, { languageId: "typescript", configurations });

	const toggle = keydown(dom.window, "a", { shiftKey: true, altKey: true });
	input.dispatchEvent(toggle);
	assert.equal(toggle.defaultPrevented, true);
	assert.equal(model.getText(), "alpha /* beta */");
	input.dispatchEvent(keydown(dom.window, "a", { shiftKey: true, altKey: true }));
	assert.equal(model.getText(), "alpha beta");

	dom.window.close();
});

test("Block comment shortcut leaves languages without a block pair alone", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("alpha");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	using configurations = new TestLanguageConfigurationService();
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new BlockCommentController(input, viewport, selections, { languageId: "plaintext", configurations });
	const toggle = keydown(dom.window, "a", { shiftKey: true, altKey: true });
	input.dispatchEvent(toggle);
	assert.equal(toggle.defaultPrevented, false);
	assert.equal(model.getText(), "alpha");

	dom.window.close();
});

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

function keydown(targetWindow: typeof browserEnvironment.window, key: string, options: { readonly shiftKey?: boolean; readonly altKey?: boolean } = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		shiftKey: options.shiftKey,
		altKey: options.altKey,
	}) as unknown as KeyboardEvent;
}

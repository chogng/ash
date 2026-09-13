import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { LanguageBracketPairs } from "../../../../common/languages/languageBracketPairs.js";
import { LanguageLexicalContextIndex } from "../../../../common/languages/languageLexicalContext.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { h } from "../../../../../base/browser/dom.js";

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
const { BracketNavigationController } = await import("../../browser/bracketNavigationController.js");

test("Go-to-bracket shortcut uses the shared structural bracket index", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("(value)");
	using configurations = configurationsForBrackets();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.testViewModel.setSelections('test', [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	viewport.layout({ width: 200, height: 60 });
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new BracketNavigationController(input, viewport, viewport.testViewModel, bracketPairs);

	const jump = keydown(dom.window, "\\", { ctrlKey: true, shiftKey: true });
	input.dispatchEvent(jump);
	assert.equal(jump.defaultPrevented, true);
	assert.deepEqual(viewport.testViewModel.getSelections()[0]!, Selection.fromPositions(new Position((0) + 1, (6) + 1)));

	dom.window.close();
});

test("Bracket navigation controller rejects cross-model wiring and unrelated chords", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("()");
	using other = new TextModel("()");
	using configurations = configurationsForBrackets();
	using lexical = new LanguageLexicalContextIndex(model, "typescript", configurations);
	using otherLexical = new LanguageLexicalContextIndex(other, "typescript", configurations);
	using bracketPairs = new LanguageBracketPairs(model, lexical);
	using otherBracketPairs = new LanguageBracketPairs(other, otherLexical);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new BracketNavigationController(input, viewport, viewport.testViewModel, bracketPairs);
	const unrelated = keydown(dom.window, "\\", { ctrlKey: true });
	input.dispatchEvent(unrelated);
	assert.equal(unrelated.defaultPrevented, false);
	assert.throws(() => new BracketNavigationController(input, viewport, viewport.testViewModel, otherBracketPairs), /must share one text model/);

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

function configurationsForBrackets(): TestLanguageConfigurationService {
	const configurations = new TestLanguageConfigurationService();
	configurations.register("typescript", { brackets: [["(", ")"]] });
	return configurations;
}

function keydown(targetWindow: typeof browserEnvironment.window, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options }) as unknown as KeyboardEvent;
}

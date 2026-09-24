import '../../../../test/browser/testEditorDom.js';
import { browserEnvironment } from '../../../../test/browser/testEditorDom.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { OperatingSystem } from "../../../../../base/common/platform.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { h } from "../../../../../base/browser/dom.js";
import { type TextMeasurer } from '../../../../common/viewModel.js';

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { GotoLineController, isStanzaGotoLineChord } = await import("../../browser/quickAccessController.js");

test("Go to Line previews locally, accepts a line and column, and cancels without changing selections", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("zero\none\ntwo");
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.testViewModel.setSelections('test', [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	viewport.layout({ width: 200, height: 40 });
	const editorInput = h(dom.window.document, "textarea");
	container.append(editorInput);
	using controller = new GotoLineController(editorInput, viewport, viewport.testViewModel, { operatingSystem: OperatingSystem.Linux });

	const open = keydown(dom.window, "g", { ctrlKey: true });
	editorInput.dispatchEvent(open);
	assert.equal(open.defaultPrevented, true);
	assert.equal(controller.visible, true);
	controller.input.value = "3:2";
	controller.input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	assert.deepEqual(viewport.testViewModel.getSelections()[0]!, Selection.fromPositions(new Position((0) + 1, (0) + 1)));
	controller.input.dispatchEvent(keydown(dom.window, "Enter"));
	assert.equal(controller.visible, false);
	assert.deepEqual(viewport.testViewModel.getSelections()[0]!, Selection.fromPositions(new Position((2) + 1, (1) + 1)));

	editorInput.dispatchEvent(keydown(dom.window, "g", { ctrlKey: true }));
	controller.input.value = "not a line";
	controller.input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	assert.equal(controller.input.classList.contains("invalid"), true);
	controller.input.dispatchEvent(keydown(dom.window, "Escape"));
	assert.deepEqual(viewport.testViewModel.getSelections()[0]!, Selection.fromPositions(new Position((2) + 1, (1) + 1)));
	dom.window.close();
});

test("Go to Line uses Command+G on macOS", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("zero\none");
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.testViewModel.setSelections('test', [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	const editorInput = h(dom.window.document, "textarea");
	container.append(editorInput);
	using controller = new GotoLineController(editorInput, viewport, viewport.testViewModel, { operatingSystem: OperatingSystem.Macintosh });

	const open = keydown(dom.window, "g", { metaKey: true });
	editorInput.dispatchEvent(open);
	assert.equal(open.defaultPrevented, true);
	assert.equal(controller.visible, true);
	assert.equal(isStanzaGotoLineChord(keydown(dom.window, "g", { ctrlKey: true }), OperatingSystem.Macintosh), false);
	dom.window.close();
});

test('Go to Offset uses one-based UTF-16 positions and returns focus on accept', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('alpha\n😊beta');
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.layout({ width: 200, height: 40 });
	const editorInput = h(dom.window.document, 'textarea');
	container.append(editorInput);
	using controller = new GotoLineController(editorInput, viewport, viewport.testViewModel);

	controller.open('offset');
	assert.equal(controller.input.getAttribute('aria-label'), 'Character offset');
	assert.equal(controller.input.value, '1');
	controller.input.value = '9';
	controller.input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	controller.input.dispatchEvent(keydown(dom.window, 'Enter'));
	assert.deepEqual(viewport.testViewModel.getSelections()[0]!, Selection.fromPositions(new Position(2, 3)));
	assert.equal(dom.window.document.activeElement, editorInput);

	controller.open();
	assert.equal(controller.input.getAttribute('aria-label'), 'Line number and optional column');
	assert.equal(controller.input.value, '2:3');
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

function keydown(targetWindow: typeof browserEnvironment.window, key: string, options: { readonly ctrlKey?: boolean; readonly metaKey?: boolean } = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		ctrlKey: options.ctrlKey,
		metaKey: options.metaKey,
	}) as unknown as KeyboardEvent;
}

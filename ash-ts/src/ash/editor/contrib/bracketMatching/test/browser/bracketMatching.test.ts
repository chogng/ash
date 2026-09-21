import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { TextDecorationCollection } from "../../../../common/model/decorationCollection.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { type TextMeasurer } from '../../../../common/viewModel.js';

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
const { BracketMatchingController } = await import("../../browser/bracketMatching.js");

test("Bracket match controller stores standard decoration options and clears them for a range selection", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel("function value() {\n}", { languageId: "typescript", languageConfigurationService: configurations });
	using registration = configurations.register("typescript", {
		brackets: [["(", ")"], ["{", "}"]],
	});
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (17) + 1))]);
	const bracketPairs = model.bracketPairs;
	using decorations = new TextDecorationCollection<void>(model);
	using viewport = new View({
		container,
		model,
		glyphMargin: false,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: selections,
	});
	using controller = new BracketMatchingController(editorFor(model, selections), bracketPairs, decorations, "always");
	viewport.layout({ width: 240, height: 40 });

	assert.deepEqual(model.getAllDecorations().filter(decoration => decoration.options.className === 'bracket-match').map(decoration => ({
		range: decoration.range,
		className: decoration.options.className,
	})), [{
		range: new Range(1, 18, 1, 19),
		className: 'bracket-match',
	}, {
		range: new Range(2, 1, 2, 2),
		className: 'bracket-match',
	}]);

	selections.setSelections([Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1))]);
	assert.equal(model.getAllDecorations().filter(decoration => decoration.options.className === 'bracket-match').length, 0);
	dom.window.close();
});

test("Bracket match controller distinguishes near, always, and never modes", () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel("{ value }", { languageId: "typescript", languageConfigurationService: configurations });
	using registration = configurations.register("typescript", { brackets: [["{", "}"]] });
	const bracketPairs = model.bracketPairs;
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (3) + 1))]);
	const editor = editorFor(model, selections);

	using nearDecorations = new TextDecorationCollection<void>(model);
	using near = new BracketMatchingController(editor, bracketPairs, nearDecorations, "near");
	assert.equal(nearDecorations.size, 0);

	using alwaysDecorations = new TextDecorationCollection<void>(model);
	using always = new BracketMatchingController(editor, bracketPairs, alwaysDecorations, "always");
	assert.equal(alwaysDecorations.size, 2);

	using neverDecorations = new TextDecorationCollection<void>(model);
	using never = new BracketMatchingController(editor, bracketPairs, neverDecorations, "never");
	assert.equal(neverDecorations.size, 0);

	model.applyEdits([{ range: new Range(1, 9, 1, 10), text: " " }]);
	assert.equal(alwaysDecorations.size, 0);
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

function editorFor(model: TextModel, selections: ReturnType<typeof createTestCursorsController>): ICodeEditor {
	return {
		getModel: () => model,
		getSelections: () => selections.getSelections(),
		onDidChangeCursorSelection: (listener: Parameters<ICodeEditor['onDidChangeCursorSelection']>[0]) => selections.onDidChange(() => listener({} as never)),
	} as unknown as ICodeEditor;
}

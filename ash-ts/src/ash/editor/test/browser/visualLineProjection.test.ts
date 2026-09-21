import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../base/common/lifecycle.js";
import { EditorLineWrapping, WrappingIndent } from "../../common/config/editorOptions.js";
import { FontInfo } from "../../common/config/fontInfo.js";
import { ViewModelLinesFromModelAsIs, ViewModelLinesFromProjectedModel } from "../../common/viewModel/viewModelLines.js";
import { DOMLineBreaksComputerFactory } from "../../browser/view/domLineBreaksComputer.js";
import { TextModel } from "../../common/model/textModel.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { PositionAffinity } from "../../common/model.js";
import { type TextMeasurer } from '../../common/viewModel.js';

test("browser visual-line projection wraps at grapheme boundaries and rebuilds after edits", () => {
	using model = new TextModel("ab😀cd\nxyz");
	using projection = createViewModelLines(model, new FixedTextMeasurer(), {
		wrapping: EditorLineWrapping.On,
		wrapWidth: 20,
	});
	let changes = 0;
	using listener = projection.onDidChange(() => changes += 1);

	assert.deepEqual(projection.projection.lines.map(line => ({
		logical: line.logicalLineIndex,
		start: line.startColumn,
		end: line.endColumn,
	})), [
		{ logical: 0, start: 0, end: 2 },
		{ logical: 0, start: 2, end: 5 },
		{ logical: 0, start: 5, end: 6 },
		{ logical: 1, start: 0, end: 2 },
		{ logical: 1, start: 2, end: 3 },
	]);

	model.applyEdits([{
		range: Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (0) + 1)),
		text: "qq",
	}]);
	assert.equal(changes, 1);
	assert.equal(projection.projection.visualLineCount, 6);

	projection.setWrapping(EditorLineWrapping.Off);
	assert.equal(projection.projection.visualLineCount, 2);
});

test("browser visual-line projection applies wrapping indent modes to continuation rows", () => {
	using model = new TextModel("  abcdefghijkl");
	const measurer = new FixedTextMeasurer();
	assert.equal(computeWrappedIndent(model, measurer, 110, WrappingIndent.None), 0);
	assert.equal(computeWrappedIndent(model, measurer, 110, WrappingIndent.Same), 20);
	assert.equal(computeWrappedIndent(model, measurer, 110, WrappingIndent.Indent), 40);
	assert.equal(computeWrappedIndent(model, measurer, 110, WrappingIndent.DeepIndent), 80);

	using projection = createViewModelLines(model, measurer, {
		wrapping: EditorLineWrapping.On,
		wrapWidth: 70,
		wrappingIndent: WrappingIndent.Same,
	});
	assert.deepEqual(projection.projection.lines.map(line => ({
		start: line.startColumn,
		end: line.endColumn,
		indent: line.wrappedTextIndentWidth,
	})), [
		{ start: 0, end: 7, indent: undefined },
		{ start: 7, end: 12, indent: 20 },
		{ start: 12, end: 14, indent: 20 },
	]);

	projection.setWrappingIndent(WrappingIndent.Indent);
	assert.deepEqual(projection.projection.lines.map(line => line.endColumn), [7, 10, 13, 14]);
	assert.equal(projection.projection.lines[1]?.wrappedTextIndentWidth, 40);
});

test('DOM soft wrapping prefers word boundaries and honors keepAll for CJK text', () => {
	const fontInfo = new FontInfo({ ...TEST_FONT_INFO, fontFamily: 'sans-serif', isMonospace: false }, true);
	using words = new TextModel('abc defgh');
	using wordLines = new ViewModelLinesFromProjectedModel(words, createFactory(new FixedTextMeasurer()), fontInfo, 4, {
		wrapping: EditorLineWrapping.On,
		wrapWidth: 60,
		wrappingIndent: WrappingIndent.None,
	});
	assert.deepEqual(Array.from({ length: wordLines.getLineCount() }, (_, index) => wordLines.getLineContent(index + 1)), ['abc ', 'defgh']);

	using cjk = new TextModel('a 中文测试');
	using cjkLines = new ViewModelLinesFromProjectedModel(cjk, createFactory(new FixedTextMeasurer()), fontInfo, 4, {
		wrapping: EditorLineWrapping.On,
		wrapWidth: 40,
		wrappingIndent: WrappingIndent.None,
	});
	assert.deepEqual(Array.from({ length: cjkLines.getLineCount() }, (_, index) => cjkLines.getLineContent(index + 1)), ['a 中文', '测试']);
	cjkLines.setWrappingSettings(fontInfo, 'advanced', 4, WrappingIndent.None, 'keepAll');
	assert.deepEqual(Array.from({ length: cjkLines.getLineCount() }, (_, index) => cjkLines.getLineContent(index + 1)), ['a ', '中文测试']);
	cjk.setValue('a 中文测试很多');
	assert.deepEqual(Array.from({ length: cjkLines.getLineCount() }, (_, index) => cjkLines.getLineContent(index + 1)), ['a ', '中文测试', '很多']);
});

test("view-model lines expose wrapped cursor rows and convert positions through the same projection", () => {
	using model = new TextModel("abcdef\nxy");
	using lines = createViewModelLines(model, new FixedTextMeasurer(), {
		wrapping: EditorLineWrapping.On,
		wrapWidth: 20,
	});
	const coordinates = lines.createCoordinatesConverter();

	assert.deepEqual(
		Array.from({ length: lines.getLineCount() }, (_, index) => lines.getLineContent(index + 1)),
		["ab", "cd", "ef", "xy"],
	);
	assert.deepEqual(coordinates.convertViewPositionToModelPosition(new Position(2, 2)), new Position(1, 4));
	assert.deepEqual(coordinates.convertModelPositionToViewPosition(new Position(1, 3)), new Position(2, 1));
	assert.deepEqual(coordinates.convertModelPositionToViewPosition(new Position(1, 3), PositionAffinity.Left), new Position(1, 3));
	assert.equal(coordinates.getModelLineViewLineCount(1), 3);
	assert.deepEqual(lines.getViewLinesData(1, 4, [true, false, true, true]).map(line => line?.content ?? null), ["ab", null, "ef", "xy"]);
});

test("model-as-is view-model lines preserve one view row per model row", () => {
	using model = new TextModel("first\nsecond");
	using lines = new ViewModelLinesFromModelAsIs(model);
	const computer = lines.createLineBreaksComputer();
	computer.addRequest(1, null);
	computer.addRequest(2, null);

	assert.equal(lines.getViewLineCount(), 2);
	assert.equal(lines.getViewLineContent(2), "second");
	assert.equal(lines.getViewLineData(1).content, "first");
	assert.deepEqual(computer.finalize(), [null, null]);
	assert.deepEqual(lines.createCoordinatesConverter().convertViewPositionToModelPosition(new Position(2, 3)), new Position(2, 3));
});

test("browser visual-line projection validates its public wrapping inputs", () => {
	using model = new TextModel("text");
	assert.throws(() => createViewModelLines(model, new FixedTextMeasurer(), {
		wrapping: "invalid" as EditorLineWrapping,
	}), /wrapping mode/);
	assert.throws(() => createViewModelLines(model, new FixedTextMeasurer(), {
		wrapWidth: -1,
	}), /wrap width/);
	assert.throws(() => createViewModelLines(model, new FixedTextMeasurer(), {
		wrappingIndent: "Same" as unknown as WrappingIndent,
	}), /wrapping indent mode/);
	assert.throws(() => createViewModelLines(model, new FixedTextMeasurer(), {
		initialWrappingMeasurement: { schedule: undefined as never },
	}), /requires a scheduler/);
	assert.throws(() => createViewModelLines(model, new FixedTextMeasurer(), {
		initialWrappingMeasurement: { initialLineCount: 0, schedule: () => toDisposable(() => {}) },
	}), /measurement count/);
});

test("browser visual-line projection measures initial wrapped rows in cancellable idle slices", () => {
	using model = new TextModel("abc\ndefg\nhij");
	const scheduled: (() => void)[] = [];
	const measurer = new CountingTextMeasurer();
	using projection = createViewModelLines(model, measurer, {
		wrapping: EditorLineWrapping.On,
		wrapWidth: 20,
		initialWrappingMeasurement: {
			initialLineCount: 1,
			linesPerSlice: 1,
			schedule: callback => {
				scheduled.push(callback);
				return toDisposable(() => {
					const index = scheduled.indexOf(callback);
					if (index >= 0) scheduled.splice(index, 1);
				});
			},
		},
	});

	assert.equal(projection.complete, false);
	assert.equal(measurer.calls, 3);
	assert.deepEqual(projection.projection.lines.map(line => line.endColumn), [2, 3, 4, 3]);
	const first = scheduled.shift();
	assert.ok(first);
	first();
	assert.equal(projection.complete, false);
	assert.equal(measurer.calls, 7);
	assert.deepEqual(projection.projection.lines.map(line => line.endColumn), [2, 3, 4, 3]);
	const second = scheduled.shift();
	assert.ok(second);
	second();
	assert.equal(projection.complete, true);
	assert.equal(measurer.calls, 10);
	assert.deepEqual(projection.projection.lines.map(line => line.endColumn), [2, 3, 2, 4, 2, 3]);
});

test("browser visual-line projection restarts an incomplete wrapped scan after an edit", () => {
	using model = new TextModel("abc\ndef");
	const scheduled: (() => void)[] = [];
	using projection = createViewModelLines(model, new FixedTextMeasurer(), {
		wrapping: EditorLineWrapping.On,
		wrapWidth: 20,
		initialWrappingMeasurement: {
			initialLineCount: 1,
			linesPerSlice: 1,
			schedule: callback => {
				scheduled.push(callback);
				return toDisposable(() => {
					const index = scheduled.indexOf(callback);
					if (index >= 0) scheduled.splice(index, 1);
				});
			},
		},
	});

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "d",
	}]);
	assert.equal(projection.complete, false);
	assert.deepEqual(projection.projection.lines.map(line => ({ logical: line.logicalLineIndex, end: line.endColumn })), [
		{ logical: 0, end: 2 },
		{ logical: 0, end: 4 },
		{ logical: 1, end: 3 },
	]);
	const complete = scheduled.shift();
	assert.ok(complete);
	complete();
	assert.equal(projection.complete, true);
	assert.equal(projection.projection.visualLineCount, 4);
});

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 0;
	readonly contentLeftPadding = 0;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		let width = 0;
		for (const character of text) {
			width = character === "\t"
				? (Math.floor(width / 10 / 4) + 1) * 4 * 10
				: width + 10;
		}
		return width;
	}
}

class CountingTextMeasurer extends FixedTextMeasurer {
	calls = 0;

	override measureLineWidth(text: string): number {
		this.calls += 1;
		return super.measureLineWidth(text);
	}
}

function createViewModelLines(model: TextModel, measurer: TextMeasurer, options: ConstructorParameters<typeof ViewModelLinesFromProjectedModel>[4] = {}): ViewModelLinesFromProjectedModel {
	return new ViewModelLinesFromProjectedModel(model, createFactory(measurer), TEST_FONT_INFO, 4, options);
}

function computeWrappedIndent(model: TextModel, measurer: TextMeasurer, wrapWidth: number, wrappingIndent: WrappingIndent): number {
	const computer = createFactory(measurer).createLineBreaksComputer({
		getLineContent: lineNumber => model.getLineContent(lineNumber),
		getLineInjectedText: () => null,
	}, TEST_FONT_INFO, 4, wrapWidth / TEST_FONT_INFO.typicalHalfwidthCharacterWidth, wrappingIndent, 'normal', false);
	computer.addRequest(1, null);
	return (computer.finalize()[0]?.wrappedTextIndentLength ?? 0) * TEST_FONT_INFO.spaceWidth;
}

function createFactory(measurer: TextMeasurer): DOMLineBreaksComputerFactory {
	return new DOMLineBreaksComputerFactory(new WeakRef({} as Window), measurer);
}

const TEST_FONT_INFO = new FontInfo({
	pixelRatio: 1,
	fontFamily: 'monospace',
	fontWeight: 'normal',
	fontSize: 10,
	fontFeatureSettings: 'none',
	fontVariationSettings: 'normal',
	lineHeight: 20,
	letterSpacing: 0,
	isMonospace: true,
	typicalHalfwidthCharacterWidth: 10,
	typicalFullwidthCharacterWidth: 20,
	canUseHalfwidthRightwardsArrow: true,
	spaceWidth: 10,
	middotWidth: 10,
	wsmiddotWidth: 10,
	maxDigitWidth: 10,
}, true);

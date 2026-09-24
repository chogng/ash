import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, Event } from "../../../base/common/event.js";
import { Disposable as DisposableBase } from '../../../base/common/lifecycle.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { type IEditorConfiguration } from '../../common/config/editorConfiguration.js';
import { EditorOption, type IComputedEditorOptions } from '../../common/config/editorOptions.js';
import { Range } from "../../common/core/range.js";
import { ScrollType } from '../../common/editorCommon.js';
import { TextModel } from "../../common/model/textModel.js";
import { type CustomLineHeightData } from '../../common/viewLayout/lineHeights.js';
import { EditorViewportChangeReason, type EditorViewportVerticalPadding, ViewLayout as EditorViewLayout } from "../../common/viewLayout/viewLayout.js";
import { type EditorViewportLineSource } from '../../common/viewModel.js';

interface TestViewLayoutOptions {
	readonly lineHeight: number;
	readonly lineSource?: EditorViewportLineSource;
	readonly padding?: EditorViewportVerticalPadding;
	readonly customLineHeightData?: readonly CustomLineHeightData[];
}

class ViewLayout extends EditorViewLayout {
	constructor(model: TextModel, options: TestViewLayoutOptions) {
		const lineSource = options.lineSource;
		super(
			testConfiguration(options.lineHeight, options.padding),
			lineSource?.lineCount ?? model.lineCount,
			[...(options.customLineHeightData ?? [])],
			callback => {
				queueMicrotask(callback);
				return DisposableBase.None;
			},
		);
		this._register(model.onDidChangeContent(() => this.onFlushed(lineSource?.lineCount ?? model.lineCount, [])));
		if (lineSource) this._register(lineSource.onDidChange(() => this.onFlushed(lineSource.lineCount, [])));
	}
}

function testConfiguration(lineHeight: number, padding: EditorViewportVerticalPadding | undefined): IEditorConfiguration {
	const values = new Map<EditorOption, unknown>([
		[EditorOption.lineHeight, lineHeight],
		[EditorOption.padding, padding ?? { top: 0, bottom: 0 }],
		[EditorOption.layoutInfo, { width: 0, height: 0 }],
		[EditorOption.smoothScrolling, false],
	]);
	return {
		isSimpleWidget: false,
		contextMenuId: MenuId.EditorContext,
		options: { get: id => values.get(id) } as IComputedEditorOptions,
		onDidChangeFast: Event.None,
		onDidChange: Event.None,
		getRawOptions: () => ({}),
		updateOptions: () => {},
		observeContainer: () => {},
		setIsDominatedByLongLines: () => {},
		setModelLineCount: () => {},
		setViewLineCount: () => {},
		setReservedHeight: () => {},
		setGlyphMarginDecorationLaneCount: () => {},
		dispose: () => {},
		[Symbol.dispose]: () => {},
	};
}

test("ViewLayout calculates visible line ranges", () => {
	using model = new TextModel(lines(100));
	using viewport = new ViewLayout(model, {
		lineHeight: 20,
	});

	viewport.setViewportSize({ width: 300, height: 100 });
	viewport.setMaxLineWidth(500);
	viewport.setScrollPosition({ scrollLeft: 250, scrollTop: 45 }, ScrollType.Immediate);

	assert.deepEqual(viewport.layout, {
		lineHeight: 20,
		viewportSize: { width: 300, height: 100 },
		contentSize: { width: 500, height: 2_000 },
		scrollPosition: { left: 200, top: 45 },
		maximumScrollPosition: { left: 200, top: 1_900 },
		visibleLines: {
			startLineIndex: 2,
			endLineIndexExclusive: 8,
		},
		renderLines: {
			startLineIndex: 2,
			endLineIndexExclusive: 8,
		},
		renderTop: 40,
	});
	assert.deepEqual({
		contentWidth: viewport.getContentWidth(),
		contentHeight: viewport.getContentHeight(),
		scrollWidth: viewport.getScrollWidth(),
		scrollHeight: viewport.getScrollHeight(),
		viewport: { ...viewport.getCurrentViewport() },
		lineNumber: viewport.getLineNumberAtVerticalOffset(45),
		lineTop: viewport.getVerticalOffsetForLineNumber(3),
		lineBottom: viewport.getVerticalOffsetAfterLineNumber(3),
		lineHeight: viewport.getLineHeightForLineNumber(3),
		whitespaces: viewport.getWhitespaces(),
	}, {
		contentWidth: 500,
		contentHeight: 2_000,
		scrollWidth: 500,
		scrollHeight: 2_000,
		viewport: { _viewportBrand: undefined, top: 45, left: 200, width: 300, height: 100 },
		lineNumber: 3,
		lineTop: 40,
		lineBottom: 60,
		lineHeight: 20,
		whitespaces: [],
	});

	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: 100_000 }, ScrollType.Immediate);

	assert.deepEqual({
		scrollPosition: viewport.layout.scrollPosition,
		visibleLines: viewport.layout.visibleLines,
		renderLines: viewport.layout.renderLines,
		renderTop: viewport.layout.renderTop,
	}, {
		scrollPosition: { left: 0, top: 1_900 },
		visibleLines: {
			startLineIndex: 95,
			endLineIndexExclusive: 100,
		},
		renderLines: {
			startLineIndex: 95,
			endLineIndexExclusive: 100,
		},
		renderTop: 1_900,
	});
});

test("ViewLayout includes vertical padding in content and row projection", () => {
	using model = new TextModel(lines(10));
	using viewport = new ViewLayout(model, {
		lineHeight: 20,
		padding: { top: 20, bottom: 10 },
	});

	viewport.setViewportSize({ width: 200, height: 40 });
	assert.deepEqual({
		contentHeight: viewport.layout.contentSize.height,
		visibleLines: viewport.layout.visibleLines,
		renderLines: viewport.layout.renderLines,
		renderTop: viewport.layout.renderTop,
	}, {
		contentHeight: 230,
		visibleLines: { startLineIndex: 0, endLineIndexExclusive: 1 },
		renderLines: { startLineIndex: 0, endLineIndexExclusive: 1 },
		renderTop: 20,
	});

	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: 1_000 }, ScrollType.Immediate);
	assert.deepEqual({
		scrollTop: viewport.layout.scrollPosition.top,
		visibleLines: viewport.layout.visibleLines,
		renderLines: viewport.layout.renderLines,
		renderTop: viewport.layout.renderTop,
	}, {
		scrollTop: 190,
		visibleLines: { startLineIndex: 8, endLineIndexExclusive: 10 },
		renderLines: { startLineIndex: 8, endLineIndexExclusive: 10 },
		renderTop: 180,
	});
});

test('ViewLayout reserves independently addressable view zones between lines', () => {
	using model = new TextModel(lines(4));
	using viewport = new ViewLayout(model, { lineHeight: 20 });
	viewport.setViewportSize({ width: 200, height: 30 });
	const reasons: EditorViewportChangeReason[] = [];
	using listener = viewport.onDidChange(change => reasons.push(change.reason));

	let beforeFirst = '';
	let beforeThird = '';
	viewport.changeWhitespace(accessor => {
		beforeFirst = accessor.insertWhitespace(0, 10_000, 10, 0);
		beforeThird = accessor.insertWhitespace(2, 10_000, 15, 0);
	});

	assert.deepEqual({
		contentHeight: viewport.layout.contentSize.height,
		lineTops: Array.from({ length: 4 }, (_, lineIndex) => viewport.getVerticalOffsetForLineIndex(lineIndex)),
		whitespaces: viewport.getWhitespaces().map(({ id, afterLineNumber, height }) => ({ id, afterLineNumber, height })),
		visibleLines: viewport.layout.visibleLines,
	}, {
		contentHeight: 105,
		lineTops: [10, 30, 65, 85],
		whitespaces: [
			{ id: beforeFirst, afterLineNumber: 0, height: 10 },
			{ id: beforeThird, afterLineNumber: 2, height: 15 },
		],
		visibleLines: { startLineIndex: 0, endLineIndexExclusive: 1 },
	});
	viewport.setViewportSize({ width: 200, height: 10 });
	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: 50 }, ScrollType.Immediate);
	assert.deepEqual(viewport.layout.visibleLines, { startLineIndex: 2, endLineIndexExclusive: 2 });
	viewport.setViewportSize({ width: 200, height: 30 });
	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: 0 }, ScrollType.Immediate);
	reasons.length = 0;

	viewport.changeWhitespace(accessor => {
		accessor.changeOneWhitespace(beforeFirst, 1, 5);
		accessor.removeWhitespace(beforeThird);
	});

	assert.deepEqual({
		contentHeight: viewport.layout.contentSize.height,
		lineTops: Array.from({ length: 4 }, (_, lineIndex) => viewport.getVerticalOffsetForLineIndex(lineIndex)),
		whitespaces: viewport.getWhitespaces().map(({ id, afterLineNumber, height }) => ({ id, afterLineNumber, height })),
		reasons,
	}, {
		contentHeight: 85,
		lineTops: [0, 25, 45, 65],
		whitespaces: [{ id: beforeFirst, afterLineNumber: 1, height: 5 }],
		reasons: [EditorViewportChangeReason.EditorViewZones],
	});
});

test('ViewLayout orders same-line view zones by explicit ordinal and creation order', () => {
	using model = new TextModel(lines(2));
	using viewport = new ViewLayout(model, { lineHeight: 20 });
	let defaultOrdinal = '';
	let later = '';
	let earlier = '';
	viewport.changeWhitespace(accessor => {
		defaultOrdinal = accessor.insertWhitespace(1, 10_000, 5, 0);
		later = accessor.insertWhitespace(1, 20, 7, 0);
		earlier = accessor.insertWhitespace(1, 10, 3, 0);
	});

	assert.deepEqual(viewport.getWhitespaces().map(({ id, afterLineNumber, height }) => ({ id, afterLineNumber, height })), [
		{ id: earlier, afterLineNumber: 1, height: 3 },
		{ id: later, afterLineNumber: 1, height: 7 },
		{ id: defaultOrdinal, afterLineNumber: 1, height: 5 },
	]);

	viewport.changeWhitespace(accessor => {
		accessor.removeWhitespace(defaultOrdinal);
		defaultOrdinal = accessor.insertWhitespace(1, 0, 5, 0);
	});
	assert.deepEqual(viewport.getWhitespaces().map(({ id, afterLineNumber, height }) => ({ id, afterLineNumber, height })), [
		{ id: defaultOrdinal, afterLineNumber: 1, height: 5 },
		{ id: earlier, afterLineNumber: 1, height: 3 },
		{ id: later, afterLineNumber: 1, height: 7 },
	]);
});

test("Viewport resize and line-height changes preserve a stable top line", () => {
	using model = new TextModel(lines(100));
	using viewport = new ViewLayout(model, {
		lineHeight: 20,
	});
	viewport.setViewportSize({ width: 300, height: 100 });
	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: 1_800 }, ScrollType.Immediate);

	viewport.setViewportSize({ width: 300, height: 200 });
	assert.deepEqual({
		top: viewport.layout.scrollPosition.top,
		maximumTop: viewport.layout.maximumScrollPosition.top,
		visibleLines: viewport.layout.visibleLines,
	}, {
		top: 1_800,
		maximumTop: 1_800,
		visibleLines: {
			startLineIndex: 90,
			endLineIndexExclusive: 100,
		},
	});

	viewport.setLineHeight(40);

	assert.deepEqual({
		top: viewport.layout.scrollPosition.top,
		maximumTop: viewport.layout.maximumScrollPosition.top,
		visibleLines: viewport.layout.visibleLines,
		renderLines: viewport.layout.renderLines,
	}, {
		top: 3_600,
		maximumTop: 3_800,
		visibleLines: {
			startLineIndex: 90,
			endLineIndexExclusive: 95,
		},
		renderLines: {
			startLineIndex: 90,
			endLineIndexExclusive: 95,
		},
	});
});

test("Model line changes update layout and clamp scrolling", () => {
	using model = new TextModel(lines(100));
	using viewport = new ViewLayout(model, {
		lineHeight: 20,
	});
	viewport.setViewportSize({ width: 200, height: 100 });
	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: 1_900 }, ScrollType.Immediate);
	const events: EditorViewportChangeReason[] = [];
	using listener = viewport.onDidChange(change => events.push(change.reason));
	const end = model.positionAt(model.createVersionedSnapshot().length);

	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(0), end),
		text: "a\nb",
	}]);

	assert.deepEqual({
		layout: viewport.layout,
		events,
	}, {
		layout: {
			lineHeight: 20,
			viewportSize: { width: 200, height: 100 },
			contentSize: { width: 200, height: 100 },
			scrollPosition: { left: 0, top: 0 },
			maximumScrollPosition: { left: 0, top: 0 },
			visibleLines: {
				startLineIndex: 0,
				endLineIndexExclusive: 2,
			},
			renderLines: {
				startLineIndex: 0,
				endLineIndexExclusive: 2,
			},
			renderTop: 0,
		},
		events: [EditorViewportChangeReason.Model],
	});
});

test("Same-line model changes do not publish unchanged layout", () => {
	using model = new TextModel("abc");
	using viewport = new ViewLayout(model, {
		lineHeight: 20,
	});
	viewport.setViewportSize({ width: 100, height: 20 });
	const reasons: EditorViewportChangeReason[] = [];
	using listener = viewport.onDidChange(change => {
		reasons.push(change.reason);
	});

	model.applyEdits([{
		range: Range.fromPositions(
			model.positionAt(1),
			model.positionAt(2),
		),
		text: "X",
	}]);

	assert.deepEqual(reasons, []);
});

test("Viewport virtualizes a caller-owned visual-line source", () => {
	using model = new TextModel("one\ntwo");
	using visualLines = new MutableLineSource(5);
	using viewport = new ViewLayout(model, {
		lineHeight: 10,
		lineSource: visualLines,
	});
	viewport.setViewportSize({ width: 100, height: 20 });
	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: 30 }, ScrollType.Immediate);
	const reasons: EditorViewportChangeReason[] = [];
	using listener = viewport.onDidChange(change => reasons.push(change.reason));

	visualLines.setLineCount(8);

	assert.deepEqual({
		contentHeight: viewport.layout.contentSize.height,
		scrollTop: viewport.layout.scrollPosition.top,
		visibleLines: viewport.layout.visibleLines,
		reasons,
	}, {
		contentHeight: 80,
		scrollTop: 30,
		visibleLines: { startLineIndex: 3, endLineIndexExclusive: 5 },
		reasons: [EditorViewportChangeReason.Model],
	});
});

test("Zero-sized viewports render no lines and setters suppress no-ops", () => {
	using model = new TextModel("");
	using viewport = new ViewLayout(model, {
		lineHeight: 20,
	});
	const reasons: EditorViewportChangeReason[] = [];
	using listener = viewport.onDidChange(change => {
		reasons.push(change.reason);
	});

	viewport.setViewportSize({ width: 0, height: 0 });
	viewport.setMaxLineWidth(0);
	viewport.setScrollPosition({ scrollLeft: -10, scrollTop: -20 }, ScrollType.Immediate);

	assert.deepEqual({
		visibleLines: viewport.layout.visibleLines,
		renderLines: viewport.layout.renderLines,
		scrollPosition: viewport.layout.scrollPosition,
		reasons,
	}, {
		visibleLines: {
			startLineIndex: 0,
			endLineIndexExclusive: 0,
		},
		renderLines: {
			startLineIndex: 0,
			endLineIndexExclusive: 0,
		},
		scrollPosition: { left: 0, top: 0 },
		reasons: [],
	});
});

test('ViewLayout publishes scroll, content-size, and whitespace changes from one owner', () => {
	using model = new TextModel(lines(10));
	using viewport = new ViewLayout(model, { lineHeight: 20 });
	viewport.setViewportSize({ width: 100, height: 40 });
	viewport.setMaxLineWidth(200);
	const scrolls: Array<{ left: number; top: number; widthChanged: boolean }> = [];
	const sizes: Array<{ width: number; height: number }> = [];
	using scrollListener = viewport.onDidScroll(event => scrolls.push({
		left: event.scrollLeft,
		top: event.scrollTop,
		widthChanged: event.scrollWidthChanged,
	}));
	using sizeListener = viewport.onDidContentSizeChange(event => sizes.push({
		width: event.contentWidth,
		height: event.contentHeight,
	}));

	viewport.setOverlayWidgetsMinWidth(250);
	viewport.setScrollPosition({ scrollLeft: 20, scrollTop: 30 }, ScrollType.Immediate);
	viewport.deltaScrollNow(5, 10);
	const changedWhitespace = viewport.changeWhitespace(accessor => {
		accessor.insertWhitespace(2, 0, 15, 0);
	});

	assert.equal(changedWhitespace, true);
	const validated = viewport.validateScrollPosition({ scrollLeft: 1_000, scrollTop: -1 });
	assert.deepEqual({ scrollLeft: validated.scrollLeft, scrollTop: validated.scrollTop }, {
		scrollLeft: 150,
		scrollTop: 0,
	});
	assert.deepEqual(viewport.saveState(), {
		scrollLeft: 25,
		scrollTop: 40,
		scrollTopWithoutViewZones: 40,
	});
	assert.equal(viewport.hasPendingScrollAnimation(), false);
	assert.equal(viewport.getWhitespaces().length, 1);
	assert.deepEqual(sizes, [
		{ width: 250, height: 200 },
		{ width: 250, height: 215 },
	]);
	assert.deepEqual(scrolls.map(event => ({ left: event.left, top: event.top })), [
		{ left: 0, top: 0 },
		{ left: 20, top: 30 },
		{ left: 25, top: 40 },
		{ left: 25, top: 40 },
	]);
	const scrollable = viewport.getScrollable();
	assert.strictEqual(viewport.getScrollable(), scrollable);
	scrollable.setScrollPositionNow({ scrollLeft: 30, scrollTop: 50 });
	assert.deepEqual(viewport.layout.scrollPosition, { left: 30, top: 50 });
});

test("ViewLayout validates geometry before changing layout", () => {
	using model = new TextModel("a");

	assert.throws(
		() => new ViewLayout(model, { lineHeight: 0 }),
		/lineHeight must be positive/,
	);
	assert.throws(
		() => new ViewLayout(model, {
			lineHeight: 20,
			padding: { top: -1, bottom: 0 },
		}),
		/padding.top must be non-negative/,
	);

	using viewport = new ViewLayout(model, {
		lineHeight: 20,
	});
	assert.throws(
		() => viewport.setViewportSize({
			width: Number.NaN,
			height: 100,
		}),
		/viewportSize.width must be finite/,
	);
	assert.throws(
		() => viewport.setMaxLineWidth(-1),
		/contentWidth must be non-negative/,
	);
	viewport.setScrollPosition({ scrollLeft: 0, scrollTop: Number.POSITIVE_INFINITY }, ScrollType.Immediate);
	assert.deepEqual(viewport.layout.scrollPosition, { left: 0, top: 20 });
	assert.deepEqual(viewport.layout.viewportSize, {
		width: 0,
		height: 0,
	});
});

test("Viewport disposal releases its listener without owning the model", () => {
	using model = new TextModel("a");
	using viewport = new ViewLayout(model, {
		lineHeight: 20,
	});
	let viewportChangeCount = 0;
	using listener = viewport.onDidChange(() => {
		viewportChangeCount++;
	});

	viewport.dispose();
	model.applyEdits([{
		range: Range.fromPositions(
			model.positionAt(1),
			model.positionAt(1),
		),
		text: "b",
	}]);

	assert.deepEqual({
		modelVersion: model.version,
		viewportChangeCount,
	}, {
		modelVersion: 2,
		viewportChangeCount: 0,
	});
});

function lines(count: number): string {
	return Array.from({ length: count }, (_, index) =>
		`line ${index}`).join("\n");
}

class MutableLineSource implements EditorViewportLineSource, Disposable {
	private readonly changeEmitter = new Emitter<void>();
	private _lineCount: number;

	constructor(lineCount: number) {
		this._lineCount = lineCount;
	}

	get lineCount(): number {
		return this._lineCount;
	}

	readonly onDidChange: Event<void> = this.changeEmitter.event;

	setLineCount(lineCount: number): void {
		this._lineCount = lineCount;
		this.changeEmitter.fire();
	}

	[Symbol.dispose](): void {
		this.changeEmitter.dispose();
	}
}

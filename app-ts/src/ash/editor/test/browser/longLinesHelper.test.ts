import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../base/common/lifecycle.js";
import { LineWidthIndex } from "../../browser/viewParts/viewLines/viewLines.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { type TextMeasurer } from '../../common/viewModel.js';

test("LineWidthIndex matches full scans across random transactions", () => {
	const random = seededRandom(0xA17A);
	const measurer = new WeightedTextMeasurer();
	using model = new TextModel(Array.from(
		{ length: 30 },
		(_, index) => `initial ${index}`,
	).join("\n"));
	const index = new LineWidthIndex(model, measurer);
	using listener = model.onDidChangeContent(change => {
		index.applyModelChange(change);
	});

	for (let iteration = 0; iteration < 400; iteration++) {
		const action = random();
		if (action < 0.08 && model.canUndo()) {
			model.undo();
		} else if (action < 0.12 && model.canRedo()) {
			model.redo();
		} else {
			applyRandomTransaction(model, random);
		}
		assert.equal(
			index.maximumLineWidth,
			fullScanMaximum(model, measurer),
			`maximum width diverged at iteration ${iteration}`,
		);
	}
});

test("LineWidthIndex refines large initial scans without blocking construction", () => {
	const scheduler = new ManualMeasurementScheduler();
	const measurer = new WeightedTextMeasurer();
	using model = new TextModel("a\nbbbbbbbb\ncccccccccc\nddddddddddd");
	using index = new LineWidthIndex(model, measurer, {
		initialMeasurement: {
			initialLineCount: 1,
			linesPerSlice: 2,
			schedule: callback => scheduler.schedule(callback),
		},
	});
	const maxima: number[] = [];
	using listener = index.onDidChange(() => maxima.push(index.maximumLineWidth));

	assert.equal(index.maximumLineWidth, 7);
	assert.equal(index.complete, false);
	scheduler.runNext();
	assert.equal(index.maximumLineWidth, 20);
	assert.equal(index.complete, false);
	scheduler.runNext();
	assert.equal(index.maximumLineWidth, 33);
	assert.equal(index.complete, true);
	assert.deepEqual(maxima, [20, 33]);
});

test("LineWidthIndex restarts an incomplete scan after an edit", () => {
	const scheduler = new ManualMeasurementScheduler();
	const measurer = new WeightedTextMeasurer();
	using model = new TextModel("a\nbbbbbbbb\ncccccccccc\nddddddddddd");
	using index = new LineWidthIndex(model, measurer, {
		initialMeasurement: {
			initialLineCount: 1,
			linesPerSlice: 1,
			schedule: callback => scheduler.schedule(callback),
		},
	});
	using listener = model.onDidChangeContent(change => index.applyModelChange(change));

	model.applyEdits([{
		range: Range.fromPositions(model.positionAt(0), model.positionAt(1)),
		text: "xxxxxxxx",
	}]);
	scheduler.runAll();

	assert.equal(index.complete, true);
	assert.equal(index.maximumLineWidth, fullScanMaximum(model, measurer));
});

test("LineWidthIndex bounds initial work and measures later visible lines on demand", () => {
	const scheduler = new ManualMeasurementScheduler();
	const measurer = new WeightedTextMeasurer();
	using model = new TextModel("a\nbb\nccc\ndddddddddddddddd");
	using index = new LineWidthIndex(model, measurer, {
		initialMeasurement: {
			initialLineCount: 1,
			linesPerSlice: 1,
			maximumMeasuredLineCount: 2,
			schedule: callback => scheduler.schedule(callback),
		},
	});

	scheduler.runAll();
	assert.equal(index.complete, false);
	assert.equal(index.maximumLineWidth, Math.max(
		measurer.measureLineWidth("a"),
		measurer.measureLineWidth("bb"),
	));
	index.observeLines([3]);
	assert.equal(index.maximumLineWidth, measurer.measureLineWidth("dddddddddddddddd"));
});

class ManualMeasurementScheduler {
	private readonly pending: { readonly callback: () => void; cancelled: boolean }[] = [];

	schedule(callback: () => void) {
		const entry = { callback, cancelled: false };
		this.pending.push(entry);
		return toDisposable(() => {
			entry.cancelled = true;
		});
	}

	runNext(): void {
		const entry = this.pending.shift();
		if (!entry) throw new Error("Expected one scheduled measurement slice");
		if (!entry.cancelled) entry.callback();
	}

	runAll(): void {
		while (this.pending.length > 0) this.runNext();
	}
}

class WeightedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 0;
	readonly contentLeftPadding = 0;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		let width = 0;
		for (const character of text) {
			width += character === "\t"
				? 11
				: character.codePointAt(0)! % 7 + 1;
		}
		return width;
	}
}

function fullScanMaximum(
	model: TextModel,
	measurer: TextMeasurer,
): number {
	let maximum = 0;
	for (let lineIndex = 0; lineIndex < model.lineCount; lineIndex++) {
		maximum = Math.max(
			maximum,
			measurer.measureLineWidth(model.getLineContent((lineIndex) + 1)),
		);
	}
	return maximum;
}

function applyRandomTransaction(
	model: TextModel,
	random: () => number,
): void {
	const length = model.createVersionedSnapshot().length;
	const edits = random() < 0.35 && length >= 4
		? [
			randomEdit(model, random, 0, Math.floor(length / 2)),
			randomEdit(
				model,
				random,
				Math.floor(length / 2) + 1,
				length,
			),
		]
		: [randomEdit(model, random, 0, length)];
	model.applyEdits(edits);
}

function randomEdit(
	model: TextModel,
	random: () => number,
	minimumOffset: number,
	maximumOffset: number,
): {
	readonly range: Range;
	readonly text: string;
} {
	const first = randomInteger(
		random,
		minimumOffset,
		maximumOffset,
	);
	const second = randomInteger(
		random,
		minimumOffset,
		maximumOffset,
	);
	const startOffset = Math.min(first, second);
	const endOffset = Math.max(first, second);
	return {
		range: Range.fromPositions(
			model.positionAt(startOffset),
			model.positionAt(endOffset),
		),
		text: randomText(random),
	};
}

function randomText(random: () => number): string {
	const alphabet = "abcXYZ09 \t\n";
	const length = randomInteger(random, 0, 12);
	let result = "";
	for (let index = 0; index < length; index++) {
		result += alphabet[randomInteger(random, 0, alphabet.length - 1)];
	}
	return result;
}

function randomInteger(
	random: () => number,
	minimum: number,
	maximum: number,
): number {
	return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

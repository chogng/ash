import assert from "node:assert/strict";
import { test } from "mocha";
import { Position } from "../../common/core/position.js";
import { TextModel } from "../../common/model/textModel.js";
import { EditorVisualLineProjection } from "../../common/viewModel/modelLineProjection.js";
import { hitTestStanzaVisualEditorPoint, EditorHitTargetKind } from "../../common/viewModel/pointerHitTest.js";
import { ModelLineProjectionData } from "../../common/modelLineProjectionData.js";
import { type TextMeasurer } from '../../common/viewModel.js';

test("visual hit testing maps wrapped visual coordinates back to logical UTF-16 positions", () => {
	using model = new TextModel("abcdef\ngh");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[2, 4, 6], [2]]);
	const layout = {
		lineHeight: 20,
		viewportSize: { width: 200, height: 80 },
		scrollPosition: { left: 0, top: 0 },
	};
	const metrics = { gutterWidth: 30, textLeft: 40 };
	const measurer = new FixedTextMeasurer();

	assert.deepEqual(hitTestStanzaVisualEditorPoint(model, projection, layout, { left: 52, top: 25 }, metrics, measurer), {
		kind: EditorHitTargetKind.Text,
		position: new Position((0) + 1, (3) + 1),
		viewPosition: new Position(2, 2),
		injectedText: null,
	});
	assert.deepEqual(hitTestStanzaVisualEditorPoint(model, projection, layout, { left: 100, top: 45 }, metrics, measurer), {
		kind: EditorHitTargetKind.EmptyContent,
		position: new Position((0) + 1, (6) + 1),
		viewPosition: new Position(3, 3),
		injectedText: null,
	});
	assert.deepEqual(hitTestStanzaVisualEditorPoint(model, projection, layout, { left: 10, top: 65 }, metrics, measurer), {
		kind: EditorHitTargetKind.Gutter,
		position: new Position((1) + 1, (0) + 1),
	});
});

test("visual hit testing treats wrapped continuation indentation as empty content", () => {
	using model = new TextModel("abcdef");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[2, 4, 6]], [20]);
	const layout = {
		lineHeight: 20,
		viewportSize: { width: 200, height: 60 },
		scrollPosition: { left: 0, top: 0 },
	};
	const metrics = { gutterWidth: 30, textLeft: 40 };
	const measurer = new FixedTextMeasurer();

	assert.deepEqual(hitTestStanzaVisualEditorPoint(model, projection, layout, { left: 55, top: 25 }, metrics, measurer), {
		kind: EditorHitTargetKind.EmptyContent,
		position: new Position((0) + 1, (2) + 1),
		viewPosition: new Position(2, 1),
		injectedText: null,
	});
	assert.deepEqual(hitTestStanzaVisualEditorPoint(model, projection, layout, { left: 66, top: 25 }, metrics, measurer), {
		kind: EditorHitTargetKind.Text,
		position: new Position((0) + 1, (3) + 1),
		viewPosition: new Position(2, 2),
		injectedText: null,
	});
});

test("visual hit testing identifies injected text and preserves attached data", () => {
	using model = new TextModel("abc");
	const marker = Object.freeze({ kind: 'marker' });
	const projection = EditorVisualLineProjection.fromLineBreakData(model, [new ModelLineProjectionData(
		[1],
		[{ content: 'X', inlineClassName: 'injected', attachedData: marker }],
		[4],
		[],
		0,
	)], 10);
	const result = hitTestStanzaVisualEditorPoint(
		model,
		projection,
		{ lineHeight: 20, viewportSize: { width: 200, height: 20 }, scrollPosition: { left: 0, top: 0 } },
		{ left: 50, top: 5 },
		{ gutterWidth: 30, textLeft: 40 },
		new FixedTextMeasurer(),
	);

	assert.equal(result?.kind, EditorHitTargetKind.Text);
	assert.deepEqual(result?.position, new Position(1, 2));
	assert.deepEqual(result?.viewPosition, new Position(1, 2));
	assert.equal(result?.injectedText?.options.attachedData, marker);
});

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 0;
	readonly contentLeftPadding = 0;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return text.length * 10;
	}
}

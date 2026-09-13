import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	AnchorAlignment,
	AnchorAxisAlignment,
	AnchorPosition,
	layout2d,
} from "../../common/layout.js";

const viewport = { left: 0, top: 0, width: 800, height: 600 };
const view = { width: 200, height: 120 };

test("layout2d uses the requested side and alignment when they fit", () => {
	const result = layout2d(
		viewport,
		view,
		{ left: 100, top: 100, width: 80, height: 30 },
		{ gap: 4 },
	);

	assert.equal(result.left, 100);
	assert.equal(result.top, 134);
	assert.equal(result.anchorAlignment, AnchorAlignment.Left);
	assert.equal(result.anchorPosition, AnchorPosition.Below);
});

test("layout2d flips above when there is no room below", () => {
	const result = layout2d(
		viewport,
		view,
		{ left: 100, top: 550, width: 80, height: 30 },
		{ gap: 4 },
	);

	assert.equal(result.top, 426);
	assert.equal(result.anchorPosition, AnchorPosition.Above);
});

test("layout2d flips cross-axis alignment before clamping", () => {
	const result = layout2d(
		viewport,
		view,
		{ left: 750, top: 100, width: 40, height: 30 },
	);

	assert.equal(result.left, 590);
	assert.equal(result.anchorAlignment, AnchorAlignment.Right);
});

test("layout2d respects a non-zero visual viewport origin", () => {
	const result = layout2d(
		{ left: 30, top: 20, width: 300, height: 200 },
		{ width: 400, height: 260 },
		{ left: 100, top: 80, width: 40, height: 20 },
	);

	assert.equal(result.left, 30);
	assert.equal(result.top, 20);
});

test("layout2d supports horizontal anchored views", () => {
	const result = layout2d(
		viewport,
		{ width: 160, height: 100 },
		{ left: 700, top: 200, width: 80, height: 40 },
		{
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			anchorPosition: AnchorPosition.Below,
			anchorAlignment: AnchorAlignment.Left,
			gap: 8,
		},
	);

	assert.equal(result.left, 532);
	assert.equal(result.top, 200);
	assert.equal(result.anchorPosition, AnchorPosition.Above);
});

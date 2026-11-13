import assert from 'node:assert/strict';
import { test } from 'mocha';
import { canvasBounds, cubicBezierPoint, toCanvasLocal } from '../../common/canvasGeometry.js';

const close = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('Canvas geometry converts a rotated world corner to frame-local coordinates', () => {
	const point = toCanvasLocal({ x: 10, y: 20, width: 40, height: 20, rotation: 90 }, { x: 40, y: 10 });
	close(point.x, 0);
	close(point.y, 0);
});

test('Canvas geometry encloses rotated frames and preserves the empty-surface bounds', () => {
	const bounds = canvasBounds([{ x: 0, y: 0, width: 40, height: 20, rotation: 90 }]);
	close(bounds.x, 10);
	close(bounds.y, -10);
	close(bounds.width, 20);
	close(bounds.height, 40);
	assert.deepEqual(canvasBounds([]), { x: 0, y: 0, width: 1, height: 1 });
});

test('Canvas cubic sampling preserves endpoints and the curve midpoint', () => {
	const start = { x: 0, y: 0 }, outgoing = { x: 0, y: 10 }, incoming = { x: 10, y: 10 }, end = { x: 10, y: 0 };
	assert.deepEqual(cubicBezierPoint(start, outgoing, incoming, end, 0), start);
	assert.deepEqual(cubicBezierPoint(start, outgoing, incoming, end, 1), end);
	assert.deepEqual(cubicBezierPoint(start, outgoing, incoming, end, .5), { x: 5, y: 7.5 });
});

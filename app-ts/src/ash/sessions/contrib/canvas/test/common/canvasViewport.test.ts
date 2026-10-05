import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CanvasViewport } from '../../common/canvasViewport.js';

test('Canvas viewport keeps a fractional world point fixed across pan and zoom', () => {
	const camera = new CanvasViewport();
	camera.panBy(123.5, -77.25);
	const point = { x: 211.25, y: 33.5 };
	const world = camera.toWorld(point);
	camera.zoomAt(point, 2);
	assert.deepEqual(camera.toWorld(point), world);
	camera.zoomAt(point, 100);
	assert.equal(camera.scale, 4);
	camera.zoomAt(point, 0.0001);
	assert.equal(camera.scale, 0.2);
	camera.reset();
	assert.deepEqual(camera.toWorld(point), point);
});

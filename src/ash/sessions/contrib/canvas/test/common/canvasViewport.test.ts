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

test('Canvas viewport frames content with editor padding without magnifying small content', () => {
	const viewport = new CanvasViewport();
	viewport.fitBounds({ x: 100, y: 50, width: 200, height: 100 }, 400, 300, { x: 20, y: 30 });
	assert.equal(viewport.scale, 1);
	assert.deepEqual(viewport.toWorld({ x: 200, y: 150 }), { x: 200, y: 100 });
	viewport.fitBounds({ x: -100, y: -50, width: 2000, height: 1000 }, 500, 400, { x: 50, y: 50 });
	assert.equal(viewport.scale, .2);
	assert.deepEqual(viewport.toWorld({ x: 250, y: 200 }), { x: 900, y: 450 });
	assert.equal(2000 * viewport.scale, 400);
	viewport.fitBounds({ x: 0, y: 0, width: 10000, height: 10000 }, 500, 400, { x: 50, y: 50 });
	assert.equal(viewport.scale, .2);
});

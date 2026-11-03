import assert from 'node:assert/strict';
import { test } from 'mocha';
import { avoidWindowControlsOverlay } from '../../browser/ui/contextview/windowControlsOverlay.js';

test('window controls leave clear views and unavailable browser geometry unchanged', () => {
	const viewport = { left: 0, top: 0, width: 900, height: 500 };
	const view = { width: 180, height: 120 };
	const position = { left: 240, top: 4 };
	for (const rect of [undefined, { x: 90, y: 0, width: 700, height: 36 },
		{ x: 0, y: 0, width: 0, height: 0 }, { x: NaN, y: 0, width: 700, height: 36 }]) {
		assert.equal(avoidWindowControlsOverlay(rect, viewport, view, position), position);
	}
});

test('window controls prefer moving down, then sideways, while keeping tall views accessible', () => {
	const rect = { x: 90, y: 0, width: 700, height: 36 };
	const viewport = { left: 0, top: 0, width: 900, height: 500 };
	assert.deepEqual(avoidWindowControlsOverlay(rect, viewport, { width: 180, height: 120 }, { left: 0, top: 4 }), { left: 0, top: 36 });
	assert.deepEqual(avoidWindowControlsOverlay(rect, viewport, { width: 180, height: 480 }, { left: 0, top: 4 }), { left: 90, top: 4 });
	assert.deepEqual(avoidWindowControlsOverlay(rect, viewport, { width: 180, height: 480 }, { left: 720, top: 4 }), { left: 610, top: 4 });
	assert.deepEqual(avoidWindowControlsOverlay(rect, viewport, { width: 900, height: 480 }, { left: 0, top: 4 }), { left: 0, top: 20 });
	assert.deepEqual(avoidWindowControlsOverlay(rect, viewport, { width: 900, height: 600 }, { left: 0, top: 0 }), { left: 0, top: 0 });
});

test('window controls geometry uses the supplied viewport origin and ignores nonintersecting bands', () => {
	const viewport = { left: 200, top: 300, width: 900, height: 500 };
	const view = { width: 180, height: 120 };
	const position = { left: 200, top: 304 };
	assert.deepEqual(avoidWindowControlsOverlay({ x: 90, y: 0, width: 700, height: 36 }, viewport, view, position), { left: 200, top: 336 });
	assert.equal(avoidWindowControlsOverlay({ x: 90, y: -80, width: 700, height: 36 }, viewport, view, position), position);
});

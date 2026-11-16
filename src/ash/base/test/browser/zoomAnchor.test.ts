import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ZoomAnchor } from '../../browser/ui/zoom/zoomAnchor.js';

suite('Zoom anchor geometry', () => {
	test('centers fitted content and preserves its midpoint when it grows past the viewport', () => {
		const axis = new ZoomAnchor({ viewport: 300, scroll: 0, size: 100, insetStart: 12, insetEnd: 12 });
		axis.zoomAround(150, 200);
		assert.deepEqual({ position: axis.position, translation: axis.translation, scroll: axis.scrollPosition }, { position: 50, translation: -50, scroll: 0 });
		axis.zoomAround(150, 400);
		assert.equal(axis.position + 400 / 2, 150);
		assert.equal(axis.scrollPosition, 62);
	});

	test('restores the same content point and scroll position after zooming in and out', () => {
		const axis = new ZoomAnchor({ viewport: 300, scroll: 100, size: 600, insetStart: 12, insetEnd: 12 });
		const point = (200 - axis.position) / 600;
		axis.zoomAround(200, 1200);
		assert.equal(axis.position + point * 1200, 200);
		axis.zoomAround(200, 600);
		assert.equal(axis.position + point * 600, 200);
		assert.equal(axis.scrollPosition, 100);
		assert.equal(axis.translation, 0);
	});

	test('retains edge insets when the pointer falls beyond the content', () => {
		const start = new ZoomAnchor({ viewport: 300, scroll: 0, size: 300, insetStart: 12, insetEnd: 12 });
		start.zoomAround(-100, 600);
		assert.equal(start.position, 12);
		assert.equal(start.scrollPosition, 0);
		const end = new ZoomAnchor({ viewport: 300, scroll: 24, size: 300, insetStart: 12, insetEnd: 12 });
		end.zoomAround(400, 600);
		assert.equal(end.position + 600 + 12, 300);
		assert.equal(end.scrollPosition, 324);
	});
});

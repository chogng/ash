import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { getPermissionGuidePosition } from '../../electron-main/screenPermissionGuideWindow.js';

suite('Screen permission companion placement', () => {
	const size = { width: 360, height: 168 };
	const area = { x: 0, y: 0, width: 1440, height: 1000 };

	test('places the card directly below the recording list controls inside Settings', () => {
		assert.deepEqual(getPermissionGuidePosition({ x: 386, y: 161, width: 740, height: 625 }, size, area,
			{ x: 638, y: 266.5, width: 468, height: 224.5 }), { x: 638, y: 499 });
	});

	test('uses a free edge when the controls are offscreen or leave no room below', () => {
		assert.deepEqual(getPermissionGuidePosition({ x: 100, y: 400, width: 800, height: 500 }, size, area,
			{ x: 300, y: 800, width: 500, height: 100 }), { x: 908, y: 732 });
	});

	test('keeps following visible controls after the top of their list scrolls away', () => {
		assert.deepEqual(getPermissionGuidePosition({ x: 386, y: 161, width: 740, height: 625 }, size, area,
			{ x: 638, y: 100, width: 468, height: 350 }), { x: 638, y: 458 });
	});

	test('uses free space below Settings before either side', () => {
		assert.deepEqual(getPermissionGuidePosition({ x: 100, y: 100, width: 800, height: 500 }, size, area), { x: 320, y: 608 });
	});

	test('uses either free side when the bottom edge is full', () => {
		assert.deepEqual(getPermissionGuidePosition({ x: 100, y: 400, width: 800, height: 500 }, size, area), { x: 908, y: 732 });
		assert.deepEqual(getPermissionGuidePosition({ x: 500, y: 400, width: 800, height: 500 }, size, area), { x: 132, y: 732 });
	});

	test('keeps the card visible above or near the sidebar when no lower edge fits', () => {
		assert.deepEqual(getPermissionGuidePosition({ x: 100, y: 300, width: 1240, height: 650 }, size, area), { x: 540, y: 124 });
		assert.deepEqual(getPermissionGuidePosition(area, size, area), { x: 0, y: 832 });
	});

	test('uses the Settings display coordinates, including negative origins', () => {
		assert.deepEqual(getPermissionGuidePosition({ x: -1800, y: -1000, width: 800, height: 500 }, size, { x: -1920, y: -1080, width: 1920, height: 1080 }), { x: -1580, y: -492 });
	});
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { PointerHandler } from '../../../browser/controller/pointerHandler.js';

test('PointerHandler retains precise pointer coordinates and mouse click count', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const element = dom.window.document.querySelector<HTMLElement>('main')!;
	using handler = new PointerHandler(element);
	const downs: Array<{ readonly pointerId: number; readonly count: number; readonly x: number; readonly y: number; }> = [];
	using listener = handler.onDidPointerDown(({ event, pointerId }) => {
		downs.push({ pointerId, count: event.detail, x: event.pos.x, y: event.pos.y });
		event.preventDefault();
	});

	element.dispatchEvent(Object.assign(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, detail: 0, clientX: 12.75, clientY: 18.5 }), {
		pointerId: 7,
		pointerType: 'mouse',
	}));
	assert.deepEqual(downs, []);
	const mouseDown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2, clientX: 12, clientY: 18 });
	element.dispatchEvent(mouseDown);
	assert.deepEqual(downs, [{ pointerId: 7, count: 2, x: 12.75, y: 18.5 }]);
	assert.equal(mouseDown.defaultPrevented, true);

	element.dispatchEvent(Object.assign(new dom.window.MouseEvent('pointerdown', { bubbles: true, detail: 0 }), {
		pointerId: 8,
		pointerType: 'touch',
	}));
	assert.deepEqual(downs, [{ pointerId: 7, count: 2, x: 12.75, y: 18.5 }, { pointerId: 8, count: 1, x: 0, y: 0 }]);

	element.dispatchEvent(Object.assign(new dom.window.MouseEvent('pointerdown', { bubbles: true }), {
		pointerId: 9,
		pointerType: 'mouse',
	}));
	element.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
	element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, detail: 3 }));
	assert.equal(downs.length, 2);
	handler.dispose();
	element.dispatchEvent(Object.assign(new dom.window.MouseEvent('pointerdown', { bubbles: true }), {
		pointerId: 10,
		pointerType: 'touch',
	}));
	assert.equal(downs.length, 2);
	dom.window.close();
});

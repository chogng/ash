import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { PointerHandler } from '../../../browser/controller/pointerHandler.js';

test('PointerHandler uses mouse click count while retaining the pointer identity', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const element = dom.window.document.querySelector<HTMLElement>('main')!;
	using handler = new PointerHandler(element);
	const downs: Array<{ readonly pointerId: number; readonly count: number }> = [];
	using listener = handler.onDidPointerDown(({ event, pointerId }) => downs.push({ pointerId, count: event.detail }));

	element.dispatchEvent(Object.assign(new dom.window.MouseEvent('pointerdown', { bubbles: true, detail: 0 }), {
		pointerId: 7,
		pointerType: 'mouse',
	}));
	assert.deepEqual(downs, []);
	element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, detail: 2 }));
	assert.deepEqual(downs, [{ pointerId: 7, count: 2 }]);

	element.dispatchEvent(Object.assign(new dom.window.MouseEvent('pointerdown', { bubbles: true, detail: 0 }), {
		pointerId: 8,
		pointerType: 'touch',
	}));
	assert.deepEqual(downs, [{ pointerId: 7, count: 2 }, { pointerId: 8, count: 1 }]);

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

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { GlobalPointerMoveMonitor } from '../../browser/globalPointerMoveMonitor.js';

test('Pointer monitoring falls back to the window and stops once when the button is released', () => {
	const { window } = new JSDOM('<div></div>');
	try {
		const element = window.document.querySelector('div')!;
		element.setPointerCapture = () => { throw new window.DOMException('No active pointer', 'NotFoundError'); };
		using monitor = new GlobalPointerMoveMonitor();
		const moves: number[] = [];
		const stops: string[] = [];
		const start = () => monitor.startMonitoring(element, 7, 1, event => moves.push(event.clientX), event => {
			assert.equal(monitor.isMonitoring(), false);
			stops.push(event?.type ?? 'cancel');
		}, 'mouse');
		start();
		window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 8, buttons: 1, clientX: 20 }));
		window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 7, buttons: 1, clientX: 30 }));
		window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 7, buttons: 0, clientX: 40 }));
		window.dispatchEvent(new window.MouseEvent('mouseup', { button: 0 }));
		assert.deepEqual(moves, [30]);
		assert.deepEqual(stops, ['pointermove']);

		start();
		window.dispatchEvent(new window.MouseEvent('mouseup', { button: 2, buttons: 1 }));
		assert.equal(monitor.isMonitoring(), true);
		window.dispatchEvent(new window.MouseEvent('mouseup', { button: 0 }));
		window.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 7 }));
		assert.deepEqual(stops, ['pointermove', 'mouseup']);
	} finally {
		window.close();
	}
});

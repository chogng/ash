import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { EventType, Gesture } from '../../browser/touch.js';
import { addDisposableListener, stopEvent } from '../../browser/dom.js';
import { DisposableStore } from '../../common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

suite('Gesture', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tap recognition chooses the nearest registered target and releases duplicate registrations', () => {
		const dom = new JSDOM('<body><div><button>Tap</button></div></body>');
		try {
			using resources = new DisposableStore();
			const parent = dom.window.document.querySelector('div')!;
			const child = dom.window.document.querySelector('button')!;
			resources.add(Gesture.addTarget(parent));
			const first = resources.add(Gesture.addTarget(child));
			const second = resources.add(Gesture.addTarget(child));
			const targets: EventTarget[] = [];
			resources.add(addDisposableListener(parent, EventType.Tap, event => { targets.push(event.target!); stopEvent(event); }));
			const tap = (): void => {
				child.dispatchEvent(new dom.window.PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true, cancelable: true }));
				child.dispatchEvent(new dom.window.PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true, cancelable: true }));
			};
			tap();
			first.dispose();
			tap();
			second.dispose();
			tap();
			assert.deepEqual(targets, [child, child, parent]);
			resources.dispose();
			const down = new dom.window.PointerEvent('pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true, cancelable: true });
			child.dispatchEvent(down);
			assert.equal(down.defaultPrevented, false);
		} finally {
			dom.window.close();
		}
	});

	test('tap recognition rejects dragging and cancellation and isolates documents', () => {
		const first = new JSDOM('<body><button>First</button></body>');
		const second = new JSDOM('<body><button>Second</button></body>');
		try {
			using resources = new DisposableStore();
			const targets = [first.window.document.querySelector('button')!, second.window.document.querySelector('button')!];
			const taps: string[] = [];
			for (const target of targets) {
				resources.add(Gesture.addTarget(target));
				resources.add(addDisposableListener(target, EventType.Tap, () => taps.push(target.textContent!)));
			}
			const dispatch = (dom: JSDOM, target: HTMLElement, type: string, x = 0): void => {
				target.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, pointerType: 'pen', isPrimary: true, button: 0, clientX: x, bubbles: true, cancelable: true }));
			};
			dispatch(first, targets[0]!, 'pointerdown');
			dispatch(first, targets[0]!, 'pointermove', 30);
			dispatch(first, targets[0]!, 'pointerup', 30);
			dispatch(first, targets[0]!, 'pointerdown');
			dispatch(first, targets[0]!, 'pointercancel');
			dispatch(first, targets[0]!, 'pointerup');
			dispatch(first, targets[0]!, 'pointerdown');
			dispatch(second, targets[1]!, 'pointerdown');
			dispatch(second, targets[1]!, 'pointerup');
			dispatch(first, targets[0]!, 'pointerup');
			assert.deepEqual(taps, ['Second', 'First']);
		} finally {
			first.window.close();
			second.window.close();
		}
	});
});

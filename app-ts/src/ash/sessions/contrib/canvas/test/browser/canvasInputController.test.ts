import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CanvasInputController, CanvasPointerAction, type CanvasInputParticipant } from '../../browser/canvasInputController.js';
import { CanvasViewport } from '../../common/canvasViewport.js';

ensureNoDisposablesAreLeakedInTestSuite();

function createInputFixture() {
	const browser = new JSDOM('<!doctype html><body><div></div></body>');
	const domNode = browser.window.document.querySelector('div')!;
	let captured: number | undefined;
	const calls: string[] = [];
	domNode.setPointerCapture = id => { captured = id; };
	domNode.hasPointerCapture = id => captured === id;
	domNode.releasePointerCapture = id => {
		captured = undefined;
		domNode.dispatchEvent(new browser.window.PointerEvent('lostpointercapture', { pointerId: id }));
	};
	const participant: CanvasInputParticipant = {
		begin: () => CanvasPointerAction.Edit,
		update: input => { calls.push(`update:${input.world.x},${input.world.y}`); },
		end: () => { calls.push('end'); },
		cancel: () => { calls.push('cancel'); },
		canNavigate: () => true,
	};
	const viewport = new CanvasViewport();
	viewport.panBy(10, 20);
	viewport.zoomAt({ x: 10, y: 20 }, 2);
	const input = new CanvasInputController({ domNode, focus: () => domNode.focus(), applyTransform: () => {} }, viewport, participant);
	return {
		input, calls,
		fire(type: string, pointerId = 1): void {
			domNode.dispatchEvent(new browser.window.PointerEvent(type, { pointerId, button: 0, isPrimary: true, clientX: 50, clientY: 60, cancelable: true }));
		},
		dispose: toDisposable(() => { input.dispose(); browser.window.close(); }),
	};
}

test('Canvas completes the captured edit once and ignores other pointers and capture release', () => {
	const fixture = createInputFixture();
	using cleanup = fixture.dispose;
	fixture.fire('pointerdown');
	fixture.fire('pointermove', 2);
	fixture.fire('pointerup', 2);
	assert.equal(fixture.input.isGesturing, true);
	fixture.fire('pointermove');
	fixture.fire('pointerup');
	assert.deepEqual({ calls: fixture.calls, active: fixture.input.isGesturing }, { calls: ['update:20,20', 'end'], active: false });
});

test('Canvas cancels captured editing and removes input listeners on disposal', () => {
	const fixture = createInputFixture();
	using cleanup = fixture.dispose;
	fixture.fire('pointerdown');
	fixture.fire('pointercancel');
	fixture.fire('pointerup');
	assert.deepEqual({ calls: fixture.calls, active: fixture.input.isGesturing }, { calls: ['cancel'], active: false });
	fixture.fire('pointerdown');
	fixture.input.dispose();
	fixture.fire('pointermove');
	fixture.fire('pointerup');
	assert.deepEqual({ calls: fixture.calls, active: fixture.input.isGesturing }, { calls: ['cancel', 'cancel'], active: false });
});

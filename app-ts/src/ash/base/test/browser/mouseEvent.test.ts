import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	PointerEvent: browserEnvironment.window.MouseEvent,
	WheelEvent: browserEnvironment.window.WheelEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const {
	StandardMouseEvent,
	StandardPointerEvent,
	StandardWheelEvent,
} = await import("../../browser/mouseEvent.js");

test("StandardMouseEvent exposes stable coordinates and event controls", () => {
	const event = new browserEnvironment.window.MouseEvent("dblclick", {
		bubbles: true,
		button: 0,
		buttons: 1,
		cancelable: true,
		clientX: 12,
		clientY: 34,
		ctrlKey: true,
	});
	const standard = new StandardMouseEvent(event);

	assert.equal(standard.button, 0);
	assert.equal(standard.leftButton, true);
	assert.equal(standard.buttons, 1);
	assert.equal(standard.detail, 2);
	assert.equal(standard.clientX, 12);
	assert.equal(standard.clientY, 34);
	assert.equal(standard.pageX, 12);
	assert.equal(standard.pageY, 34);
	assert.equal(standard.ctrlKey, true);
	standard.preventDefault();
	assert.equal(standard.defaultPrevented, true);
});

test("StandardPointerEvent supplies mouse-compatible pointer defaults", () => {
	const event = new browserEnvironment.window.MouseEvent("pointermove", {
		button: 0,
		buttons: 1,
		clientX: 8,
	});
	const standard = new StandardPointerEvent(
		event as unknown as PointerEvent,
	);

	assert.equal(standard.pointerId, 0);
	assert.equal(standard.pointerType, "mouse");
	assert.equal(standard.pressure, 0.5);
	assert.equal(standard.isPrimary, true);
	assert.equal(standard.width, 1);
	assert.equal(standard.clientX, 8);
});

test("StandardWheelEvent normalizes pixel, line, and page deltas", () => {
	const pixel = new StandardWheelEvent(wheelEvent({
		deltaX: 3,
		deltaY: 7,
		deltaMode: 0,
	}));
	const line = new StandardWheelEvent(wheelEvent({
		deltaX: 2,
		deltaY: -3,
		deltaMode: 1,
	}), {
		lineHeight: 20,
	});
	const page = new StandardWheelEvent(wheelEvent({
		deltaX: 1,
		deltaY: 2,
		deltaMode: 2,
	}), {
		pageWidth: 300,
		pageHeight: 200,
	});

	assert.deepEqual(
		[pixel.deltaX, pixel.deltaY],
		[3, 7],
	);
	assert.deepEqual(
		[line.deltaX, line.deltaY],
		[40, -60],
	);
	assert.deepEqual(
		[page.deltaX, page.deltaY],
		[300, 400],
	);
});

test("StandardWheelEvent stop prevents the native default", () => {
	const event = wheelEvent({ deltaY: 1 });
	const standard = new StandardWheelEvent(event);

	standard.stop();

	assert.equal(event.defaultPrevented, true);
});

function wheelEvent(
	options: WheelEventInit,
): WheelEvent {
	return new browserEnvironment.window.WheelEvent("wheel", {
		bubbles: true,
		cancelable: true,
		...options,
	}) as unknown as WheelEvent;
}

import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DragAndDropObserver } from "../../browser/dnd.js";
import { h } from "../../browser/dom.js";

test("DragAndDropObserver normalizes nested targets and enables the native drop", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const target = h(dom.window.document, "div");
	const child = h(dom.window.document, "span");
	target.append(child);
	const events: string[] = [];
	const observer = new DragAndDropObserver(target, {
		onDragStart: () => events.push("start"),
		onDragEnter: () => events.push("enter"),
		onDragOver: (_event, duration) => {
			assert.ok(duration >= 0);
			events.push("over");
		},
		onDragLeave: () => events.push("leave"),
		onDrop: () => events.push("drop"),
		onDragEnd: () => events.push("end"),
	});
	dom.window.document.body.append(target);

	target.dispatchEvent(dragEvent(dom.window, "dragstart"));
	child.dispatchEvent(dragEvent(dom.window, "dragenter"));
	child.dispatchEvent(dragEvent(dom.window, "dragenter"));
	const dragOver = dragEvent(dom.window, "dragover");
	child.dispatchEvent(dragOver);
	child.dispatchEvent(dragEvent(dom.window, "dragleave"));
	child.dispatchEvent(dragEvent(dom.window, "dragleave"));
	target.dispatchEvent(dragEvent(dom.window, "drop"));
	target.dispatchEvent(dragEvent(dom.window, "dragend"));

	assert.equal(dragOver.defaultPrevented, true);
	assert.deepEqual(events, ["start", "enter", "over", "leave", "drop", "end"]);
	observer.dispose();
	dom.window.close();
});

function dragEvent(targetWindow: { readonly Event: typeof Event }, type: string): DragEvent {
	return new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
}

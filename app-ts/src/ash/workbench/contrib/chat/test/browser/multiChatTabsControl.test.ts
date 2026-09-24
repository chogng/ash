import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { ChatTabsDelegate } from "../../browser/view/chatTabsControl.js";
import { MultiChatTabsControl } from "../../browser/view/multiChatTabsControl.js";

test("MultiChatTabsControl moves the dragged tab through its delegate", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const moves: Array<{ source: string; target: string | undefined; position: string }> = [];
	const control = new MultiChatTabsControl(dom.window.document.body, "chat", {
		selectTab: () => undefined,
		closeTab: () => undefined,
		moveTab: (source, target, position) => moves.push({ source, target, position }),
	} satisfies ChatTabsDelegate, "pane-title");
	control.setTabs([
		{ id: "first", label: "First", panelId: "first-panel" },
		{ id: "second", label: "Second", panelId: "second-panel" },
	], "first");
	dom.window.document.body.append(control.element);
	const [first, second] = control.element.querySelectorAll<HTMLElement>(".ash-tab");
	assert.ok(first);
	assert.ok(second);
	Object.defineProperty(second, "getBoundingClientRect", {
		value: () => ({ left: 100, width: 100 }),
	});

	first.dispatchEvent(dragEvent(dom.window, "dragstart"));
	second.dispatchEvent(dragEvent(dom.window, "dragover", 175));
	second.dispatchEvent(dragEvent(dom.window, "drop", 175));

	assert.deepEqual(moves, [{ source: "first", target: "second", position: "after" }]);
	control.dispose();
	dom.window.close();
});

function dragEvent(targetWindow: { readonly Event: typeof Event }, type: string, clientX = 0): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "clientX", { value: clientX });
	return event;
}

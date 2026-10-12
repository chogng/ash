import '../../../../../editor/test/browser/testEditorDom.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { setNlsResolver, resetNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { ChatTabsDelegate } from "../../browser/widgetHosts/viewPane/chatTabsControl.js";
import { MultiChatTabsControl } from "../../browser/widgetHosts/viewPane/multiChatTabsControl.js";

test("MultiChatTabsControl moves the dragged tab through its delegate", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const moves: Array<{ source: string; target: string | undefined; position: string; }> = [];
	using services = createTestEditorServices();
	const control = services.createInstance(MultiChatTabsControl, dom.window.document.body, "chat", {
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

function dragEvent(targetWindow: { readonly Event: typeof Event; }, type: string, clientX = 0): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "clientX", { value: clientX });
	return event;
}


test('Chat tab row uses the client language for its accessible name', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
		using services = createTestEditorServices();
		using control = services.createInstance(MultiChatTabsControl, dom.window.document.body, 'chat', {
			selectTab: () => { }, closeTab: () => { }, moveTab: () => { },
		}, 'pane-title');
		assert.equal(control.element.querySelector('[role="tablist"]')!.getAttribute('aria-label'), '打开的聊天');
	} finally {
		resetNlsResolver();
		dom.window.close();
	}
});

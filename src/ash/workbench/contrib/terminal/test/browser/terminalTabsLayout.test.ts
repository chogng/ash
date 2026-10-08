import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { ITerminalInstance, ITerminalService } from '../../browser/terminal.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	MouseEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { TerminalTabbedView } = await import("../../../../../workbench/contrib/terminal/browser/terminalTabbedView.js");

suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"]) {
		Reflect.deleteProperty(globalThis, name);
	}
});

test("Terminal instance list sash resizes the right column within its bounds", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const parent = h(dom.window.document, 'main');
	using changed = new Emitter<void>();
	const createInstance = (id: string): ITerminalInstance => ({
		...Disposable.None, id, dirId: 'folder', processId: 1, initialCwd: '/folder', title: id,
		profile: { profileId: 'shell', title: 'Shell', isDefault: true }, state: 'running', exitCode: undefined,
		onDidWriteData: Event.None, onDidChangeCommandStatus: Event.None, onDidExit: Event.None, onDidChangeState: Event.None,
		xterm: undefined, xtermReadyPromise: Promise.resolve(undefined), getContribution: () => null, attachToElement() { }, detachFromElement() { }, async sendText() { }, processBinary: async () => { }, resize() { }, close: async () => { },
	});
	const instances = [createInstance('one'), createInstance('two')];
	const terminals: ITerminalService = {
		...Disposable.None, instances, activeInstance: instances[0], onDidCreateInstance: Event.None,
		onDidDisposeInstance: Event.None, onDidChangeInstances: changed.event, onDidChangeActiveInstance: Event.None,
		getProfiles: async () => [], createTerminal: async () => { throw new Error('Unexpected creation'); },
		relaunchTerminal: async () => { }, setActiveInstance() { }, moveTerminal() { }, closeTerminal: async () => { },
	};
	using layout = new TerminalTabbedView(parent, terminals);
	const tabs = layout.element.querySelector<HTMLElement>('.ash-terminal-tabs')!;
	dom.window.document.body.append(layout.element);
	layout.layout(1_000, 200);
	const panes = layout.element.querySelectorAll<HTMLElement>(":scope > .ash-split-view-pane");
	const sash = layout.element.querySelector<HTMLElement>(":scope > .ash-sash");
	assert.equal(panes.length, 2);
	assert.ok(sash);
	assert.equal(panes[0]?.style.width, "880px");
	assert.equal(panes[1]?.style.width, "120px");
	assert.equal(sash.getAttribute("aria-label"), "Resize terminal instance list");

	sash.dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, clientX: 880, bubbles: true }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 950, bubbles: true }));
	assert.equal(panes[1]?.style.width, "46px");
	assert.equal(tabs.classList.contains("ash-terminal-tabs-narrow"), true);
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { clientX: 950, bubbles: true }));

	sash.dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, clientX: 954, bubbles: true }));
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 930, bubbles: true }));
	assert.equal(panes[1]?.style.width, "80px");
	assert.equal(tabs.classList.contains("ash-terminal-tabs-narrow"), false);
	dom.window.dispatchEvent(new dom.window.MouseEvent("pointerup", { clientX: 930, bubbles: true }));

	for (let index = 0; index < 50; index += 1) {
		sash.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
	}
	assert.equal(panes[1]?.style.width, "500px");

	const second = instances.pop()!;
	changed.fire();
	assert.equal(panes[1]?.hidden, true);
	assert.equal(panes[0]?.style.width, "1000px");
	const hiddenSash = layout.element.querySelector<HTMLElement>(":scope > .ash-sash");
	assert.ok(hiddenSash);
	assert.equal(hiddenSash.classList.contains("ash-sash-disabled"), true);
	assert.equal(hiddenSash.getAttribute("aria-disabled"), "true");

	instances.push(second);
	changed.fire();
	assert.equal(panes[1]?.hidden, false);
	assert.equal(panes[1]?.style.width, "500px");
	assert.equal(layout.element.querySelector(":scope > .ash-sash"), hiddenSash);
	assert.equal(layout.element.querySelector(":scope > .ash-sash")?.getAttribute("aria-label"), "Resize terminal instance list");
	dom.window.close();
});

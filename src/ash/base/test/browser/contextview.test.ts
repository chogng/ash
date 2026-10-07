import assert from "node:assert/strict";
import { suiteTeardown, test } from "mocha";
import { JSDOM } from "jsdom";
import type { ContextViewHideReason as ContextViewHideReasonValue } from "../../browser/ui/contextview/contextview.js";
import { h } from "../../browser/dom.js";
import { ActionRunner, SubmenuAction } from "../../common/actions.js";
import { DisposableStore, toDisposable } from "../../common/lifecycle.js";

const environment = new JSDOM("<!doctype html><html><body><main></main><button id='anchor'>Anchor</button><button id='outside'>Outside</button></body></html>");
const previousGlobals = new Map(["window", "document", "Node"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperties(globalThis, {
	window: { configurable: true, value: environment.window },
	document: { configurable: true, value: environment.window.document },
	Node: { configurable: true, value: environment.window.Node },
});
Object.defineProperties(environment.window, {
	innerWidth: { configurable: true, value: 800 },
	innerHeight: { configurable: true, value: 600 },
});
Object.defineProperty(environment.window.Element.prototype, "scrollTo", {
	configurable: true,
	value: () => { },
});
// jsdom has no layout. Model painted boxes, including targets hidden by ancestors.
Object.defineProperty(environment.window.Element.prototype, "getClientRects", {
	configurable: true,
	value(this: Element): readonly DOMRect[] {
		if (!this.isConnected || this.closest("[hidden]")) return [];
		for (let element: Element | null = this; element; element = element.parentElement) {
			if (environment.window.getComputedStyle(element).display === "none") return [];
		}
		return [rectangle(0, 0, 100, 20)];
	},
});

suiteTeardown(() => {
	environment.window.close();
	for (const [name, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

const { ContextView, ContextViewFocusRestore, ContextViewHideReason } = await import("../../browser/ui/contextview/contextview.js");

test("ContextView positions next to its anchor and flips within the viewport", () => {
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLElement>("#anchor");
	anchor.getBoundingClientRect = () => rectangle(750, 550, 40, 30);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 200, 120);

	assert.equal(contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		gap: 4,
	}), true);

	assert.equal(contextView.element.style.left, "590px");
	assert.equal(contextView.element.style.top, "426px");
	assert.equal(contextView.element.classList.contains("ash-context-view-above"), true);
	assert.equal(contextView.element.classList.contains("ash-context-view-align-right"), true);
	contextView.dispose();
});

test("ContextView reports replacement and outside-pointer hide reasons exactly once", () => {
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLElement>("#anchor");
	const outside = requiredElement<HTMLElement>("#outside");
	anchor.getBoundingClientRect = () => rectangle(20, 20, 30, 20);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 100, 80);
	const reasons: ContextViewHideReasonValue[] = [];

	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		onHide: (reason) => reasons.push(reason),
	});
	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		onHide: (reason) => reasons.push(reason),
	});
	outside.dispatchEvent(new environment.window.MouseEvent("pointerdown", { bubbles: true }));
	outside.dispatchEvent(new environment.window.MouseEvent("pointerdown", { bubbles: true }));

	assert.deepEqual(reasons, [
		ContextViewHideReason.Replaced,
		ContextViewHideReason.OutsidePointer,
	]);
	assert.equal(contextView.visible, false);
	contextView.dispose();
});

test("ContextView restores focus after Escape closes the topmost view", () => {
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLButtonElement>("#anchor");
	anchor.getBoundingClientRect = () => rectangle(20, 20, 30, 20);
	anchor.focus();
	const content = h(environment.window.document, "button");
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 100, 80);
	const reasons: ContextViewHideReasonValue[] = [];
	contextView.show({
		anchor,
		content,
		focusRestore: ContextViewFocusRestore.Previous,
		onHide: (reason) => reasons.push(reason),
	});
	content.focus();

	environment.window.document.dispatchEvent(new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));

	assert.deepEqual(reasons, [ContextViewHideReason.Escape]);
	assert.equal(environment.window.document.activeElement, anchor);
	contextView.dispose();
});

test("ContextView follows anchor and content size changes", () => {
	const observers: TestResizeObserver[] = [];
	class TestResizeObserver {
		readonly targets = new Set<Element>();

		constructor(private readonly listener: ResizeObserverCallback) {
			observers.push(this);
		}

		observe(target: Element): void {
			this.targets.add(target);
		}

		unobserve(target: Element): void {
			this.targets.delete(target);
		}

		disconnect(): void {
			this.targets.clear();
		}

		fire(): void {
			this.listener([], this as unknown as ResizeObserver);
		}
	}
	Object.defineProperty(environment.window, "ResizeObserver", {
		configurable: true,
		value: TestResizeObserver,
	});
	const container = requiredElement<HTMLElement>("main");
	const anchor = requiredElement<HTMLElement>("#anchor");
	let anchorTop = 40;
	let viewWidth = 100;
	anchor.getBoundingClientRect = () => rectangle(750, anchorTop, 30, 20);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, viewWidth, 80);
	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
	});

	assert.equal(observers.length, 1);
	assert.deepEqual([...observers[0]!.targets], [contextView.element, anchor]);
	assert.equal(contextView.element.style.top, "60px");
	assert.equal(contextView.element.style.left, "680px");
	anchorTop = 120;
	viewWidth = 200;
	observers[0]!.fire();
	assert.equal(contextView.element.style.top, "140px");
	assert.equal(contextView.element.style.left, "580px");

	contextView.dispose();
	assert.equal(observers[0]!.targets.size, 0);
	Reflect.deleteProperty(environment.window, "ResizeObserver");
});

test("ContextView hides when a resized element anchor is no longer connected", () => {
	let listener: ResizeObserverCallback | undefined;
	class TestResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			listener = callback;
		}

		observe(): void { }
		unobserve(): void { }
		disconnect(): void { }
	}
	Object.defineProperty(environment.window, "ResizeObserver", {
		configurable: true,
		value: TestResizeObserver,
	});
	const container = requiredElement<HTMLElement>("main");
	const anchor = h(environment.window.document, "button");
	container.append(anchor);
	anchor.getBoundingClientRect = () => rectangle(40, 40, 30, 20);
	const contextView = new ContextView(container);
	contextView.element.getBoundingClientRect = () => rectangle(0, 0, 100, 80);
	const reasons: ContextViewHideReasonValue[] = [];
	contextView.show({
		anchor,
		content: h(environment.window.document, "div"),
		onHide: (reason) => reasons.push(reason),
	});

	anchor.remove();
	listener?.([], {} as ResizeObserver);

	assert.deepEqual(reasons, [ContextViewHideReason.AnchorRemoved]);
	contextView.dispose();
	Reflect.deleteProperty(environment.window, "ResizeObserver");
});

test("ContextView leaves focus transferred outside unchanged for every hide reason", () => {
	for (const reason of [ContextViewHideReason.Programmatic, ContextViewHideReason.OutsidePointer, ContextViewHideReason.Escape, ContextViewHideReason.WindowBlur, ContextViewHideReason.AnchorRemoved]) {
		using fixture = createFocusFixture();
		fixture.show();
		fixture.outside.focus();
		fixture.contextView.hide(reason);
		assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
			focused: fixture.outside, attempts: 0, reasons: [reason],
		});
	}
});

test("ContextView outside-pointer dismissal preserves an already transferred focus", () => {
	using fixture = createFocusFixture();
	fixture.show();
	fixture.outside.focus();
	fixture.outside.dispatchEvent(new environment.window.MouseEvent("pointerdown", { bubbles: true }));
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		focused: fixture.outside, attempts: 0, reasons: [ContextViewHideReason.OutsidePointer],
	});
});

test("ContextView does not attempt to restore unavailable focus targets", () => {
	const unavailable = [
		(anchor: HTMLButtonElement) => anchor.remove(),
		(anchor: HTMLButtonElement) => { anchor.hidden = true; },
		(anchor: HTMLButtonElement) => { anchor.parentElement!.hidden = true; },
		(anchor: HTMLButtonElement) => { anchor.style.display = "none"; },
		(anchor: HTMLButtonElement) => { anchor.parentElement!.style.display = "none"; },
		(anchor: HTMLButtonElement) => { anchor.style.visibility = "hidden"; },
		(anchor: HTMLButtonElement) => { anchor.disabled = true; },
		(anchor: HTMLButtonElement) => { anchor.parentElement!.setAttribute("inert", ""); },
		(anchor: HTMLButtonElement) => { anchor.parentElement!.setAttribute("aria-hidden", "true"); },
	];
	for (const invalidate of unavailable) {
		using fixture = createFocusFixture();
		fixture.show();
		invalidate(fixture.anchor);
		fixture.contextView.hide();
		assert.deepEqual({ attempts: fixture.focusAttempts(), reasons: fixture.reasons }, { attempts: 0, reasons: [ContextViewHideReason.Programmatic] });
		assert.notEqual(environment.window.document.activeElement, fixture.anchor);
	}
});

test("ContextView lets another menu keep focus when an older view closes", () => {
	using fixture = createFocusFixture();
	fixture.show();
	using next = new ContextView(fixture.host);
	const content = h(environment.window.document, "button");
	next.show({ anchor: fixture.outside, content, focusRestore: ContextViewFocusRestore.Previous });
	content.focus();
	fixture.contextView.hide();
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), nextVisible: next.visible }, {
		focused: content, attempts: 0, nextVisible: true,
	});
});

test("ContextView replacement captures the new owner's focus without restoring the old owner", () => {
	using fixture = createFocusFixture();
	fixture.show();
	fixture.outside.focus();
	const next = h(environment.window.document, "button");
	const nextReasons: ContextViewHideReasonValue[] = [];
	fixture.contextView.show({ anchor: fixture.outside, content: next, focusRestore: ContextViewFocusRestore.Previous, onHide: reason => nextReasons.push(reason) });
	next.focus();
	fixture.contextView.hide();
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons, nextReasons }, {
		focused: fixture.outside, attempts: 0, reasons: [ContextViewHideReason.Replaced], nextReasons: [ContextViewHideReason.Programmatic],
	});
});

test("ContextView menu replacement keeps the new focus origin across a separate close and show", () => {
	using fixture = createFocusFixture();
	fixture.show();
	fixture.outside.focus();
	// ContextMenuHandler closes the previous menu before it shows the next one.
	fixture.contextView.hide();
	const next = h(environment.window.document, "button");
	fixture.contextView.show({ anchor: fixture.host, content: next, focusRestore: ContextViewFocusRestore.Previous });
	next.focus();
	next.dispatchEvent(new environment.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		focused: fixture.outside, attempts: 0, reasons: [ContextViewHideReason.Programmatic],
	});
});

test("ContextView Escape unwinds nested views through their own focus targets", () => {
	using fixture = createFocusFixture();
	fixture.show();
	using child = new ContextView(fixture.host);
	const content = h(environment.window.document, "button");
	const childReasons: ContextViewHideReasonValue[] = [];
	child.show({ anchor: fixture.content, content, focusRestore: ContextViewFocusRestore.Previous, onHide: reason => childReasons.push(reason) });
	content.focus();
	content.dispatchEvent(new environment.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	assert.deepEqual({ focused: environment.window.document.activeElement, parentVisible: fixture.contextView.visible, childVisible: child.visible, attempts: fixture.focusAttempts(), childReasons }, {
		focused: fixture.content, parentVisible: true, childVisible: false, attempts: 0, childReasons: [ContextViewHideReason.Escape],
	});
	fixture.content.dispatchEvent(new environment.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	assert.deepEqual({ focused: environment.window.document.activeElement, parentVisible: fixture.contextView.visible, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		focused: fixture.anchor, parentVisible: false, attempts: 1, reasons: [ContextViewHideReason.Escape],
	});
});

test("ContextView does not reclaim focus owned by a child hosted inside its content", () => {
	using fixture = createFocusFixture();
	fixture.show();
	using child = new ContextView(fixture.content);
	const content = h(environment.window.document, "button");
	const childReasons: ContextViewHideReasonValue[] = [];
	child.show({ anchor: fixture.content, content, focusRestore: ContextViewFocusRestore.Previous, onHide: reason => childReasons.push(reason) });
	content.focus();
	fixture.contextView.hide();
	child.layout();
	assert.deepEqual({ attempts: fixture.focusAttempts(), reasons: fixture.reasons, childReasons, childVisible: child.visible }, {
		attempts: 0, reasons: [ContextViewHideReason.Programmatic], childReasons: [ContextViewHideReason.AnchorRemoved], childVisible: false,
	});
});

test("ContextView closing beneath a modal keeps the dialog's focus", () => {
	using fixture = createFocusFixture();
	fixture.show();
	const dialog = h(environment.window.document, "dialog");
	const content = h(environment.window.document, "button");
	dialog.append(content);
	fixture.host.append(dialog);
	// jsdom lacks the dialog top layer; model only the modal lookup used by the host.
	const closest = content.closest.bind(content);
	content.closest = (selector: string) => selector === "dialog:modal" ? dialog : closest(selector);
	content.focus();
	content.dispatchEvent(new environment.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	assert.equal(fixture.contextView.visible, true);
	fixture.contextView.hide();
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		focused: content, attempts: 0, reasons: [ContextViewHideReason.Programmatic],
	});
});

test("ContextView does not restore behind a modal hosted inside its content", () => {
	using fixture = createFocusFixture();
	fixture.show();
	const dialog = h(environment.window.document, "dialog");
	const content = h(environment.window.document, "button");
	dialog.append(content);
	fixture.content.append(dialog);
	const closest = content.closest.bind(content);
	content.closest = (selector: string) => selector === "dialog:modal" ? dialog : closest(selector);
	content.focus();
	fixture.contextView.hide();
	assert.deepEqual({ attempts: fixture.focusAttempts(), reasons: fixture.reasons }, { attempts: 0, reasons: [ContextViewHideReason.Programmatic] });
	assert.notEqual(environment.window.document.activeElement, fixture.anchor);
});

test("ContextView restores focus held by a shadow descendant", () => {
	using fixture = createFocusFixture();
	fixture.show();
	const content = h(environment.window.document, "button");
	fixture.content.attachShadow({ mode: "open" }).append(content);
	content.focus();
	fixture.contextView.hide();
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		focused: fixture.anchor, attempts: 1, reasons: [ContextViewHideReason.Programmatic],
	});
});

test("ContextView restores the menu owner before a related submenu action runs", async () => {
	const { Menu } = await import("../../browser/ui/menu/menu.js");
	using fixture = createFocusFixture();
	using runner = new ActionRunner();
	let actionFocus: Element | null = null;
	using menu = new Menu(fixture.host, {
		actions: [new SubmenuAction("test.more", "More", [{
			id: "test.child", label: "Child", tooltip: "Child", enabled: true,
			run: () => { actionFocus = environment.window.document.activeElement; fixture.outside.focus(); },
		}])],
		actionRunner: runner,
		contextViewContainer: fixture.host,
	});
	fixture.anchor.focus();
	fixture.contextView.show({ anchor: fixture.anchor, content: menu.element, focusRestore: ContextViewFocusRestore.Previous, isTargetWithin: target => menu.contains(target) });
	menu.focus(true);
	const attempts = fixture.focusAttempts();
	using close = runner.onWillRun(() => { fixture.contextView.hide(); menu.dispose(); });
	const completion = new Promise<void>(resolve => fixture.add(runner.onDidRun(() => resolve())));
	const trigger = menu.element.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
	trigger.dispatchEvent(new environment.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
	const child = fixture.host.querySelector<HTMLButtonElement>('.ash-context-view-menu [role="menuitem"]')!;
	assert.ok(child);
	assert.equal(environment.window.document.activeElement, child);
	child.click();
	await completion;
	assert.deepEqual({ actionFocus, focused: environment.window.document.activeElement, attempts: fixture.focusAttempts() - attempts }, {
		actionFocus: fixture.anchor, focused: fixture.outside, attempts: 1,
	});
});

test("ContextView disposal restores only focus it still owns and reports closure once", () => {
	for (const movedOutside of [false, true]) {
		using fixture = createFocusFixture();
		fixture.show();
		if (movedOutside) fixture.outside.focus();
		fixture.contextView.dispose();
		fixture.contextView.dispose();
		assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons, connected: fixture.contextView.element.isConnected }, {
			focused: movedOutside ? fixture.outside : fixture.anchor, attempts: movedOutside ? 0 : 1, reasons: [ContextViewHideReason.Programmatic], connected: false,
		});
	}
});

test("ContextView restores before action execution and leaves the action's new focus in place", async () => {
	using fixture = createFocusFixture();
	using runner = new ActionRunner();
	using subscription = runner.onWillRun(() => fixture.contextView.hide());
	fixture.show();
	let actionRan = false;
	await runner.run({
		id: "test.action", label: "Run", tooltip: "Run", enabled: true,
		run: () => {
			assert.equal(environment.window.document.activeElement, fixture.anchor);
			actionRan = true;
			fixture.outside.focus();
		},
	});
	assert.deepEqual({ actionRan, focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		actionRan: true, focused: fixture.outside, attempts: 1, reasons: [ContextViewHideReason.Programmatic],
	});
});

test("ContextView onHide can open a new view without a late focus restore or duplicate callback", () => {
	using fixture = createFocusFixture();
	const next = h(environment.window.document, "button");
	const nextReasons: ContextViewHideReasonValue[] = [];
	fixture.show(() => {
		fixture.contextView.show({ anchor: fixture.anchor, content: next, focusRestore: ContextViewFocusRestore.Previous, onHide: reason => nextReasons.push(reason) });
		next.focus();
	});
	fixture.contextView.hide();
	assert.deepEqual({ focused: environment.window.document.activeElement, visible: fixture.contextView.visible, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		focused: next, visible: true, attempts: 1, reasons: [ContextViewHideReason.Programmatic],
	});
	fixture.contextView.hide();
	fixture.contextView.hide();
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), nextReasons }, {
		focused: fixture.anchor, attempts: 2, nextReasons: [ContextViewHideReason.Programmatic],
	});
});

test("ContextView does not refocus an owner when its content never took focus", () => {
	using fixture = createFocusFixture();
	fixture.show();
	fixture.anchor.focus();
	const attempts = fixture.focusAttempts();
	fixture.contextView.hide();
	assert.deepEqual({ focused: environment.window.document.activeElement, attempts: fixture.focusAttempts(), reasons: fixture.reasons }, {
		focused: fixture.anchor, attempts, reasons: [ContextViewHideReason.Programmatic],
	});
});

function createFocusFixture(): DisposableStore & {
	readonly host: HTMLElement;
	readonly anchor: HTMLButtonElement;
	readonly outside: HTMLInputElement;
	readonly content: HTMLElement;
	readonly contextView: InstanceType<typeof ContextView>;
	readonly reasons: ContextViewHideReasonValue[];
	readonly focusAttempts: () => number;
	readonly show: (onHide?: () => void) => void;
} {
	const resources = new DisposableStore();
	const host = h(environment.window.document, "section");
	resources.add(toDisposable(() => host.remove()));
	const anchorHost = h(environment.window.document, "div");
	const anchor = h(environment.window.document, "button");
	const outside = h(environment.window.document, "input");
	anchorHost.append(anchor);
	host.append(anchorHost, outside);
	environment.window.document.body.append(host);
	const content = h(environment.window.document, "div");
	content.tabIndex = -1;
	const contextView = resources.add(new ContextView(host));
	const reasons: ContextViewHideReasonValue[] = [];
	const focus = anchor.focus.bind(anchor);
	let attempts = 0;
	anchor.focus = (options?: FocusOptions): void => { attempts++; focus(options); };
	return Object.assign(resources, {
		host, anchor, outside, content, contextView, reasons,
		focusAttempts: () => attempts,
		show: (onHide?: () => void): void => {
			anchor.focus();
			assert.equal(contextView.show({ anchor, content, focusRestore: ContextViewFocusRestore.Previous, onHide: reason => { reasons.push(reason); onHide?.(); } }), true);
			content.focus();
			attempts = 0;
		},
	});
}

function requiredElement<T extends Element>(selector: string): T {
	const element = environment.window.document.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

function rectangle(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

import assert from "node:assert/strict";
import { test } from "mocha";

class FakeNode extends EventTarget {
	static readonly ELEMENT_NODE = 1;
	static readonly DOCUMENT_NODE = 9;
}

class FakeDocument extends EventTarget {
	readonly nodeType = FakeNode.DOCUMENT_NODE;
	defaultView: FakeWindow | undefined;
	activeElement: FakeElement | null = null;

	hasFocus(): boolean {
		return this.activeElement !== null;
	}
}

class FakeWindow extends EventTarget {
	readonly window = this;

	constructor(readonly document: FakeDocument) {
		super();
	}

	readonly setTimeout = globalThis.setTimeout.bind(globalThis);
	readonly clearTimeout = globalThis.clearTimeout.bind(globalThis);

	getComputedStyle(): Pick<CSSStyleDeclaration, "display" | "visibility"> {
		return { display: "block", visibility: "visible" };
	}
}

class FakeElement extends FakeNode {
	readonly nodeType = FakeNode.ELEMENT_NODE;
	readonly namespaceURI = "http://www.w3.org/1999/xhtml";
	readonly parentElement = null;
	readonly shadowRoot = null;
	readonly isConnected = true;
	readonly hidden = false;
	readonly isContentEditable = false;
	readonly scrollLeft = 0;
	readonly scrollTop = 0;
	private readonly attributes = new Map<string, string>();
	private children: FakeElement[] = [];

	constructor(
		readonly ownerDocument: FakeDocument,
		readonly tagName: string,
		readonly tabIndex: number,
		readonly disabled = false,
		readonly rendered = true,
	) {
		super();
	}

	setChildren(children: readonly FakeElement[]): void {
		this.children = [...children];
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	closest(): FakeElement | null {
		return null;
	}

	matches(selector: string): boolean {
		return selector === ":disabled" && this.disabled;
	}

	getClientRects(): readonly object[] {
		return this.rendered ? [{}] : [];
	}

	getRootNode(): FakeDocument {
		return this.ownerDocument;
	}

	querySelectorAll<T extends Element>(): NodeListOf<T> {
		return this.children as unknown as NodeListOf<T>;
	}

	contains(candidate: Node | null): boolean {
		const element = candidate as unknown as FakeElement | null;
		return element === this ||
			this.children.includes(element as FakeElement);
	}

	focus(): void {
		this.ownerDocument.activeElement = this;
	}

	scrollTo(): void {}
}

Object.defineProperty(globalThis, "Node", {
	configurable: true,
	value: FakeNode,
});
const fakeDocument = new FakeDocument();
const fakeWindow = new FakeWindow(fakeDocument);
fakeDocument.defaultView = fakeWindow;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: fakeWindow,
});

const {
	FocusNavigationBoundary,
	FocusNavigationDirection,
	getTabbableElements,
	moveFocus,
} = await import("../../browser/focus.js");

test("tabbable elements follow positive tabindex then DOM order", () => {
	const normal = new FakeElement(fakeDocument, "BUTTON", 0);
	const second = new FakeElement(fakeDocument, "BUTTON", 2);
	const first = new FakeElement(fakeDocument, "BUTTON", 1);
	const disabled = new FakeElement(fakeDocument, "BUTTON", 0, true);
	const hidden = new FakeElement(fakeDocument, "BUTTON", 0, false, false);
	const container = new FakeElement(fakeDocument, "DIV", -1);
	container.setChildren([normal, second, first, disabled, hidden]);

	assert.deepEqual(
		getTabbableElements(container as unknown as ParentNode),
		[first, second, normal],
	);
});

test("moveFocus wraps explicitly at the container boundary", () => {
	const first = new FakeElement(fakeDocument, "BUTTON", 1);
	const second = new FakeElement(fakeDocument, "BUTTON", 2);
	const normal = new FakeElement(fakeDocument, "BUTTON", 0);
	const container = new FakeElement(fakeDocument, "DIV", -1);
	container.setChildren([normal, second, first]);
	normal.focus();

	const focused = moveFocus(
		container as unknown as ParentNode,
		FocusNavigationDirection.Forward,
		FocusNavigationBoundary.Wrap,
	);

	assert.equal(focused, first);
	assert.equal(fakeDocument.activeElement, first);
});

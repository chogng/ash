import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { observeElementSize, observeResize } from "../../browser/observer.js";

test("resize observation uses the target document and owns all targets", () => {
	const ownerDocument = new JSDOM("<!doctype html><body><div></div><span></span></body>").window.document;
	const instances: TestResizeObserver[] = [];
	class WindowResizeObserver extends TestResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			super(callback);
			instances.push(this);
		}
	}
	Object.defineProperty(ownerDocument.defaultView, "ResizeObserver", {
		value: WindowResizeObserver,
	});
	const targets = [...ownerDocument.body.children];
	const deliveries: (readonly ResizeObserverEntry[])[] = [];
	const registration = observeResize(targets, entries => deliveries.push(entries), { box: "border-box" });

	assert.equal(instances.length, 1);
	assert.deepEqual(instances[0]?.targets, targets);
	assert.deepEqual(instances[0]?.options, [{ box: "border-box" }, { box: "border-box" }]);
	instances[0]?.emit([]);
	assert.equal(deliveries.length, 1);
	registration.dispose();
	assert.equal(instances[0]?.disconnected, true);
});

test("element-size observation falls back to the content rectangle", () => {
	const ownerDocument = new JSDOM("<!doctype html><body><div></div></body>").window.document;
	let observer: TestResizeObserver | undefined;
	class WindowResizeObserver extends TestResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			super(callback);
			observer = this;
		}
	}
	Object.defineProperty(ownerDocument.defaultView, "ResizeObserver", {
		value: WindowResizeObserver,
	});
	const sizes: { readonly width: number; readonly height: number }[] = [];
	using registration = observeElementSize(ownerDocument.body.firstElementChild as HTMLElement, size => sizes.push(size));
	observer?.emit([{
		contentRect: { width: 320, height: 180 },
		borderBoxSize: [],
	} as unknown as ResizeObserverEntry]);

	assert.equal(sizes.length, 1);
	assert.equal(sizes[0]?.width, 320);
	assert.equal(sizes[0]?.height, 180);
});

test("resize observation is disposable when the capability is unavailable", () => {
	const ownerDocument = new JSDOM("<!doctype html><body><div></div></body>").window.document;
	using registration = observeResize(ownerDocument.body.firstElementChild!, () => {
		throw new Error("Unavailable observers must not deliver");
	});
	registration.dispose();
});

test("resize observation keeps auxiliary-window constructors isolated", () => {
	const firstDocument = new JSDOM("<!doctype html><body><div></div></body>").window.document;
	const secondDocument = new JSDOM("<!doctype html><body><div></div></body>").window.document;
	const firstInstances: TestResizeObserver[] = [];
	const secondInstances: TestResizeObserver[] = [];
	installResizeObserver(firstDocument, firstInstances);
	installResizeObserver(secondDocument, secondInstances);

	const registration = observeResize([
		firstDocument.body.firstElementChild!,
		secondDocument.body.firstElementChild!,
	], () => {});

	assert.equal(firstInstances.length, 1);
	assert.equal(secondInstances.length, 1);
	assert.equal(firstInstances[0]?.targets[0]?.ownerDocument, firstDocument);
	assert.equal(secondInstances[0]?.targets[0]?.ownerDocument, secondDocument);
	registration.dispose();
	assert.equal(firstInstances[0]?.disconnected, true);
	assert.equal(secondInstances[0]?.disconnected, true);
});

function installResizeObserver(ownerDocument: Document, instances: TestResizeObserver[]): void {
	class WindowResizeObserver extends TestResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			super(callback);
			instances.push(this);
		}
	}
	Object.defineProperty(ownerDocument.defaultView, "ResizeObserver", { value: WindowResizeObserver });
}

class TestResizeObserver {
	readonly targets: Element[] = [];
	readonly options: (ResizeObserverOptions | undefined)[] = [];
	disconnected = false;

	constructor(private readonly callback: ResizeObserverCallback) {}

	observe(target: Element, options?: ResizeObserverOptions): void {
		this.targets.push(target);
		this.options.push(options);
	}

	disconnect(): void {
		this.disconnected = true;
	}

	emit(entries: ResizeObserverEntry[]): void {
		this.callback(entries, this as unknown as ResizeObserver);
	}
}

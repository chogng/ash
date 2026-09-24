import { DisposableStore, type IDisposable, toDisposable } from "../common/lifecycle.js";
import { Dimension } from "./dom.js";

type ObserverWindow = Window & typeof globalThis;

export interface ResizeObservationOptions extends ResizeObserverOptions {
	/** Overrides the owning window's constructor for tests or compatibility. */
	readonly observerType?: typeof ResizeObserver;
}

/**
 * Observes one or more elements using the constructor from their owning
 * window. The returned registration is a no-op when ResizeObserver is absent.
 */
export function observeResize(
	targets: Element | readonly Element[],
	listener: (entries: readonly ResizeObserverEntry[]) => void,
	options: ResizeObservationOptions = {},
): IDisposable {
	const elements = isElementList(targets) ? targets : [targets];
	const store = new DisposableStore();
	const elementsByWindow = new Map<ObserverWindow, Element[]>();
	for (const element of elements) {
		const targetWindow = getObserverWindow(element);
		if (!targetWindow) continue;
		const group = elementsByWindow.get(targetWindow);
		if (group) group.push(element);
		else elementsByWindow.set(targetWindow, [element]);
	}
	const observation = options.box === undefined ? undefined : { box: options.box };
	for (const [targetWindow, windowElements] of elementsByWindow) {
		const Observer = options.observerType ?? targetWindow.ResizeObserver;
		if (!Observer) continue;
		const observer = new Observer(entries => listener(entries));
		for (const target of windowElements) observer.observe(target, observation);
		store.add(toDisposable(() => observer.disconnect()));
	}
	return store;
}

/** Observes the requested box size of one element. */
export function observeElementSize(
	target: HTMLElement,
	listener: (size: Dimension) => void,
	options: ResizeObservationOptions = { box: "border-box" },
): IDisposable {
	return observeResize(target, ([entry]) => {
		if (!entry) return;
		const box = options.box ?? "border-box";
		const size = box === "content-box"
			? entry.contentBoxSize?.[0]
			: box === "device-pixel-content-box"
			? entry.devicePixelContentBoxSize?.[0]
			: entry.borderBoxSize?.[0];
		listener(new Dimension(
			size?.inlineSize ?? entry.contentRect.width,
			size?.blockSize ?? entry.contentRect.height,
		));
	}, options);
}

export function observeMutations(
	target: Node,
	listener: (records: readonly MutationRecord[]) => void,
	options: MutationObserverInit,
): IDisposable {
	const Observer = getObserverWindow(target)?.MutationObserver;
	if (!Observer) return toDisposable(() => {});
	const observer = new Observer(records => listener(records));
	observer.observe(target, options);
	return toDisposable(() => observer.disconnect());
}

export function observeIntersection(
	target: Element,
	listener: (entry: IntersectionObserverEntry) => void,
	options?: IntersectionObserverInit,
): IDisposable {
	const Observer = getObserverWindow(target)?.IntersectionObserver;
	if (!Observer) return toDisposable(() => {});
	const observer = new Observer(([entry]) => {
		if (entry) listener(entry);
	}, options);
	observer.observe(target);
	return toDisposable(() => observer.disconnect());
}

function isElementList(
	targets: Element | readonly Element[],
): targets is readonly Element[] {
	return Array.isArray(targets);
}

function getObserverWindow(target: Node): ObserverWindow | undefined {
	const ownerDocument = target.nodeType === 9 ? target as Document : target.ownerDocument;
	return ownerDocument?.defaultView as ObserverWindow | undefined;
}

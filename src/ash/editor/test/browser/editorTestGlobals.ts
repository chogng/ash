import { type JSDOM } from 'jsdom';
import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';

type DomGlobalName =
	| 'Node'
	| 'Element'
	| 'HTMLElement'
	| 'HTMLButtonElement'
	| 'HTMLCanvasElement'
	| 'Event'
	| 'InputEvent'
	| 'KeyboardEvent'
	| 'MouseEvent'
	| 'NodeFilter';

/** Measures explicit list heights in jsdom, which has no browser layout engine. */
export function installTestElementHeights(document: Document): IDisposable {
	const prototype = document.defaultView!.HTMLElement.prototype;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const name of ['clientHeight', 'scrollHeight']) {
		previous.set(name, Object.getOwnPropertyDescriptor(prototype, name));
		Object.defineProperty(prototype, name, {
			configurable: true,
			get(this: HTMLElement) {
				for (let node: HTMLElement | null = this; node; node = node.parentElement) {
					if (node.style.height.endsWith('px')) return Number.parseFloat(node.style.height) || 0;
				}
				return 0;
			},
		});
	}
	return toDisposable(() => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(prototype, name, descriptor);
			else Reflect.deleteProperty(prototype, name);
		}
	});
}

/** Installs only the browser globals a test needs, then restores their original descriptors. */
export function installEditorTestGlobals(bindings: Record<string, unknown>): IDisposable {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries(bindings)) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
	return toDisposable(() => {
		for (const [name, descriptor] of previous) {
			if (descriptor) {
				Object.defineProperty(globalThis, name, descriptor);
			} else {
				Reflect.deleteProperty(globalThis, name);
			}
		}
	});
}

/** Keeps each test's DOM constructor set explicit so unrelated browser APIs do not change its behavior. */
export function installEditorTestDom(
	dom: JSDOM,
	names: readonly DomGlobalName[],
	extras: Record<string, unknown> = {},
): IDisposable {
	const bindings: Record<string, unknown> = { window: dom.window, document: dom.window.document };
	for (const name of names) {
		bindings[name] = dom.window[name];
	}
	return installEditorTestGlobals({ ...bindings, ...extras });
}

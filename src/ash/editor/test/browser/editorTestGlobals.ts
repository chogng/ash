import { type JSDOM } from 'jsdom';
import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';

type DomGlobalName = 'Node' | 'Element' | 'HTMLElement' | 'HTMLButtonElement' | 'HTMLCanvasElement' | 'Event' | 'InputEvent' | 'KeyboardEvent' | 'MouseEvent' | 'NodeFilter';

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
export function installEditorTestDom(dom: JSDOM, names: readonly DomGlobalName[], extras: Record<string, unknown> = {}): IDisposable {
	const bindings: Record<string, unknown> = { window: dom.window, document: dom.window.document };
	for (const name of names) {
		bindings[name] = dom.window[name];
	}
	return installEditorTestGlobals({ ...bindings, ...extras });
}

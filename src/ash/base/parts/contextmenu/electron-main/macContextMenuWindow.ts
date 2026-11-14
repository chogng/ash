import type { BrowserWindow } from 'electron';
import koffi from 'koffi';

function loadRuntime() {
	const library = koffi.load('/usr/lib/libobjc.A.dylib');
	const selector = library.func('void *sel_registerName(const char *name)');
	return {
		library,
		window: selector('window'),
		makeMainWindow: selector('makeMainWindow'),
		sendObject: library.func('void *objc_msgSend(void *receiver, void *selector)'),
		sendVoid: library.func('void objc_msgSend(void *receiver, void *selector)'),
	};
}

// Function bindings have process lifetime; no window or Objective-C object is retained here.
let runtime: ReturnType<typeof loadRuntime> | undefined;

/** Keep the document window main while a transient menu owns key-window input. */
export function restoreMacMainWindow(parent: BrowserWindow): void {
	if (process.platform !== 'darwin' || parent.isDestroyed() || !parent.isVisible()) return;
	const bindings = runtime ??= loadRuntime();
	// Electron exposes an NSView pointer, not an NSWindow pointer, on macOS.
	const handle = parent.getNativeWindowHandle();
	if (handle.byteLength !== 8) throw new TypeError('Invalid macOS window handle');
	const view = handle.readBigUInt64LE();
	if (!view) throw new TypeError('Missing macOS window view');
	const window = bindings.sendObject(view, bindings.window);
	if (!window) throw new Error('macOS window view is detached');
	// Unlike makeKeyAndOrderFront, this preserves the menu's keyboard focus.
	bindings.sendVoid(window, bindings.makeMainWindow);
}

import type { BrowserWindow } from 'electron';
import koffi from 'koffi';
import { Disposable, toDisposable, type IDisposable } from '../../../common/lifecycle.js';

function loadRuntime() {
	const library = koffi.load('/usr/lib/libobjc.A.dylib');
	const selector = library.func('void *sel_registerName(const char *name)');
	return {
		library,
		object: library.func('void *objc_getClass(const char *name)')('NSObject'),
		window: selector('window'),
		makeMainWindow: selector('makeMainWindow'),
		perform: selector('performSelector:withObject:afterDelay:'),
		cancel: selector('cancelPreviousPerformRequestsWithTarget:selector:object:'),
		sendObject: library.func('void *objc_msgSend(void *receiver, void *selector)'),
		sendDelayed: library.func('void objc_msgSend(void *receiver, void *selector, void *action, void *object, double delay)'),
		sendCancel: library.func('void objc_msgSend(void *receiver, void *selector, void *target, void *action, void *object)'),
	};
}

// Function bindings have process lifetime; no window or Objective-C object is retained here.
let runtime: ReturnType<typeof loadRuntime> | undefined;

/** Keep the document main while its menu owns key-window input. */
export function scheduleMacMainWindowRestore(parent: BrowserWindow): IDisposable {
	if (process.platform !== 'darwin' || parent.isDestroyed() || !parent.isVisible()) return Disposable.None;
	const bindings = runtime ??= loadRuntime();
	// Electron exposes an NSView pointer, not an NSWindow pointer, on macOS.
	const handle = parent.getNativeWindowHandle();
	if (handle.byteLength !== 8) throw new TypeError('Invalid macOS window handle');
	const view = handle.readBigUInt64LE();
	if (!view) throw new TypeError('Missing macOS window view');
	const window = bindings.sendObject(view, bindings.window);
	if (!window) throw new Error('macOS window view is detached');
	// makeMainWindow synchronously emits Electron/JavaScript notifications. Koffi
	// forbids that reentry while its native call is active. Cocoa performs this
	// selector in the next run-loop cycle, after the FFI stack has unwound.
	bindings.sendDelayed(window, bindings.perform, bindings.makeMainWindow, null, 0);
	return toDisposable(() => {
		if (!parent.isDestroyed()) bindings.sendCancel(bindings.object, bindings.cancel, window, bindings.makeMainWindow, null);
	});
}

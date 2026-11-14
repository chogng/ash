import { addDisposableListener } from '../../../base/browser/dom.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { SCREENSHOT_INITIALIZE_CHANNEL, SCREENSHOT_READY_CHANNEL, SCREENSHOT_COMPLETE_CHANNEL, validateScreenshotInitialization, type ScreenshotInitialization, type ScreenshotCompletion } from '../common/screenshot.js';
import { setNlsMessages } from '../../../nls.js';

/** Initializes the bundled capture or pinned-image window and owns its lifetime. */
export async function openScreenshotWindow(mountBuiltin: (initial: ScreenshotInitialization, complete: (result: ScreenshotCompletion) => Promise<boolean>, signal: AbortSignal) => Promise<IDisposable>): Promise<void> {
	const initial = validateScreenshotInitialization(await invoke<unknown>(SCREENSHOT_INITIALIZE_CHANNEL));
	setNlsMessages(initial.locale, initial.bundles);
	document.documentElement.lang = initial.locale;

	const controller = new AbortController();
	let editor: IDisposable | undefined;
	const unload = addDisposableListener(window, 'pagehide', () => { controller.abort(); unload.dispose(); editor?.dispose(); });
	const complete = (result: ScreenshotCompletion) => invoke<boolean>(SCREENSHOT_COMPLETE_CHANNEL, result);
	const ready = () => { void invoke<void>(SCREENSHOT_READY_CHANNEL); };
	try {
		editor = await mountBuiltin(initial, complete, controller.signal);
		if (controller.signal.aborted) { editor.dispose(); return; }
		ready();
	} catch (error) {
		if (!controller.signal.aborted) await complete({ kind: 'error', message: String(error).slice(0, 4096) });
	}
}

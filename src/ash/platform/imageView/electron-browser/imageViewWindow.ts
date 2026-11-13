import { addDisposableListener } from '../../../base/browser/dom.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { IMAGE_VIEW_INITIALIZE_CHANNEL, IMAGE_VIEW_READY_CHANNEL, IMAGE_VIEW_COMPLETE_CHANNEL, validateImageViewInitialization, type ImageViewInitialization, type ImageViewCompletion } from '../common/imageView.js';
import { setNlsMessages } from '../../../nls.js';
import { createImageViewFrame } from '../browser/imageViewFrame.js';

/** The product host mounts bundled UI; provider HTML always uses the opaque sandbox. */
export async function openImageViewWindow(mountBuiltin: (initial: ImageViewInitialization, complete: (result: ImageViewCompletion) => Promise<boolean>, signal: AbortSignal) => Promise<IDisposable>): Promise<void> {
	const initial = validateImageViewInitialization(await invoke<unknown>(IMAGE_VIEW_INITIALIZE_CHANNEL));
	setNlsMessages(initial.locale, initial.bundles);
	document.documentElement.lang = initial.locale;
	document.title = initial.presentation.title;
	const controller = new AbortController();
	let editor: IDisposable | undefined;
	const unload = addDisposableListener(window, 'pagehide', () => { controller.abort(); unload.dispose(); editor?.dispose(); });
	const complete = (result: ImageViewCompletion) => invoke<boolean>(IMAGE_VIEW_COMPLETE_CHANNEL, result);
	const ready = () => { void invoke<void>(IMAGE_VIEW_READY_CHANNEL); };
	const presentation = initial.presentation;
	try {
		if (initial.desktopCapture || presentation.renderer === 'builtin') {
			editor = await mountBuiltin(initial, complete, controller.signal);
			if (controller.signal.aborted) { editor.dispose(); return; }
			ready();
		} else {
			editor = createImageViewFrame(document, presentation.title, presentation.html, {
				...presentation.input, ...(presentation.source !== 'content' ? { image: initial.image } : {}),
			}, complete, ready);
		}
	} catch (error) {
		if (!controller.signal.aborted) await complete({ kind: 'error', message: String(error).slice(0, 4096) });
	}
}

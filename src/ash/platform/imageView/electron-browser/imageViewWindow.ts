import { addDisposableListener } from '../../../base/browser/dom.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { IMAGE_VIEW_INITIALIZE_CHANNEL, IMAGE_VIEW_READY_CHANNEL, IMAGE_VIEW_COMPLETE_CHANNEL, validateImageViewInitialization, type ImageViewInitialization } from '../common/imageView.js';
import { setNlsMessages } from '../../../nls.js';
import { createImageViewFrame } from '../browser/imageViewFrame.js';

export async function openImageViewWindow(loadDesktopCapture: (initial: ImageViewInitialization) => Promise<{ title: string; html: string; input: object; }>): Promise<void> {
	const initial = validateImageViewInitialization(await invoke<unknown>(IMAGE_VIEW_INITIALIZE_CHANNEL));
	setNlsMessages(initial.locale, initial.bundles);
	document.documentElement.lang = initial.locale;
	const presentation = initial.desktopCapture ? await loadDesktopCapture(initial) : initial.presentation;
	document.title = presentation.title;
	const editor = createImageViewFrame(document, presentation.title, presentation.html, {
		...presentation.input,
		...(initial.presentation.source !== 'content' ? { image: initial.image } : {}),
	}, result => invoke<boolean>(IMAGE_VIEW_COMPLETE_CHANNEL, result), () => { void invoke<void>(IMAGE_VIEW_READY_CHANNEL); });
	const unload = addDisposableListener(window, 'pagehide', () => { unload.dispose(); editor.dispose(); });
}

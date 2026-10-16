import { addDisposableListener } from '../../../../base/browser/dom.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import {
	SCREENSHOT_INITIALIZE_CHANNEL,
	SCREENSHOT_READY_CHANNEL,
	SCREENSHOT_COMPLETE_CHANNEL,
	validateScreenshotInitialization
} from '../common/screenshotProtocol.js';
import { localize, setNlsMessages } from '../../../../nls.js';
import { ScreenshotEditor } from '../browser/screenshotEditor.js';

export async function openScreenshotWindow(): Promise<void> {
	const initial = validateScreenshotInitialization(await invoke<unknown>(SCREENSHOT_INITIALIZE_CHANNEL));
	setNlsMessages(initial.locale, initial.bundles);
	document.documentElement.lang = initial.locale;
	document.title = localize('screenshot.title', 'Screen Capture');
	document.documentElement.dataset.colorScheme = initial.presentation.colorScheme;
	for (const [key, value] of Object.entries(initial.presentation.styles))
		document.documentElement.style.setProperty(key, value);
	const editor = await ScreenshotEditor.create(document, initial.image, {
		accessibilityHints: initial.presentation.accessibilityHints,
		complete: (result) => invoke<boolean>(SCREENSHOT_COMPLETE_CHANNEL, result)
	});
	const unload = addDisposableListener(window, 'pagehide', () => {
		unload.dispose();
		editor.dispose();
	});
	await invoke<void>(SCREENSHOT_READY_CHANNEL);
}

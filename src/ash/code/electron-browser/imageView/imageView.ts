import { localize } from '../../../nls.js';
import { openImageViewWindow } from '../../../platform/imageView/electron-browser/imageViewWindow.js';
import { defaultImageEditorTheme } from '../../../workbench/services/imageEditor/browser/imageEditorTheme.js';
import { mountScreenshotTool, type ScreenshotToolInput } from '../../../workbench/contrib/screenshotTool/browser/screenshotToolView.js';
import { getScreenshotAccessibilityHelp } from '../../../workbench/contrib/screenshotTool/browser/screenshotToolService.js';

await openImageViewWindow(async (initial, complete, signal) => {
	document.title = initial.presentation.title || localize('screenshot.builtin.title', 'Screenshot');
	const input = initial.presentation.input;
	return mountScreenshotTool(document, {
		...input, image: initial.image, defaultAction: input.defaultAction ?? 'copy',
		state: input.state ?? { help: getScreenshotAccessibilityHelp(), accessibilityHints: input.accessibilityHints !== false },
		theme: input.theme ?? defaultImageEditorTheme(input.colorScheme),
	} as unknown as ScreenshotToolInput, complete, signal);
});

import { mountPinnedScreenshot } from '../../../workbench/contrib/screenshotTool/browser/screenshotPinnedImage.js';
import { localize } from '../../../nls.js';
import { openScreenshotWindow } from '../../../platform/screenshot/electron-browser/screenshotWindow.js';
import { defaultImageEditorTheme } from '../../../workbench/services/imageEditor/browser/imageEditorTheme.js';
import { mountScreenshotTool, type ScreenshotToolInput } from '../../../workbench/contrib/screenshotTool/browser/screenshotToolView.js';
import { getScreenshotAccessibilityHelp } from '../../../workbench/contrib/screenshotTool/browser/screenshotToolService.js';

await openScreenshotWindow(async (initial, complete, signal) => {
	document.title = localize('screenshot.builtin.title', 'Screenshot');
	const input = initial.input as unknown as Partial<ScreenshotToolInput> & { readonly accessibilityHints?: boolean; readonly help?: string; };
	if (initial.kind === 'pinned') {
		return mountPinnedScreenshot(document, initial.image, input.theme ?? defaultImageEditorTheme(input.colorScheme), input.accessibilityHints !== false, complete);
	}
	return mountScreenshotTool(document, {
		...input, image: initial.image, defaultAction: input.defaultAction ?? 'copy',
		canRetake: initial.kind === 'capture',
		canPin: true,
		state: { help: input.help ?? getScreenshotAccessibilityHelp(), accessibilityHints: input.accessibilityHints !== false },
		theme: input.theme ?? defaultImageEditorTheme(input.colorScheme),
	} as unknown as ScreenshotToolInput, complete, signal);
});

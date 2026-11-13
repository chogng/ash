import { openImageViewWindow } from '../../../platform/imageView/electron-browser/imageViewWindow.js';
import { defaultImageEditorTheme } from '../../../workbench/services/imageEditor/browser/imageEditorTheme.js';
import { createScreenshotToolView } from '../../../workbench/contrib/screenshotTool/browser/screenshotToolService.js';
import { localize } from '../../../nls.js';

await openImageViewWindow(async ({ presentation }) => {
	const view = await createScreenshotToolView({ accessibilityHints: presentation.input.accessibilityHints !== false });
	return {
		title: localize('screenshot.builtin.title', 'Screenshot'), html: view.html,
		input: { ...presentation.input, state: view.state, theme: defaultImageEditorTheme(presentation.input.colorScheme) },
	};
});

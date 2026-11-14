import { mountPinnedScreenshot } from '../../../workbench/contrib/screenshotTool/browser/screenshotPinnedImage.js';
import { localize } from '../../../nls.js';
import { openScreenshotWindow } from '../../../platform/screenshot/electron-browser/screenshotWindow.js';
import { defaultImageEditorTheme, getDefaultImageEditorColorTheme, readImageEditorTheme } from '../../../workbench/services/imageEditor/browser/imageEditorTheme.js';
import { mountScreenshotTool, type ScreenshotToolInput } from '../../../workbench/contrib/screenshotTool/browser/screenshotToolView.js';
import { getScreenshotAccessibilityHelp } from '../../../workbench/contrib/screenshotTool/browser/screenshotToolService.js';
import { generateColorThemeCSS } from '../../../workbench/services/themes/browser/colorThemeCss.js';
import { createColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { getSessionsWindowColorOverrides } from '../../../sessions/common/theme.js';
import '../../../workbench/browser/media/style.css';
import '../../../sessions/browser/media/style.css';

await openScreenshotWindow(async (initial, complete, signal) => {
	document.title = localize('screenshot.builtin.title', 'Screenshot');
	const input = initial.input as unknown as Partial<ScreenshotToolInput> & { readonly accessibilityHints?: boolean; readonly help?: string; };
	if (initial.kind === 'pinned') {
		return mountPinnedScreenshot(document, initial.image, input.theme ?? defaultImageEditorTheme(input.colorScheme), input.accessibilityHints !== false, complete);
	}
	let theme = input.theme;
	if (initial.agentWindow) {
		const baseTheme = getDefaultImageEditorColorTheme(input.colorScheme);
		const windowTheme = createColorTheme({
			id: baseTheme.id,
			label: baseTheme.label,
			colorScheme: baseTheme.colorScheme,
			baseTheme,
			colorOverrides: getSessionsWindowColorOverrides(baseTheme.colorScheme, 'warm'),
			allowUnregisteredColorOverrides: true,
		});
		const style = document.createElement('style');
		style.textContent = generateColorThemeCSS(windowTheme, ':root').code;
		document.head.append(style);
		document.body.classList.add('ash-sessions-window');
		theme ??= readImageEditorTheme(document, document.body);
	}
	return mountScreenshotTool(document, {
		image: initial.image, defaultAction: input.defaultAction ?? 'copy',
		windowBounds: initial.windowBounds,
		agentWindow: initial.agentWindow,
		canRetake: initial.kind === 'capture',
		canPin: true,
		state: { help: input.help ?? getScreenshotAccessibilityHelp(initial.agentWindow), accessibilityHints: input.accessibilityHints !== false },
		theme: theme ?? defaultImageEditorTheme(input.colorScheme),
		colorScheme: input.colorScheme ?? 'dark',
	}, complete, signal);
});

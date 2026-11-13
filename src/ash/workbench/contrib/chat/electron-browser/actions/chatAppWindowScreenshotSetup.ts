import { localize } from '../../../../../nls.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IScreenCaptureSetupOptions } from '../../../screenshotTool/electron-browser/screenCaptureSetup.js';

/** Chat owns its permission explanation; permission state and controls belong to the screenshot setup. */
export function getAppWindowScreenshotSetupOptions(): IScreenCaptureSetupOptions {
	return {
		title: localize('appWindowScreenshotSetup.title', 'Attach Screenshots of Other Apps'),
		description: localize('appWindowScreenshotSetup.description', 'Ash captures another app window only when requested. Screen Recording permission allows these screenshots.'),
		help: localize('appWindowScreenshotSetup.help', 'Use Tab and Shift+Tab to reach Allow in Settings, Check Again, Restart Ash, and Close. Returning from System Settings checks permission again. Escape closes setup and preserves the Chat draft.'),
		providerId: AccessibleViewProviderId.AppWindowScreenshotSetup,
		verbositySetting: AccessibilityVerbositySettingId.AppWindowScreenshotSetup,
	};
}

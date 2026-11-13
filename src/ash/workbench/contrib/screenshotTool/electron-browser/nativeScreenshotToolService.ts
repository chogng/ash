import { isMacintosh } from '../../../../base/common/platform.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SCREEN_CAPTURE_PERMISSION_REQUIRED } from '../../../../platform/native/common/native.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INativeHostService } from '../../../common/services.js';
import { IImageEditorService } from '../../../services/imageEditor/common/imageEditorService.js';
import { ScreenshotToolService } from '../browser/screenshotToolService.js';
import type { IScreenshotToolOptions } from '../browser/screenshotTool.js';
import { IScreenCaptureSetupService } from './screenCaptureSetup.js';

/** Ash desktop-wide capture needs OS permission; frozen app pixels and code images need none. */
export class NativeScreenshotToolService extends ScreenshotToolService {
	constructor(
		@IImageEditorService images: IImageEditorService,
		@IConfigurationService configuration: IConfigurationService,
		@INativeHostService private readonly native: INativeHostApi,
		@IScreenCaptureSetupService private readonly setup: IScreenCaptureSetupService,
	) { super(images, configuration); }
	override captureAndEdit(signal: AbortSignal, options: IScreenshotToolOptions = {}): Promise<VSBuffer | undefined> {
		return this.interact(signal, requestSignal => this.withDesktopPermission(options, requestSignal, () => super.captureAndEdit(requestSignal, options)));
	}
	override async show(options: IScreenshotToolOptions, signal: AbortSignal): Promise<void> {
		await this.interact(signal, requestSignal => this.withDesktopPermission(options, requestSignal, () => super.show(options, requestSignal)));
	}
	private async withDesktopPermission<T>(options: IScreenshotToolOptions, signal: AbortSignal, run: () => Promise<T>): Promise<T | undefined> {
		if (signal.aborted || !this.isSupported) return undefined;
		const desktop = !options.image && !options.code;
		const permission = desktop && isMacintosh ? await this.native.getMediaAccessStatus('screen') : 'granted';
		if (signal.aborted || !this.isSupported) return undefined;
		if (permission !== 'granted') {
			await this.showSetup(signal);
			return undefined;
		}
		try { return await run(); }
		catch (error) {
			// Permissions can change after preflight or between retakes. Main remains authoritative.
			if (!desktop || !String(error).includes(SCREEN_CAPTURE_PERMISSION_REQUIRED)) throw error;
			await this.showSetup(signal);
			return undefined;
		}
	}
	private showSetup(signal: AbortSignal): Promise<void> {
		return this.setup.show({
			title: localize('screenshot.setup.title', 'Set Up Desktop Screenshots'),
			description: localize('screenshot.setup.description', 'Ash captures the desktop only when requested. Screen Recording permission allows selecting a region across applications.'),
			help: localize('screenshot.setup.help', 'Use Tab and Shift+Tab to reach Allow in Settings, Check Again, Restart Ash, and Close. Returning from System Settings checks permission again. Escape closes setup. After allowing access, start a new screenshot.'),
			providerId: AccessibleViewProviderId.ScreenCaptureSetup,
			verbositySetting: AccessibilityVerbositySettingId.ChatScreenshot,
		}, signal);
	}
}

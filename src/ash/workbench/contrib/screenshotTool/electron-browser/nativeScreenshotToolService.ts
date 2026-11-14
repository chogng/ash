import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { SCREENSHOT_OPEN_CHANNEL, SCREENSHOT_CANCEL_CHANNEL, SCREENSHOT_PIN_CHANNEL } from '../../../../platform/screenshot/common/screenshot.js';
import { validatePngImage } from '../../../../platform/imageResize/common/imageData.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';
import type { ScreenshotToolInput } from '../browser/screenshotToolView.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { isMacintosh } from '../../../../base/common/platform.js';
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
		@IHostService host: IHostService,
		@IClipboardService clipboard: IClipboardService,
		@IFileDialogService dialogs: IFileDialogService,
		@IFileService files: IFileService,
		@INativeHostService private readonly native: INativeHostApi,
		@IScreenCaptureSetupService private readonly setup: IScreenCaptureSetupService,
	) { super(images, configuration, host, clipboard, dialogs, files); }
	protected override get canPin(): boolean { return true; }
	protected override async pin(image: Uint8Array, input: ScreenshotToolInput): Promise<void> {
		await invoke(SCREENSHOT_PIN_CHANNEL, { image, input: { theme: input.theme, colorScheme: input.colorScheme, accessibilityHints: input.state?.accessibilityHints !== false } });
	}
	protected override async capture(options: IScreenshotToolOptions, signal: AbortSignal): Promise<VSBuffer | undefined> {
		if (options.image || options.code) { return super.capture(options, signal); }
		signal.throwIfAborted();
		const id = createUuid();
		const appearance = this.presentation(options);
		const input = { defaultAction: appearance.defaultAction, theme: appearance.theme, colorScheme: appearance.colorScheme, accessibilityHints: appearance.state?.accessibilityHints !== false, help: appearance.state?.help ?? '' };
		using cancellation = addDisposableListener(signal, 'abort', () => { void invoke(SCREENSHOT_CANCEL_CHANNEL, id).catch(() => { }); }, { once: true });
		try {
			const result = await invoke<unknown>(SCREENSHOT_OPEN_CHANNEL, { id, input: input as unknown as Readonly<Record<string, JsonValue>> });
			if (result === undefined || signal.aborted || this.isDisposed) { return undefined; }
			return VSBuffer.wrap(new Uint8Array(validatePngImage(result)));
		} catch (error) {
			if (String(error).includes('ScreenshotUnavailable')) { throw new Error(localize('screenshot.unavailable', 'Screen capture is unavailable. Try again.')); }
			if (String(error).includes('ScreenshotWindowUnavailable')) { throw new Error(localize('screenshot.overlayUnavailable', 'The screen capture window could not be opened.')); }
			throw error;
		}
	}

	protected override interact<T>(signal: AbortSignal, options: IScreenshotToolOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		return super.interact(signal, options, requestSignal => this.withDesktopPermission(options, requestSignal, () => run(requestSignal)));
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

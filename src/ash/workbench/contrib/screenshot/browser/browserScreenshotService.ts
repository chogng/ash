import { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IScreenshotService, type ScreenshotShortcutStatus } from '../common/screenshot.js';
import { captureBrowserScreenshot } from './screenshotEditor.js';

export class BrowserScreenshotService extends Disposable implements IScreenshotService {
	readonly onDidChangeShortcut = Event.None;
	readonly shortcutStatus: ScreenshotShortcutStatus = { availability: 'unsupported', global: false, activeLabel: '' };
	async checkShortcut(): Promise<void> { }
	private readonly screenshotLifetime = this._register(new MutableDisposable());
	constructor(
		@IHostService private readonly host: IHostService,
		@IConfigurationService private readonly configuration: IConfigurationService
	) {
		super();
	}

	public async captureScreenshot(signal: AbortSignal): Promise<VSBuffer | undefined> {
		this.assertNotDisposed();
		const controller = new AbortController();
		const lifetime = toDisposable(() => controller.abort());
		this.screenshotLifetime.value = lifetime;
		try {
			const result = await captureBrowserScreenshot(
				document,
				async () => (await this.host.getScreenshot())?.buffer,
				AbortSignal.any([signal, controller.signal]),
				this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatScreenshot) !== false
			);
			return result ? VSBuffer.wrap(new Uint8Array(result)) : undefined;
		} finally {
			if (this.screenshotLifetime.value === lifetime) this.screenshotLifetime.clear();
			lifetime.dispose();
		}
	}
}

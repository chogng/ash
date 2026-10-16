import { Emitter } from '../../../../base/common/event.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { toElectronAccelerator } from '../../../../platform/keybinding/common/electronAccelerator.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { createUuid } from '../../../../base/common/uuid.js';
import {
	SCREENSHOT_SHORTCUT_CHANNEL,
	SCREENSHOT_TRIGGER_CHANNEL,
	validateScreenshotShortcutResult,
	SCREENSHOT_CAPTURE_CHANNEL,
	SCREENSHOT_CANCEL_CHANNEL,
	validateScreenshotImage,
	type ScreenshotRequest
} from '../common/screenshotProtocol.js';
import { screenshotStyles } from '../browser/screenshotEditor.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { invoke, subscribe } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import {
	IScreenshotService,
	ScreenshotGlobalShortcutSetting,
	ScreenshotCommandId,
	type ScreenshotShortcutStatus
} from '../common/screenshot.js';

export class DesktopScreenshotService extends Disposable implements IScreenshotService {
	private readonly shortcutChanged = this._register(new Emitter<void>());
	readonly onDidChangeShortcut = this.shortcutChanged.event;
	private shortcut: ScreenshotShortcutStatus = { availability: 'unchecked', global: false, activeLabel: '' };
	get shortcutStatus(): ScreenshotShortcutStatus {
		return this.shortcut;
	}
	private pendingShortcut: Promise<void> = Promise.resolve();
	private shortcutGeneration = 0;
	private readonly desktopCaptureLifetime = this._register(new MutableDisposable());
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@ICommandService commands: ICommandService,
		@ILogService log: ILogService
	) {
		super();
		this._register(
			keybindings.onDidUpdateKeybindings(() => {
				void this.checkShortcut();
			})
		);
		this._register(
			configuration.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(ScreenshotGlobalShortcutSetting)) void this.checkShortcut();
			})
		);
		const trigger = subscribe<unknown>(SCREENSHOT_TRIGGER_CHANNEL, value => {
			if (value !== undefined) throw new TypeError('Unexpected screenshot shortcut event');
			void commands.executeCommand(ScreenshotCommandId).catch(error => log.error('Could not start screenshot from global shortcut', error));
		});
		this._register(toDisposable(() => trigger.dispose()));
	}

	public checkShortcut(): Promise<void> {
		const generation = ++this.shortcutGeneration;
		const operation = this.pendingShortcut.then(async () => {
			if (this.isDisposed || generation !== this.shortcutGeneration) return;
			const binding = this.keybindings.lookupKeybinding(ScreenshotCommandId);
			const accelerator = toElectronAccelerator(binding);
			const global = this.configuration.getValue<boolean>(ScreenshotGlobalShortcutSetting) === true;
			try {
				const result = validateScreenshotShortcutResult(
					await invoke<unknown>(SCREENSHOT_SHORTCUT_CHANNEL, {
						accelerator: accelerator ?? '',
						label: binding ? getKeybindingLabel(binding) : '',
						global: global && !!binding
					})
				);
				if (this.isDisposed || generation !== this.shortcutGeneration) return;
				this.shortcut = {
					global,
					availability: !binding
						? 'unassigned'
						: !accelerator
							? 'unsupported'
							: result.available
								? 'available'
								: 'unavailable',
					activeLabel: result.activeLabel
				};
			} catch (error) {
				if (this.isDisposed || generation !== this.shortcutGeneration) return;
				this.shortcut = { global, availability: 'unknown', activeLabel: '' };
			}
			this.shortcutChanged.fire();
		});
		this.pendingShortcut = operation.catch(() => { });
		return operation;
	}

	public async captureScreenshot(signal: AbortSignal): Promise<VSBuffer | undefined> {
		if (signal.aborted || this.isDisposed) return undefined;
		const id = createUuid();
		const root = document.querySelector('.ash-workbench');
		const colorScheme = root?.getAttribute('data-color-scheme');
		const request: ScreenshotRequest = {
			id,
			styles: screenshotStyles(document),
			colorScheme:
				colorScheme === 'light' || colorScheme === 'hcDark' || colorScheme === 'hcLight' ? colorScheme : 'dark',
			accessibilityHints:
				this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatScreenshot) !== false
		};
		const cancellation = addDisposableListener(signal, 'abort', () => {
			void invoke<void>(SCREENSHOT_CANCEL_CHANNEL, id).catch(() => { });
		});
		const lifetime = toDisposable(() => {
			cancellation.dispose();
			void invoke<void>(SCREENSHOT_CANCEL_CHANNEL, id).catch(() => { });
		});
		this.desktopCaptureLifetime.value = lifetime;
		try {
			const result = await invoke<unknown>(SCREENSHOT_CAPTURE_CHANNEL, request);
			if (signal.aborted || this.isDisposed || result === undefined) return undefined;
			return VSBuffer.wrap(new Uint8Array(validateScreenshotImage(result)));
		} catch (error) {
			const message = String(error);
			if (message.includes('ScreenshotUnavailable'))
				throw new Error(localize('screenshot.unavailable', 'Screen capture is unavailable. Try again.'));
			if (message.includes('ScreenshotTooLarge'))
				throw new Error(localize('chat.screenshot.tooLarge', 'The screenshot is too large to preview.'));
			if (message.includes('ScreenshotOverlayUnavailable'))
				throw new Error(
					localize('screenshot.overlayUnavailable', 'The screen capture window could not be opened.')
				);
			throw error;
		} finally {
			if (this.desktopCaptureLifetime.value === lifetime) this.desktopCaptureLifetime.clear();
			lifetime.dispose();
		}
	}
}

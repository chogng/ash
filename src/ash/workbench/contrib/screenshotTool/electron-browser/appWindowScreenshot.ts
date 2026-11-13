import { addDisposableListener } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import type { IScreenshotToolImage } from '../browser/screenshotTool.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { INativeAppWindow } from '../../../../platform/native/common/native.js';
import { INativeHostService } from '../../../common/services.js';

export interface IAppWindowScreenshotOptions {
	readonly pick?: boolean;
	/** Ash draft acquisition supplies cancellation for a retired composer. */
	readonly signal?: AbortSignal;
}

export type AppWindowScreenshotTarget = 'frontmost' | 'picked' | 'systemPicked';

export type AppWindowScreenshotResult =
	| { readonly kind: 'captured'; readonly target: AppWindowScreenshotTarget; readonly window: INativeAppWindow; readonly image: IScreenshotToolImage; }
	| { readonly kind: 'cancelled' | 'noWindow' | 'permissionRequired'; readonly target: AppWindowScreenshotTarget; }
	| { readonly kind: 'failed'; readonly target: AppWindowScreenshotTarget; readonly window: INativeAppWindow | undefined; };

export type AppWindowScreenshotPermission = 'granted' | 'notGranted' | 'restricted' | 'notRequired';

export interface IAppWindowScreenshotService {
	readonly hasCaptured: boolean;
	readonly onDidChangeHasCaptured: Event<void>;
	getPermission(): Promise<AppWindowScreenshotPermission>;
	requestPermission(): Promise<void>;
	capture(options?: IAppWindowScreenshotOptions): Promise<AppWindowScreenshotResult>;
}

export const IAppWindowScreenshotService = createServiceIdentifier<IAppWindowScreenshotService>('appWindowScreenshotService');

export function getAppWindowLabel(window: INativeAppWindow): string {
	return window.title.trim() || localize('appWindowScreenshot.untitled', 'Untitled Window');
}

/** Owns app-window selection and acquisition; the caller owns editing and the destination draft. */
export class AppWindowScreenshotService implements IAppWindowScreenshotService {
	constructor(
		@INativeHostService private readonly native: INativeHostApi,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService private readonly storage: IStorageService,
	) { }

	public get hasCaptured(): boolean { return this.storage.getBoolean('chat.appWindowScreenshots.captured', StorageScope.APPLICATION, false); }
	public get onDidChangeHasCaptured(): Event<void> {
		return (listener, thisArgs, disposables) => this.storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.APPLICATION && event.key === 'chat.appWindowScreenshots.captured') { listener.call(thisArgs, undefined); }
		}, undefined, disposables);
	}
	public async getPermission(): Promise<AppWindowScreenshotPermission> {
		if (!isMacintosh) { return 'notRequired'; }
		const permission = await this.native.getMediaAccessStatus('screen');
		return permission === 'granted' ? 'granted' : permission === 'restricted' ? 'restricted' : 'notGranted';
	}
	public requestPermission(): Promise<void> { return this.native.requestScreenCaptureAccess(); }

	public async capture(options: IAppWindowScreenshotOptions = {}): Promise<AppWindowScreenshotResult> {
		const signal = options.signal ?? new AbortController().signal;
		const target: AppWindowScreenshotTarget = options.pick ? 'picked' : 'frontmost';
		if (signal.aborted) {
			return { kind: 'cancelled', target };
		}
		const result = await this.native.getAppWindows().catch(() => undefined);
		if (!result) {
			return { kind: 'failed', target, window: undefined };
		}
		if (signal.aborted) {
			return { kind: 'cancelled', target };
		}
		if (result.kind === 'permissionRequired') {
			return { kind: 'permissionRequired', target };
		}
		if (!result.windows.length) {
			await this.native.focusWindow();
			if (signal.aborted) {
				return { kind: 'cancelled', target };
			}
			this.notifications.info(localize('appWindowScreenshot.noWindow', 'No other app has a window to capture.'));
			return { kind: 'noWindow', target };
		}
		let selected = result.windows[0];
		if (options.pick) {
			using lifetime = new DisposableStore();
			const picker = lifetime.add(this.quickInput.createQuickPick<{ label: string; window: INativeAppWindow; }>());
			picker.placeholder = localize('appWindowScreenshot.pick', 'Select an app window to capture');
			picker.items = result.windows.map(window => ({ label: getAppWindowLabel(window), window }));
			const pick = await new Promise<{ window: INativeAppWindow; } | undefined>(resolve => {
				lifetime.add(picker.onDidAccept(() => resolve(picker.selectedItems[0])));
				lifetime.add(picker.onDidHide(() => resolve(undefined)));
				lifetime.add(addDisposableListener(signal, 'abort', () => resolve(undefined), { once: true }));
				if (signal.aborted) {
					resolve(undefined);
				} else {
					picker.show();
				}
			});
			lifetime.dispose();
			if (!pick || signal.aborted) {
				return { kind: 'cancelled', target };
			}
			selected = pick.window;
		}
		const image = await this.native.captureAppWindow(selected, signal).catch(() => undefined);
		if (signal.aborted) {
			return { kind: 'cancelled', target };
		}
		if (!image) {
			const permission = await this.getPermission();
			if (permission === 'notGranted' || permission === 'restricted') { return { kind: 'permissionRequired', target }; }
			return { kind: 'failed', target, window: selected };
		}
		this.storage.store('chat.appWindowScreenshots.captured', true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const bytes = image.buffer;
		const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return {
			kind: 'captured', target, window: selected,
			image: { dataUrl: `data:image/png;base64,${encodeBase64(image)}`, width: header.getUint32(16), height: header.getUint32(20) },
		};
	}
}

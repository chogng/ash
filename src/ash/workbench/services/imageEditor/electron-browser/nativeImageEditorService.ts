import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';
import { IMAGE_VIEW_OPEN_CHANNEL, IMAGE_VIEW_CANCEL_CHANNEL, validateImageViewImage, type ImageViewRequest } from '../../../../platform/imageView/common/imageView.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { localize } from '../../../../nls.js';
import { IImageEditorService, type ImageEditorOptions } from '../common/imageEditorService.js';
import { ImageEditorService } from '../browser/imageEditorService.js';
import { readImageEditorTheme } from '../browser/imageEditorTheme.js';

/** Binds each provider interaction to its native presentation and cancellation lease. */
export class NativeImageEditorService extends ImageEditorService {
	private readonly desktopCaptureLifetime = this._register(new MutableDisposable());
	public async capture(signal: AbortSignal, options?: ImageEditorOptions): Promise<VSBuffer | undefined> {
		if (signal.aborted || this.isDisposed) return undefined;
		const resolved = await this.resolve(options?.code ? 'selection' : 'screen', signal, options?.editorId);
		signal = resolved.signal;
		const id = createUuid();
		const root = document.querySelector('.ash-workbench');
		const colorScheme = root?.getAttribute('data-color-scheme');
		const request: ImageViewRequest = {
			id, title: resolved.displayName, html: resolved.view.html,
			source: options?.code ? 'content' : 'screen',
			input: {
				defaultAction: options?.defaultAction ?? 'attach',
				...(options?.code ? { code: options.code } : {}),
				...(resolved.view.state !== undefined ? { state: resolved.view.state } : {}),
				theme: readImageEditorTheme(document),
				colorScheme: colorScheme === 'light' || colorScheme === 'hcDark' || colorScheme === 'hcLight' ? colorScheme : 'dark',
			} as unknown as Readonly<Record<string, JsonValue>>,
		};
		const cancellation = addDisposableListener(signal, 'abort', () => {
			void invoke<void>(IMAGE_VIEW_CANCEL_CHANNEL, id).catch(() => { });
		});
		const lifetime = toDisposable(() => {
			cancellation.dispose();
			void invoke<void>(IMAGE_VIEW_CANCEL_CHANNEL, id).catch(() => { });
		});
		this.desktopCaptureLifetime.value = lifetime;
		try {
			const result = await invoke<unknown>(IMAGE_VIEW_OPEN_CHANNEL, request);
			if (signal.aborted || this.isDisposed || result === undefined) return undefined;
			return VSBuffer.wrap(new Uint8Array(validateImageViewImage(result)));
		} catch (error) {
			const message = String(error);
			if (message.includes('ScreenshotUnavailable'))
				throw new Error(localize('screenshot.unavailable', 'Screen capture is unavailable. Try again.'));
			if (message.includes('ScreenshotTooLarge'))
				throw new Error(localize('chat.screenshot.tooLarge', 'The screenshot is too large to preview.'));
			if (message.includes('ImageViewUnavailable'))
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

registerSingleton(IImageEditorService, NativeImageEditorService, InstantiationType.Delayed);

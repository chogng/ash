import { BrowserImageEditorService } from '../browser/browserImageEditorService.js';
import { IImageEditorService } from '../common/imageEditorService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { NATIVE_HOST_DESKTOP_SCREENSHOT_CHANNEL } from '../../../../platform/native/common/nativeHost.js';
import { validatePngImage } from '../../../../platform/imageResize/common/imageData.js';

/** Extension HTML uses the shared Webview host; Native contributes only pixel acquisition. */
export class NativeImageEditorService extends BrowserImageEditorService {
	protected override async getImage(signal: AbortSignal): Promise<Uint8Array | undefined> {
		const image = await invoke<unknown>(NATIVE_HOST_DESKTOP_SCREENSHOT_CHANNEL);
		return image !== undefined && !signal.aborted ? validatePngImage(image) : undefined;
	}
}

registerSingleton(IImageEditorService, NativeImageEditorService, InstantiationType.Delayed);

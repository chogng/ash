import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { encodeImageAsPng } from '../../mediaPreview/browser/imageEncoder.js';

/** Use the loaded bytes or decoded local image while the click still grants clipboard access. */
export function copyChatImage(accessor: ServicesAccessor, image: HTMLImageElement, data: Blob | undefined): Promise<void> {
	const clipboard = accessor.get(IClipboardService);
	if (data?.type === 'image/png') {
		return clipboard.writeImage(data.arrayBuffer().then(buffer => new Uint8Array(buffer)));
	}
	const workers = accessor.get(IWebWorkerService);
	return clipboard.writeImage(encodeImageAsPng(image.cloneNode() as HTMLImageElement, workers));
}

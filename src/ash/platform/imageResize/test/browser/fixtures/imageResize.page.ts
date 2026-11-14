import '../../../../../workbench/services/imageResize/browser/imageResizeService.js';
import { IImageResizeService } from '../../../common/imageResizeService.js';
import { InstantiationService } from '../../../../instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../../instantiation/common/extensions.js';
import { ServiceCollection } from '../../../../instantiation/common/serviceCollection.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
const services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors()));
declare global {
	interface Window {
		imageResizeFixture: {
			run(width: number, height: number, maximum?: number, mime?: string, asString?: boolean): Promise<{ width: number; height: number; unchanged: boolean; type: string; alpha: number; }>;
			invalid(): Promise<boolean>;
		};
	}
}
window.imageResizeFixture = {
	async run(width, height, maximum, mime = 'image/png', asString = false) {
		const canvas = document.createElement('canvas');
		canvas.width = width; canvas.height = height;
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'rgba(255, 0, 0, 0.5)';
		context.fillRect(0, 0, width, height);
		const original = new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), mime))).arrayBuffer());
		const source = asString ? `data:${mime};base64,${encodeBase64(VSBuffer.wrap(original))}` : original;
		const bytes = await services.get(IImageResizeService).resizeImage(source, mime, maximum ? { maxDimension: maximum } : undefined);
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
		try {
			canvas.width = bitmap.width; canvas.height = bitmap.height;
			context.drawImage(bitmap, 0, 0);
			return { width: bitmap.width, height: bitmap.height, unchanged: bytes === original, type: bytes[0] === 137 ? 'image/png' : 'image/jpeg', alpha: context.getImageData(0, 0, 1, 1).data[3] };
		} finally { bitmap.close(); }
	},
	async invalid() {
		try { await services.get(IImageResizeService).resizeImage(new Uint8Array([1, 2, 3])); return false; }
		catch { return true; }
	}
};
window.addEventListener('pagehide', () => services.dispose(), { once: true });

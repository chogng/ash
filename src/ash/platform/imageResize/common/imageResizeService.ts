import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const IImageResizeService = createServiceIdentifier<IImageResizeService>('imageResizeMainService');

export interface IImageResizeOptions {
	/** A caller-owned pixel budget. The default limits the longest edge to 768 pixels. */
	readonly maxDimension: number;
}

/** Decodes and scales pixels without owning attachments, persistence, or model selection. */
export interface IImageResizeService {
	readonly _serviceBrand: undefined;
	resizeImage(data: Uint8Array | string, mimeType?: string, options?: IImageResizeOptions): Promise<Uint8Array>;
}

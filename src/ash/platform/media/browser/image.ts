import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';

export interface ImageMetadata {
	readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
	readonly width: number;
	readonly height: number;
}

/** Decode bytes at the import boundary; filenames and declared dimensions are not evidence. */
export async function inspectImage(bytes: Uint8Array): Promise<ImageMetadata> {
	let mediaType: ImageMetadata['mediaType'];
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
		mediaType = 'image/png';
	} else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
		mediaType = 'image/jpeg';
	} else if (new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP') {
		mediaType = 'image/webp';
	} else {
		throw new TypeError(localize('media.image.unsupported', 'Choose a PNG, JPEG or WebP image.'));
	}
	let image: ImageBitmap;
	try {
		image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mediaType }));
	} catch (cause) {
		throw new TypeError(localize('media.image.invalid', 'The image data could not be decoded.'), { cause });
	}
	try {
		return { mediaType, width: image.width, height: image.height };
	} finally {
		image.close();
	}
}

/** The consuming view owns this URL; it is never a saved asset identity. */
export class ImageResource extends AbstractDisposable {
	public readonly url: string;

	constructor(bytes: Uint8Array, mediaType: ImageMetadata['mediaType']) {
		super();
		this.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
	}

	protected override disposeCore(): void {
		URL.revokeObjectURL(this.url);
	}
}

import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { DesignAssetVersion, DesignDocument } from '../common/model/document.js';
import { flattenDesignShapes } from '../common/model/document.js';

export interface DesignImageSource {
	readonly url: string;
	readonly width: number;
	readonly height: number;
}

export function encodeDesignMedia(bytes: Uint8Array): string {
	let value = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) { value += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); }
	return btoa(value);
}

export async function hashDesignMedia(bytes: Uint8Array): Promise<string> {
	return encodeHex(VSBuffer.wrap(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))));
}

/** Decode the original bytes before committing an import; filenames do not establish media type. */
export async function inspectDesignImage(bytes: Uint8Array): Promise<Pick<DesignAssetVersion, 'mediaType' | 'width' | 'height'>> {
	let mediaType: DesignAssetVersion['mediaType'];
	if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) { mediaType = 'image/png'; }
	else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { mediaType = 'image/jpeg'; }
	else if (new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP') { mediaType = 'image/webp'; }
	else { throw new TypeError(localize('sessions.design.imageTypeUnsupported', 'Choose a PNG, JPEG or WebP image.')); }
	const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mediaType }));
	try { return { mediaType, width: image.width, height: image.height }; }
	finally { image.close(); }
}

/** Preview URLs belong to one view; original bytes remain in the document working copy. */
export class DesignMediaPreview extends Disposable {
	private readonly urls = this._register(new DisposableMap<string, ReturnType<typeof toDisposable> & { readonly url: string }>());

	public getSources(document: DesignDocument, read: (version: DesignAssetVersion) => Uint8Array): ReadonlyMap<string, DesignImageSource> {
		const sources = new Map<string, DesignImageSource>();
		const used = new Set<string>();
		for (const shape of flattenDesignShapes(document.shapes)) {
			if (shape.kind !== 'image') { continue; }
			const version = document.assets.find(asset => asset.id === shape.assetId)!.versions.find(version => version.id === shape.assetVersionId)!;
			used.add(version.sha256);
			let resource = this.urls.get(version.sha256);
			if (!resource) {
				const url = URL.createObjectURL(new Blob([new Uint8Array(read(version))], { type: version.mediaType }));
				resource = Object.assign(toDisposable(() => URL.revokeObjectURL(url)), { url });
				this.urls.set(version.sha256, resource);
			}
			sources.set(shape.assetVersionId, { url: resource.url, width: version.width, height: version.height });
		}
		for (const [key] of this.urls) { if (!used.has(key)) { this.urls.deleteAndDispose(key); } }
		return sources;
	}
}

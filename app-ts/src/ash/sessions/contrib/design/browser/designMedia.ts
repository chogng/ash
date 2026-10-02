import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ImageResource } from '../../../../platform/media/browser/image.js';
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

/** Preview URLs belong to one view; original bytes remain in the document working copy. */
export class DesignMediaPreview extends Disposable {
	private readonly urls = this._register(new DisposableMap<string, ImageResource>());

	public getSources(document: DesignDocument, read: (version: DesignAssetVersion) => Uint8Array): ReadonlyMap<string, DesignImageSource> {
		const sources = new Map<string, DesignImageSource>();
		const used = new Set<string>();
		for (const shape of flattenDesignShapes(document.shapes)) {
			if (shape.kind !== 'image') { continue; }
			const version = document.assets.find(asset => asset.id === shape.assetId)!.versions.find(version => version.id === shape.assetVersionId)!;
			used.add(version.sha256);
			let resource = this.urls.get(version.sha256);
			if (!resource) {
				resource = new ImageResource(read(version), version.mediaType);
				this.urls.set(version.sha256, resource);
			}
			sources.set(shape.assetVersionId, { url: resource.url, width: version.width, height: version.height });
		}
		for (const [key] of this.urls) { if (!used.has(key)) { this.urls.deleteAndDispose(key); } }
		return sources;
	}
}

import { encodeHex, VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { ImageResource } from '../../../../../base/browser/image.js';
import type { ArtifactCanvasAssetVersion, ArtifactCanvasDocument } from '../../common/model/artifactCanvasDocument.js';
import { flattenArtifactCanvasShapes } from '../../common/model/artifactCanvasDocument.js';

export interface ArtifactCanvasImageSource {
	readonly url: string;
	/** Embedded image for SVG filter sources, which cannot load blob URLs. */
	readonly embeddedUrl?: string;
	readonly width: number;
	readonly height: number;
}

export function encodeArtifactCanvasMedia(bytes: Uint8Array): string {
	let value = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) { value += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); }
	return btoa(value);
}

export async function hashArtifactCanvasMedia(bytes: Uint8Array): Promise<string> {
	return encodeHex(VSBuffer.wrap(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))));
}

/** Preview URLs belong to one view; original bytes remain in the document working copy. */
export class ArtifactCanvasMediaPreview extends Disposable {
	private readonly embedded = new WeakMap<ImageResource, string>();
	private readonly urls = this._register(new DisposableMap<string, ImageResource>());

	public getSources(document: ArtifactCanvasDocument, read: (version: ArtifactCanvasAssetVersion) => Uint8Array): ReadonlyMap<string, ArtifactCanvasImageSource> {
		const sources = new Map<string, ArtifactCanvasImageSource>();
		const needsEmbedded = flattenArtifactCanvasShapes(document.shapes).some(shape => shape.blendMode === 'plus-darker' || !!shape.effects);
		const used = new Set<string>();
		for (const shape of flattenArtifactCanvasShapes(document.shapes)) {
			if (shape.kind !== 'image') { continue; }
			const version = document.assets.find(asset => asset.id === shape.assetId)!.versions.find(version => version.id === shape.assetVersionId)!;
			used.add(version.sha256);
			let resource = this.urls.get(version.sha256);
			if (!resource) {
				resource = new ImageResource(read(version), version.mediaType);
				this.urls.set(version.sha256, resource);
			}
			if (needsEmbedded && !this.embedded.has(resource)) { this.embedded.set(resource, `data:${version.mediaType};base64,${encodeArtifactCanvasMedia(read(version))}`); }
			sources.set(shape.assetVersionId, { url: resource.url, ...(needsEmbedded ? { embeddedUrl: this.embedded.get(resource) } : {}), width: version.width, height: version.height });
		}
		for (const [key] of this.urls) { if (!used.has(key)) { this.urls.deleteAndDispose(key); } }
		return sources;
	}
}

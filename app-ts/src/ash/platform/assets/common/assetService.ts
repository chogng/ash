import type { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface AssetVersion {
	readonly assetId: string;
	readonly versionId: string;
	readonly name: string;
	readonly source: URI;
	readonly sha256: string;
	readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
	readonly size: number;
	readonly width: number;
	readonly height: number;
}

export interface AssetImport {
	readonly assetId: string;
	readonly versionId: string;
	readonly name: string;
	readonly source: URI;
	readonly bytes: Uint8Array;
}

export const IAssetService = createServiceIdentifier<IAssetService>('assetService');

/** Committed versions outlive windows. Callers choose identities before importing so an unknown
 * publication result can be recovered with getVersion; publication is not a cancellable UI task. */
export interface IAssetService {
	importImage(request: AssetImport): Promise<AssetVersion>;
	getVersion(assetId: string, versionId: string): Promise<AssetVersion>;
	readVersion(version: AssetVersion): Promise<Uint8Array>;
}

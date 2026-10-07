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

export interface AssetCatalogEntry {
	readonly version: AssetVersion;
	readonly addedAt: number;
	readonly favorite: boolean;
	readonly collectionIds: readonly string[];
}

export interface AssetCollection {
	readonly id: string;
	readonly name: string;
}

export interface AssetCatalog {
	readonly entries: readonly AssetCatalogEntry[];
	readonly collections: readonly AssetCollection[];
}

export const IAssetService = createServiceIdentifier<IAssetService>('assetService');

/** Committed versions outlive windows. Callers choose identities before importing so an unknown
 * publication result can be recovered with getVersion; publication is not a cancellable UI task. */
export interface IAssetService {
	getCatalog(): Promise<AssetCatalog>;
	updateEntry(assetId: string, favorite: boolean, collectionIds: readonly string[]): Promise<void>;
	createCollection(collection: AssetCollection): Promise<void>;
	deleteCollection(id: string): Promise<void>;
	importImage(request: AssetImport): Promise<AssetVersion>;
	getVersion(assetId: string, versionId: string): Promise<AssetVersion>;
	readVersion(version: AssetVersion): Promise<Uint8Array>;
}

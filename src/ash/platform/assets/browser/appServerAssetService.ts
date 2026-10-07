import { URI } from '../../../base/common/uri.js';
import { decodeBase64 } from '../../../base/common/buffer.js';
import { localize } from '../../../nls.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import type { AssetVersionResult } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';
import type { AssetCatalog, AssetCollection, AssetImport, AssetVersion, IAssetService } from '../common/assetService.js';

/** Only this adapter handles generated DTOs; the backend owns all committed content and metadata. */
export class AppServerAssetService implements IAssetService {
	constructor(private readonly connection: AppServerProtocolClient) { }

	public async getCatalog(): Promise<AssetCatalog> {
		this.requireAssets();
		try {
			const catalog = await appServerRequest(this.connection, 'asset/catalog', {});
			return { collections: catalog.collections, entries: catalog.entries.map(entry => ({ ...entry, addedAt: Number(entry.addedAt), version: versionFromResult(entry.version) })) };
		} catch (error) { throw assetError(error); }
	}

	public async updateEntry(assetId: string, favorite: boolean, collectionIds: readonly string[]): Promise<void> {
		this.requireAssets();
		try { await appServerRequest(this.connection, 'asset/catalog/update', { assetId, favorite, collectionIds: [...collectionIds] }); }
		catch (error) { throw assetError(error); }
	}

	public async createCollection(collection: AssetCollection): Promise<void> {
		this.requireAssets();
		try { await appServerRequest(this.connection, 'asset/collection/create', collection); }
		catch (error) { throw assetError(error); }
	}

	public async deleteCollection(id: string): Promise<void> {
		this.requireAssets();
		try { await appServerRequest(this.connection, 'asset/collection/delete', { id }); }
		catch (error) { throw assetError(error); }
	}

	public async importImage(request: AssetImport): Promise<AssetVersion> {
		this.requireAssets();
		let uploading = false;
		try {
			const start = await appServerRequest(this.connection, 'asset/import/start', { assetId: request.assetId, versionId: request.versionId, name: request.name, source: request.source.toString(), size: request.bytes.length });
			uploading = true;
			let offset = 0;
			while (offset < request.bytes.length) {
				const chunk = request.bytes.subarray(offset, offset + start.maxChunkBytes);
				const result = await appServerRequest(this.connection, 'asset/import/write', { versionId: request.versionId, offset, dataBase64: bytesToBase64(chunk) });
				if (result.nextOffset !== offset + chunk.length) { throw new Error(localize('assets.invalidResponse', 'The asset service returned inconsistent content.')); }
				offset = result.nextOffset;
			}
			// Finish consumes the upload, including validation failures. Cancellation only applies
			// to the staged bytes; a lost publication response is recovered by its stable identities.
			uploading = false;
			return versionFromResult(await appServerRequest(this.connection, 'asset/import/finish', { versionId: request.versionId }));
		} catch (error) {
			if (uploading) {
				try { await appServerRequest(this.connection, 'asset/import/cancel', { versionId: request.versionId }); }
				catch (cleanupError) { throw new AggregateError([assetError(error), assetError(cleanupError)], localize('assets.cleanupFailed', 'Could not import the asset or release its upload.')); }
			}
			throw assetError(error);
		}
	}

	public async getVersion(assetId: string, versionId: string): Promise<AssetVersion> {
		this.requireAssets();
		try { return versionFromResult(await appServerRequest(this.connection, 'asset/version', { assetId, versionId })); }
		catch (error) { throw assetError(error); }
	}

	public async readVersion(version: AssetVersion): Promise<Uint8Array> {
		this.requireAssets();
		try {
			const bytes = new Uint8Array(version.size);
			let offset = 0;
			while (offset < bytes.length) {
				const result = await appServerRequest(this.connection, 'asset/read', { assetId: version.assetId, versionId: version.versionId, offset, maxBytes: Math.min(192 * 1024, bytes.length - offset) });
				const chunk = decodeBase64(result.dataBase64).buffer;
				if (result.offset !== offset || chunk.length !== result.decodedLength || chunk.length === 0 || chunk.length > bytes.length - offset || result.eof !== (offset + chunk.length === bytes.length)) {
					throw new Error(localize('assets.invalidResponse', 'The asset service returned inconsistent content.'));
				}
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			return bytes;
		} catch (error) { throw assetError(error); }
	}

	private requireAssets(): void {
		if (this.connection.capabilities?.contracts.assets?.version !== 1) { throw new Error(localize('assets.unavailable', 'Connect to an asset service that supports version 1.')); }
	}
}

function versionFromResult(result: AssetVersionResult): AssetVersion {
	return { ...result, source: URI.parse(result.source) };
}

function assetError(error: unknown): unknown {
	if (error instanceof AppServerRemoteError) {
		if (error.errorName === 'AssetInvalidImage') { return new Error(localize('assets.invalidImage', 'Choose a valid PNG, JPEG or WebP image.'), { cause: error }); }
		return new Error(localize('assets.operationFailed', 'Could not complete the asset operation ({0}).', error.errorName), { cause: error });
	}
	return error;
}

function bytesToBase64(bytes: Uint8Array): string {
	let encoded = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) { encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); }
	return btoa(encoded);
}

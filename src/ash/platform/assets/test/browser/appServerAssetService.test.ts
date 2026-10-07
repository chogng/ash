import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { setNlsResolver, resetNlsResolver, formatNlsMessage } from '../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../workbench/services/localization/common/localizationCatalogs.js';
import { AppServerAssetService } from '../../browser/appServerAssetService.js';
import { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../agentHost/test/common/testAppServerProtocol.js';

class Transport implements AppServerTransport {
	public readonly requests: { method: string; params: Record<string, unknown>; }[] = [];
	public failWrite = false;
	public invalidImage = false;
	public supportsAssets = true;
	public favorite = false;
	public collectionIds: string[] = [];
	public collections: { id: string; name: string; }[] = [];
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	private bytes = Buffer.alloc(0);
	private version: Record<string, unknown> = {};

	public on(event: string, listener: (value: unknown) => void): void {
		const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners);
	}
	public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/test' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as { id?: number; method: string; params: Record<string, unknown>; };
		if (request.id === undefined) { return; }
		this.requests.push(request);
		const params = request.params;
		let result: unknown;
		let failure: string | undefined;
		switch (request.method) {
			case 'initialize': {
				const initialized = createTestInitializeResult();
				if (this.supportsAssets) initialized.capabilities.contracts.assets = { version: 1 };
				result = initialized;
				break;
			}
			case 'asset/catalog': result = { entries: this.version.assetId ? [{ version: this.version, addedAt: 1700000000000, favorite: this.favorite, collectionIds: this.collectionIds }] : [], collections: this.collections }; break;
			case 'asset/catalog/update': this.favorite = params.favorite as boolean; this.collectionIds = params.collectionIds as string[]; result = null; break;
			case 'asset/collection/create': this.collections.push(params as { id: string; name: string; }); result = null; break;
			case 'asset/collection/delete': this.collections = this.collections.filter(collection => collection.id !== params.id); result = null; break;
			case 'asset/import/start':
				this.bytes = Buffer.alloc(0);
				this.version = { ...params, sha256: 'a'.repeat(64), mediaType: 'image/png', width: 20, height: 10 };
				result = { maxChunkBytes: 3 }; break;
			case 'asset/import/write':
				if (this.failWrite) { failure = 'AssetCapacity'; break; }
				assert.equal(params.offset, this.bytes.length);
				this.bytes = Buffer.concat([this.bytes, Buffer.from(params.dataBase64 as string, 'base64')]);
				result = { nextOffset: this.bytes.length }; break;
			case 'asset/import/finish':
				if (this.invalidImage) { failure = 'AssetInvalidImage'; break; }
				result = this.version; break;
			case 'asset/import/cancel': result = null; break;
			case 'asset/version': result = this.version; break;
			case 'asset/read': {
				const offset = params.offset as number;
				const chunk = this.bytes.subarray(offset, offset + Math.min(3, params.maxBytes as number));
				result = { offset, dataBase64: chunk.toString('base64'), decodedLength: chunk.length, eof: offset + chunk.length === this.bytes.length }; break;
			}
			default: throw new Error(`Unexpected request: ${request.method}`);
		}
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify(failure ? { jsonrpc: '2.0', id: request.id, error: { code: -32130, message: failure, data: { kind: failure } } } : { jsonrpc: '2.0', id: request.id, result }) });
	}
	private emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(value); } }
}

const request = { assetId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222', name: 'product.png', source: URI.file('/product.png'), bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) };

test('Asset import uses bounded uploads and reads the exact committed version through the generated protocol', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const service = new AppServerAssetService(client);
		const version = await service.importImage(request);
		assert.equal(version.assetId, request.assetId);
		assert.equal(version.versionId, request.versionId);
		assert.equal(version.width, 20);
		assert.equal(version.source.toString(), request.source.toString());
		assert.deepEqual(await service.getVersion(version.assetId, version.versionId), version);
		assert.deepEqual(await service.readVersion(version), request.bytes);
		assert.equal(transport.requests.filter(value => value.method === 'asset/import/write').length, 3);
		assert.equal(transport.requests.filter(value => value.method === 'asset/read').length, 3);
	} finally { client.dispose(); }
});

test('A failed upload is cancelled and a consumed invalid image reports translated errors', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const service = new AppServerAssetService(client);
		transport.failWrite = true;
		await assert.rejects(service.importImage(request), /AssetCapacity/);
		assert.equal(transport.requests.at(-1)!.method, 'asset/import/cancel');
		transport.failWrite = false; transport.invalidImage = true;
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
		await assert.rejects(service.importImage(request), /请选择有效的 PNG、JPEG 或 WebP 图片/);
		assert.equal(transport.requests.at(-1)!.method, 'asset/import/finish');
	} finally { resetNlsResolver(); client.dispose(); }
});

test('Asset operations reject an unsupported backend contract before creating an upload', async () => {
	const transport = new Transport(); transport.supportsAssets = false;
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		await assert.rejects(new AppServerAssetService(client).importImage(request), /supports version 1/);
		assert.equal(transport.requests.length, 1);
	} finally { client.dispose(); }
});


test('Asset catalog adapts generated metadata and sends durable organization operations', async () => {
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const service = new AppServerAssetService(client);
		const version = await service.importImage(request);
		const collection = { id: '33333333-3333-4333-8333-333333333333', name: 'Brand' };
		await service.createCollection(collection);
		await service.updateEntry(version.assetId, true, [collection.id]);
		assert.deepEqual(await service.getCatalog(), { entries: [{ version, addedAt: 1700000000000, favorite: true, collectionIds: [collection.id] }], collections: [collection] });
		await service.deleteCollection(collection.id);
		assert.equal((await service.getCatalog()).collections.length, 0);
	} finally { client.dispose(); }
});

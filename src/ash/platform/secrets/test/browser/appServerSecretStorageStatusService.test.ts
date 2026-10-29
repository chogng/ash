import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { AppServerRemoteError } from '../../../agentHost/common/appServerError.js';
import { unavailableOperation, WebAppServerUnavailableError } from '../../../renderer/browser/disconnectedHost.js';
import {
	createAppServerSecretStorageStatusService,
	createDisconnectedSecretStorageStatusService,
	withSecretStorageErrors,
} from '../../browser/appServerSecretStorageStatusService.js';
import { SecretStorageError, secretStorageMessage, type SecretStorageStatus } from '../../common/secrets.js';
import { setNlsMessages } from '../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../workbench/services/localization/common/localizationCatalogs.js';

test('Secret storage status reads the current backend observation on every query', async () => {
	const states: SecretStorageStatus[] = [
		'available',
		'unavailable',
		'accessDenied',
		'keyMissing',
		'corrupted',
		'migrationFailed',
		'failure',
	];
	let reads = 0;
	const service = createAppServerSecretStorageStatusService({
		async request(definition: { method: string }, params: unknown): Promise<unknown> {
			assert.equal(definition.method, 'secrets/status');
			assert.deepEqual(params, {});
			return { status: states[reads++] };
		},
	} as unknown as AppServerProtocolClient);
	for (const state of states) assert.deepEqual(await service.readState(), { status: state });
	assert.equal(reads, states.length);
});

test('Secret storage adapter converts structured failures to localized domain errors', async () => {
	const failures = [
		['SecretStorageUnavailable', 'unavailable'],
		['SecretStorageAccessDenied', 'accessDenied'],
		['SecretStorageKeyMissing', 'keyMissing'],
		['SecretStorageCorrupted', 'corrupted'],
		['SecretStorageMigrationFailed', 'migrationFailed'],
		['SecretStorageOperationFailed', 'failure'],
	] as const;
	for (const [kind, status] of failures) {
		const remoteError = new AppServerRemoteError(-32094, 'Private backend diagnostic', { kind });
		const service = createAppServerSecretStorageStatusService({
			request: async () => {
				throw remoteError;
			},
		} as unknown as AppServerProtocolClient);
		for (const operation of [
			() => service.readState(),
			() => withSecretStorageErrors(Promise.reject(remoteError)),
		]) {
			await assert.rejects(operation(), error => {
				assert.ok(error instanceof SecretStorageError);
				assert.equal(error.status, status);
				assert.equal(error.message, secretStorageMessage(status));
				assert.doesNotMatch(error.message, /Private backend diagnostic/);
				return true;
			});
		}
	}
});

test('Secret storage adapter preserves unrelated operation and transport errors', async () => {
	for (const original of [
		new Error('Connection closed'),
		new AppServerRemoteError(-32602, 'Invalid parameters', { kind: 'InvalidParams' }),
	]) {
		const service = createAppServerSecretStorageStatusService({
			request: async () => {
				throw original;
			},
		} as unknown as AppServerProtocolClient);
		await assert.rejects(service.readState(), error => error === original);
		await assert.rejects(withSecretStorageErrors(Promise.reject(original)), error => error === original);
	}
	const result = { configured: true };
	assert.equal(await withSecretStorageErrors(Promise.resolve(result)), result);
});

test('Disconnected secret storage status rejects explicitly instead of reporting profile storage health', async () => {
	const service = createDisconnectedSecretStorageStatusService(unavailableOperation);
	await assert.rejects(service.readState(), error => {
		assert.ok(error instanceof WebAppServerUnavailableError);
		assert.equal(error.operation, 'secrets.status');
		return true;
	});
});

test('Secret storage recovery messages retain the Chinese language pack', () => {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	try {
		assert.equal(
			new SecretStorageError('accessDenied').message,
			'凭据存储访问被拒绝。请检查配置目录权限，或使用“授权系统钥匙串”请求访问。后台操作不会显示系统窗口。',
		);
		assert.match(secretStorageMessage('keyMissing'), /已保留加密凭据/);
		assert.match(secretStorageMessage('corrupted'), /已保留存储文件/);
	} finally {
		setNlsMessages('en', {});
	}
});

test('Secret storage controls require separate explicit requests and preserve mode observations', async () => {
	const calls: [string, unknown][] = [];
	const service = createAppServerSecretStorageStatusService({
		async request(definition: { method: string }, params: unknown): Promise<unknown> {
			calls.push([definition.method, params]);
			return { status: 'available', mode: 'file' };
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.readState(), { status: 'available', mode: 'file' });
	assert.deepEqual(calls, [['secrets/status', {}]]);
	await service.authorizeAccess();
	await service.setStorageMode('encrypted');
	assert.deepEqual(calls, [
		['secrets/status', {}],
		['secrets/authorize', {}],
		['secrets/storageMode/set', { mode: 'encrypted' }],
	]);
});

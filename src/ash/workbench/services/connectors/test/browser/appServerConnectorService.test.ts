import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { IConnectorApi } from '../../../../../platform/connectors/common/connectorApi.js';
import { AppServerConnectorService } from '../../browser/appServerConnectorService.js';

test('Connector adapter preserves distinct declaration and runtime identities including unavailable bindings', async () => {
	let runtimeId: string | null = 'runtime-91';
	const api: Pick<IConnectorApi, 'list'> = {
		list: async () => ({
			generation: 3,
			connectors: [
				{
					id: 'account-7',
					displayName: 'Example service',
					description: 'Example tools',
					runtimeServerId: 'declaration-42',
					mcpServerId: runtimeId,
					definitionDigest: 'sha256:definition',
					connectionGeneration: 2,
					enabled: false,
					state: { status: 'disconnected' },
					availableActions: ['connectApiToken'],
					oauthMethods: [],
					credentialCleanupPending: false,
				},
			],
		}),
	};
	using service = new AppServerConnectorService(
		api as IConnectorApi,
		{ subscribe: () => ({ dispose() {} }) } as IServerEventApi,
	);
	assert.deepEqual(await service.list(), {
		generation: 3,
		connectors: [
			{
				id: 'account-7',
				displayName: 'Example service',
				description: 'Example tools',
				mcpDeclarationId: 'declaration-42',
				mcpServerId: 'runtime-91',
				connectionGeneration: 2,
				enabled: false,
				state: { status: 'disconnected' },
				oauthMethods: [],
				canConnectApiToken: true,
				canConnectOAuth: false,
				canDisconnect: false,
				canRefreshOAuth: false,
				canRevokeOAuth: false,
			},
		],
	});
	runtimeId = null;
	assert.equal((await service.list()).connectors[0].mcpServerId, null);
});

test('Connector enablement uses the non-destructive backend operation and retains account projection', async () => {
	const requests: unknown[] = [];
	const api: Pick<IConnectorApi, 'setEnabled'> = {
		setEnabled: async params => {
			requests.push(params);
			return { generation: 5, disposition: 'updated' };
		},
	};
	using service = new AppServerConnectorService(
		api as IConnectorApi,
		{ subscribe: () => ({ dispose() {} }) } as IServerEventApi,
	);
	const connector = {
		id: 'account-7',
		connectionGeneration: 2,
	} as import('../../../../../platform/connectors/common/connectorService.js').ConnectorView;
	await service.setEnabled(connector, 4, false);
	await service.setEnabled(connector, 5, true);
	assert.deepEqual(
		requests.map(request => {
			const { commandId, ...payload } = request as Record<string, unknown>;
			assert.match(String(commandId), /^desktop-connector-enablement-/);
			return payload;
		}),
		[
			{ enabled: false, expectedGeneration: 4, connectorId: 'account-7' },
			{ enabled: true, expectedGeneration: 5, connectorId: 'account-7' },
		],
	);
});

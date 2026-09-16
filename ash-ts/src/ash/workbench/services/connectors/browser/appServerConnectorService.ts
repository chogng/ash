import type { ConnectorConnectionStateDto, ConnectorDto } from "../../../../platform/app-server/common/generated/index.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { IConnectorApi } from "../../../../platform/connectors/common/connectorApi.js";
import type { ConnectorCatalogView, ConnectorState, ConnectorView, IConnectorService } from "../../../../platform/connectors/common/connectorService.js";

export class AppServerConnectorService extends Disposable implements IConnectorService {
	private readonly _onDidChange = this._register(new Emitter<number>());
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly api: IConnectorApi, events: IServerEventApi) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method === "connector/changed") this._onDidChange.fire(event.params.generation);
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	async list(): Promise<ConnectorCatalogView> {
		const result = await this.api.list();
		return { generation: result.generation, connectors: result.connectors.map(connectorView) };
	}

	async connectApiToken(connector: ConnectorView, catalogGeneration: number, input: { readonly accountId: string; readonly accountDisplayName: string; readonly token: string }): Promise<void> {
		await this.api.connectApiToken({
			commandId: `desktop-connector-connect-${crypto.randomUUID()}`,
			expectedGeneration: catalogGeneration,
			connectorId: connector.id,
			connectionGeneration: connector.connectionGeneration + 1,
			accountId: input.accountId,
			accountDisplayName: input.accountDisplayName,
			apiToken: input.token,
		});
	}

	async connectOAuth(connector: ConnectorView, catalogGeneration: number): Promise<void> {
		await this.api.connectOAuth({
			commandId: `desktop-connector-oauth-${crypto.randomUUID()}`,
			expectedGeneration: catalogGeneration,
			connectorId: connector.id,
			connectionGeneration: connector.connectionGeneration + 1,
		});
	}

	async disconnect(connector: ConnectorView, catalogGeneration: number): Promise<void> {
		await this.api.disconnect({
			commandId: `desktop-connector-disconnect-${crypto.randomUUID()}`,
			expectedGeneration: catalogGeneration,
			connectorId: connector.id,
		});
	}

	async refreshOAuth(connector: ConnectorView): Promise<void> {
		await this.api.refreshOAuth(connector.id);
	}

	async revokeOAuth(connector: ConnectorView, catalogGeneration: number): Promise<void> {
		await this.api.revokeOAuth({
			commandId: `desktop-connector-oauth-revoke-${crypto.randomUUID()}`,
			expectedGeneration: catalogGeneration,
			connectorId: connector.id,
		});
	}
}

function connectorView(connector: ConnectorDto): ConnectorView {
	return {
		id: connector.id,
		displayName: connector.displayName,
		description: connector.description,
		connectionGeneration: connector.connectionGeneration,
		state: connectorState(connector.state),
		oauthMethods: connector.oauthMethods,
		canConnectApiToken: connector.availableActions.includes("connectApiToken") || connector.availableActions.includes("reauthorizeApiToken"),
		canConnectOAuth: connector.availableActions.includes("connectOAuth") || connector.availableActions.includes("reauthorizeOAuth"),
		canDisconnect: connector.availableActions.includes("disconnect"),
		canRefreshOAuth: connector.availableActions.includes("refreshOAuth"),
		canRevokeOAuth: connector.availableActions.includes("revokeOAuth"),
	};
}

function connectorState(state: ConnectorConnectionStateDto): ConnectorState {
	switch (state.status) {
		case "disconnected": return { status: "disconnected" };
		case "connecting": return { status: "connecting" };
		case "connected": return { status: "connected", account: { ...state.account } };
		case "unavailable": return { status: "unavailable", reason: state.reason };
		case "reauthorizationRequired": return { status: "reauthorizationRequired", account: { ...state.account } };
	}
}

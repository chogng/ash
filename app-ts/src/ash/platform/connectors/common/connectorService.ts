import type { Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type ConnectorAccount = { readonly id: string; readonly displayName: string };

export type ConnectorState =
	| { readonly status: "disconnected" }
	| { readonly status: "connecting" }
	| { readonly status: "connected"; readonly account: ConnectorAccount }
	| { readonly status: "unavailable"; readonly reason: string }
	| { readonly status: "reauthorizationRequired"; readonly account: ConnectorAccount };

export interface ConnectorView {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly connectionGeneration: number;
	readonly state: ConnectorState;
	readonly oauthMethods: readonly ("browser" | "device")[];
	readonly canConnectApiToken: boolean;
	readonly canConnectOAuth: boolean;
	readonly canDisconnect: boolean;
	readonly canRefreshOAuth: boolean;
	readonly canRevokeOAuth: boolean;
}

export interface ConnectorCatalogView {
	readonly generation: number;
	readonly connectors: readonly ConnectorView[];
}

export interface ConnectorApiTokenInput {
	readonly accountId: string;
	readonly accountDisplayName: string;
	readonly token: string;
}

/** Frontend-owned projection of external-service connection state. */
export interface IConnectorService {
	readonly onDidChange: Event<number>;
	list(): Promise<ConnectorCatalogView>;
	connectApiToken(connector: ConnectorView, catalogGeneration: number, input: ConnectorApiTokenInput): Promise<void>;
	connectOAuth(connector: ConnectorView, catalogGeneration: number): Promise<void>;
	disconnect(connector: ConnectorView, catalogGeneration: number): Promise<void>;
	refreshOAuth(connector: ConnectorView): Promise<void>;
	revokeOAuth(connector: ConnectorView, catalogGeneration: number): Promise<void>;
}

export const IConnectorService = createServiceIdentifier<IConnectorService>("connectorService");

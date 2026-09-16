import type { ResourceMetadataParams, ResourceMetadataResult, ResourceReadParams, ResourceReadResult, ResourceReleaseParams, ServerNotification, SlashCommandDefinition } from "./generated/index.js";
import type { DisposableHandle } from "../../ipc/common/ipc.js";

export type AppServerConnectionState = "stopped" | "starting" | "initializing" | "ready" | "stopping" | "crashed" | "restarting";

/** App Server connection lifecycle visible to a renderer host. */
export interface IAppServerApi {
	getConnectionState(): Promise<AppServerConnectionState>;
	getSlashCommands(): Promise<readonly SlashCommandDefinition[]>;
	onConnectionState(listener: (state: AppServerConnectionState) => void): DisposableHandle;
}

/** Connection-owned opaque resource operations. */
export interface IResourceApi {
	metadata(params: ResourceMetadataParams): Promise<ResourceMetadataResult>;
	read(params: ResourceReadParams): Promise<ResourceReadResult>;
	release(params: ResourceReleaseParams): Promise<void>;
}

/** Canonical App Server notification stream. */
export interface IServerEventApi {
	subscribe(listener: (event: ServerNotification) => void): DisposableHandle;
}

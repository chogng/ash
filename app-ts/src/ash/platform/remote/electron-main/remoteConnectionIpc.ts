import { VSBuffer } from "../../../base/common/buffer.js";
import type { IpcRoute } from "../../ipc/electron-main/trustedIpcRouter.js";
import { nonEmptyString } from "../../ipc/electron-main/ipcValidation.js";
import { record } from "../../ipc/electron-main/ipcValidation.js";
import { REMOTE_CONNECTION_CONNECT_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_LIST_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_REMOVE_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_SAVE_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_UPDATE_CHANNEL } from "../common/remoteConnectionIpc.js";
import { canonicalRemoteConnectionDefinition } from "../common/remoteConnectionService.js";
import { canonicalRemoteConnectionName } from "../common/remoteConnectionService.js";
import type { IRemoteConnectionService } from "../common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../common/remoteConnectionService.js";

const MAX_WORKSPACE_INPUT_BYTES = 1024 * 1024;

/** Trusted IPC routes for managing and selecting named targets without accepting SSH options. */
export function remoteConnectionIpcRoutes(service: IRemoteConnectionService): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: REMOTE_CONNECTION_LIST_CHANNEL,
			validate: emptyParams,
			invoke: () => service.list(),
		},
		{
			channel: REMOTE_CONNECTION_CONNECT_CHANNEL,
			validate: namedParams,
			invoke: params => service.connect((params as { readonly name: string }).name),
		},
		{
			channel: REMOTE_CONNECTION_SAVE_CHANNEL,
			validate: saveParams,
			invoke: params => service.save((params as { readonly connection: RemoteConnectionDefinition }).connection),
		},
		{
			channel: REMOTE_CONNECTION_UPDATE_CHANNEL,
			validate: updateParams,
			invoke: params => {
				const request = params as { readonly originalName: string; readonly connection: RemoteConnectionDefinition };
				return service.update(request.originalName, request.connection);
			},
		},
		{
			channel: REMOTE_CONNECTION_REMOVE_CHANNEL,
			validate: namedParams,
			invoke: params => service.remove((params as { readonly name: string }).name),
		},
	];
}

function emptyParams(value: unknown): undefined {
	if (value !== undefined) throw new Error("Remote connection list does not accept parameters");
	return undefined;
}

function namedParams(value: unknown): { readonly name: string } {
	const params = record(value, ["name"]);
	return { name: canonicalRemoteConnectionName(boundedString(params.name, "name", 64)) };
}

function saveParams(value: unknown): { readonly connection: RemoteConnectionDefinition } {
	const params = record(value, ["connection"]);
	return { connection: connectionDefinition(params.connection) };
}

function updateParams(value: unknown): { readonly originalName: string; readonly connection: RemoteConnectionDefinition } {
	const params = record(value, ["originalName", "connection"]);
	return {
		originalName: canonicalRemoteConnectionName(boundedString(params.originalName, "originalName", 64)),
		connection: connectionDefinition(params.connection),
	};
}

function connectionDefinition(value: unknown): RemoteConnectionDefinition {
	const connection = record(value, ["name", "host", "workspace"]);
	return canonicalRemoteConnectionDefinition({
		name: boundedString(connection.name, "connection.name", 64),
		host: boundedString(connection.host, "connection.host", 253),
		workspace: boundedString(connection.workspace, "connection.workspace", MAX_WORKSPACE_INPUT_BYTES),
	});
}

function boundedString(value: unknown, field: string, maximumBytes: number): string {
	const string = nonEmptyString(value, field);
	if (VSBuffer.fromString(string).byteLength > maximumBytes) throw new Error(`${field} exceeds its maximum encoded length`);
	return string;
}

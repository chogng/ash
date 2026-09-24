import type { IpcRoute } from "../../ipc/electron-main/trustedIpcRouter.js";
import { boundedPositiveInteger, nonEmptyString, record } from "../../ipc/electron-main/ipcValidation.js";
import { REMOTE_TUNNEL_CLOSE_ALL_CHANNEL, REMOTE_TUNNEL_CLOSE_CHANNEL, REMOTE_TUNNEL_LIST_CHANNEL, REMOTE_TUNNEL_OPEN_CHANNEL, type IRemoteTunnelService, type RemoteTunnelOpenRequest } from "../common/remoteTunnelService.js";

/** Trusted IPC routes for the window-scoped Remote tunnel coordinator. */
export function remoteTunnelIpcRoutes(service: IRemoteTunnelService): readonly IpcRoute<unknown, unknown>[] {
	return [
		route({
			channel: REMOTE_TUNNEL_LIST_CHANNEL,
			validate: emptyParams,
			invoke: () => service.list(),
		}),
		route({
			channel: REMOTE_TUNNEL_OPEN_CHANNEL,
			validate: remoteTunnelOpenRequest,
			invoke: request => service.open(request),
		}),
		route({
			channel: REMOTE_TUNNEL_CLOSE_CHANNEL,
			validate: remoteTunnelCloseRequest,
			invoke: request => service.close(request.id),
		}),
		route({
			channel: REMOTE_TUNNEL_CLOSE_ALL_CHANNEL,
			validate: emptyParams,
			invoke: () => service.closeAll(),
		}),
	];
}

function route<P, R>(definition: IpcRoute<P, R>): IpcRoute<unknown, unknown> {
	return {
		channel: definition.channel,
		validate: definition.validate,
		invoke: params => definition.invoke(params as P),
	};
}

function emptyParams(value: unknown): undefined {
	if (value !== undefined) throw new Error("Remote tunnel list does not accept parameters");
	return undefined;
}

function remoteTunnelOpenRequest(value: unknown): RemoteTunnelOpenRequest {
	const params = record(value, ["remotePort"]);
	return { remotePort: boundedPositiveInteger(params.remotePort, "remotePort", 65_535) };
}

function remoteTunnelCloseRequest(value: unknown): { readonly id: string } {
	const params = record(value, ["id"]);
	return { id: nonEmptyString(params.id, "id") };
}

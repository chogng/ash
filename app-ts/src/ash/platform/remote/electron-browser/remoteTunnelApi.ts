import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import { REMOTE_TUNNEL_CHANGED_CHANNEL, REMOTE_TUNNEL_CLOSE_ALL_CHANNEL, REMOTE_TUNNEL_CLOSE_CHANNEL, REMOTE_TUNNEL_LIST_CHANNEL, REMOTE_TUNNEL_OPEN_CHANNEL, type IRemoteTunnelService, type RemoteTunnel, type RemoteTunnelChange, type RemoteTunnelOpenRequest } from "../common/remoteTunnelService.js";

/** Renderer bridge for tunnels whose SSH process remains owned by Electron Main. */
export function createRemoteTunnelApi(): IRemoteTunnelService {
	return {
		list: () => invoke<readonly RemoteTunnel[]>(REMOTE_TUNNEL_LIST_CHANNEL),
		open: (request: RemoteTunnelOpenRequest) => invoke<RemoteTunnel>(REMOTE_TUNNEL_OPEN_CHANNEL, request),
		close: (id: string) => invoke<void>(REMOTE_TUNNEL_CLOSE_CHANNEL, { id }),
		closeAll: () => invoke<void>(REMOTE_TUNNEL_CLOSE_ALL_CHANNEL),
		onDidChange: listener => subscribe<RemoteTunnelChange>(REMOTE_TUNNEL_CHANGED_CHANNEL, listener),
	};
}

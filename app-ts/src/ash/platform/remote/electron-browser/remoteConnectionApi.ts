import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import { REMOTE_CONNECTION_CONNECT_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_LIST_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_REMOVE_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_SAVE_CHANNEL } from "../common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_UPDATE_CHANNEL } from "../common/remoteConnectionIpc.js";
import type { IRemoteConnectionService } from "../common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../common/remoteConnectionService.js";

/** Renderer adapter for the Electron Main-owned named Remote connection lifecycle. */
export function createRemoteConnectionApi(): IRemoteConnectionService {
	return {
		available: true,
		list: () => invoke<readonly RemoteConnectionDefinition[]>(REMOTE_CONNECTION_LIST_CHANNEL),
		save: connection => invoke<RemoteConnectionDefinition>(REMOTE_CONNECTION_SAVE_CHANNEL, { connection }),
		update: (originalName, connection) => invoke<RemoteConnectionDefinition>(REMOTE_CONNECTION_UPDATE_CHANNEL, { originalName, connection }),
		remove: name => invoke<RemoteConnectionDefinition | undefined>(REMOTE_CONNECTION_REMOVE_CHANNEL, { name }),
		connect: name => invoke<void>(REMOTE_CONNECTION_CONNECT_CHANNEL, { name }),
	};
}

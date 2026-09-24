import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type { RemoteConnectionState } from "../../../../platform/remote/common/remote.js";
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import type { IRemoteAgentService } from "../../../services/remote/common/remoteAgentService.js";
import type { RemoteAgentConnection } from "../../../../platform/remote/common/remoteAgentApi.js";
import { StatusbarAlignment, type IStatusbarEntry, type IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { ConnectToRemoteCommandId } from "./remoteActions.js";
import { ReconnectRemoteCommandId } from "./remoteActions.js";

const RemoteStatusPriority = 1_000;

export interface RemoteStatusIndicatorOptions {
	readonly remoteAgentService: IRemoteAgentService;
	readonly statusbarService: IStatusbarService;
	readonly runCommand: (id: string) => unknown;
}

/** Projects the active backend connection into the leading Workbench status item. */
export class RemoteStatusIndicator extends Disposable implements IWorkbenchContribution {
	static readonly ID = "workbench.contrib.remoteStatusIndicator";

	constructor(options: RemoteStatusIndicatorOptions) {
		super();
		let state = options.remoteAgentService.connectionState ?? "connecting";
		let connection = options.remoteAgentService.connection;
		const status = this._register(options.statusbarService.addEntry(remoteStatusEntry(state, connection, options.runCommand), {
			id: "ash.status.remote",
			alignment: StatusbarAlignment.Left,
			priority: RemoteStatusPriority,
		}));
		this._register(options.remoteAgentService.onDidChangeConnectionState(nextState => {
			state = nextState;
			status.update(remoteStatusEntry(state, connection, options.runCommand));
		}));
		this._register(options.remoteAgentService.onDidChangeConnection(nextConnection => {
			connection = nextConnection;
			status.update(remoteStatusEntry(state, connection, options.runCommand));
		}));
	}
}

function remoteStatusEntry(state: RemoteConnectionState, connection: RemoteAgentConnection | undefined, runCommand: (id: string) => unknown): IStatusbarEntry {
	const backend = connection?.kind === "ssh" ? `SSH host ${connection.host}` : "local backend";
	const run = () => runCommand(connection?.kind === "ssh" && state === "disconnected" ? ReconnectRemoteCommandId : ConnectToRemoteCommandId);
	const kind = connection?.kind === "ssh" && state === "connected" ? "remote" : undefined;
	switch (state) {
		case "connected":
			return { kind, icon: lxiconsLibrary.remote, text: "", ariaLabel: `Remote connection to ${backend} is ready`, tooltip: `Connected to ${backend}`, run };
		case "connecting":
			return { kind, icon: lxiconsLibrary.remote, text: "Connecting\u2026", ariaLabel: `Remote connection to ${backend} is connecting`, tooltip: `Connecting to ${backend}`, run };
		case "reconnecting":
			return { kind, icon: lxiconsLibrary.remote, text: "Reconnecting\u2026", ariaLabel: `Remote connection to ${backend} is reconnecting`, tooltip: `Reconnecting to ${backend}`, run };
		case "disconnecting":
			return { kind, icon: lxiconsLibrary.remote, text: "Disconnecting\u2026", ariaLabel: `Remote connection to ${backend} is disconnecting`, tooltip: `Disconnecting from ${backend}`, run };
		case "disconnected":
			return { kind, icon: lxiconsLibrary.remote, text: "Disconnected", ariaLabel: `Remote connection to ${backend} is disconnected`, tooltip: `${backend} is disconnected`, run };
	}
}

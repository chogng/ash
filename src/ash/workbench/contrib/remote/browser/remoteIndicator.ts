import { localize } from '../../../../nls.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type { RemoteConnectionState } from "../../../../platform/remote/common/remote.js";
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import type { IAppServerRemoteAgentService } from "../../../services/remote/common/appServerRemoteAgentService.js";
import type { RemoteAgentConnection } from "../../../../platform/remote/common/remoteAgentApi.js";
import { StatusbarAlignment, type IStatusbarEntry, type IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { ConnectToRemoteCommandId } from "./remoteActions.js";
import { ReconnectRemoteCommandId } from "./remoteActions.js";

const RemoteStatusPriority = 1_000;

export interface RemoteStatusIndicatorOptions {
	readonly remoteAgentService: IAppServerRemoteAgentService;
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
	let backend = localize({ bundle: 'ash.workbench', key: 'remote.indicator.local' }, 'local backend');
	if (connection?.kind === 'ssh') { backend = localize({ bundle: 'ash.workbench', key: 'remote.indicator.ssh' }, 'SSH host {0}', connection.host); }
	if (connection?.kind === 'remote') { backend = localize({ bundle: 'ash.workbench', key: 'remote.indicator.remote' }, 'Remote host {0}', connection.authority); }
	const run = () => runCommand(connection?.kind === "ssh" && state === "disconnected" ? ReconnectRemoteCommandId : ConnectToRemoteCommandId);
	const kind = connection && connection.kind !== "local" && state === "connected" ? "remote" : undefined;
	switch (state) {
		case "connected":
			return { kind, icon: Lxicon.remote, text: "", ariaLabel: localize({ bundle: 'ash.workbench', key: 'remote.indicator.ready' }, 'Remote connection to {0} is ready', backend), tooltip: localize({ bundle: 'ash.workbench', key: 'remote.indicator.connected' }, 'Connected to {0}', backend), run };
		case "connecting":
			return { kind, icon: Lxicon.remote, text: localize({ bundle: 'ash.workbench', key: 'remote.indicator.connectingText' }, 'Connecting…'), ariaLabel: localize({ bundle: 'ash.workbench', key: 'remote.indicator.connecting' }, 'Remote connection to {0} is connecting', backend), tooltip: localize({ bundle: 'ash.workbench', key: 'remote.indicator.connectingTooltip' }, 'Connecting to {0}', backend), run };
		case "reconnecting":
			return { kind, icon: Lxicon.remote, text: localize({ bundle: 'ash.workbench', key: 'remote.indicator.reconnectingText' }, 'Reconnecting…'), ariaLabel: localize({ bundle: 'ash.workbench', key: 'remote.indicator.reconnecting' }, 'Remote connection to {0} is reconnecting', backend), tooltip: localize({ bundle: 'ash.workbench', key: 'remote.indicator.reconnectingTooltip' }, 'Reconnecting to {0}', backend), run };
		case "disconnecting":
			return { kind, icon: Lxicon.remote, text: localize({ bundle: 'ash.workbench', key: 'remote.indicator.disconnectingText' }, 'Disconnecting…'), ariaLabel: localize({ bundle: 'ash.workbench', key: 'remote.indicator.disconnecting' }, 'Remote connection to {0} is disconnecting', backend), tooltip: localize({ bundle: 'ash.workbench', key: 'remote.indicator.disconnectingTooltip' }, 'Disconnecting from {0}', backend), run };
		case "disconnected":
			return { kind, icon: Lxicon.remote, text: localize({ bundle: 'ash.workbench', key: 'remote.indicator.disconnectedText' }, 'Disconnected'), ariaLabel: localize({ bundle: 'ash.workbench', key: 'remote.indicator.disconnected' }, 'Remote connection to {0} is disconnected', backend), tooltip: localize({ bundle: 'ash.workbench', key: 'remote.indicator.disconnectedTooltip' }, '{0} is disconnected', backend), run };
	}
}

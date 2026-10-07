import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type IContextKey, RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { type IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { RemoteConnectionState } from "../../../../platform/remote/common/remote.js";
import type { IRemoteConnectionService } from "../../../../platform/remote/common/remoteConnectionService.js";
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import type { IRemoteAgentService } from "../../../services/remote/common/remoteAgentService.js";

export type RemoteConnectionKind = "unknown" | "local" | "ssh";

export const RemoteConnectionKindContext = new RawContextKey<RemoteConnectionKind>("remoteConnectionKind", "unknown");
export const RemoteConnectionStateContext = new RawContextKey<RemoteConnectionState | "unknown">("remoteConnectionState", "unknown");
export const RemoteConnectionsAvailableContext = new RawContextKey<boolean>("remoteConnectionsAvailable", false);

export interface RemoteContextKeysOptions {
	readonly contextKeyService: IContextKeyService;
	readonly remoteAgentService: IRemoteAgentService;
	readonly remoteConnectionService: IRemoteConnectionService;
}

/** Projects the host-owned connection kind into action enablement without exposing transport state. */
export class RemoteContextKeys extends Disposable implements IWorkbenchContribution {
	static readonly ID = "workbench.contrib.remoteContextKeys";

	private readonly connectionKind: IContextKey<RemoteConnectionKind>;
	private readonly connectionState: IContextKey<RemoteConnectionState | "unknown">;
	private readonly connectionsAvailable: IContextKey<boolean>;

	constructor(options: RemoteContextKeysOptions) {
		super();
		this.connectionKind = RemoteConnectionKindContext.bindTo(options.contextKeyService);
		this.connectionState = RemoteConnectionStateContext.bindTo(options.contextKeyService);
		this.connectionsAvailable = RemoteConnectionsAvailableContext.bindTo(options.contextKeyService);
		this.connectionKind.set(options.remoteAgentService.connection?.kind ?? "unknown");
		this.connectionState.set(options.remoteAgentService.connectionState ?? "unknown");
		this.connectionsAvailable.set(options.remoteConnectionService.available);
		this._register(options.remoteAgentService.onDidChangeConnection(connection => this.connectionKind.set(connection.kind)));
		this._register(options.remoteAgentService.onDidChangeConnectionState(state => this.connectionState.set(state)));
		this._register(toDisposable(() => this.connectionKind.reset()));
		this._register(toDisposable(() => this.connectionState.reset()));
		this._register(toDisposable(() => this.connectionsAvailable.reset()));
	}
}

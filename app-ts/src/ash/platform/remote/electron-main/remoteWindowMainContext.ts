import type { Event } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { AppServerConnectionRelay } from "../../app-server/electron-main/appServerConnectionRelay.js";
import type { IpcRoute } from "../../ipc/electron-main/trustedIpcRouter.js";
import type { IAnyWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import type { IWorkspaceContextMainChangeEvent } from "../../workspaces/electron-main/workspacesMainService.js";
import { REMOTE_AGENT_CONNECTION_CHANGED_CHANNEL } from "../common/remoteAgentApi.js";
import type { IRemoteConnectionService } from "../common/remoteConnectionService.js";
import { REMOTE_TUNNEL_CHANGED_CHANNEL } from "../common/remoteTunnelService.js";
import type { IRemoteTunnelService } from "../common/remoteTunnelService.js";
import { remoteAgentConnection } from "./remoteAgentIpc.js";
import { remoteAgentIpcRoutes } from "./remoteAgentIpc.js";
import type { IRemoteAgentRecoveryMainService } from "./remoteAgentIpc.js";
import { remoteConnectionIpcRoutes } from "./remoteConnectionIpc.js";
import { RemoteConnectionRecoveryCoordinator } from "./remoteConnectionRecoveryCoordinator.js";
import { SshAppServerProcessLauncher } from "./sshAppServerProcessLauncher.js";
import { remoteTunnelIpcRoutes } from "./remoteTunnelIpc.js";

export type RemoteRuntimeRollbackConfirmation = "confirmed" | "cancelled";

/** Electron-independent window operations needed by the Remote Main context. */
export interface IRemoteWindowMainHost {
	send(channel: string, payload: unknown): void;
	confirmRuntimeRollback(): Promise<RemoteRuntimeRollbackConfirmation>;
	reportRuntimeRollbackFailure(message: string): Promise<void>;
}

/** Window-owned Workspace identity observed by Remote transports and projections. */
export interface IRemoteWindowWorkspaceContext {
	readonly onDidChangeWorkspace: Event<IWorkspaceContextMainChangeEvent>;
	getWorkspace(): IAnyWorkspaceIdentifier;
}

export interface RemoteWindowMainContextOptions {
	readonly supervisor: AppServerConnectionRelay;
	readonly workspaceContext: IRemoteWindowWorkspaceContext;
	readonly connections: IRemoteConnectionService;
	readonly tunnels: IRemoteTunnelService & IDisposable;
	readonly host: IRemoteWindowMainHost;
	readonly prepareForRuntimeReplacement?: () => void;
	readonly reportError?: (message: string, error: unknown) => void;
}

/**
 * Owns all Remote capabilities attached to one Workbench window.
 *
 * The context exposes transport-neutral IPC routes, projects Agent/Tunnel
 * changes, closes SSH forwards when the Workspace changes, and keeps runtime
 * rollback scoped to the supervisor backing this exact window.
 */
export class RemoteWindowMainContext extends Disposable {
	readonly ipcRoutes: readonly IpcRoute<unknown, unknown>[];

	constructor(private readonly options: RemoteWindowMainContextOptions) {
		super();
		const recovery = this.createConnectionRecovery();
		this.ipcRoutes = Object.freeze([
			...remoteAgentIpcRoutes(options.supervisor, () => options.workspaceContext.getWorkspace(), recovery),
			...remoteConnectionIpcRoutes(options.connections),
			...remoteTunnelIpcRoutes(options.tunnels),
		]);
		this._register(options.tunnels);
		const tunnelChanges = options.tunnels.onDidChange(change => options.host.send(REMOTE_TUNNEL_CHANGED_CHANNEL, change));
		this._register(toDisposable(() => tunnelChanges.dispose()));
		this._register(options.workspaceContext.onDidChangeWorkspace(() => {
			void options.tunnels.closeAll().catch(error => this.reportError("Failed to close Remote tunnels after Workspace change", error));
		}));
		this._register(options.supervisor.onStateChange(() => {
			options.host.send(REMOTE_AGENT_CONNECTION_CHANGED_CHANNEL, remoteAgentConnection(options.supervisor, options.workspaceContext.getWorkspace()));
		}));
	}

	private createConnectionRecovery(): IRemoteAgentRecoveryMainService | undefined {
		const launcher = this.options.supervisor.options.processLauncher;
		if (!(launcher instanceof SshAppServerProcessLauncher)) return undefined;
		const prepareForRuntimeReplacement = (): void => {
			try {
				this.options.prepareForRuntimeReplacement?.();
			} catch (error) {
				this.reportError("Failed to prepare Remote terminals for runtime replacement", error);
			}
		};
		const coordinator = new RemoteConnectionRecoveryCoordinator(this.options.supervisor, launcher, prepareForRuntimeReplacement);
		return {
			reconnect: () => coordinator.reconnect(),
			rollback: async () => {
				if (!launcher.runtimeRollbackAvailable) throw new Error("Remote runtime rollback is not available for this connection");
				const confirmation = await this.options.host.confirmRuntimeRollback();
				if (confirmation === "cancelled") return { kind: "cancelled" };
				try {
					await coordinator.rollback();
					return { kind: "rolledBack" };
				} catch (error) {
					const message = error instanceof Error ? error.message : "Remote runtime rollback failed";
					try {
						await this.options.host.reportRuntimeRollbackFailure(message.slice(0, 8_000));
					} catch (reportError) {
						this.reportError("Failed to report Remote runtime rollback failure", reportError);
					}
					throw error;
				}
			},
		};
	}

	private reportError(message: string, error: unknown): void {
		if (this.options.reportError) this.options.reportError(message, error);
		else console.error(message, error);
	}
}

import type { DirGrant } from "../../dirPermissions/common/dirPermissionsService.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { AppServerConnectionState } from "../../app-server/common/appServerApi.js";
import { AppServerRemoteError } from "../../app-server/common/appServerError.js";
import type { AppServerConnectionRelay } from "../../app-server/electron-main/appServerConnectionRelay.js";
import { type IWorkspaceRuntimeSwitcher, type IWorkspaceTransitionContext, type IWorkspaceTransitionFailure, type IWorkspaceTransitionRecoveryRouter, WorkspaceTransitionFailureKind, WorkspaceTransitionRecovery } from "./workspaceTransitionMainService.js";

export interface IAppServerWorkspaceTransitionHost {
	getState(): AppServerConnectionState;
	switchWorkspace(root: string, grant: IWorkspaceTransitionContext["grant"], workspaceId: string, previousWorkspaceId: string): Promise<void>;
	onStateChange(listener: (state: AppServerConnectionState) => void): IDisposable;
}

/**
 * Adapts App Server connection lifecycle into Workspace transition semantics.
 *
 * Connection loss is retryable. Busy, unsupported protocol, and runtime
 * rejection remain visible transition failures.
 */
export class AppServerWorkspaceTransitionAdapter implements IWorkspaceRuntimeSwitcher, IWorkspaceTransitionRecoveryRouter {
	constructor(private readonly host: IAppServerWorkspaceTransitionHost) {}

	switchWorkspace({ root, grant, workspace, previous }: IWorkspaceTransitionContext): Promise<void> {
		return this.host.switchWorkspace(root, grant, workspace.id, previous.id);
	}

	classifyRuntimeError(error: unknown): WorkspaceTransitionFailureKind {
		if (error instanceof AppServerRemoteError) {
			switch (error.errorName) {
				case "EnvironmentBusy":
					return WorkspaceTransitionFailureKind.RuntimeBusy;
				case "EnvironmentUnavailable":
				case "MethodNotFound":
					return WorkspaceTransitionFailureKind.RuntimeUnsupported;
				default:
					return WorkspaceTransitionFailureKind.RuntimeRejected;
			}
		}
		if (
			this.host.getState() !== "ready"
			|| (error instanceof Error && /connection closed|stdout ended|exited|not ready/i.test(error.message))
		) {
			return WorkspaceTransitionFailureKind.RuntimeUnavailable;
		}
		return WorkspaceTransitionFailureKind.RuntimeRejected;
	}

	async recover(failure: IWorkspaceTransitionFailure): Promise<WorkspaceTransitionRecovery> {
		if (failure.kind !== WorkspaceTransitionFailureKind.RuntimeUnavailable) {
			return WorkspaceTransitionRecovery.KeepCurrent;
		}
		try {
			await this.waitUntilReady({ timeoutMs: 10_000 });
			return WorkspaceTransitionRecovery.Retry;
		} catch {
			return WorkspaceTransitionRecovery.KeepCurrent;
		}
	}

	private waitUntilReady(options: IWaitUntilReadyOptions): Promise<void> {
		const state = this.host.getState();
		if (state === "ready") return Promise.resolve();
		if (state === "stopped" || state === "stopping") {
			return Promise.reject(new Error(`App Server cannot recover from ${state}`));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let subscription: IDisposable | undefined;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				subscription?.dispose();
				if (error) reject(error);
				else resolve();
			};
			const timeout = setTimeout(() => {
				finish(new Error("Timed out waiting for App Server recovery"));
			}, options.timeoutMs);
			timeout.unref();
			subscription = this.host.onStateChange((nextState) => {
				if (nextState === "ready") {
					finish();
				} else if (nextState === "stopped" || nextState === "stopping") {
					finish(new Error(`App Server recovery stopped in ${nextState}`));
				}
			});
		});
	}
}

interface IWaitUntilReadyOptions {
	readonly timeoutMs: number;
}

export function createAppServerWorkspaceTransitionAdapter(
	supervisor: AppServerConnectionRelay,
	switchWorkspace: (root: string, grant: DirGrant, workspaceId: string, previousWorkspaceId: string) => Promise<void>,
): AppServerWorkspaceTransitionAdapter {
	return new AppServerWorkspaceTransitionAdapter({
		getState: () => supervisor.state,
		switchWorkspace,
		onStateChange: (listener) => supervisor.onStateChange(listener),
	});
}

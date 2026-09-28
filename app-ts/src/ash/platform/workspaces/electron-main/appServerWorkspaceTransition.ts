import type { RendererWorkspaceHost } from './rendererWorkspaceHost.js';
import { type DirPermission, type DirGrant } from "../../dirPermissions/common/dirPermissionsService.js";
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

export async function readAppServerDirPermissions(workspace: RendererWorkspaceHost, path: string): Promise<readonly DirPermission[] | undefined> {
	const result = { permissions: await workspace.readPermissions(path) };
	return result.permissions ?? undefined;
}

export async function createUserDirGrant(workspace: RendererWorkspaceHost, path: string, permissions: readonly DirPermission[]): Promise<DirGrant> {
	return workspace.createGrant(path, permissions);
}

/** Persists a user grant before the window reconnects to its new directory root. */
export async function persistAppServerDirectoryGrant(workspace: RendererWorkspaceHost, path: string, grant: DirGrant): Promise<void> {
	await workspace.persistDirectoryGrant(path, grant);
}

export interface IAppServerWorkspaceFolder {
	readonly id: string;
	readonly path: string;
	readonly grant: DirGrant;
}

/** Atomically replaces the App Server's ordered workspace-folder collection. */
export async function setAppServerWorkspaceFolders(workspace: RendererWorkspaceHost, folders: readonly IAppServerWorkspaceFolder[]): Promise<void> {
	await workspace.setFolders(folders);
}

import type { DirGrant } from "../../dirPermissions/common/dirPermissionsService.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { AppServerConnectionState } from "../../agentHost/common/appServerApi.js";
import { AppServerRemoteError } from "../../agentHost/common/appServerError.js";
import type { AppServerConnectionRelay } from "../../agentHost/electron-main/appServerConnectionRelay.js";
import { AppServerDaemonLauncher } from '../../app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { RemoteAppServerProcessLauncher } from '../../remote/electron-main/remoteAppServerProcessLauncher.js';
import type { RendererWorkspaceHost } from './rendererWorkspaceHost.js';
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
	constructor(private readonly host: IAppServerWorkspaceTransitionHost) { }

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
	workspaceHost: RendererWorkspaceHost,
): AppServerWorkspaceTransitionAdapter {
	resolveWorkspaceLauncher(supervisor);
	return new AppServerWorkspaceTransitionAdapter({
		getState: () => supervisor.state,
		switchWorkspace: (root, grant, workspaceId, previousWorkspaceId) => reconnectAppServerWorkspace(supervisor, workspaceHost, root, grant, workspaceId, previousWorkspaceId),
		onStateChange: (listener) => supervisor.onStateChange(listener),
	});
}

/** Replaces the window's authority and restores the previous connection if the new scope fails. */
export async function reconnectAppServerWorkspace(
	supervisor: AppServerConnectionRelay,
	workspaceHost: RendererWorkspaceHost,
	root: string | undefined,
	grant: DirGrant,
	workspaceId: string,
	previousWorkspaceId: string,
): Promise<void> {
	const launcher = resolveWorkspaceLauncher(supervisor);
	const previous = launcher instanceof AppServerDaemonLauncher
		? { kind: 'local' as const, launcher, environment: launcher.environment, root: launcher.environment.ASH_WORKSPACE_ROOT }
		: { kind: 'remote' as const, launcher, root: launcher.workspaceRoot };
	if (root !== undefined) {
		await workspaceHost.persistDirectoryGrant(root, grant);
	}
	// Only this window's connection is replaced; the shared profile backend keeps running.
	await supervisor.stop();
	if (previous.kind === 'local') {
		const environment = { ...previous.environment };
		if (root === undefined) {
			delete environment.ASH_WORKSPACE_ROOT;
			delete environment.ASH_DIR_GRANT_SOURCE;
		} else {
			environment.ASH_WORKSPACE_ROOT = root;
			environment.ASH_DIR_GRANT_SOURCE = 'userConfig';
		}
		previous.launcher.replaceEnvironment(environment);
	} else {
		previous.launcher.replaceWorkspaceRoot(root);
	}
	try {
		await supervisor.start();
		await workspaceHost.setFolders(root === undefined ? [] : [{ id: workspaceId, path: root, grant: { type: 'config' } }]);
	} catch (error) {
		await supervisor.stop();
		if (previous.kind === 'local') {
			previous.launcher.replaceEnvironment(previous.environment);
		} else {
			previous.launcher.replaceWorkspaceRoot(previous.root);
		}
		try {
			await supervisor.start();
			await workspaceHost.setFolders(previous.root
				? [{ id: previousWorkspaceId, path: previous.root, grant: { type: 'config' } }]
				: []);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], 'Workspace authority switch and rollback both failed');
		}
		throw error;
	}
}

function resolveWorkspaceLauncher(supervisor: AppServerConnectionRelay): AppServerDaemonLauncher | RemoteAppServerProcessLauncher {
	const launcher = supervisor.options.enabled ? supervisor.options.processLauncher : undefined;
	if (!(launcher instanceof AppServerDaemonLauncher) && !(launcher instanceof RemoteAppServerProcessLauncher)) {
		throw new Error('Workspace connection has no directory launcher');
	}
	return launcher;
}

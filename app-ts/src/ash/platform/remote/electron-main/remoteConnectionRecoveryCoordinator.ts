import type { AppServerConnectionState } from "../../app-server/common/appServerApi.js";
import type { RemoteAgentReconnectResult } from "../common/remoteAgentApi.js";
import type { SshAppServerProcessLauncher } from "./sshAppServerProcessLauncher.js";

export interface RemoteConnectionRecoveryHost {
	readonly state: AppServerConnectionState;
	start(): Promise<void>;
	stop(): Promise<void>;
}

/** Serializes manual reconnect and verified runtime replacement for one Remote window. */
export class RemoteConnectionRecoveryCoordinator {
	private operation: Promise<unknown> | undefined;

	constructor(
		private readonly host: RemoteConnectionRecoveryHost,
		private readonly launcher: SshAppServerProcessLauncher,
		private readonly prepareForConnectionReplacement: () => void = () => {},
	) {}

	reconnect(): Promise<RemoteAgentReconnectResult> {
		return this.runExclusive(() => this.performReconnect());
	}

	rollback(): Promise<void> {
		return this.runExclusive(() => this.performRollback());
	}

	private runExclusive<T>(operationFactory: () => Promise<T>): Promise<T> {
		if (this.operation) return Promise.reject(new Error("Remote connection recovery is already in progress"));
		const operation = operationFactory();
		this.operation = operation;
		void operation.finally(() => {
			if (this.operation === operation) this.operation = undefined;
		}).catch(() => {
			// The caller observes the original operation; this branch only settles finally().
		});
		return operation;
	}

	private async performReconnect(): Promise<RemoteAgentReconnectResult> {
		switch (this.host.state) {
			case "ready":
				return { kind: "alreadyConnected" };
			case "crashed":
				await this.host.stop();
				break;
			case "stopped":
				break;
			case "starting":
			case "initializing":
			case "stopping":
			case "restarting":
				throw new Error(`Remote connection is already transitioning: ${this.host.state}`);
		}
		await this.host.start();
		return { kind: "reconnected" };
	}

	private async performRollback(): Promise<void> {
		if (!this.launcher.runtimeRollbackAvailable) throw new Error("Remote runtime rollback is not available for this connection");
		await this.launcher.rollbackRuntime();
		this.prepareForConnectionReplacement();
		await this.host.stop();
		await this.host.start();
	}
}

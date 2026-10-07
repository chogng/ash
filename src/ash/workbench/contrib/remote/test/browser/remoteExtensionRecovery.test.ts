import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { RemoteConnectionState } from "../../../../../platform/remote/common/remote.js";
import type { RemoteAgentConnection } from "../../../../../platform/remote/common/remoteAgentApi.js";
import { RemoteExtensionRecoveryContribution } from "../../browser/remoteExtensionRecovery.js";
import type { IExtensionService } from "../../../../services/extensions/common/extensionService.js";
import type { IRemoteAgentService } from "../../../../services/remote/common/remoteAgentService.js";

test("remote extension recovery reloads only after a known non-connected state", async () => {
	using remoteAgentService = new TestRemoteAgentService();
	let reloads = 0;
	const extensionService = { reload: async () => { reloads += 1; } } as unknown as IExtensionService;
	using contribution = new RemoteExtensionRecoveryContribution({ extensionService, remoteAgentService });

	remoteAgentService.emit("connected");
	remoteAgentService.emit("reconnecting");
	remoteAgentService.emit("connected");
	remoteAgentService.emit("connected");
	await Promise.resolve();

	assert.equal(reloads, 1);
});

class TestRemoteAgentService extends Disposable implements IRemoteAgentService {
	private readonly stateEmitter = this._register(new Emitter<RemoteConnectionState>());
	private readonly connectionEmitter = this._register(new Emitter<RemoteAgentConnection>());
	connectionState: RemoteConnectionState | undefined;
	connection: RemoteAgentConnection | undefined;
	readonly onDidChangeConnectionState = this.stateEmitter.event;
	readonly onDidChangeConnection = this.connectionEmitter.event;
	async reconnect() { return { kind: "reconnected" } as const; }
	async rollbackRuntime() { return { kind: "rolledBack" } as const; }

	emit(state: RemoteConnectionState): void {
		this.connectionState = state;
		this.stateEmitter.fire(state);
	}
}

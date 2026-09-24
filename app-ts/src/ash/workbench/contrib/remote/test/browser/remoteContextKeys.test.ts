import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { isMenuItem, MenuId, MenusRegistry } from "../../../../../platform/actions/common/actions.js";
import type { RemoteConnectionState } from "../../../../../platform/remote/common/remote.js";
import type { RemoteAgentConnection } from "../../../../../platform/remote/common/remoteAgentApi.js";
import type { IRemoteConnectionService } from "../../../../../platform/remote/common/remoteConnectionService.js";
import { ContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { ConnectToRemoteCommandId, ManageRemoteConnectionsCommandId, ReconnectRemoteCommandId, RollbackRemoteRuntimeCommandId } from "../../browser/remoteActions.js";
import { RemoteConnectionKindContext, RemoteConnectionsAvailableContext, RemoteConnectionStateContext, RemoteContextKeys } from "../../browser/remoteContextKeys.js";
import type { IRemoteAgentService } from "../../../../services/remote/common/remoteAgentService.js";

test("Remote context keys track sanitized connection kind and lifecycle", () => {
	using contextKeyService = new ContextKeyService();
	using remoteAgentService = new TestRemoteAgentService();
	using contribution = new RemoteContextKeys({ contextKeyService, remoteAgentService, remoteConnectionService: TestRemoteConnectionService });

	assert.equal(contextKeyService.contextMatchesRules(RemoteConnectionKindContext.isEqualTo("ssh")), false);
	remoteAgentService.emit({ kind: "ssh", generation: 4, authority: "ssh+work-server", host: "work-server" });
	assert.equal(contextKeyService.contextMatchesRules(RemoteConnectionKindContext.isEqualTo("ssh")), true);
	remoteAgentService.emitState("disconnected");
	assert.equal(contextKeyService.contextMatchesRules(RemoteConnectionStateContext.isEqualTo("disconnected")), true);
	remoteAgentService.emit({ kind: "local", generation: 5 });
	assert.equal(contextKeyService.contextMatchesRules(RemoteConnectionKindContext.isEqualTo("local")), true);
});

test("Remote reconnect appears only for a disconnected SSH context", () => {
	const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(candidate => isMenuItem(candidate) && candidate.command.id === ReconnectRemoteCommandId);
	assert.ok(item && isMenuItem(item));
	using contextKeyService = new ContextKeyService();

	contextKeyService.setContext(RemoteConnectionKindContext.key, "ssh");
	contextKeyService.setContext(RemoteConnectionStateContext.key, "connected");
	assert.equal(contextKeyService.contextMatchesRules(item.when), false);
	contextKeyService.setContext(RemoteConnectionStateContext.key, "disconnected");
	assert.equal(contextKeyService.contextMatchesRules(item.when), true);
	contextKeyService.setContext(RemoteConnectionKindContext.key, "local");
	assert.equal(contextKeyService.contextMatchesRules(item.when), false);
});

test("Remote connection selection appears only when the renderer has a native connection host", () => {
	const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(candidate => isMenuItem(candidate) && candidate.command.id === ConnectToRemoteCommandId);
	assert.ok(item && isMenuItem(item));
	using contextKeyService = new ContextKeyService();

	assert.equal(contextKeyService.contextMatchesRules(item.when), false);
	contextKeyService.setContext(RemoteConnectionsAvailableContext.key, true);
	assert.equal(contextKeyService.contextMatchesRules(item.when), true);
});

test("Remote connection management appears only when the renderer has a native connection host", () => {
	const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(candidate => isMenuItem(candidate) && candidate.command.id === ManageRemoteConnectionsCommandId);
	assert.ok(item && isMenuItem(item));
	using contextKeyService = new ContextKeyService();

	assert.equal(contextKeyService.contextMatchesRules(item.when), false);
	contextKeyService.setContext(RemoteConnectionsAvailableContext.key, true);
	assert.equal(contextKeyService.contextMatchesRules(item.when), true);
});

test("Remote runtime rollback appears in the Command Palette only for SSH context", () => {
	const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(candidate => isMenuItem(candidate) && candidate.command.id === RollbackRemoteRuntimeCommandId);
	assert.ok(item && isMenuItem(item));
	using contextKeyService = new ContextKeyService();

	assert.equal(contextKeyService.contextMatchesRules(item.when), false);
	contextKeyService.setContext(RemoteConnectionKindContext.key, "ssh");
	assert.equal(contextKeyService.contextMatchesRules(item.when), true);
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

	emit(connection: RemoteAgentConnection): void {
		this.connection = connection;
		this.connectionEmitter.fire(connection);
	}

	emitState(state: RemoteConnectionState): void {
		this.connectionState = state;
		this.stateEmitter.fire(state);
	}
}

const TestRemoteConnectionService: IRemoteConnectionService = {
	available: true,
	list: async () => [],
	save: async connection => connection,
	update: async (_originalName, connection) => connection,
	remove: async () => undefined,
	connect: async () => {},
};

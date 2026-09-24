import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { AppServerConnectionState, IAppServerApi } from "../../../../../platform/app-server/common/appServerApi.js";
import type { RemoteConnectionState } from "../../../../../platform/remote/common/remote.js";
import type { IRemoteAgentApi, RemoteAgentConnection } from "../../../../../platform/remote/common/remoteAgentApi.js";
import { AppServerRemoteAgentService } from "../../browser/appServerRemoteAgentService.js";

test("remote agent events supersede a stale initial App Server read", async () => {
	using api = new TestAppServerApi();
	const states: RemoteConnectionState[] = [];
	using service = new AppServerRemoteAgentService({ api, onReadError: error => { throw error; } });
	service.onDidChangeConnectionState(state => states.push(state));

	api.emit("restarting");
	api.emit("ready");
	api.resolveInitial("starting");
	await settlePromises();

	assert.deepEqual(states, ["reconnecting", "connected"]);
	assert.equal(service.connectionState, "connected");
});

test("remote agent collapses backend states into the frontend connection lifecycle", async () => {
	using api = new TestAppServerApi();
	const states: RemoteConnectionState[] = [];
	using service = new AppServerRemoteAgentService({ api, onReadError: error => { throw error; } });
	service.onDidChangeConnectionState(state => states.push(state));

	api.resolveInitial("starting");
	await settlePromises();
	api.emit("initializing");
	api.emit("ready");
	api.emit("stopping");
	api.emit("stopped");

	assert.deepEqual(states, ["connecting", "connected", "disconnecting", "disconnected"]);
});

test("remote agent suppresses pending reads and events after disposal", async () => {
	using api = new TestAppServerApi();
	const states: RemoteConnectionState[] = [];
	const service = new AppServerRemoteAgentService({ api, onReadError: error => { throw error; } });
	service.onDidChangeConnectionState(state => states.push(state));

	await Promise.resolve();
	assert.equal(api.connectionStateReads, 1);
	service.dispose();
	api.resolveInitial("ready");
	api.emit("crashed");
	await settlePromises();

	assert.deepEqual(states, []);
});

test("remote agent metadata events supersede a stale connection read", async () => {
	using api = new TestAppServerApi();
	using remoteApi = new TestRemoteAgentApi();
	using service = new AppServerRemoteAgentService({ api, remoteApi, onReadError: error => { throw error; } });
	const connections: RemoteAgentConnection[] = [];
	service.onDidChangeConnection(connection => connections.push(connection));

	remoteApi.emit({ kind: "ssh", generation: 2, authority: "ssh+work-server", host: "work-server" });
	remoteApi.resolveInitial({ kind: "local", generation: 1 });
	await settlePromises();

	assert.deepEqual(connections, [{ kind: "ssh", generation: 2, authority: "ssh+work-server", host: "work-server" }]);
	assert.deepEqual(service.connection, connections[0]);
});

test("remote agent delegates path-free runtime rollback only for SSH connections", async () => {
	using api = new TestAppServerApi();
	using remoteApi = new TestRemoteAgentApi();
	using service = new AppServerRemoteAgentService({ api, remoteApi, onReadError: error => { throw error; } });
	remoteApi.emit({ kind: "ssh", generation: 2, authority: "ssh+work-server", host: "work-server" });

	assert.deepEqual(await service.reconnect(), { kind: "reconnected" });
	assert.deepEqual(await service.rollbackRuntime(), { kind: "rolledBack" });
	assert.equal(remoteApi.reconnects, 1);
	assert.equal(remoteApi.rollbacks, 1);

	remoteApi.emit({ kind: "local", generation: 3 });
	await assert.rejects(() => service.reconnect(), /SSH Remote Workspace/);
	await assert.rejects(() => service.rollbackRuntime(), /SSH Remote Workspace/);
	assert.equal(remoteApi.reconnects, 1);
	assert.equal(remoteApi.rollbacks, 1);
});

class TestAppServerApi extends Disposable implements IAppServerApi {
	private readonly stateEmitter = this._register(new Emitter<AppServerConnectionState>());
	private readonly initial = deferred<AppServerConnectionState>();
	connectionStateReads = 0;

	getConnectionState(): Promise<AppServerConnectionState> { this.connectionStateReads += 1; return this.initial.promise; }
	async getSlashCommands() { return []; }
	onConnectionState(listener: (state: AppServerConnectionState) => void) { return this.stateEmitter.event(listener); }
	emit(state: AppServerConnectionState): void { this.stateEmitter.fire(state); }
	resolveInitial(state: AppServerConnectionState): void { this.initial.resolve(state); }
}

class TestRemoteAgentApi extends Disposable implements IRemoteAgentApi {
	private readonly connectionEmitter = this._register(new Emitter<RemoteAgentConnection>());
	private readonly initial = deferred<RemoteAgentConnection>();
	reconnects = 0;
	rollbacks = 0;

	getConnection(): Promise<RemoteAgentConnection> { return this.initial.promise; }
	async reconnect() { this.reconnects += 1; return { kind: "reconnected" } as const; }
	async rollbackRuntime() { this.rollbacks += 1; return { kind: "rolledBack" } as const; }
	onDidChangeConnection(listener: (connection: RemoteAgentConnection) => void) { return this.connectionEmitter.event(listener); }
	emit(connection: RemoteAgentConnection): void { this.connectionEmitter.fire(connection); }
	resolveInitial(connection: RemoteAgentConnection): void { this.initial.resolve(connection); }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

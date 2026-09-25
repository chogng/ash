import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import type { RemoteConnectionState } from "../../../../../platform/remote/common/remote.js";
import type { RemoteAgentConnection } from "../../../../../platform/remote/common/remoteAgentApi.js";
import { RemoteStatusIndicator } from "../../browser/remoteIndicator.js";
import { ConnectToRemoteCommandId } from "../../browser/remoteActions.js";
import { ReconnectRemoteCommandId } from "../../browser/remoteActions.js";
import type { IRemoteAgentService } from "../../../../services/remote/common/remoteAgentService.js";
import { StatusbarAlignment, StatusbarService } from "../../../../services/statusbar/browser/statusbar.js";

test("remote indicator owns the leading clickable left status entry", async () => {
	using remoteAgentService = new TestRemoteAgentService("connected");
	using statusbarService = new StatusbarService();
	const commands: string[] = [];
	statusbarService.addEntry({ text: "main" }, { id: "ash.status.git.branch", alignment: StatusbarAlignment.Left, priority: 900 });
	using indicator = new RemoteStatusIndicator({ remoteAgentService, runCommand: commandRunner(commands), statusbarService });

	const entries = statusbarService.getEntries(StatusbarAlignment.Left);
	assert.deepEqual(entries.map(entry => entry.id), ["ash.status.remote", "ash.status.git.branch"]);
	assert.equal(entries[0]?.entry.kind, undefined);
	assert.equal(entries[0]?.entry.icon, Lxicon.remote);
	assert.equal(entries[0]?.entry.text, "");
	assert.equal(entries[0]?.entry.ariaLabel, "Remote connection to local backend is ready");
	await entries[0]?.entry.run?.();
	assert.deepEqual(commands, [ConnectToRemoteCommandId]);
});

test("remote indicator projects connection changes and reconnects a disconnected SSH host", async () => {
	using remoteAgentService = new TestRemoteAgentService("connecting");
	using statusbarService = new StatusbarService();
	const commands: string[] = [];
	const indicator = new RemoteStatusIndicator({ remoteAgentService, runCommand: commandRunner(commands), statusbarService });

	assert.equal(statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.text, "Connecting\u2026");
	remoteAgentService.emit("reconnecting");
	assert.equal(statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.text, "Reconnecting\u2026");
	remoteAgentService.emit("disconnected");
	assert.equal(statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.text, "Disconnected");
	assert.equal(statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.kind, undefined);
	remoteAgentService.emitConnection({ kind: "ssh", generation: 2, authority: "ssh+work-server", host: "work-server" });
	assert.equal(statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.tooltip, "SSH host work-server is disconnected");
	assert.equal(statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.kind, undefined);
	await statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.();
	assert.deepEqual(commands, [ReconnectRemoteCommandId]);
	remoteAgentService.emit("connected");
	assert.equal(statusbarService.getEntries(StatusbarAlignment.Left)[0]?.entry.kind, "remote");

	indicator.dispose();
	assert.deepEqual(statusbarService.getEntries(StatusbarAlignment.Left), []);
});

function commandRunner(commands: string[]): (id: string) => void {
	return id => {
		commands.push(id);
	};
}

class TestRemoteAgentService extends Disposable implements IRemoteAgentService {
	private readonly stateEmitter = this._register(new Emitter<RemoteConnectionState>());
	private readonly connectionEmitter = this._register(new Emitter<RemoteAgentConnection>());
	readonly onDidChangeConnectionState = this.stateEmitter.event;
	readonly onDidChangeConnection = this.connectionEmitter.event;
	async reconnect() { return { kind: "reconnected" } as const; }
	async rollbackRuntime() { return { kind: "rolledBack" } as const; }
	connection: RemoteAgentConnection | undefined = { kind: "local", generation: 1 };

	constructor(public connectionState: RemoteConnectionState | undefined) { super(); }

	emit(state: RemoteConnectionState): void {
		this.connectionState = state;
		this.stateEmitter.fire(state);
	}

	emitConnection(connection: RemoteAgentConnection): void {
		this.connection = connection;
		this.connectionEmitter.fire(connection);
	}
}

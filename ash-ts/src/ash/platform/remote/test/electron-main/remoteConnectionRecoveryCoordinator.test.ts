import { strict as assert } from "node:assert";
import { test } from "mocha";
import type { AppServerConnectionState } from "../../../../platform/app-server/common/appServerApi.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { RemoteConnectionRecoveryCoordinator, type RemoteConnectionRecoveryHost } from "../../../../platform/remote/electron-main/remoteConnectionRecoveryCoordinator.js";
import { SshAppServerProcessLauncher } from "../../../../platform/remote/electron-main/sshAppServerProcessLauncher.js";

test("Remote runtime recovery verifies rollback before replacing the connection", async () => {
	const lifecycle: string[] = [];
	const launcher = createLauncher(async () => {
		lifecycle.push("rollback");
		return "/srv/ash/runtime/one/bin/ash-remote-server";
	});
	const host = new TestRecoveryHost(lifecycle);
	const coordinator = new RemoteConnectionRecoveryCoordinator(host, launcher, () => lifecycle.push("prepare"));

	await coordinator.rollback();

	assert.deepEqual(lifecycle, ["rollback", "prepare", "stop", "start"]);
	assert.equal(host.state, "ready");
});

test("Remote runtime recovery leaves the active connection untouched when verification fails", async () => {
	const lifecycle: string[] = [];
	const launcher = createLauncher(async () => {
		lifecycle.push("rollback");
		throw new Error("previous runtime incompatible");
	});
	const host = new TestRecoveryHost(lifecycle);
	const coordinator = new RemoteConnectionRecoveryCoordinator(host, launcher);

	await assert.rejects(() => coordinator.rollback(), /previous runtime incompatible/);

	assert.deepEqual(lifecycle, ["rollback"]);
	assert.equal(host.state, "ready");
});

test("Remote reconnect restarts an exhausted crashed connection without changing runtime", async () => {
	const lifecycle: string[] = [];
	const host = new TestRecoveryHost(lifecycle, "crashed");
	const coordinator = new RemoteConnectionRecoveryCoordinator(host, createLauncher(async () => "/unused"), () => lifecycle.push("prepare"));

	assert.deepEqual(await coordinator.reconnect(), { kind: "reconnected" });

	assert.deepEqual(lifecycle, ["stop", "start"]);
	assert.equal(host.state, "ready");
});

test("Remote reconnect releases its operation gate after a failed start", async () => {
	const lifecycle: string[] = [];
	const host = new TestRecoveryHost(lifecycle, "crashed", 1);
	const coordinator = new RemoteConnectionRecoveryCoordinator(host, createLauncher(async () => "/unused"));

	await assert.rejects(() => coordinator.reconnect(), /temporary SSH failure/);
	assert.deepEqual(await coordinator.reconnect(), { kind: "reconnected" });

	assert.deepEqual(lifecycle, ["stop", "start", "stop", "start"]);
});

test("Remote reconnect is idempotent when connected and rejects an active transition", async () => {
	const lifecycle: string[] = [];
	const host = new TestRecoveryHost(lifecycle);
	const coordinator = new RemoteConnectionRecoveryCoordinator(host, createLauncher(async () => "/unused"));

	assert.deepEqual(await coordinator.reconnect(), { kind: "alreadyConnected" });
	host.state = "restarting";
	await assert.rejects(() => coordinator.reconnect(), /already transitioning: restarting/);
	assert.deepEqual(lifecycle, []);
});

test("Remote connection recovery rejects concurrent reconnect and rollback operations", async () => {
	const lifecycle: string[] = [];
	const pending = deferred<string>();
	const launcher = createLauncher(async () => pending.promise);
	const coordinator = new RemoteConnectionRecoveryCoordinator(new TestRecoveryHost(lifecycle), launcher);

	const first = coordinator.rollback();
	await assert.rejects(() => coordinator.reconnect(), /already in progress/);
	pending.resolve("/srv/ash/runtime/one/bin/ash-remote-server");
	await first;

	assert.deepEqual(lifecycle, ["stop", "start"]);
});

function createLauncher(rollbackRuntime: () => Promise<string>): SshAppServerProcessLauncher {
	return new SshAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "/srv/ash/runtime/two/bin/ash-remote-server",
		localEnvironment: {},
		rollbackRuntime,
	});
}

class TestRecoveryHost implements RemoteConnectionRecoveryHost {
	constructor(private readonly lifecycle: string[], public state: AppServerConnectionState = "ready", private startFailures = 0) {}

	async stop(): Promise<void> {
		this.lifecycle.push("stop");
		this.state = "stopped";
	}

	async start(): Promise<void> {
		this.lifecycle.push("start");
		if (this.startFailures > 0) {
			this.startFailures -= 1;
			this.state = "crashed";
			throw new Error("temporary SSH failure");
		}
		this.state = "ready";
	}
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}

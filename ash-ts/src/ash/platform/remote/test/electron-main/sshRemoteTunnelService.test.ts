import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { test } from "mocha";
import { isCancellationError } from "../../../../base/common/errors.js";
import { URI } from "../../../../base/common/uri.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { SshRemoteTunnelService, sshTunnelArguments } from "../../../../platform/remote/electron-main/sshRemoteTunnelService.js";
import type { RemoteTunnelChange } from "../../../../platform/remote/common/remoteTunnelService.js";

test("SSH tunnel coordinator fixes both ends of the forward to loopback", async () => {
	const child = new FakeChildProcess();
	let launch: { executable: string; args: readonly string[] } | undefined;
	using service = new SshRemoteTunnelService({
		getWorkspace: () => ({ id: "remote", uri: createSshRemoteWorkspaceUri("build-server", "/srv/project") }),
		sshExecutable: "ssh",
		localEnvironment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
		reserveLocalPort: async () => 41_234,
		spawnProcess: (executable, args) => {
			launch = { executable, args };
			return child as unknown as ChildProcess;
		},
		probeLoopbackListener: readyListener,
		startupTimeoutMs: 50,
		wait: async () => {},
	});

	const tunnel = await service.open({ remotePort: 3_000 });
	assert.deepEqual(tunnel, {
		id: "remote-tunnel-1",
		localPort: 41_234,
		remoteHost: "127.0.0.1",
		remotePort: 3_000,
		state: "open",
	});
	assert.deepEqual(launch, {
		executable: "ssh",
		args: sshTunnelArguments("build-server", 41_234, 3_000),
	});

	await service.close(tunnel.id);
	assert.deepEqual(await service.list(), []);
});

test("SSH tunnel coordinator rejects local workspaces before spawning a process", async () => {
	let launches = 0;
	using service = new SshRemoteTunnelService({
		getWorkspace: () => ({ id: "local", uri: URI.file("/tmp/project") }),
		sshExecutable: "ssh",
		localEnvironment: {},
		spawnProcess: () => {
			launches += 1;
			return new FakeChildProcess() as unknown as ChildProcess;
		},
	});
	await assert.rejects(() => service.open({ remotePort: 3_000 }), /SSH Remote Workspace/);
	assert.equal(launches, 0);
});

test("SSH tunnel coordinator recovers repeatedly on the original local port", async () => {
	const children: FakeChildProcess[] = [];
	const launches: string[][] = [];
	const changes: RemoteTunnelChange[] = [];
	using service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: (_executable, args) => {
			children.push(new FakeChildProcess());
			launches.push([...args]);
			return children.at(-1) as unknown as ChildProcess;
		},
		probeLoopbackListener: readyListener,
		startupTimeoutMs: 50,
		wait: async () => {},
	});
	service.onDidChange(change => changes.push(change));

	const tunnel = await service.open({ remotePort: 3_000 });
	children[0].exit(17);
	await waitUntil(() => children.length === 2 && tunnelState(changes) === "open");
	children[1].exit(18);
	await waitUntil(() => children.length === 3 && tunnelState(changes) === "open");

	assert.deepEqual(launches[0], sshTunnelArguments("build-server", tunnel.localPort, tunnel.remotePort));
	assert.deepEqual(launches[1], launches[0]);
	assert.deepEqual(launches[2], launches[0]);
	assert.deepEqual(changes.filter(change => change.kind === "upsert").map(change => change.tunnel.state), [
		"open",
		"recovering",
		"open",
		"recovering",
		"open",
	]);
	assert.equal((await service.list())[0].localPort, 41_234);
});

test("closing a recovering SSH tunnel cancels backoff without launching another child", async () => {
	const child = new FakeChildProcess();
	const changes: RemoteTunnelChange[] = [];
	let waitCall = 0;
	let recoveryWaitStarted!: () => void;
	const waitingForRecovery = new Promise<void>(resolve => recoveryWaitStarted = resolve);
	using service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => child as unknown as ChildProcess,
		probeLoopbackListener: readyListener,
		startupTimeoutMs: 50,
		wait: (_milliseconds, signal) => {
			waitCall += 1;
			if (waitCall === 1) return Promise.resolve();
			recoveryWaitStarted();
			return new Promise(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
		},
	});
	service.onDidChange(change => changes.push(change));

	const tunnel = await service.open({ remotePort: 3_000 });
	child.exit(17);
	await waitingForRecovery;
	await service.close(tunnel.id);

	assert.deepEqual(await service.list(), []);
	assert.deepEqual(changes.map(change => change.kind === "upsert" ? change.tunnel.state : change.kind), ["open", "recovering", "removed"]);
});

test("closing during recovery startup kills the candidate SSH child", async () => {
	const children: FakeChildProcess[] = [];
	let waitCall = 0;
	let candidateSpawned!: () => void;
	const waitingForCandidate = new Promise<void>(resolve => candidateSpawned = resolve);
	using service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => {
			const child = new FakeChildProcess();
			children.push(child);
			if (children.length === 2) candidateSpawned();
			return child as unknown as ChildProcess;
		},
		probeLoopbackListener: readyListener,
		startupTimeoutMs: 100,
		recoveryPolicy: { windowMs: 100, initialDelayMs: 2, maxDelayMs: 4 },
		wait: (_milliseconds, signal) => {
			waitCall += 1;
			if (waitCall < 3) return Promise.resolve();
			return new Promise(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
		},
	});

	const tunnel = await service.open({ remotePort: 3_000 });
	children[0].exit(17);
	await waitingForCandidate;
	await service.close(tunnel.id);

	assert.equal(children.length, 2);
	assert.equal(children[1].exitCode, 0);
	assert.deepEqual(await service.list(), []);
});

test("disposing a recovering coordinator prevents post-window relaunch", async () => {
	const child = new FakeChildProcess();
	let waitCall = 0;
	let recoveryWaitStarted!: () => void;
	const waitingForRecovery = new Promise<void>(resolve => recoveryWaitStarted = resolve);
	const service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => child as unknown as ChildProcess,
		probeLoopbackListener: readyListener,
		startupTimeoutMs: 50,
		wait: (_milliseconds, signal) => {
			waitCall += 1;
			if (waitCall === 1) return Promise.resolve();
			recoveryWaitStarted();
			return new Promise(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
		},
	});

	await service.open({ remotePort: 3_000 });
	child.exit(17);
	await waitingForRecovery;
	service.dispose();
	await new Promise<void>(resolve => setImmediate(resolve));

	assert.deepEqual(await service.list(), []);
});

test("SSH tunnel recovery becomes failed only after its bounded retry window", async () => {
	const children: FakeChildProcess[] = [];
	const changes: RemoteTunnelChange[] = [];
	let now = 0;
	using service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => {
			const child = new FakeChildProcess(children.length === 0 ? null : 17);
			children.push(child);
			return child as unknown as ChildProcess;
		},
		probeLoopbackListener: readyListener,
		startupTimeoutMs: 50,
		recoveryPolicy: { windowMs: 7, initialDelayMs: 2, maxDelayMs: 4 },
		now: () => now,
		wait: async milliseconds => {
			now += milliseconds;
		},
	});
	service.onDidChange(change => changes.push(change));

	await service.open({ remotePort: 3_000 });
	children[0].exit(17);
	await waitUntil(() => tunnelState(changes) === "failed");

	assert.equal(children.length, 3);
	assert.equal((await service.list())[0].state, "failed");
	assert.deepEqual(changes.filter(change => change.kind === "upsert").map(change => change.tunnel.state), ["open", "recovering", "failed"]);
});

test("SSH tunnel startup failure is reported without entering recovery", async () => {
	const changes: RemoteTunnelChange[] = [];
	using service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => new FakeChildProcess(17) as unknown as ChildProcess,
		probeLoopbackListener: readyListener,
		startupTimeoutMs: 50,
		wait: async () => {},
	});
	service.onDidChange(change => changes.push(change));

	await assert.rejects(() => service.open({ remotePort: 3_000 }), /before startup/);
	assert.deepEqual(await service.list(), []);
	assert.deepEqual(changes, []);
});

test("SSH tunnel startup waits until the loopback listener is stable", async () => {
	const child = new FakeChildProcess();
	const probes: string[] = [];
	const waits: number[] = [];
	using service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => child as unknown as ChildProcess,
		probeLoopbackListener: async localPort => {
			probes.push(`127.0.0.1:${localPort}`);
			return probes.length === 1 ? "pending" : "ready";
		},
		startupTimeoutMs: 100,
		wait: async milliseconds => {
			waits.push(milliseconds);
		},
	});

	const tunnel = await service.open({ remotePort: 3_000 });

	assert.equal(tunnel.state, "open");
	assert.deepEqual(probes, ["127.0.0.1:41234", "127.0.0.1:41234", "127.0.0.1:41234"]);
	assert.deepEqual(waits, [10, 50]);
});

test("SSH tunnel startup times out and stops the child when no listener appears", async () => {
	const child = new FakeChildProcess();
	using service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => child as unknown as ChildProcess,
		probeLoopbackListener: async () => "pending",
		startupTimeoutMs: 20,
		wait: async () => {},
	});

	await assert.rejects(() => service.open({ remotePort: 3_000 }), /did not listen on 127\.0\.0\.1:41234 within 20ms/);
	assert.equal(child.exitCode, 0);
	assert.deepEqual(await service.list(), []);
});

test("SSH tunnel default readiness probe observes a real loopback listener", async () => {
	const listener = createServer(socket => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = listener.address();
	assert.ok(address && typeof address !== "string");
	try {
		const child = new FakeChildProcess();
		using service = new SshRemoteTunnelService({
			getWorkspace: remoteWorkspace,
			sshExecutable: "ssh",
			localEnvironment: {},
			reserveLocalPort: async () => address.port,
			spawnProcess: () => child as unknown as ChildProcess,
			startupTimeoutMs: 500,
		});

		const tunnel = await service.open({ remotePort: 3_000 });

		assert.equal(tunnel.localPort, address.port);
		assert.equal(tunnel.state, "open");
	} finally {
		await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
	}
});

test("disposing during SSH tunnel startup cancels readiness and stops the child", async () => {
	const child = new FakeChildProcess();
	let spawned!: () => void;
	const waitingForSpawn = new Promise<void>(resolve => spawned = resolve);
	const service = new SshRemoteTunnelService({
		getWorkspace: remoteWorkspace,
		sshExecutable: "ssh",
		localEnvironment: {},
		reserveLocalPort: async () => 41_234,
		spawnProcess: () => {
			spawned();
			return child as unknown as ChildProcess;
		},
		probeLoopbackListener: async () => "pending",
		startupTimeoutMs: 500,
		wait: (_milliseconds, signal) => {
			if (signal?.aborted) return Promise.resolve();
			return new Promise(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
		},
	});

	const opening = service.open({ remotePort: 3_000 });
	await waitingForSpawn;
	service.dispose();

	await assert.rejects(opening, error => isCancellationError(error) && /startup was cancelled/.test(error.message));
	assert.equal(child.exitCode, 0);
	assert.deepEqual(await service.list(), []);
});

test("SSH tunnel arguments reject invalid ports and shell control characters", () => {
	assert.throws(() => sshTunnelArguments("build\nserver", 41_234, 3_000), /control characters/);
	assert.throws(() => sshTunnelArguments("build-server", 0, 3_000), /localPort/);
	assert.throws(() => sshTunnelArguments("build-server", 41_234, 65_536), /remotePort/);
});

function remoteWorkspace() {
	return { id: "remote", uri: createSshRemoteWorkspaceUri("build-server", "/srv/project") };
}

function tunnelState(changes: readonly RemoteTunnelChange[]): string | undefined {
	const change = changes.at(-1);
	return change?.kind === "upsert" ? change.tunnel.state : undefined;
}

function readyListener(): Promise<"ready"> {
	return Promise.resolve("ready");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	assert.fail("condition did not become true");
}

class FakeChildProcess extends EventEmitter {
	constructor(public exitCode: number | null = null) {
		super();
	}

	exit(code: number, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}

	kill(): boolean {
		this.exit(0);
		return true;
	}
}

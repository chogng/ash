import { strict as assert } from "node:assert";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "mocha";
import { AppServerDaemonLauncher } from "../../../../platform/app-server-daemon/electron-main/appServerDaemonLauncher.js";
import { AppServerProtocolIncompatibleError } from "../../../../platform/app-server/common/appServerProtocolCompatibility.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { RemoteAppServerProcessLauncher, SshRuntimeProbeError, sshRuntimeProbeArguments } from "../../../../platform/remote/electron-main/remoteAppServerProcessLauncher.js";

test('Remote launcher starts a local daemon carrier with a remote connection scope', () => {
	const launches: Array<{ executable: string; args: readonly string[]; environment: Readonly<Record<string, string>>; }> = [];
	const child = {} as ChildProcessWithoutNullStreams;
	const carrier = createCarrier((executable, args, options) => {
		launches.push({ executable, args, environment: options.environment });
		return child;
	});
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri('Work-Server', '/home/ash/project with spaces'),
		sshExecutable: 'ssh',
		remoteExecutable: '/opt/ash/bin/ash-remote-server',
		localEnvironment: {},
		carrier,
	});
	assert.equal(launcher.launch(), child);
	assert.deepEqual(launches, [{
		executable: '/runtime/ash-app-server-daemon', args: ['connect-selected'],
		environment: { ASH_HOME: '/profile', SSH_AUTH_SOCK: '/tmp/agent.sock', ASH_REMOTE_HOST: 'work-server', ASH_REMOTE_ROOT: '/home/ash/project with spaces', ASH_REMOTE_RUNTIME: '/opt/ash/bin/ash-remote-server' },
	}]);
	launcher.replaceWorkspaceRoot(undefined);
	launcher.launch();
	assert.equal(launcher.workspaceRoot, undefined);
	assert.equal(launches[1]!.environment.ASH_REMOTE_ROOT, undefined);
	assert.equal(launches[1]!.environment.ASH_REMOTE_HOST, 'work-server');
});

test('Remote launcher retargets the same authority without opening the path locally', () => {
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri('work-server', '/srv/one'), sshExecutable: 'ssh',
		remoteExecutable: '/opt/ash/bin/ash-remote-server', localEnvironment: {}, carrier: createCarrier(),
	});
	launcher.replaceWorkspaceRoot('/srv/two');
	launcher.launch();
	assert.equal(launcher.options.carrier.environment.ASH_REMOTE_ROOT, '/srv/two');
	assert.equal(launcher.options.carrier.environment.ASH_WORKSPACE_ROOT, undefined);
	assert.throws(() => launcher.replaceWorkspaceRoot('relative'), /absolute POSIX path/);
});

test("Desktop validates the selected runtime before starting the App Server", async () => {
	let probe: { executable: string; args: readonly string[]; environment: NodeJS.ProcessEnv; } | undefined;
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("Work-Server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
		probeRuntime: async (executable, args, options) => {
			probe = { executable, args, environment: options.environment };
			return { exitCode: 0, stdout: "__ASH_REMOTE_RUNTIME_FOUND__:/usr/bin/ash-remote-server\n", stderr: "" };
		},
	});

	await launcher.validate();
	assert.deepEqual(probe, {
		executable: "ssh",
		args: sshRuntimeProbeArguments("work-server", "ash"),
		environment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
	});
});

test("Desktop exposes a typed missing-runtime decision", async () => {
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: {},
		probeRuntime: async () => ({ exitCode: 127, stdout: "__ASH_REMOTE_RUNTIME_MISSING__\n", stderr: "" }),
	});

	await assert.rejects(
		() => launcher.validate(),
		(error: unknown) => error instanceof SshRuntimeProbeError && error.kind === "runtime-unavailable",
	);
});

test("Desktop provisions a missing runtime in Main and re-probes the exact installed path", async () => {
	const probes: string[][] = [];
	const provisions: string[] = [];
	const settlements: number[] = [];
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: {},
		probeRuntime: async (_executable, args) => {
			probes.push([...args]);
			return probes.length === 1
				? { exitCode: 127, stdout: "__ASH_REMOTE_RUNTIME_MISSING__\n", stderr: "" }
				: { exitCode: 0, stdout: "__ASH_REMOTE_RUNTIME_FOUND__:/srv/ash/runtime/bin/ash-remote-server\n", stderr: "" };
		},
		provisionRuntime: async host => {
			provisions.push(host);
			return "/srv/ash/runtime/bin/ash-remote-server";
		},
		settleRuntimeProvision: () => settlements.push(probes.length),
	});

	await launcher.validate();
	launcher.launch();

	assert.deepEqual(provisions, ["work-server"]);
	assert.deepEqual(settlements, [2]);
	assert.deepEqual(probes, [
		[...sshRuntimeProbeArguments("work-server", "ash")],
		[...sshRuntimeProbeArguments("work-server", "/srv/ash/runtime/bin/ash-remote-server")],
	]);
	assert.equal(launcher.options.carrier.environment.ASH_REMOTE_RUNTIME, "/srv/ash/runtime/bin/ash-remote-server");
});

test("Desktop settles bootstrap progress when provisioning fails", async () => {
	let settlements = 0;
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: {},
		probeRuntime: async () => ({ exitCode: 127, stdout: "__ASH_REMOTE_RUNTIME_MISSING__\n", stderr: "" }),
		provisionRuntime: async () => { throw new Error("cancelled install"); },
		settleRuntimeProvision: () => { settlements += 1; },
	});

	await assert.rejects(() => launcher.validate(), /cancelled install/);
	assert.equal(settlements, 1);
});

test("Desktop never provisions on an SSH transport failure", async () => {
	let provisioned = false;
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: {},
		probeRuntime: async () => ({ exitCode: 255, stdout: "", stderr: "host key rejected" }),
		provisionRuntime: async () => {
			provisioned = true;
			return "/srv/ash/runtime/bin/ash-remote-server";
		},
	});

	await assert.rejects(
		() => launcher.validate(),
		(error: unknown) => error instanceof SshRuntimeProbeError && error.kind === "transport",
	);
	assert.equal(provisioned, false);
});

test("Desktop resolves and activates a persisted exact runtime only around the initialize gate", async () => {
	const lifecycle: string[] = [];
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: {},
		resolveRuntime: async (host, workspace) => {
			lifecycle.push(`resolve:${host}:${workspace}`);
			return "/srv/ash/runtime/one/bin/ash-remote-server";
		},
		activateRuntime: async (host, workspace, runtime) => {
			lifecycle.push(`activate:${host}:${workspace}:${runtime}`);
		},
		probeRuntime: async () => ({ exitCode: 0, stdout: "__ASH_REMOTE_RUNTIME_FOUND__:/srv/ash/runtime/one/bin/ash-remote-server\n", stderr: "" }),
	});

	await launcher.validate();
	assert.deepEqual(lifecycle, ["resolve:work-server:/home/ash/project"]);
	launcher.launch();
	assert.equal(launcher.options.carrier.environment.ASH_REMOTE_RUNTIME, "/srv/ash/runtime/one/bin/ash-remote-server");

	await launcher.didInitialize();
	assert.deepEqual(lifecycle, [
		"resolve:work-server:/home/ash/project",
		"activate:work-server:/home/ash/project:/srv/ash/runtime/one/bin/ash-remote-server",
	]);
});

test("Desktop selects only a host-verified rollback runtime", async () => {
	const rollbacks: string[] = [];
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "/usr/bin/ssh",
		remoteExecutable: "/srv/ash/runtime/two/bin/ash-remote-server",
		carrier: createCarrier(),
		localEnvironment: {},
		rollbackRuntime: async (host, workspace, sshExecutable) => {
			rollbacks.push(`${host}:${workspace}:${sshExecutable}`);
			return "/srv/ash/runtime/one/bin/ash-remote-server";
		},
	});

	assert.equal(launcher.runtimeRollbackAvailable, true);
	await launcher.rollbackRuntime();
	launcher.launch();

	assert.deepEqual(rollbacks, ["work-server:/home/ash/project:/usr/bin/ssh"]);
	assert.equal(launcher.options.carrier.environment.ASH_REMOTE_RUNTIME, "/srv/ash/runtime/one/bin/ash-remote-server");
});

test("Desktop rejects an invalid runtime returned by rollback policy", async () => {
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "/srv/ash/runtime/two/bin/ash-remote-server",
		carrier: createCarrier(),
		localEnvironment: {},
		rollbackRuntime: async () => "relative/bin/ash-remote-server",
	});

	await assert.rejects(() => launcher.rollbackRuntime(), /invalid executable path/);
});

test("Desktop provisions once for a typed protocol incompatibility and launches the installed runtime", async () => {
	const provisions: string[] = [];
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: {},
		probeRuntime: async (_executable, args) => {
			const runtime = args.at(-1)?.includes("/srv/ash/runtime/two/bin/ash-remote-server") ? "/srv/ash/runtime/two/bin/ash-remote-server" : "/usr/bin/ash-remote-server";
			return { exitCode: 0, stdout: `__ASH_REMOTE_RUNTIME_FOUND__:${runtime}\n`, stderr: "" };
		},
		provisionRuntime: async host => {
			provisions.push(host);
			return "/srv/ash/runtime/two/bin/ash-remote-server";
		},
	});
	await launcher.validate();

	const incompatible = new AppServerProtocolIncompatibleError({ kind: "majorVersion", expected: 1, received: 2 });
	assert.equal(await launcher.recoverInitializationFailure(incompatible), true);
	assert.equal(await launcher.recoverInitializationFailure(incompatible), false);
	launcher.launch();

	assert.deepEqual(provisions, ["work-server"]);
	assert.equal(launcher.options.carrier.environment.ASH_REMOTE_RUNTIME, "/srv/ash/runtime/two/bin/ash-remote-server");
});

test("an explicit new startup validation permits protocol provisioning after a failed gate", async () => {
	let provisions = 0;
	const launcher = new RemoteAppServerProcessLauncher({
		workspace: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
		sshExecutable: "ssh",
		remoteExecutable: "ash",
		carrier: createCarrier(),
		localEnvironment: {},
		probeRuntime: async (_executable, args) => {
			const runtime = args.at(-1)?.includes("/srv/ash/runtime/two/bin/ash-remote-server") ? "/srv/ash/runtime/two/bin/ash-remote-server" : "/usr/bin/ash-remote-server";
			return { exitCode: 0, stdout: `__ASH_REMOTE_RUNTIME_FOUND__:${runtime}\n`, stderr: "" };
		},
		provisionRuntime: async () => {
			provisions += 1;
			if (provisions === 1) throw new Error("temporary install failure");
			return "/srv/ash/runtime/two/bin/ash-remote-server";
		},
	});

	await launcher.validate();
	const incompatible = new AppServerProtocolIncompatibleError({ kind: "majorVersion", expected: 1, received: 2 });
	await assert.rejects(() => launcher.recoverInitializationFailure(incompatible), /temporary install failure/);
	assert.equal(await launcher.recoverInitializationFailure(incompatible), false);

	await launcher.validate();
	assert.equal(await launcher.recoverInitializationFailure(incompatible), true);
	assert.equal(provisions, 2);
});

function createCarrier(spawnProcess: NonNullable<ConstructorParameters<typeof AppServerDaemonLauncher>[0]['spawnProcess']> = () => ({} as ChildProcessWithoutNullStreams)): AppServerDaemonLauncher {
	return new AppServerDaemonLauncher({
		executable: '/runtime/ash-app-server-daemon', args: ['connect-selected'],
		environment: { ASH_HOME: '/profile', ASH_WORKSPACE_ROOT: '/local', ASH_DIR_GRANT_SOURCE: 'userConfig', SSH_AUTH_SOCK: '/tmp/agent.sock' },
		fileExists: () => true, spawnProcess,
	});
}

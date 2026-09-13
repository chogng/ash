import { strict as assert } from "node:assert";
import { test } from "mocha";
import { RemoteConnectionProfiles } from "../../../../platform/remote/electron-main/remoteConnectionProfiles.js";

test("Electron Main delegates Remote profile reads, activation, and rollback to the shared Rust store", async () => {
	const invocations: Array<{ executable: string; args: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
	const profiles = new RemoteConnectionProfiles({
		remoteExecutable: "/Applications/Ash.app/Contents/Resources/bin/ash-remote",
		environment: { ASH_HOME: "/Users/test/Library/Application Support/Ash/state" },
		runCommand: async (executable, args, environment) => {
			invocations.push({ executable, args, environment });
			const activeRuntime = args.includes("activate") ? args.at(-1) : "/srv/ash/runtime/one/bin/ash-remote-server";
			return { exitCode: 0, stdout: JSON.stringify({ activeRuntime }), stderr: "" };
		},
	});

	assert.deepEqual(await profiles.get("Build-Linux", "/srv/project"), {
		activeRuntime: "/srv/ash/runtime/one/bin/ash-remote-server",
	});
	assert.deepEqual(await profiles.activate("Build-Linux", "/srv/project", "/srv/ash/runtime/two/bin/ash-remote-server"), {
		activeRuntime: "/srv/ash/runtime/two/bin/ash-remote-server",
	});
	assert.deepEqual(await profiles.rollback("Build-Linux", "/srv/project", "/usr/bin/ssh"), {
		activeRuntime: "/srv/ash/runtime/one/bin/ash-remote-server",
	});
	assert.deepEqual(invocations.map(invocation => invocation.args), [
		["profile", "get", "--host", "build-linux", "--workspace", "/srv/project"],
		["profile", "activate", "--host", "build-linux", "--workspace", "/srv/project", "--runtime", "/srv/ash/runtime/two/bin/ash-remote-server"],
		["profile", "rollback", "--host", "build-linux", "--workspace", "/srv/project", "--ssh", "/usr/bin/ssh"],
	]);
	assert.equal(invocations[0]?.environment.ASH_HOME, "/Users/test/Library/Application Support/Ash/state");
});

test("Remote profile adapter fails closed on command and record errors", async () => {
	const absent = new RemoteConnectionProfiles({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 0, stdout: "null\n", stderr: "" }),
	});
	assert.equal(await absent.get("build-linux", "/srv/project"), undefined);

	const invalid = new RemoteConnectionProfiles({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 0, stdout: '{"activeRuntime":"relative/ash","password":"secret"}', stderr: "" }),
	});
	await assert.rejects(() => invalid.get("build-linux", "/srv/project"), /invalid record/);

	const rejected = new RemoteConnectionProfiles({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "profile busy" }),
	});
	await assert.rejects(() => rejected.get("build-linux", "/srv/project"), /profile busy/);
});

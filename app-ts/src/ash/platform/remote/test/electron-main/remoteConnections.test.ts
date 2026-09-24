import { strict as assert } from "node:assert";
import { test } from "mocha";
import type { RemoteConnectionDefinition } from "../../../../platform/remote/common/remoteConnectionService.js";
import { RemoteConnections } from "../../../../platform/remote/electron-main/remoteConnections.js";

test("Electron Main lists and resolves named targets through the shared Rust catalog", async () => {
	const calls: string[][] = [];
	const scheduled: RemoteConnectionDefinition[] = [];
	const service = new RemoteConnections({
		remoteExecutable: "/Applications/Ash.app/Contents/Resources/bin/ash-remote",
		environment: { ASH_HOME: "/Users/test/Library/Application Support/Ash/state" },
		runCommand: async (_executable, args) => {
			calls.push([...args]);
			if (args.includes("list")) {
				return { exitCode: 0, stdout: '[{"name":"build","host":"build-linux","workspace":"/srv/project"}]\n', stderr: "" };
			}
			return { exitCode: 0, stdout: '{"name":"build","host":"build-linux","workspace":"/srv/project"}\n', stderr: "" };
		},
		scheduleConnect: connection => { scheduled.push(connection); },
	});

	assert.deepEqual(await service.list(), [{ name: "build", host: "build-linux", workspace: "/srv/project" }]);
	await service.connect(" BUILD ");
	assert.deepEqual(calls, [
		["connections", "list"],
		["connections", "get", "--name", "build"],
	]);
	assert.deepEqual(scheduled, [{ name: "build", host: "build-linux", workspace: "/srv/project" }]);
});

test("Electron Main creates, atomically updates, and removes targets through the Rust CLI", async () => {
	const calls: string[][] = [];
	const outputs = [
		'{"name":"build","host":"build-linux","workspace":"/srv/project"}\n',
		'{"name":"production","host":"production-linux","workspace":"/srv/production"}\n',
		'{"name":"production","host":"production-linux","workspace":"/srv/production"}\n',
	];
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async (_executable, args) => {
			calls.push([...args]);
			return { exitCode: 0, stdout: outputs.shift()!, stderr: "" };
		},
		scheduleConnect: () => {},
	});

	assert.deepEqual(await service.save({ name: " BUILD ", host: "BUILD-LINUX", workspace: " /srv/project " }), { name: "build", host: "build-linux", workspace: "/srv/project" });
	assert.deepEqual(await service.update("BUILD", { name: "Production", host: "PRODUCTION-LINUX", workspace: "/srv/production" }), { name: "production", host: "production-linux", workspace: "/srv/production" });
	assert.deepEqual(await service.remove("PRODUCTION"), { name: "production", host: "production-linux", workspace: "/srv/production" });
	assert.deepEqual(calls, [
		["connections", "save", "--name", "build", "--host", "build-linux", "--workspace", "/srv/project", "--mode", "create"],
		["connections", "update", "--name", "build", "--new-name", "production", "--host", "production-linux", "--workspace", "/srv/production"],
		["connections", "remove", "--name", "production"],
	]);
});

test("named Remote connection paths preserve POSIX backslashes", async () => {
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 0, stdout: '[{"name":"build","host":"build","workspace":"/srv/project\\\\archive"}]', stderr: "" }),
		scheduleConnect: () => {},
	});

	assert.deepEqual(await service.list(), [{ name: "build", host: "build", workspace: "/srv/project\\archive" }]);
});

test("named Remote connection mutations require the CLI to return the exact requested target", async () => {
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 0, stdout: '{"name":"other","host":"other","workspace":"/srv/other"}', stderr: "" }),
		scheduleConnect: () => {},
	});

	await assert.rejects(() => service.save({ name: "build", host: "build", workspace: "/srv/build" }), /different target/);
	await assert.rejects(() => service.remove("build"), /different named target/);
});

test("named Remote connections fail closed on missing, non-canonical, or expanded records", async () => {
	const outputs = [
		"null\n",
		'{"name":"build","host":"Build-Linux","workspace":"/srv/project"}\n',
		'{"name":"build","host":"build-linux","workspace":"/srv/project","password":"secret"}\n',
	];
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 0, stdout: outputs.shift()!, stderr: "" }),
		scheduleConnect: () => assert.fail("invalid connection must not be scheduled"),
	});

	await assert.rejects(() => service.connect("build"), /no longer exists/);
	await assert.rejects(() => service.connect("build"), /non-canonical/);
	await assert.rejects(() => service.connect("build"), /invalid record/);
});

test("named Remote connection lists require sorted unique canonical records", async () => {
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({
			exitCode: 0,
			stdout: '[{"name":"zulu","host":"zulu","workspace":"/srv/z"},{"name":"alpha","host":"alpha","workspace":"/srv/a"}]',
			stderr: "",
		}),
		scheduleConnect: () => {},
	});
	await assert.rejects(() => service.list(), /duplicate or unsorted/);
});

test("named Remote connection scheduling is reusable after one window open settles", async () => {
	let schedules = 0;
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 0, stdout: '{"name":"build","host":"build","workspace":"/"}', stderr: "" }),
		scheduleConnect: () => { schedules += 1; },
	});

	await service.connect("build");
	await service.connect("build");
	assert.equal(schedules, 2);
});

test("concurrent named Remote connection requests cannot both cross the catalog gate", async () => {
	let finishLookup!: (output: { exitCode: number; stdout: string; stderr: string }) => void;
	const lookup = new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => finishLookup = resolve);
	let schedules = 0;
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => lookup,
		scheduleConnect: () => { schedules += 1; },
	});

	const first = service.connect("build");
	await assert.rejects(() => service.connect("build"), /window is already being opened/);
	finishLookup({ exitCode: 0, stdout: '{"name":"build","host":"build","workspace":"/srv/project"}', stderr: "" });
	await first;
	assert.equal(schedules, 1);
});

test("named Remote connection remains fenced until asynchronous window creation settles", async () => {
	let finishWindowOpen!: () => void;
	const windowOpen = new Promise<void>(resolve => finishWindowOpen = resolve);
	let schedules = 0;
	const service = new RemoteConnections({
		remoteExecutable: "ash-remote",
		environment: {},
		runCommand: async () => ({ exitCode: 0, stdout: '{"name":"build","host":"build","workspace":"/srv/project"}', stderr: "" }),
		scheduleConnect: async () => {
			schedules += 1;
			await windowOpen;
		},
	});

	const first = service.connect("build");
	await Promise.resolve();
	await assert.rejects(() => service.connect("build"), /window is already being opened/);
	finishWindowOpen();
	await first;
	await service.connect("build");
	assert.equal(schedules, 2);
});

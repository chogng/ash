import { strict as assert } from "node:assert";
import { test } from "mocha";
import { REMOTE_CONNECTION_CONNECT_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_LIST_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_REMOVE_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_SAVE_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_UPDATE_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import type { IRemoteConnectionService } from "../../../../platform/remote/common/remoteConnectionService.js";
import { remoteConnectionIpcRoutes } from "../../../../platform/remote/electron-main/remoteConnectionIpc.js";

test("Remote connection IPC exposes only credential-free canonical catalog operations", async () => {
	const calls: unknown[] = [];
	const build = { name: "build", host: "build-linux", workspace: "/srv/project" };
	const service: IRemoteConnectionService = {
		available: true,
		list: async () => [build],
		save: async connection => { calls.push(["save", connection]); return connection; },
		update: async (originalName, connection) => { calls.push(["update", originalName, connection]); return connection; },
		remove: async name => { calls.push(["remove", name]); return build; },
		connect: async name => { calls.push(["connect", name]); },
	};
	const routes = remoteConnectionIpcRoutes(service);

	assert.deepEqual(await route(routes, REMOTE_CONNECTION_LIST_CHANNEL).invoke(route(routes, REMOTE_CONNECTION_LIST_CHANNEL).validate(undefined)), [build]);
	const save = route(routes, REMOTE_CONNECTION_SAVE_CHANNEL);
	await save.invoke(save.validate({ connection: { name: " BUILD ", host: "BUILD-LINUX", workspace: " /srv/project " } }));
	const update = route(routes, REMOTE_CONNECTION_UPDATE_CHANNEL);
	await update.invoke(update.validate({ originalName: "BUILD", connection: { name: "prod", host: "prod-linux", workspace: "/srv/prod" } }));
	const remove = route(routes, REMOTE_CONNECTION_REMOVE_CHANNEL);
	await remove.invoke(remove.validate({ name: "BUILD" }));
	const connect = route(routes, REMOTE_CONNECTION_CONNECT_CHANNEL);
	await connect.invoke(connect.validate({ name: "BUILD" }));

	assert.deepEqual(calls, [
		["save", build],
		["update", "build", { name: "prod", host: "prod-linux", workspace: "/srv/prod" }],
		["remove", "build"],
		["connect", "build"],
	]);
});

test("Remote connection IPC rejects credentials, extra fields, invalid paths, and overwrite modes", () => {
	const routes = remoteConnectionIpcRoutes(testService());
	const save = route(routes, REMOTE_CONNECTION_SAVE_CHANNEL);
	const update = route(routes, REMOTE_CONNECTION_UPDATE_CHANNEL);
	const connect = route(routes, REMOTE_CONNECTION_CONNECT_CHANNEL);

	assert.throws(() => save.validate({ connection: { name: "build", host: "build", workspace: "/srv/project", password: "secret" } }), /exactly required keys/);
	assert.throws(() => save.validate({ connection: { name: "build", host: "user@host", workspace: "/srv/project" } }), /without credentials/);
	assert.throws(() => save.validate({ connection: { name: "build", host: "build", workspace: "/srv/project/" } }), /canonical/);
	assert.throws(() => save.validate({ connection: { name: "build", host: "build", workspace: "/srv/project" }, mode: "replace" }), /exactly required keys/);
	assert.throws(() => update.validate({ originalName: "build", connection: { name: "prod", host: "prod", workspace: "/srv/prod" }, identityFile: "/tmp/key" }), /exactly required keys/);
	assert.throws(() => connect.validate({ name: "build", host: "build-linux" }), /exactly required keys/);
	assert.throws(() => connect.validate({ name: "a".repeat(65) }), /maximum encoded length/);
});

function route(routes: readonly { readonly channel: string; readonly validate: (value: unknown) => unknown; readonly invoke: (value: unknown) => unknown }[], channel: string) {
	return routes.find(candidate => candidate.channel === channel)!;
}

function testService(): IRemoteConnectionService {
	return {
		available: true,
		list: async () => [],
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async () => {},
	};
}

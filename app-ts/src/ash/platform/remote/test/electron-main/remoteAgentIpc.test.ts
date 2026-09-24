import { strict as assert } from "node:assert";
import { test } from "mocha";
import { URI } from "../../../../base/common/uri.js";
import type { AppServerConnectionRelay } from "../../../../platform/app-server/electron-main/appServerConnectionRelay.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { REMOTE_AGENT_RECONNECT_CHANNEL } from "../../../../platform/remote/common/remoteAgentApi.js";
import { REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL } from "../../../../platform/remote/common/remoteAgentApi.js";
import { remoteAgentConnection, remoteAgentIpcRoutes } from "../../../../platform/remote/electron-main/remoteAgentIpc.js";
import type { IAnyWorkspaceIdentifier } from "../../../../platform/workspace/common/workspace.js";

test("Remote Agent IPC projects only sanitized authority and connection generation", () => {
	const supervisor = { generation: 7 } as AppServerConnectionRelay;

	assert.deepEqual(remoteAgentConnection(supervisor, { id: "local", uri: URI.file("/tmp") }), { kind: "local", generation: 7 });
	assert.deepEqual(remoteAgentConnection(supervisor, {
		id: "remote",
		uri: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
	}), {
		kind: "ssh",
		generation: 7,
		authority: "ssh+work-server",
		host: "work-server",
	});
});

test("Remote Agent IPC delegates path-free reconnect and rollback only for a Remote Workspace", async () => {
	const supervisor = { generation: 7 } as AppServerConnectionRelay;
	let reconnects = 0;
	let rollbacks = 0;
	let workspace: IAnyWorkspaceIdentifier = { id: "remote", uri: createSshRemoteWorkspaceUri("work-server", "/home/ash/project") };
	const routes = remoteAgentIpcRoutes(supervisor, () => workspace, {
		reconnect: async () => {
			reconnects += 1;
			return { kind: "reconnected" };
		},
		rollback: async () => {
			rollbacks += 1;
			return { kind: "rolledBack" };
		},
	});
	const reconnect = routes.find(route => route.channel === REMOTE_AGENT_RECONNECT_CHANNEL);
	const rollback = routes.find(route => route.channel === REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL);
	assert.ok(reconnect);
	assert.ok(rollback);

	assert.deepEqual(await reconnect.invoke(reconnect.validate(undefined)), { kind: "reconnected" });
	assert.deepEqual(await rollback.invoke(rollback.validate(undefined)), { kind: "rolledBack" });
	assert.equal(reconnects, 1);
	assert.equal(rollbacks, 1);

	workspace = { id: "local", uri: URI.file("/tmp") };
	await assert.rejects(async () => reconnect.invoke(reconnect.validate(undefined)), /SSH Remote Workspace/);
	await assert.rejects(async () => rollback.invoke(rollback.validate(undefined)), /SSH Remote Workspace/);
	assert.equal(reconnects, 1);
	assert.equal(rollbacks, 1);
});

test("Remote Agent IPC fails closed when the product host has no rollback policy", async () => {
	const supervisor = { generation: 7 } as AppServerConnectionRelay;
	const routes = remoteAgentIpcRoutes(supervisor, () => ({
		id: "remote",
		uri: createSshRemoteWorkspaceUri("work-server", "/home/ash/project"),
	}));
	const reconnect = routes.find(route => route.channel === REMOTE_AGENT_RECONNECT_CHANNEL);
	const rollback = routes.find(route => route.channel === REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL);
	assert.ok(reconnect);
	assert.ok(rollback);

	await assert.rejects(async () => reconnect.invoke(reconnect.validate(undefined)), /not available/);
	await assert.rejects(async () => rollback.invoke(rollback.validate(undefined)), /not available/);
});

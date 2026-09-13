import { strict as assert } from "node:assert";
import { test } from "mocha";
import type { AppServerConnectionState } from "../../../../platform/app-server/common/appServerApi.js";
import type { AppServerConnectionRelay } from "../../../../platform/app-server/electron-main/appServerConnectionRelay.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { REMOTE_AGENT_CONNECTION_CHANGED_CHANNEL } from "../../../../platform/remote/common/remoteAgentApi.js";
import { REMOTE_AGENT_CONNECTION_READ_CHANNEL } from "../../../../platform/remote/common/remoteAgentApi.js";
import { REMOTE_AGENT_RECONNECT_CHANNEL } from "../../../../platform/remote/common/remoteAgentApi.js";
import { REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL } from "../../../../platform/remote/common/remoteAgentApi.js";
import { REMOTE_CONNECTION_CONNECT_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import type { IRemoteConnectionService } from "../../../../platform/remote/common/remoteConnectionService.js";
import { REMOTE_CONNECTION_LIST_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_REMOVE_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_SAVE_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_CONNECTION_UPDATE_CHANNEL } from "../../../../platform/remote/common/remoteConnectionIpc.js";
import { REMOTE_TUNNEL_CLOSE_ALL_CHANNEL } from "../../../../platform/remote/common/remoteTunnelService.js";
import { REMOTE_TUNNEL_CLOSE_CHANNEL } from "../../../../platform/remote/common/remoteTunnelService.js";
import { REMOTE_TUNNEL_CHANGED_CHANNEL } from "../../../../platform/remote/common/remoteTunnelService.js";
import { REMOTE_TUNNEL_LIST_CHANNEL } from "../../../../platform/remote/common/remoteTunnelService.js";
import { REMOTE_TUNNEL_OPEN_CHANNEL } from "../../../../platform/remote/common/remoteTunnelService.js";
import type { IRemoteTunnelService } from "../../../../platform/remote/common/remoteTunnelService.js";
import type { RemoteTunnelChange } from "../../../../platform/remote/common/remoteTunnelService.js";
import { RemoteWindowMainContext } from "../../../../platform/remote/electron-main/remoteWindowMainContext.js";
import { SshAppServerProcessLauncher } from "../../../../platform/remote/electron-main/sshAppServerProcessLauncher.js";
import { WorkspaceContextMainService } from "../../../../platform/workspaces/electron-main/workspacesMainService.js";

test("Remote window context owns routes, projections, and Workspace tunnel cleanup", async () => {
	const stateListeners = new Set<(state: AppServerConnectionState) => void>();
	const supervisor = {
		generation: 4,
		options: { processLauncher: {} },
		onStateChange: (listener: (state: AppServerConnectionState) => void): IDisposable => {
			stateListeners.add(listener);
			return toDisposable(() => stateListeners.delete(listener));
		},
	} as unknown as AppServerConnectionRelay;
	const workspaceContext = new WorkspaceContextMainService({
		id: "remote-one",
		uri: URI.parse("ash-remote://ssh+build-linux/workspace/one"),
	});
	const connections: IRemoteConnectionService = {
		available: true,
		list: async () => [],
		save: async connection => connection,
		update: async (_originalName, connection) => connection,
		remove: async () => undefined,
		connect: async () => {},
	};
	const tunnelListeners = new Set<(change: RemoteTunnelChange) => void>();
	let tunnelCloseAllCalls = 0;
	let tunnelsDisposed = false;
	const tunnels: IRemoteTunnelService & IDisposable = {
		list: async () => [],
		open: async () => { throw new Error("not used"); },
		close: async () => {},
		closeAll: async () => { tunnelCloseAllCalls += 1; },
		onDidChange: listener => {
			tunnelListeners.add(listener);
			return toDisposable(() => tunnelListeners.delete(listener));
		},
		dispose: () => { tunnelsDisposed = true; },
		[Symbol.dispose]: () => { tunnelsDisposed = true; },
	};
	const events: Array<{ readonly channel: string; readonly payload: unknown }> = [];
	const context = new RemoteWindowMainContext({
		supervisor,
		workspaceContext,
		connections,
		tunnels,
		host: {
			send: (channel, payload) => events.push({ channel, payload }),
			confirmRuntimeRollback: async () => "cancelled",
			reportRuntimeRollbackFailure: async () => {},
		},
	});
	try {
		assert.deepEqual(context.ipcRoutes.map(route => route.channel), [
			REMOTE_AGENT_CONNECTION_READ_CHANNEL,
			REMOTE_AGENT_RECONNECT_CHANNEL,
			REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL,
			REMOTE_CONNECTION_LIST_CHANNEL,
			REMOTE_CONNECTION_CONNECT_CHANNEL,
			REMOTE_CONNECTION_SAVE_CHANNEL,
			REMOTE_CONNECTION_UPDATE_CHANNEL,
			REMOTE_CONNECTION_REMOVE_CHANNEL,
			REMOTE_TUNNEL_LIST_CHANNEL,
			REMOTE_TUNNEL_OPEN_CHANNEL,
			REMOTE_TUNNEL_CLOSE_CHANNEL,
			REMOTE_TUNNEL_CLOSE_ALL_CHANNEL,
		]);

		const change: RemoteTunnelChange = { kind: "removed", id: "remote-tunnel-1" };
		for (const listener of tunnelListeners) listener(change);
		for (const listener of stateListeners) listener("ready");
		assert.deepEqual(events, [
			{ channel: REMOTE_TUNNEL_CHANGED_CHANNEL, payload: change },
			{
				channel: REMOTE_AGENT_CONNECTION_CHANGED_CHANNEL,
				payload: { kind: "ssh", generation: 4, authority: "ssh+build-linux", host: "build-linux" },
			},
		]);

		workspaceContext.updateWorkspace({ id: "local-two", uri: URI.file("/workspace/two") });
		await Promise.resolve();
		assert.equal(tunnelCloseAllCalls, 1);
	} finally {
		context.dispose();
		workspaceContext.dispose();
	}
	assert.equal(tunnelsDisposed, true);
	assert.equal(stateListeners.size, 0);
	assert.equal(tunnelListeners.size, 0);
});

test("Remote window context scopes verified rollback to its own supervisor", async () => {
	const workspace = URI.parse("ash-remote://ssh+build-linux/workspace/one");
	const calls: string[] = [];
	const launcher = new SshAppServerProcessLauncher({
		workspace,
		sshExecutable: "custom-ssh",
		remoteExecutable: "ash",
		localEnvironment: {},
		rollbackRuntime: async (host, remoteWorkspace, sshExecutable) => {
			calls.push(`rollback:${host}:${remoteWorkspace}:${sshExecutable}`);
			return "/opt/ash/previous/bin/ash-remote-server";
		},
	});
	const stateListeners = new Set<(state: AppServerConnectionState) => void>();
	const supervisor = {
		generation: 9,
		state: "ready",
		options: { processLauncher: launcher },
		onStateChange: (listener: (state: AppServerConnectionState) => void): IDisposable => {
			stateListeners.add(listener);
			return toDisposable(() => stateListeners.delete(listener));
		},
		stop: async () => { calls.push("stop"); },
		start: async () => { calls.push("start"); },
	} as unknown as AppServerConnectionRelay;
	const workspaceContext = new WorkspaceContextMainService({ id: "remote-one", uri: workspace });
	const tunnels: IRemoteTunnelService & IDisposable = {
		list: async () => [],
		open: async () => { throw new Error("not used"); },
		close: async () => {},
		closeAll: async () => {},
		onDidChange: () => toDisposable(() => {}),
		dispose: () => {},
		[Symbol.dispose]: () => {},
	};
	const context = new RemoteWindowMainContext({
		supervisor,
		workspaceContext,
		connections: {
			available: true,
			list: async () => [],
			save: async connection => connection,
			update: async (_originalName, connection) => connection,
			remove: async () => undefined,
			connect: async () => {},
		},
		tunnels,
		host: {
			send: () => {},
			confirmRuntimeRollback: async () => {
				calls.push("confirm");
				return "confirmed";
			},
			reportRuntimeRollbackFailure: async () => { throw new Error("not used"); },
		},
		prepareForRuntimeReplacement: () => { calls.push("prepare-terminals"); },
	});
	try {
		const route = context.ipcRoutes.find(candidate => candidate.channel === REMOTE_AGENT_RUNTIME_ROLLBACK_CHANNEL);
		assert.ok(route);
		const result = await route.invoke(route.validate(undefined));
		assert.deepEqual(result, { kind: "rolledBack" });
		assert.deepEqual(calls, [
			"confirm",
			"rollback:build-linux:/workspace/one:custom-ssh",
			"prepare-terminals",
			"stop",
			"start",
		]);
	} finally {
		context.dispose();
		workspaceContext.dispose();
	}
});

import assert from "node:assert/strict";
import { test } from "mocha";
import { CancellationError } from "../../../../base/common/errors.js";
import { URI } from "../../../../base/common/uri.js";
import type { DisposableHandle } from "../../../../platform/ipc/common/ipc.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import type { IRemoteTunnelService } from "../../../../platform/remote/common/remoteTunnelService.js";
import type { RemoteTunnel } from "../../../../platform/remote/common/remoteTunnelService.js";
import type { RemoteTunnelChange } from "../../../../platform/remote/common/remoteTunnelService.js";
import { RemoteBrowserViewNavigationResolver } from "../../../../platform/remote/electron-main/remoteBrowserViewNavigationResolver.js";
import type { IAnyWorkspaceIdentifier } from "../../../../platform/workspace/common/workspace.js";

test("Remote Browser tunnels only loopback URLs in a Remote workspace", async () => {
	const tunnels = new TestRemoteTunnels();
	let workspace: IAnyWorkspaceIdentifier = { id: "local", uri: URI.file("/tmp/project") };
	const resolver = new RemoteBrowserViewNavigationResolver({ getWorkspace: () => workspace, tunnels });

	const localLoopback = await resolver.resolve("http://localhost:3000/path", new AbortController().signal);
	workspace = remoteWorkspace();
	const remotePublic = await resolver.resolve("https://example.test/path", new AbortController().signal);

	assert.equal(localLoopback.loadUrl, "http://localhost:3000/path");
	assert.equal(remotePublic.loadUrl, "https://example.test/path");
	assert.deepEqual(tunnels.openedPorts, []);
});

test("Remote Browser maps one requested loopback origin through its SSH tunnel", async () => {
	const tunnels = new TestRemoteTunnels();
	const resolver = new RemoteBrowserViewNavigationResolver({ getWorkspace: remoteWorkspace, tunnels });
	const navigation = await resolver.resolve("http://localhost:3000/path?q=one#two", new AbortController().signal);

	assert.deepEqual(tunnels.openedPorts, [3000]);
	assert.equal(navigation.loadUrl, "http://localhost:41000/path?q=one#two");
	assert.equal(navigation.loadUrlFor("http://localhost:3000/next"), "http://localhost:41000/next");
	assert.equal(navigation.requestedUrlFor("http://localhost:41000/result"), "http://localhost:3000/result");
	assert.equal(navigation.ownsRequestedUrl("http://localhost:3000/another"), true);
	assert.equal(navigation.ownsRequestedUrl("http://localhost:3001/another"), false);
	assert.equal(navigation.ownsLoadedUrl("http://localhost:41000/another"), true);

	navigation.release();
	navigation.release();
	assert.deepEqual(tunnels.closedIds, ["tunnel-1"]);
});

test("Remote Browser derives default HTTPS ports and preserves IPv4 reachability", async () => {
	const tunnels = new TestRemoteTunnels();
	const resolver = new RemoteBrowserViewNavigationResolver({ getWorkspace: remoteWorkspace, tunnels });
	const navigation = await resolver.resolve("https://[::1]/secure", new AbortController().signal);

	assert.deepEqual(tunnels.openedPorts, [443]);
	assert.equal(navigation.loadUrl, "https://127.0.0.1:41000/secure");
	assert.equal(navigation.requestedUrlFor("https://127.0.0.1:41000/next"), "https://[::1]/next");
});

test("Remote Browser retains recovering tunnels but stops reusing failed or removed tunnels", async () => {
	const tunnels = new TestRemoteTunnels();
	const resolver = new RemoteBrowserViewNavigationResolver({ getWorkspace: remoteWorkspace, tunnels });
	const recovering = await resolver.resolve("http://127.0.0.1:8080", new AbortController().signal);
	tunnels.emit({ kind: "upsert", tunnel: { id: "tunnel-1", localPort: 41000, remoteHost: "127.0.0.1", remotePort: 8080, state: "recovering" } });
	assert.equal(recovering.isReusable(), true);
	tunnels.emit({ kind: "upsert", tunnel: { id: "tunnel-1", localPort: 41000, remoteHost: "127.0.0.1", remotePort: 8080, state: "failed" } });
	assert.equal(recovering.isReusable(), false);
	tunnels.emit({ kind: "upsert", tunnel: { id: "tunnel-1", localPort: 41000, remoteHost: "127.0.0.1", remotePort: 8080, state: "open" } });
	assert.equal(recovering.isReusable(), false);

	const removed = await resolver.resolve("http://localhost:9090", new AbortController().signal);
	tunnels.emit({ kind: "removed", id: "tunnel-2" });
	assert.equal(removed.isReusable(), false);
});

test("Remote Browser stops reusing a tunnel after the workspace identity changes", async () => {
	const tunnels = new TestRemoteTunnels();
	let workspace = remoteWorkspace();
	const resolver = new RemoteBrowserViewNavigationResolver({ getWorkspace: () => workspace, tunnels });
	const navigation = await resolver.resolve("http://localhost:8000", new AbortController().signal);

	workspace = { id: "remote-next", uri: createSshRemoteWorkspaceUri("next-host", "/srv/project") };
	assert.equal(navigation.isReusable(), false);
});

test("Remote Browser closes a tunnel completed after cancellation", async () => {
	const tunnels = new TestRemoteTunnels();
	let finishOpen: (tunnel: RemoteTunnel) => void = () => {};
	tunnels.openImplementation = () => new Promise(resolve => {
		finishOpen = resolve;
	});
	const resolver = new RemoteBrowserViewNavigationResolver({ getWorkspace: remoteWorkspace, tunnels });
	const cancellation = new AbortController();
	const pending = resolver.resolve("http://localhost:7000", cancellation.signal);
	const reason = new Error("cancelled by test");
	cancellation.abort(reason);
	finishOpen(tunnels.tunnel());

	await assert.rejects(pending, error => {
		assert.ok(error instanceof CancellationError);
		assert.equal(error.cause, reason);
		return true;
	});
	assert.deepEqual(tunnels.closedIds, ["tunnel-1"]);
});

test("Remote Browser closes a tunnel completed after a workspace change", async () => {
	const tunnels = new TestRemoteTunnels();
	let workspace = remoteWorkspace();
	let finishOpen: (tunnel: RemoteTunnel) => void = () => {};
	tunnels.openImplementation = () => new Promise(resolve => {
		finishOpen = resolve;
	});
	const resolver = new RemoteBrowserViewNavigationResolver({ getWorkspace: () => workspace, tunnels });
	const pending = resolver.resolve("http://localhost:6000", new AbortController().signal);
	workspace = { id: "local", uri: URI.file("/tmp/next") };
	finishOpen(tunnels.tunnel());

	await assert.rejects(pending, /workspace changed/);
	assert.deepEqual(tunnels.closedIds, ["tunnel-1"]);
});

class TestRemoteTunnels implements IRemoteTunnelService {
	readonly openedPorts: number[] = [];
	readonly closedIds: string[] = [];
	openImplementation: (remotePort: number) => Promise<RemoteTunnel> = remotePort => Promise.resolve(this.tunnel({ remotePort }));
	private readonly listeners = new Set<(change: RemoteTunnelChange) => void>();
	private nextTunnel = 1;

	list(): Promise<readonly RemoteTunnel[]> {
		return Promise.resolve([]);
	}

	open(request: { readonly remotePort: number }): Promise<RemoteTunnel> {
		this.openedPorts.push(request.remotePort);
		return this.openImplementation(request.remotePort);
	}

	close(id: string): Promise<void> {
		this.closedIds.push(id);
		return Promise.resolve();
	}

	closeAll(): Promise<void> {
		return Promise.resolve();
	}

	onDidChange(listener: (change: RemoteTunnelChange) => void): DisposableHandle {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	emit(change: RemoteTunnelChange): void {
		for (const listener of this.listeners) listener(change);
	}

	tunnel(overrides: Partial<RemoteTunnel> = {}): RemoteTunnel {
		const number = this.nextTunnel++;
		return {
			id: `tunnel-${number}`,
			localPort: 40999 + number,
			remoteHost: "127.0.0.1",
			remotePort: 8080,
			state: "open",
			...overrides,
		};
	}
}

function remoteWorkspace() {
	return { id: "remote", uri: createSshRemoteWorkspaceUri("work-server", "/srv/project") };
}

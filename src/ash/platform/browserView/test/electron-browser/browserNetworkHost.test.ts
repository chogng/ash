import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import type { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import type { IRendererAgentHostConnection, IRendererHost } from '../../../renderer/common/rendererHost.js';
import { AgentHostConnectionsService } from '../../../agentHost/browser/agentHostConnectionsService.js';
import type { RemoteAgentHostConnection } from '../../../agentHost/common/remoteAgentHostService.js';
import { createDisconnectedRendererApi } from '../../../../workbench/browser/rendererApi.js';
import { createProviderRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import type { IWorkspaceContextService } from '../../../workspace/common/workspace.js';
import type { ITcpService } from '../../../network/common/tcp.js';
import { registerBrowserNetworkHost } from '../../electron-browser/browserNetworkHost.js';

ensureNoDisposablesAreLeakedInTestSuite();

function registry(ambient: IRendererHost, entries: IRendererAgentHostConnection[]): AgentHostConnectionsService {
	return new AgentHostConnectionsService({
		...ambient,
		agentHosts: {
			get connections() { return entries; }, onDidChangeConnections: Event.None,
			connect: async () => { throw new Error('Routing borrows existing connections'); },
			disconnect: () => { throw new Error('Routing cannot retire connections'); },
			reconnect: async () => { }, listWSLDistros: async () => [],
		},
	});
}

function endpoint(authority: string, path: string, api: IRendererHost): IRendererAgentHostConnection {
	let connection: RemoteAgentHostConnection = { name: path, host: authority.slice(4), workspace: path };
	if (authority.startsWith('wsl+')) {
		connection = { type: 'wsl', name: path, distro: 'distro', workspace: path };
	} else if (authority.startsWith('tunnel+')) {
		connection = { type: 'tunnel', name: path, endpoint: 'http://127.0.0.1:5174/', workspace: path };
	}
	const id = `${authority}:${path}`;
	return {
		id, connection, state: 'ready',
		host: {
			id, connection, api, ...toDisposable(() => { }),
			directory: { uri: URI.from({ scheme: 'ash-remote', authority, path }), target: { type: 'environment', dirId: id } },
		},
	};
}

test('browser proxy routes SSH, WSL, Tunnel and nested containers through their exact backend connection', async () => {
	let channel: IServerChannel<string>;
	const calls: unknown[] = [];
	const api = (name: string): ITcpService => ({
		generation: 1, open: async (...args) => { calls.push([name, ...args]); }, read: async () => ({ bytes: new Uint8Array(), eof: true }),
		write: async () => 0, end: async () => { }, close: async () => { },
	});
	let windowRemote: string | undefined;
	const ambient = { ...createDisconnectedRendererApi(), tcp: api('local'), localTcp: api('device') };
	const hosts = ['ssh+host', 'wsl+64697374726f', 'tunnel+1234'].map(authority => ({
		directory: { uri: URI.from({ scheme: 'ash-remote', authority, path: '/repo' }) }, state: 'ready', connection: { tcp: api(authority) },
	}));
	using resources = new DisposableStore();
	const entries = hosts.map(host => endpoint(host.directory.uri.authority, '/repo', { ...ambient, tcp: host.connection.tcp }));
	for (const entry of entries) { resources.add(entry.host!); }
	using connections = registry(ambient, entries);
	using lifetime = registerBrowserNetworkHost({ registerChannel: (_name, registered) => { channel = registered; } } as IMainProcessService,
		connections,
		{ getWorkspace: () => ({ id: 'window', folders: [], remoteAuthority: windowRemote }) } as unknown as IWorkspaceContextService, ambient.localTcp);
	for (const host of hosts) {
		const id = crypto.randomUUID();
		await channel!.call('window', 'open', { id, network: { authority: host.directory.uri.authority }, host: 'localhost', port: 3000 });
	}
	for (const hostAuthority of [undefined, ...hosts.map(host => host.directory.uri.authority)]) {
		const authority = createProviderRemoteWorkspaceUri('container', 'runtime', '/workspace', hostAuthority).authority;
		await channel!.call('window', 'open', { id: crypto.randomUUID(), network: { authority, root: '/workspace' }, host: 'service.internal', port: 80 });
	}
	assert.deepEqual(calls.map(call => (call as unknown[])[0]), ['ssh+host', 'wsl+64697374726f', 'tunnel+1234', 'local', 'ssh+host', 'wsl+64697374726f', 'tunnel+1234']);
	assert.deepEqual((calls[6] as unknown[])[4], { type: 'provider', providerId: 'container', workspace: 'runtime', root: '/workspace', hostAuthority: 'tunnel+1234' });
	windowRemote = 'ssh+primary';
	await channel!.call('window', 'open', { id: crypto.randomUUID(), network: { authority: createProviderRemoteWorkspaceUri('container', 'local-runtime', '/workspace').authority, root: '/workspace' }, host: 'localhost', port: 3000 });
	assert.equal((calls.at(-1) as unknown[])[0], 'device');
	await assert.rejects(channel!.call('window', 'open', { id: crypto.randomUUID(), network: { authority: 'wsl+missing' }, host: 'localhost', port: 3000 }), /BrowserRemoteNetworkUnavailable/);
});

test('a reconnect during open retires its reservation without closing a new connection stream', async () => {
	let channel: IServerChannel<string>;
	let generation = 1;
	let finishOpen!: () => void;
	let firstOpen = true;
	let closed = false;
	const tcp: ITcpService = {
		get generation() { return generation; },
		open: async () => { if (firstOpen) { firstOpen = false; await new Promise<void>(resolve => { finishOpen = resolve; }); } },
		read: async () => ({ bytes: new Uint8Array(), eof: true }), write: async () => 0, end: async () => { }, close: async () => { closed = true; },
	};
	using connections = registry({ ...createDisconnectedRendererApi(), tcp }, []);
	using lifetime = registerBrowserNetworkHost({ registerChannel: (_name, registered) => { channel = registered; } } as IMainProcessService,
		connections,
		{ getWorkspace: () => ({ id: 'window', folders: [] }) } as unknown as IWorkspaceContextService);
	const request = { id: crypto.randomUUID(), network: { authority: 'ssh+host' }, host: 'localhost', port: 3000 };
	const opening = channel!.call('window', 'open', request);
	generation++;
	finishOpen();
	await assert.rejects(opening, /BrowserRemoteNetworkUnavailable/);
	assert.equal(closed, false);
	await channel!.call('window', 'open', request);
});

test('same-host directory routing keeps an unavailable child and ambiguous resources off other connections', async () => {
	let channel: IServerChannel<string>;
	const calls: string[] = [];
	const ambient = createDisconnectedRendererApi();
	const tcp = (name: string): ITcpService => ({
		generation: 1, open: async () => { calls.push(name); }, close: async () => { },
		read: async () => ({ bytes: new Uint8Array(), eof: true }), write: async () => 0, end: async () => { },
	});
	const parent = endpoint('ssh+host', '/repo', { ...ambient, tcp: tcp('parent') });
	const child = endpoint('ssh+host', '/repo/nested', { ...ambient, tcp: tcp('child') });
	using resources = new DisposableStore();
	resources.add(parent.host!); resources.add(child.host!);
	const entries = [parent, child];
	using connections = registry({ ...ambient, tcp: tcp('ambient') }, entries);
	using lifetime = registerBrowserNetworkHost({ registerChannel: (_name, registered) => { channel = registered; } } as IMainProcessService,
		connections, { getWorkspace: () => ({ id: 'window', folders: [] }) } as unknown as IWorkspaceContextService);
	const open = (root?: string): Promise<unknown> => channel!.call('window', 'open', {
		id: crypto.randomUUID(), network: { authority: 'ssh+host', root }, host: 'localhost', port: 3000,
	});
	await open('/repo/nested/worktree');
	await open('/repo/file');
	assert.deepEqual(calls, ['child', 'parent']);
	entries[1] = { ...child, state: 'initializing', host: undefined };
	await assert.rejects(open('/repo/nested/worktree'), /BrowserRemoteNetworkUnavailable/);
	await assert.rejects(open('/repository'), /BrowserRemoteNetworkUnavailable/);
	await assert.rejects(open(), /BrowserRemoteNetworkUnavailable/);
	assert.deepEqual(calls, ['child', 'parent']);
});

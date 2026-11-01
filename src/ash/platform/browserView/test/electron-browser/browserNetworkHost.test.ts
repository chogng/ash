import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import type { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import type { IRendererHost } from '../../../renderer/common/rendererHost.js';
import type { IAgentHostConnectionsService } from '../../../agentHost/common/agentHostConnectionsService.js';
import { createProviderRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import type { IWorkspaceContextService } from '../../../workspace/common/workspace.js';
import type { ITcpService } from '../../../network/common/tcp.js';
import { registerBrowserNetworkHost } from '../../electron-browser/browserNetworkHost.js';

test('browser proxy routes SSH, WSL, Tunnel and nested containers through their exact backend connection', async () => {
	let channel: IServerChannel<string>;
	const calls: unknown[] = [];
	const api = (name: string): ITcpService => ({
		generation: 1, open: async (...args) => { calls.push([name, ...args]); }, read: async () => ({ bytes: new Uint8Array(), eof: true }),
		write: async () => 0, end: async () => { }, close: async () => { },
	});
	let windowRemote: string | undefined;
	const ambient = { tcp: api('local'), localTcp: api('device') } as IRendererHost;
	const hosts = ['ssh+host', 'wsl+64697374726f', 'tunnel+1234'].map(authority => ({
		directory: { uri: URI.from({ scheme: 'ash-remote', authority, path: '/repo' }) }, state: 'ready', connection: { tcp: api(authority) },
	}));
	using lifetime = registerBrowserNetworkHost({ registerChannel: (_name, registered) => { channel = registered; } } as IMainProcessService,
		{ connections: hosts } as unknown as IAgentHostConnectionsService, ambient,
		{ getWorkspace: () => ({ id: 'window', folders: [], remoteAuthority: windowRemote }) } as unknown as IWorkspaceContextService);
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
	using lifetime = registerBrowserNetworkHost({ registerChannel: (_name, registered) => { channel = registered; } } as IMainProcessService,
		{ connections: [] } as unknown as IAgentHostConnectionsService, { tcp } as IRendererHost,
		{ getWorkspace: () => ({ id: 'window', folders: [] }) } as unknown as IWorkspaceContextService);
	const request = { id: crypto.randomUUID(), network: { authority: 'ssh+host' }, host: 'localhost', port: 3000 };
	const opening = channel!.call('window', 'open', request);
	generation++;
	finishOpen();
	await assert.rejects(opening, /BrowserRemoteNetworkUnavailable/);
	assert.equal(closed, false);
	await channel!.call('window', 'open', request);
});

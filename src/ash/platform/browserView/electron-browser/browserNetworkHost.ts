import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import type { IAgentHostConnectionInfo, IAgentHostConnectionsService } from '../../agentHost/common/agentHostConnectionsService.js';
import type { IWorkspaceContextService } from '../../workspace/common/workspace.js';
import { getWorkspaceRemoteAuthority } from '../../workspace/common/workspace.js';
import { ASH_REMOTE_SCHEME, getProviderRemoteWorkspace } from '../../remote/common/remote.js';
import type { ITcpService, TcpExecutionTarget } from '../../network/common/tcp.js';
import { validateBrowserViewNetwork } from '../common/browserView.js';
import { isRecord } from '../../../base/common/types.js';

/** Resolves proxy streams through backend connections; local device access is supplied by the window owner. */
export function registerBrowserNetworkHost(
	main: IMainProcessService,
	hosts: IAgentHostConnectionsService,
	workspace: IWorkspaceContextService,
	localTcp?: ITcpService,
) {
	const lifetime = new DisposableStore();
	const ambient = hosts.ambientConnection;
	const streams = new Map<string, { api: ITcpService; generation: number; target?: TcpExecutionTarget; }>();
	lifetime.add(toDisposable(() => {
		for (const [id, stream] of streams) { if (stream.api.generation === stream.generation) { void stream.api.close(id, stream.target).catch(() => { }); } }
		streams.clear();
	}));
	const select = (value: unknown) => {
		const network = validateBrowserViewNetwork(value);
		const runtime = getProviderRemoteWorkspace(URI.from({ scheme: ASH_REMOTE_SCHEME, authority: network.authority, path: '/' }));
		const authority = runtime?.hostAuthority ?? (runtime ? 'local' : network.authority);
		let info: IAgentHostConnectionInfo | undefined;
		try {
			info = hosts.resolveConnection(URI.from({ scheme: ASH_REMOTE_SCHEME, authority, path: runtime ? '/' : network.root ?? '/' }));
		} catch {
			throw new Error('BrowserRemoteNetworkUnavailable');
		}
		const local = authority === 'local' || authority === getWorkspaceRemoteAuthority(workspace.getWorkspace());
		let host = info?.connection;
		if (!info && (local || authority.startsWith('ssh+'))) { host = ambient; }
		const tcp = authority === 'local' && getWorkspaceRemoteAuthority(workspace.getWorkspace()) ? localTcp : host?.tcp;
		if (!tcp || info && info.state !== 'ready') { throw new Error('BrowserRemoteNetworkUnavailable'); }
		const target: TcpExecutionTarget | undefined = runtime
			? { type: 'provider', providerId: runtime.providerId, workspace: runtime.workspace, root: network.root ?? '/', ...(runtime.hostAuthority ? { hostAuthority: runtime.hostAuthority } : {}) }
			: !info && !local && authority.startsWith('ssh+') ? { type: 'ssh', host: authority.slice(4), root: '/' } : undefined;
		return { api: tcp, generation: tcp.generation, target };
	};
	main.registerChannel('browserNetwork', {
		listen: () => { throw new Error('Browser network has no events'); },
		call: async <T>(_context: string, command: string, value: unknown): Promise<T> => {
			if (lifetime.isDisposed || !isRecord(value)) { throw new Error('BrowserRemoteNetworkUnavailable'); }
			if (command === 'probe') { select(value.network); return undefined as T; }
			const id = value.id;
			if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id)) { throw new TypeError('Invalid browser TCP identity'); }
			if (command === 'open') {
				if (streams.has(id) || streams.size >= 256 || typeof value.host !== 'string' || value.host.length > 253 || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) { throw new TypeError('Invalid browser TCP request'); }
				const stream = select(value.network);
				streams.set(id, stream);
				try { await stream.api.open(id, value.host, value.port as number, stream.target); }
				catch (error) { if (streams.get(id) === stream) { streams.delete(id); } throw error; }
				if (lifetime.isDisposed || streams.get(id) !== stream || stream.api.generation !== stream.generation) {
					if (streams.get(id) === stream) { streams.delete(id); }
					if (stream.api.generation === stream.generation) { await stream.api.close(id, stream.target); }
					throw new Error('BrowserRemoteNetworkUnavailable');
				}
				return undefined as T;
			}
			const stream = streams.get(id);
			if (command === 'close') {
				streams.delete(id);
				if (stream && stream.api.generation === stream.generation) { await stream.api.close(id, stream.target); }
				return undefined as T;
			}
			if (!stream || stream.api.generation !== stream.generation) { throw new Error('BrowserRemoteNetworkUnavailable'); }
			if (command === 'read') { const result = await stream.api.read(id, stream.target); return { dataBase64: encodeBase64(VSBuffer.wrap(new Uint8Array(result.bytes))), eof: result.eof } as T; }
			if (command === 'end') { return await stream.api.end(id, stream.target) as T; }
			if (command === 'write' && typeof value.dataBase64 === 'string' && value.dataBase64.length <= 87384) {
				const bytes = decodeBase64(value.dataBase64);
				if (bytes.byteLength > 65536 || encodeBase64(bytes) !== value.dataBase64) { throw new TypeError('Invalid TCP chunk'); }
				return await stream.api.write(id, bytes.buffer, stream.target) as T;
			}
			throw new TypeError('Invalid browser TCP operation');
		},
	});
	return lifetime;
}

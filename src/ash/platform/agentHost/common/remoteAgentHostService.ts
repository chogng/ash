import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IFileSystemDirectory } from '../../files/common/fileApi.js';
import type { IAgentConnection } from './agentService.js';
import type { AppServerConnectionState } from './appServerApi.js';
import { localize } from '../../../nls.js';
import { encodeHex, VSBuffer } from '../../../base/common/buffer.js';
import { URI } from '../../../base/common/uri.js';
import { ASH_REMOTE_SCHEME, createSshRemoteWorkspaceUri, normalizeRemoteWorkspacePath } from '../../remote/common/remote.js';
import { canonicalRemoteConnectionDefinition, type RemoteConnectionDefinition } from '../../remote/common/remoteConnectionService.js';

/** SSH uses the backend-owned saved catalog. WSL and self-hosted Tunnel leases are window-local. */
export type RemoteAgentHostConnection = RemoteConnectionDefinition
	| { readonly type: 'wsl'; readonly name: string; readonly distro: string; readonly workspace: string; }
	| { readonly type: 'tunnel'; readonly name: string; readonly endpoint: string; readonly workspace: string; };

export function isSSHAgentHost(connection: RemoteAgentHostConnection): connection is RemoteConnectionDefinition {
	return !('type' in connection);
}

export function remoteAgentHostRoot(connection: RemoteAgentHostConnection, leaseId?: string): URI {
	if (isSSHAgentHost(connection)) return createSshRemoteWorkspaceUri(connection.host, connection.workspace);
	// A loopback port can later forward to another device. Tunnel resource identity lasts only for this authenticated lease.
	if (connection.type === 'tunnel' && !leaseId) throw new TypeError('Tunnel resources require a connection lease');
	const identity = connection.type === 'wsl' ? connection.distro : leaseId!;
	const authority = `${connection.type}+${encodeHex(VSBuffer.fromString(identity))}`;
	const path = normalizeRemoteWorkspacePath(connection.workspace);
	return URI.from({ scheme: ASH_REMOTE_SCHEME, authority, path: /^[A-Z]:\//.test(path) ? `/${path}` : path });
}

/** Canonicalizes untrusted native IPC input without accepting commands or arbitrary network endpoints. */
export function canonicalAgentHostConnection(value: unknown): RemoteAgentHostConnection {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Agent host');
	const data = value as Record<string, unknown>;
	const type = data.type;
	if (type === undefined) {
		keys(data, ['name', 'host', 'workspace']);
		return canonicalRemoteConnectionDefinition({ name: text(data.name, 64), host: text(data.host, 253), workspace: text(data.workspace, 32768) });
	}
	const name = text(data.name, 256);
	const workspace = normalizeRemoteWorkspacePath(text(data.workspace, 32768));
	if (type === 'wsl') {
		keys(data, ['type', 'name', 'distro', 'workspace']);
		const distro = text(data.distro, 256);
		if (distro.startsWith('-') || /[\\/]/.test(distro) || !workspace.startsWith('/')) throw new TypeError('Invalid WSL target');
		return { type, name, distro, workspace };
	}
	if (type === 'tunnel') {
		keys(data, ['type', 'name', 'endpoint', 'workspace']);
		return { type, name, endpoint: tunnelEndpoint(text(data.endpoint, 512)).href, workspace };
	}
	throw new TypeError('Unsupported Agent host type');
}

/** Ash Tunnel's SSH forward preserves the launch URL's loopback port and Origin. */
export function tunnelEndpoint(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
		throw new TypeError('Expected the loopback URL from Ash Tunnel connection instructions');
	}
	return url;
}

function text(value: unknown, maximum: number): string {
	if (typeof value !== 'string' || !value.length || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid Agent host field');
	return value;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
	if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new TypeError('Agent host must contain exactly required keys');
}

/** One independent backend connection. Disposing it releases its carrier, never its shared daemon. */
export interface IRemoteAgentHostProtocolClient extends IDisposable {
	readonly id: string;
	readonly connection: RemoteAgentHostConnection;
	readonly api: IAgentConnection;
	readonly directory: IFileSystemDirectory;
}

/** A runtime-owned endpoint. Domain ports are borrowed and retain their original connection scope. */
export interface IRemoteAgentHostConnectionInfo {
	readonly id: string;
	readonly connection: RemoteAgentHostConnection;
	readonly state: AppServerConnectionState;
	readonly host: IRemoteAgentHostProtocolClient | undefined;
}

export interface IRemoteAgentHostService {
	readonly isAvailable: boolean;
	readonly connections: readonly IRemoteAgentHostConnectionInfo[];
	readonly onDidChangeConnections: Event<void>;
	connect(connection: RemoteAgentHostConnection, signal: AbortSignal, ticket?: string): Promise<IRemoteAgentHostProtocolClient>;
	listWSLDistros(): Promise<readonly string[]>;
	disconnect(id: string): void;
	reconnect(id: string): Promise<void>;
}


export const IRemoteAgentHostService = createDecorator<IRemoteAgentHostService>('remoteAgentHostService');

/** Explicit runtime availability for windows without native remote-host acquisition. */
export class NullRemoteAgentHostService implements IRemoteAgentHostService {
	readonly isAvailable = false;
	readonly connections = [];
	readonly onDidChangeConnections = Event.None;
	async connect(): Promise<IRemoteAgentHostProtocolClient> {
		throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.unavailable' }, 'Agent host connections are unavailable in this window.'));
	}
	async listWSLDistros(): Promise<readonly string[]> { return []; }
	disconnect(): void { }
	async reconnect(): Promise<void> { await this.connect(); }
}

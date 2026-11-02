import type { IVoiceCodeTranscriptionBackendService } from './dictation.js';
import type { IAgentConnection } from '../../agentHost/common/agentService.js';
import type { IFileSystemDirectory } from '../../files/common/fileApi.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { RemoteAgentHostConnection } from '../../agentHost/common/remoteAgentHostService.js';
import type { ILocalTranscriptionService, ILocalTranscriptionModelService } from '../../localTranscription/common/localTranscription.js';
import type { AppServerConnectionState } from '../../agentHost/common/appServerApi.js';
import type { Event } from '../../../base/common/event.js';
import type { IDebugAdapterProcessService } from '../../debug/common/debugAdapterProcessService.js';
import type { IRemoteAgentApi } from '../../remote/common/remoteAgentApi.js';
import type { IRemoteConnectionApi } from '../../remote/common/remoteConnectionService.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { URI } from '../../../base/common/uri.js';

/** Optional product capabilities contributed by a statically selected host bundle. */
export interface RendererHostCapabilities {
	readonly debugAdapter?: IDebugAdapterProcessService;
	readonly localTranscription?: ILocalTranscriptionService;
	readonly localTranscriptionModels?: ILocalTranscriptionModelService;
}

/** Merges product capabilities while rejecting two contributions that claim the same slot. */
export function mergeRendererHostCapabilities(capabilities: readonly RendererHostCapabilities[]): RendererHostCapabilities {
	const merged: Record<string, unknown> = {};
	for (const capability of capabilities) {
		for (const [name, value] of Object.entries(capability)) {
			if (value === undefined) continue;
			if (Object.hasOwn(merged, name)) throw new Error(`Renderer host capability '${name}' was contributed more than once`);
			merged[name] = value;
		}
	}
	return merged;
}

/** One independent backend connection. Disposing it releases its carrier, never its shared daemon. */
export interface IRendererAgentHost extends IDisposable {
	readonly id: string;
	readonly connection: RemoteAgentHostConnection;
	readonly api: IAgentConnection;
	readonly directory: IFileSystemDirectory;
}

/** A runtime-owned endpoint. Domain ports are borrowed and retain their original connection scope. */
export interface IRendererAgentHostConnection {
	readonly id: string;
	readonly connection: RemoteAgentHostConnection;
	readonly state: AppServerConnectionState;
	readonly host: IRendererAgentHost | undefined;
}

export interface IRendererAgentHostService {
	readonly connections: readonly IRendererAgentHostConnection[];
	readonly onDidChangeConnections: Event<void>;
	connect(connection: RemoteAgentHostConnection, signal: AbortSignal, ticket?: string): Promise<IRendererAgentHost>;
	listWSLDistros(): Promise<readonly string[]>;
	disconnect(id: string): void;
	reconnect(id: string): Promise<void>;
}

/** Transport-neutral capability set supplied by a renderer host at startup. */
export interface IRendererHost extends IAgentConnection, RendererHostCapabilities {
	readonly dictation?: IVoiceCodeTranscriptionBackendService;
	/** Native local connection remains distinct when the window's primary host is remote. */
	readonly localTcp?: import('../../network/common/tcp.js').ITcpService;
	/** Host support is stable for the window; connection state describes temporary availability. */
	readonly hasAppServer: boolean;
	/** Actual local OS user directory when supplied by the desktop host. */
	readonly localUserHome?: URI;
	/** Granted local profile directory; absent in browser-only hosts. */
	readonly userDataHome?: URI;
	/** Opens this host's profile TOML; absent when the host cannot edit a local profile. */
	readonly editUserConfiguration?: () => Promise<void>;
	readonly remote?: IRemoteAgentApi;
	/** Optional because web hosts cannot restart into a host-owned SSH connection. */
	readonly remoteConnections?: IRemoteConnectionApi;
	/** Additional backend scopes are available only in hosts with a multi-host window owner. */
	readonly agentHosts?: IRendererAgentHostService;
}

export const IRendererHostService = createServiceIdentifier<IRendererHost>('rendererHostService');

import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IAddressProvider } from '../../remote/common/remoteAgentConnection.js';

export enum TunnelPrivacyId {
	ConstantPrivate = 'constantPrivate',
	Private = 'private',
	Public = 'public',
}

export interface RemoteTunnel {
	readonly tunnelRemotePort: number;
	readonly tunnelRemoteHost: string;
	readonly tunnelLocalPort?: number;
	readonly localAddress: string;
	readonly privacy: string;
	readonly protocol?: string;
	/** Ash SSH forwards also report process recovery without exposing the process handle. */
	readonly state?: 'open' | 'recovering' | 'failed';
	dispose(silent?: boolean): Promise<void>;
}

/** The supported Tunnel service surface; SSH transport details stay behind its provider. */
export interface ITunnelService {
	readonly _serviceBrand: undefined;
	readonly tunnels: Promise<readonly RemoteTunnel[]>;
	readonly onTunnelOpened: Event<RemoteTunnel>;
	readonly onTunnelClosed: Event<{ host: string; port: number; }>;
	openTunnel(addressProvider: IAddressProvider | undefined, remoteHost: string | undefined, remotePort: number, localHost?: string, localPort?: number, elevateIfNeeded?: boolean, privacy?: string, protocol?: string): Promise<RemoteTunnel | string | undefined> | undefined;
	closeTunnel(remoteHost: string, remotePort: number): Promise<void>;
}

export const ITunnelService = createServiceIdentifier<ITunnelService>('tunnelService');

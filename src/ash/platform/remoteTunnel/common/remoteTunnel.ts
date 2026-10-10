import type { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export interface IRemoteTunnelSession {
	readonly providerId: string;
	readonly sessionId: string;
	readonly accountLabel: string;
	readonly token?: string;
}

export interface ActiveTunnelMode {
	readonly active: true;
	readonly session: IRemoteTunnelSession;
	readonly asService: boolean;
}

export interface InactiveTunnelMode {
	readonly active: false;
}

export type TunnelMode = ActiveTunnelMode | InactiveTunnelMode;
export const INACTIVE_TUNNEL_MODE: InactiveTunnelMode = Object.freeze({ active: false });

export interface ConnectionInfo {
	readonly link?: string;
	readonly domain?: string;
	readonly tunnelName: string;
	readonly tunnelId?: string;
	readonly isAttached: boolean;
}

export namespace TunnelStates {
	export interface Uninitialized { readonly type: 'uninitialized'; }
	export interface Connecting { readonly type: 'connecting'; readonly progress?: string; }
	export interface Connected { readonly type: 'connected'; readonly info: ConnectionInfo; readonly serviceInstallFailed: boolean; }
	export interface Disconnected { readonly type: 'disconnected'; readonly onTokenFailed?: IRemoteTunnelSession; }

	export const uninitialized: Uninitialized = Object.freeze({ type: 'uninitialized' });
	export function connecting(progress?: string): Connecting { return { type: 'connecting', progress }; }
	export function connected(info: ConnectionInfo, serviceInstallFailed: boolean): Connected { return { type: 'connected', info, serviceInstallFailed }; }
	export function disconnected(onTokenFailed?: IRemoteTunnelSession): Disconnected { return { type: 'disconnected', onTokenFailed }; }
}

export type TunnelStatus = TunnelStates.Uninitialized | TunnelStates.Connecting | TunnelStates.Connected | TunnelStates.Disconnected;
export const IRemoteTunnelService = createDecorator<IRemoteTunnelService>('IRemoteTunnelService');

/** Application-scoped inbound access. Port forwarding belongs to ITunnelService. */
export interface IRemoteTunnelService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeTunnelStatus: Event<TunnelStatus>;
	readonly onDidChangeMode: Event<TunnelMode>;
	readonly onDidTokenFailed: Event<IRemoteTunnelSession | undefined>;
	getTunnelStatus(): Promise<TunnelStatus>;
	getMode(): Promise<TunnelMode>;
	initialize(mode: TunnelMode): Promise<TunnelStatus>;
	startTunnel(mode: ActiveTunnelMode): Promise<TunnelStatus>;
	stopTunnel(): Promise<void>;
	getTunnelName(): Promise<string | undefined>;
}

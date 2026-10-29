import { Event } from '../../../base/common/event.js';
import { INACTIVE_TUNNEL_MODE, TunnelStates, type ActiveTunnelMode, type IRemoteTunnelService, type TunnelMode, type TunnelStatus } from '../common/remoteTunnel.js';

/** Browsers can connect to a hosted workspace but cannot host local processes. */
export class BrowserRemoteTunnelService implements IRemoteTunnelService {
	declare public readonly _serviceBrand: undefined;
	public readonly onDidChangeTunnelStatus = Event.None;
	public readonly onDidChangeMode = Event.None;
	public readonly onDidTokenFailed = Event.None;
	public async getTunnelStatus(): Promise<TunnelStatus> { return TunnelStates.uninitialized; }
	public async getMode(): Promise<TunnelMode> { return INACTIVE_TUNNEL_MODE; }
	public async initialize(_mode: TunnelMode): Promise<TunnelStatus> { return TunnelStates.uninitialized; }
	public async startTunnel(_mode: ActiveTunnelMode): Promise<TunnelStatus> { return TunnelStates.uninitialized; }
	public async stopTunnel(): Promise<void> { }
	public async getTunnelName(): Promise<string | undefined> { return undefined; }
}

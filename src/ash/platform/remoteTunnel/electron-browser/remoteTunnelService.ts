import type { Event } from '../../../base/common/event.js';
import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import type { ActiveTunnelMode, IRemoteTunnelService, IRemoteTunnelSession, TunnelMode, TunnelStatus } from '../common/remoteTunnel.js';

/** Desktop facade for the application's inbound-host owner. */
export class RemoteTunnelService implements IRemoteTunnelService {
	declare public readonly _serviceBrand: undefined;
	private readonly channel: IChannel;
	public readonly onDidChangeTunnelStatus: Event<TunnelStatus>;
	public readonly onDidChangeMode: Event<TunnelMode>;
	public readonly onDidTokenFailed: Event<IRemoteTunnelSession | undefined>;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.channel = mainProcessService.getChannel('remoteTunnel');
		this.onDidChangeTunnelStatus = this.channel.listen('onDidChangeTunnelStatus');
		this.onDidChangeMode = this.channel.listen('onDidChangeMode');
		this.onDidTokenFailed = this.channel.listen('onDidTokenFailed');
	}

	public getTunnelStatus(): Promise<TunnelStatus> { return this.channel.call('getTunnelStatus'); }
	public getMode(): Promise<TunnelMode> { return this.channel.call('getMode'); }
	public initialize(mode: TunnelMode): Promise<TunnelStatus> { return this.channel.call('initialize', mode); }
	public startTunnel(mode: ActiveTunnelMode): Promise<TunnelStatus> { return this.channel.call('startTunnel', mode); }
	public stopTunnel(): Promise<void> { return this.channel.call('stopTunnel'); }
	public getTunnelName(): Promise<string | undefined> { return this.channel.call('getTunnelName'); }
}

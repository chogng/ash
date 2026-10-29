import { Event } from '../../../../base/common/event.js';
import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import type { IAddressProvider } from '../../../../platform/remote/common/remoteAgentConnection.js';
import type { ITunnelService, RemoteTunnel } from '../../../../platform/tunnel/common/tunnel.js';

/** Web currently has no tunnel provider; SSH execution belongs to the Desktop host. */
export class TunnelService extends AbstractDisposable implements ITunnelService {
	declare public readonly _serviceBrand: undefined;
	public readonly onDidChange = Event.None;
	public readonly onTunnelOpened = Event.None;
	public readonly onTunnelClosed = Event.None;

	public get tunnels(): Promise<readonly RemoteTunnel[]> {
		this.assertNotDisposed();
		return Promise.resolve([]);
	}

	public openTunnel(_addressProvider: IAddressProvider | undefined, _remoteHost: string | undefined, _remotePort: number, _localHost?: string, _localPort?: number, _elevateIfNeeded?: boolean, _privacy?: string, _protocol?: string): undefined {
		this.assertNotDisposed();
		return undefined;
	}

	public async getExistingTunnel(_host: string, _port: number): Promise<undefined> { this.assertNotDisposed(); return undefined; }
	public async closeAll(): Promise<void> { this.assertNotDisposed(); }

	public async closeTunnel(_remoteHost: string, _remotePort: number): Promise<void> {
		this.assertNotDisposed();
	}

	protected override disposeCore(): void { }
}

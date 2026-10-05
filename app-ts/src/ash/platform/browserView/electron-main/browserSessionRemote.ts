import type { Session } from 'electron/main';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { SshRemoteTunnelService } from '../../remote/electron-main/sshRemoteTunnelService.js';

/** A remote storage session keeps its proxy policy until its last page releases the network owner. */
export class BrowserSessionRemote extends Disposable {
	private readonly cancellation = new AbortController();

	constructor(private readonly session: Session) {
		super();
		this._register(toDisposable(() => this.cancellation.abort()));
	}
	public async initialize(tunnels: SshRemoteTunnelService): Promise<void> {
		const proxy = await tunnels.openProxy(this.cancellation.signal);
		if (this.isDisposed) { proxy.dispose(); this.cancellation.signal.throwIfAborted(); }
		this._register(proxy);
		// Chromium otherwise bypasses loopback even when a proxy is explicitly configured.
		await this.session.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${proxy.localPort}`, proxyBypassRules: '<-loopback>' });
		await this.session.closeAllConnections();
		this.cancellation.signal.throwIfAborted();
		proxy.signal.throwIfAborted();
		const stop = (): void => { void this.session.closeAllConnections(); };
		proxy.signal.addEventListener('abort', stop, { once: true });
		this._register(toDisposable(() => proxy.signal.removeEventListener('abort', stop)));
	}
}

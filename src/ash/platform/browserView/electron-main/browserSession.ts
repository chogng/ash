import { raceCancellationError } from '../../../base/common/async.js';
import type { Session } from 'electron/main';
import { BrowserViewStorageScope } from '../common/browserView.js';
import { BrowserSessionPermissions } from './browserSessionPermissions.js';
import { BrowserSessionRemote } from './browserSessionRemote.js';
import type { SshRemoteTunnelService } from '../../remote/electron-main/sshRemoteTunnelService.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';

/** Storage and permission policy have the Electron session's lifetime, independent of any page. */
export class BrowserSession {
	private static readonly sessions = new WeakMap<Session, BrowserSession>();
	public readonly permissions: BrowserSessionPermissions;
	private remote: BrowserSessionRemote | undefined;
	private remoteReady: Promise<void> | undefined;
	private networkUsers = 0;

	private constructor(
		public readonly id: string,
		public readonly storageScope: BrowserViewStorageScope,
		public readonly electronSession: Session,
	) {
		this.permissions = new BrowserSessionPermissions(electronSession);
	}

	public async acquireRemote(tunnels: SshRemoteTunnelService, signal: AbortSignal): Promise<IDisposable> {
		this.networkUsers++;
		if (!this.remote) {
			this.remote = new BrowserSessionRemote(this.electronSession);
			this.remoteReady = this.remote.initialize(tunnels);
		}
		const lease = toDisposable(() => {
			if (--this.networkUsers === 0) { this.remote?.dispose(); this.remote = undefined; }
		});
		try { await raceCancellationError(this.remoteReady!, signal, 'BrowserCapabilityUnavailable'); return lease; }
		catch (error) { lease.dispose(); throw error; }
	}

	public static getOrCreate(id: string, scope: BrowserViewStorageScope, electronSession: Session): BrowserSession {
		const existing = this.sessions.get(electronSession);
		if (existing) {
			if (existing.id !== id || existing.storageScope !== scope) {
				throw new Error('BrowserSessionIdentityConflict');
			}
			return existing;
		}
		const browserSession = new BrowserSession(id, scope, electronSession);
		this.sessions.set(electronSession, browserSession);
		return browserSession;
	}
}

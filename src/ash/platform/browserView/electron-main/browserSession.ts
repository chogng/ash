import { raceCancellationError } from '../../../base/common/async.js';
import type { Session } from 'electron/main';
import { BrowserViewStorageScope } from '../common/browserView.js';
import { BrowserSessionPermissions } from './browserSessionPermissions.js';
import { BrowserSessionRemote } from './browserSessionRemote.js';
import type { SshPortForwardingService } from '../../remote/electron-main/sshPortForwardingService.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron/main';
import type { BrowserViewEvent, IBrowserViewOwner } from '../common/browserView.js';

/** Storage and permission policy have the Electron session's lifetime, independent of any page. */
export class BrowserSession {
	private static readonly sessions = new WeakMap<Session, BrowserSession>();
	public readonly permissions: BrowserSessionPermissions;
	private remote: BrowserSessionRemote | undefined;
	private remoteReady: Promise<void> | undefined;
	private networkUsers = 0;
	private readonly networkPages = new Map<number, { id: string; token: () => string | null; emit: (event: BrowserViewEvent) => void; }>();
	private readonly networkRequests = new Map<string, { contentsId: number; settle: (allowed: boolean) => void; }>();
	private hasNetworkFilter = false;
	private networkTurn: Promise<void> = Promise.resolve();

	private constructor(
		public readonly id: string,
		public readonly storageScope: BrowserViewStorageScope,
		public readonly electronSession: Session,
	) {
		this.permissions = new BrowserSessionPermissions(electronSession);
	}

	/** Requests are authorized by the backend; Chromium never receives its policy or credentials. */
	public attachNetwork(id: string, contents: WebContents, owner: IBrowserViewOwner, token: () => string | null, emit: (event: BrowserViewEvent) => void): IDisposable {
		if (owner.type !== 'agent') { return toDisposable(() => { }); }
		if (this.storageScope !== BrowserViewStorageScope.Agent) { throw new Error('BrowserNetworkIsolationRequired'); }
		this.networkPages.set(contents.id, { id, token, emit });
		if (!this.hasNetworkFilter) {
			this.electronSession.webRequest.onBeforeRequest((details, callback) => {
				const contentsId = details.webContentsId;
				const page = contentsId === undefined ? undefined : this.networkPages.get(contentsId);
				const networkToken = page?.token();
				if (details.url === 'about:blank' || details.url.startsWith('data:') || details.url.startsWith('blob:')) { callback({ cancel: false }); return; }
				// Chromium cannot revoke an established WebSocket with closeAllConnections.
				// Keep streaming sockets denied until the host has a revocable transport.
				if (details.url.startsWith('ws:') || details.url.startsWith('wss:')) { callback({ cancel: true }); return; }
				if (!page || contentsId === undefined || !networkToken || this.networkRequests.size >= 128) { callback({ cancel: true }); return; }
				const requestId = randomUUID();
				const timer = setTimeout(() => settle(false), 30_000);
				const settle = (allowed: boolean): void => {
					if (!this.networkRequests.delete(requestId)) { return; }
					clearTimeout(timer);
					callback({ cancel: !allowed || page.token() !== networkToken });
				};
				this.networkRequests.set(requestId, { contentsId, settle });
				try { page.emit({ type: 'networkRequested', targetId: page.id, requestId, networkToken, url: details.url, method: details.method }); }
				catch { settle(false); }
			});
			this.hasNetworkFilter = true;
		}
		return toDisposable(() => {
			this.cancelNetworkRequests(contents.id);
			this.networkPages.delete(contents.id);
		});
	}

	public respondToNetworkRequest(contentsId: number, requestId: string, allowed: boolean): void {
		const request = this.networkRequests.get(requestId);
		if (request?.contentsId === contentsId) { request.settle(allowed); }
	}

	public cancelNetworkRequests(contentsId: number): void {
		for (const request of this.networkRequests.values()) {
			if (request.contentsId === contentsId) { request.settle(false); }
		}
	}

	/** Connection retirement affects the whole partition, so its authorized operations cannot overlap. */
	public runNetworkOperation<T>(execute: () => Promise<T>): Promise<T> {
		const operation = this.networkTurn.then(execute);
		this.networkTurn = operation.then(() => { }, () => { });
		return operation;
	}

	public async acquireRemote(tunnels: SshPortForwardingService, signal: AbortSignal): Promise<IDisposable> {
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

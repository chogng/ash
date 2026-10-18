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
import type { ISerializedBrowserHistoryEntriesSnapshot, ISerializedBrowserFaviconsSnapshot } from '../common/browserHistory.js';
import type { BrowserSessionHistory } from './browserSessionHistory.js';
import { getMediaOrTextMime } from '../../../base/common/mime.js';

/** Storage and permission policy have the Electron session's lifetime, independent of any page. */
export class BrowserSession {
	private readonly authenticationOwners = new Set<() => void>();

	/** Clearing a partition also cancels authentication in other windows sharing that partition. */
	public attachAuthentication(cancel: () => void): IDisposable {
		this.authenticationOwners.add(cancel);
		return toDisposable(() => this.authenticationOwners.delete(cancel));
	}

	public cancelAuthentication(): void {
		for (const cancel of this.authenticationOwners) { cancel(); }
	}

	private readonly fileReaders = new Map<string, (url: string) => Promise<Uint8Array>>();
	/** File bytes come from the renderer File Service, which retains Rust directory authorization. */
	public attachFileReader(id: string, read: (url: string) => Promise<Uint8Array>): IDisposable {
		if (this.storageScope === BrowserViewStorageScope.Agent) { throw new Error('BrowserLocalFileAccessDenied'); }
		if (this.fileReaders.size === 0) {
			this.electronSession.protocol.handle('file', async request => {
				// Remote websites cannot probe local files through this protocol handler.
				const initiator: unknown = Reflect.get(request, 'initiatorOrigin');
				if ((initiator !== undefined && initiator !== 'file://') || !['GET', 'HEAD'].includes(request.method) || request.url.length > 8192) { return new Response(null, { status: 403 }); }
				const url = new URL(request.url);
				const reader = this.fileReaders.values().next().value;
				if (!reader || url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) { return new Response(null, { status: 403 }); }
				try {
					const bytes = await reader(url.href);
					return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': getMediaOrTextMime(url.pathname) ?? 'application/octet-stream', 'Cache-Control': 'no-store' } });
				} catch { return new Response(null, { status: 403 }); }
			});
		}
		this.fileReaders.set(id, read);
		return toDisposable(() => {
			this.fileReaders.delete(id);
			if (this.fileReaders.size === 0) { this.electronSession.protocol.unhandle('file'); }
		});
	}
	private static readonly sessions = new WeakMap<Session, BrowserSession>();
	public readonly permissions: BrowserSessionPermissions;
	private remote: BrowserSessionRemote | undefined;
	private remoteReady: Promise<void> | undefined;
	private networkUsers = 0;
	private readonly networkPages = new Map<number, { id: string; token: () => string | null; emit: (event: BrowserViewEvent) => void; }>();
	private readonly networkRequests = new Map<string, { contentsId: number; settle: (allowed: boolean) => void; }>();
	private hasNetworkFilter = false;
	private networkTurn: Promise<void> = Promise.resolve();
	private history: BrowserSessionHistory | undefined;
	private historyReady: Promise<void> | undefined;
	private historyLoaded = false;
	private historySnapshot: { entries: ISerializedBrowserHistoryEntriesSnapshot; favicons: ISerializedBrowserFaviconsSnapshot; } | undefined;
	private historyUsers = 0;

	private constructor(
		public readonly id: string,
		public readonly storageScope: BrowserViewStorageScope,
		public readonly electronSession: Session,
	) {
		this.permissions = new BrowserSessionPermissions(electronSession);
	}

	/** Windows share one session store. A retired store leaves only its immutable data behind. */
	public async acquireHistory(createHistory: () => BrowserSessionHistory): Promise<IDisposable & { readonly history: BrowserSessionHistory; }> {
		if (!this.history) {
			const history = this.history = createHistory();
			this.historyReady = history.initialize().then(() => {
				if (this.historySnapshot) {
					history.favicons.hydrate(this.historySnapshot.favicons);
					history.entries.hydrate(this.historySnapshot.entries);
					this.historySnapshot = undefined;
				}
				this.historyLoaded = true;
			});
		}
		this.historyUsers++;
		const history = this.history;
		const lease = Object.assign(toDisposable(() => {
			if (--this.historyUsers === 0) {
				if (this.historyLoaded) { this.historySnapshot = { entries: history.entries.serialize(), favicons: history.favicons.serialize() }; }
				history.dispose();
				this.history = undefined;
				this.historyReady = undefined;
				this.historyLoaded = false;
			}
		}), { history });
		try { await this.historyReady; return lease; }
		catch (error) { lease.dispose(); throw error; }
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

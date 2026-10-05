import type { Session, WebContents, DownloadItem } from 'electron/main';
import { randomUUID } from 'node:crypto';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { BrowserViewEvent } from '../common/browserView.js';

interface Page {
	readonly id: string;
	readonly contents: WebContents;
	readonly emit: (event: BrowserViewEvent) => void;
}

/** Chromium asks the owning page's user; grants are scoped to this storage session and both origins. */
export class BrowserSessionPermissions {
	private readonly pages = new Map<WebContents, Page>();
	private readonly grants = new Map<string, boolean>();
	private readonly pending = new Map<string, { page: Page; settle: (value: boolean | undefined) => void }>();
	private readonly downloads = new Map<string, { page: Page; item: DownloadItem; cleanup: () => void }>();

	constructor(session: Session) {
		session.setPermissionCheckHandler((contents, permission, origin, details) => {
			if (!contents || !this.pages.has(contents)) { return false; }
			const embeddingOrigin = details.embeddingOrigin ?? new URL(contents.getURL()).origin;
			// Opaque documents have no website identity to which a reusable grant can belong.
			if (!URL.canParse(origin) || !URL.canParse(embeddingOrigin)) return false;
			const requestingOrigin = new URL(origin).origin;
			const embeddedOrigin = new URL(embeddingOrigin).origin;
			if (requestingOrigin === 'null' || embeddedOrigin === 'null') return false;
			const category = permission === 'media' ? `media:${details.mediaType}` : permission;
			return this.grants.get(this.key(requestingOrigin, embeddedOrigin, category)) === true;
		});
		session.setPermissionRequestHandler((contents, permission, callback, details) => {
			const page = this.pages.get(contents);
			if (!page) { callback(false); return; }
			const origin = details.requestingUrl ? new URL(details.requestingUrl).origin : new URL(contents.getURL()).origin;
			const embeddingOrigin = new URL(contents.getURL()).origin;
			if (origin === 'null' || embeddingOrigin === 'null') { callback(false); return; }
			const categories = permission === 'media' && 'mediaTypes' in details && details.mediaTypes ? details.mediaTypes.map(type => `media:${type}`) : [permission];
			const keys = categories.map(category => this.key(origin, embeddingOrigin, category));
			if (!keys.length || this.pending.size >= 16 || !['geolocation', 'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)) { callback(false); return; }
			if (keys.every(key => this.grants.has(key))) { callback(keys.every(key => this.grants.get(key) === true)); return; }
			const requestId = randomUUID();
			const settle = (allowed: boolean | undefined): void => {
				if (!this.pending.delete(requestId)) { return; }
				clearTimeout(timer);
				contents.removeListener('did-start-navigation', revoke);
				// Closing or navigating a page cancels a request without recording a user's decision.
				if (allowed !== undefined) for (const key of keys) { this.grants.set(key, allowed); }
				callback(allowed === true);
				page.emit({ type: 'permissionRequestClosed', targetId: page.id, requestId });
			};
			const revoke = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => { if (mainFrame && !inPlace) settle(undefined); };
			const timer = setTimeout(() => settle(undefined), 30_000);
			contents.on('did-start-navigation', revoke);
			this.pending.set(requestId, { page, settle });
			page.emit({ type: 'permissionRequested', targetId: page.id, requestId, origin, permission: categories.join(',') });
		});
		session.setDevicePermissionHandler(() => false);
		session.on('will-download', (_event, item, contents) => {
			const page = this.pages.get(contents);
			if (!page) { item.cancel(); return; }
			const requestId = randomUUID();
			// Electron owns the save-location dialog; this host never selects a destination for the user.
			const updated = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void => this.progress(page, item, state);
			const done = (_event: Electron.Event, state: 'completed' | 'cancelled' | 'interrupted'): void => { this.downloads.delete(requestId); cleanup(); this.progress(page, item, state); };
			const cleanup = (): void => { item.removeListener('updated', updated); item.removeListener('done', done); };
			this.downloads.set(requestId, { page, item, cleanup });
			item.on('updated', updated);
			item.once('done', done);
			this.progress(page, item, 'progressing');
		});
	}

	public attach(id: string, contents: WebContents, emit: Page['emit']): IDisposable {
		const page = { id, contents, emit };
		this.pages.set(contents, page);
		return toDisposable(() => {
			this.pages.delete(contents);
			for (const request of [...this.pending.values()]) { if (request.page === page) { request.settle(undefined); } }
			this.cancelDownloads(id);
		});
	}
	public respond(id: string, requestId: string, allowed: boolean): void {
		const request = this.pending.get(requestId);
		if (!request || request.page.id !== id) { throw new Error('BrowserPermissionRequestUnavailable'); }
		request.settle(allowed);
	}
	public clear(): void {
		for (const request of [...this.pending.values()]) { request.settle(undefined); }
		this.grants.clear();
	}
	public cancelRequests(id: string): void {
		for (const request of [...this.pending.values()]) { if (request.page.id === id) request.settle(undefined); }
	}
	public cancelDownloads(id: string): void {
		for (const [requestId, request] of this.downloads) {
			if (request.page.id === id) { this.downloads.delete(requestId); request.cleanup(); request.item.cancel(); this.progress(request.page, request.item, 'cancelled'); }
		}
	}
	private key(origin: string, embeddingOrigin: string, permission: string): string {
		return JSON.stringify([origin, embeddingOrigin, permission]);
	}
	private progress(page: Page, item: DownloadItem, state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'): void {
		page.emit({ type: 'downloadProgress', targetId: page.id, filename: item.getFilename(), receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state });
	}
}

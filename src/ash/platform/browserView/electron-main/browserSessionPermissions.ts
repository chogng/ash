import type { Session, WebContents, DownloadItem } from 'electron/main';
import { randomUUID } from 'node:crypto';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { BrowserViewEvent } from '../common/browserView.js';
import {
	BrowserPermissionStore,
	electronPermissionToCategories,
	toOriginKey,
	type IPermissionCategoryState,
	type ISerializedBrowserPermissionsSnapshot,
} from '../common/browserPermissions.js';

interface Page {
	readonly id: string;
	readonly contents: WebContents;
	readonly changed?: () => void;
	readonly emit: (event: BrowserViewEvent) => void;
}

/** Chromium asks the owning page's user; grants are scoped to this storage session and both origins. */
export class BrowserSessionPermissions {
	private readonly pages = new Map<WebContents, Page>();
	private readonly grants = new Map<string, boolean>();
	private readonly siteGrants = new Map<string, BrowserPermissionStore>();
	private readonly pending = new Map<
		string,
		{
			page: Page;
			origin: string;
			embeddingOrigin: string;
			categories: readonly import('../common/browserPermissions.js').PermissionCategory[];
			settle: (value: boolean | undefined) => void;
		}
	>();
	private readonly downloads = new Map<string, { page: Page; item: DownloadItem; cleanup: () => void }>();

	constructor(session: Session) {
		session.setPermissionCheckHandler((contents, permission, origin, details) => {
			if (!contents || !this.pages.has(contents)) {
				return false;
			}
			const embeddingOrigin = details.embeddingOrigin ?? contents.getURL();
			// Opaque documents have no website identity to which a reusable grant can belong.
			const requestingOrigin = toOriginKey(origin);
			const embeddedOrigin = toOriginKey(embeddingOrigin);
			if (!requestingOrigin || !embeddedOrigin) return false;
			const media =
				details.mediaType === 'video' || details.mediaType === 'audio' ? [details.mediaType] : undefined;
			const categories = electronPermissionToCategories(permission, media);
			return categories.length > 0
				? categories.every(
						category =>
							this.siteGrants.get(embeddedOrigin)?.getDecision(requestingOrigin, category) === 'allow',
					)
				: this.grants.get(this.key(requestingOrigin, embeddedOrigin, permission)) === true;
		});
		session.setPermissionRequestHandler((contents, permission, callback, details) => {
			const page = this.pages.get(contents);
			if (!page) {
				callback(false);
				return;
			}
			const origin = toOriginKey(details.requestingUrl || contents.getURL());
			const embeddingOrigin = toOriginKey(contents.getURL());
			if (!origin || !embeddingOrigin) {
				callback(false);
				return;
			}
			const categories =
				permission === 'media' && 'mediaTypes' in details && details.mediaTypes
					? details.mediaTypes.map(type => `media:${type}`)
					: [permission];
			const keys = categories.map(category => this.key(origin, embeddingOrigin, category));
			if (
				!keys.length ||
				this.pending.size >= 16 ||
				![
					'geolocation',
					'notifications',
					'media',
					'clipboard-read',
					'clipboard-sanitized-write',
					'fullscreen',
				].includes(permission)
			) {
				callback(false);
				return;
			}
			const media = permission === 'media' && 'mediaTypes' in details ? details.mediaTypes : undefined;
			const siteCategories = electronPermissionToCategories(permission, media);
			const decisions = siteCategories.map(category =>
				this.siteGrants.get(embeddingOrigin)?.getDecision(origin, category),
			);
			if (decisions.some(decision => decision === 'deny')) {
				callback(false);
				return;
			}
			if (
				siteCategories.length
					? decisions.every(decision => decision === 'allow')
					: keys.every(key => this.grants.has(key))
			) {
				callback(siteCategories.length > 0 || keys.every(key => this.grants.get(key) === true));
				return;
			}
			const requestId = randomUUID();
			const settle = (allowed: boolean | undefined): void => {
				if (!this.pending.delete(requestId)) {
					return;
				}
				clearTimeout(timer);
				contents.removeListener('did-start-navigation', revoke);
				// Closing or navigating a page cancels a request without recording a user's decision.
				if (allowed !== undefined) {
					if (siteCategories.length) {
						let store = this.siteGrants.get(embeddingOrigin);
						if (!store) {
							store = new BrowserPermissionStore();
							this.siteGrants.set(embeddingOrigin, store);
						}
						for (const category of siteCategories) {
							store.set(origin, category, allowed ? 'allow' : 'deny');
						}
					} else {
						for (const key of keys) {
							this.grants.set(key, allowed);
						}
					}
				}
				for (const attached of this.pages.values()) {
					attached.changed?.();
				}
				callback(allowed === true);
				page.emit({ type: 'permissionRequestClosed', targetId: page.id, requestId });
			};
			const revoke = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
				if (mainFrame && !inPlace) settle(undefined);
			};
			const timer = setTimeout(() => settle(undefined), 30_000);
			contents.on('did-start-navigation', revoke);
			this.pending.set(requestId, { page, origin, embeddingOrigin, categories: siteCategories, settle });
			page.emit({
				type: 'permissionRequested',
				targetId: page.id,
				requestId,
				origin,
				permission: categories.join(','),
			});
		});
		session.setDevicePermissionHandler(() => false);
		session.on('will-download', (_event, item, contents) => {
			const page = this.pages.get(contents);
			if (!page) {
				item.cancel();
				return;
			}
			const requestId = randomUUID();
			// Electron owns the save-location dialog; this host never selects a destination for the user.
			const updated = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void =>
				this.progress(page, item, state);
			const done = (_event: Electron.Event, state: 'completed' | 'cancelled' | 'interrupted'): void => {
				this.downloads.delete(requestId);
				cleanup();
				this.progress(page, item, state);
			};
			const cleanup = (): void => {
				item.removeListener('updated', updated);
				item.removeListener('done', done);
			};
			this.downloads.set(requestId, { page, item, cleanup });
			item.on('updated', updated);
			item.once('done', done);
			this.progress(page, item, 'progressing');
		});
	}

	public attach(id: string, contents: WebContents, emit: Page['emit'], changed?: () => void): IDisposable {
		const page = { id, contents, emit, changed };
		this.pages.set(contents, page);
		return toDisposable(() => {
			this.pages.delete(contents);
			for (const request of [...this.pending.values()]) {
				if (request.page === page) {
					request.settle(undefined);
				}
			}
			this.cancelDownloads(id);
		});
	}
	public snapshot(contents: WebContents): ISerializedBrowserPermissionsSnapshot {
		return this.siteGrants.get(toOriginKey(contents.getURL()))?.serialize() ?? { origins: {} };
	}
	public setPermissions(id: string, origin: string, grants: readonly IPermissionCategoryState[]): void {
		const page = [...this.pages.values()].find(page => page.id === id);
		if (!page) {
			throw new Error('BrowserTargetUnavailable');
		}
		if (grants.length === 0) {
			return;
		}
		const embeddingOrigin = toOriginKey(page.contents.getURL());
		if (!embeddingOrigin) {
			throw new Error('BrowserPermissionOriginUnavailable');
		}
		let store = this.siteGrants.get(embeddingOrigin);
		if (!store && grants.every(grant => grant.state === null)) {
			return;
		}
		if (!store) {
			store = new BrowserPermissionStore();
			this.siteGrants.set(embeddingOrigin, store);
		}
		for (const grant of grants) {
			store.set(origin, grant.category, grant.state);
		}
		for (const pending of [...this.pending.values()]) {
			if (
				pending.embeddingOrigin !== embeddingOrigin ||
				pending.origin !== origin ||
				pending.categories.length === 0
			) {
				continue;
			}
			const decisions = pending.categories.map(category => store.getDecision(origin, category));
			if (decisions.some(value => value === 'deny')) {
				pending.settle(false);
			} else if (decisions.every(value => value === 'allow')) {
				pending.settle(true);
			}
		}
		for (const attached of this.pages.values()) {
			attached.changed?.();
		}
	}
	public respond(id: string, requestId: string, allowed: boolean): void {
		const request = this.pending.get(requestId);
		if (!request || request.page.id !== id) {
			throw new Error('BrowserPermissionRequestUnavailable');
		}
		request.settle(allowed);
	}
	public clear(): void {
		for (const request of [...this.pending.values()]) {
			request.settle(undefined);
		}
		this.grants.clear();
		for (const store of this.siteGrants.values()) {
			store.dispose();
		}
		this.siteGrants.clear();
		for (const page of this.pages.values()) {
			page.changed?.();
		}
	}
	public cancelRequests(id: string): void {
		for (const request of [...this.pending.values()]) {
			if (request.page.id === id) request.settle(undefined);
		}
	}
	public cancelDownloads(id: string): void {
		for (const [requestId, request] of this.downloads) {
			if (request.page.id === id) {
				this.downloads.delete(requestId);
				request.cleanup();
				request.item.cancel();
				this.progress(request.page, request.item, 'cancelled');
			}
		}
	}
	private key(origin: string, embeddingOrigin: string, permission: string): string {
		return JSON.stringify([origin, embeddingOrigin, permission]);
	}
	private progress(
		page: Page,
		item: DownloadItem,
		state: 'progressing' | 'completed' | 'cancelled' | 'interrupted',
	): void {
		page.emit({
			type: 'downloadProgress',
			targetId: page.id,
			filename: item.getFilename(),
			receivedBytes: item.getReceivedBytes(),
			totalBytes: item.getTotalBytes(),
			state,
		});
	}
}

import { RunOnceScheduler } from '../../../base/common/async.js';
import { isRecord } from '../../../base/common/types.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { ILogService } from '../../log/common/log.js';
import { BrowserHistoryStore, type IBrowserHistoryItemHandle, type ISerializedBrowserHistoryEntriesSnapshot, type ISerializedBrowserFaviconsSnapshot } from '../common/browserHistory.js';
import { BrowserViewStorageScope, normalizeBrowserViewUrl, type IBrowserViewStorageKeys } from '../common/browserView.js';
import type { BrowserSession } from './browserSession.js';

export interface IBrowserSessionHistory {
	readonly storageKeys: IBrowserViewStorageKeys;
	add(url: string, title: string, favicon?: string, userInitiated?: boolean): IBrowserHistoryItemHandle;
	delete(entryIds?: readonly number[]): Promise<void>;
	setMaxEntries(max: number): void;
}

const applicationStorage = { scope: StorageScope.APPLICATION, id: 'application' };
type HistoryPart = 'history' | 'favicons';

/** A session's existing history model also owns its persistence; the application storage owns disk IO. */
export class BrowserSessionHistory extends BrowserHistoryStore implements IBrowserSessionHistory {
	readonly storageKeys: IBrowserViewStorageKeys;
	private readonly dirty = new Set<HistoryPart>();
	private initialization: Promise<void> | undefined;
	private loaded = false;
	private writing: Promise<void> = Promise.resolve();
	private readonly scheduledSave = this._register(new RunOnceScheduler(() => this.saveInBackground(), 2000));

	constructor(
		session: BrowserSession,
		@IApplicationStorageMainService private readonly storage: IApplicationStorageMainService,
		@ILogService private readonly logService: ILogService,
	) {
		const persistent = session.storageScope === BrowserViewStorageScope.Global || session.storageScope === BrowserViewStorageScope.Workspace;
		super(persistent ? 200 : 0);
		this.storageKeys = persistent ? { history: `browser.history.entries.${session.id}`, favicons: `browser.history.favicons.${session.id}` } : {};
		this._register(this.entries.onDidChange(() => this.changed('history')));
		this._register(this.favicons.onDidChange(() => this.changed('favicons')));
		this._register(storage.onWillSaveState(() => this.saveInBackground()));
	}

	/** Ash's storage reads are asynchronous. The page manager waits here before navigation can record a visit. */
	initialize(): Promise<void> {
		return this.initialization ??= this.restore();
	}

	private async restore(): Promise<void> {
		if (this.storageKeys.history) {
			const snapshot = await this.storage.getItems(applicationStorage);
			const favicons = decodeFavicons(snapshot.entries[this.storageKeys.favicons!]?.value);
			this.favicons.hydrate(favicons);
			this.entries.hydrate(decodeEntries(snapshot.entries[this.storageKeys.history]?.value, favicons, this.entries.maxEntries));
		}
		this.loaded = true;
	}

	private changed(part: HistoryPart): void {
		if (!this.loaded || !this.storageKeys[part]) { return; }
		this.dirty.add(part);
		// Additional visits share the first pending deadline instead of postponing persistence indefinitely.
		if (!this.scheduledSave.isScheduled()) { this.scheduledSave.schedule(); }
	}

	async delete(entryIds?: readonly number[]): Promise<void> {
		if (entryIds === undefined) {
			this.clear();
			this.favicons.clear();
			if (this.storageKeys.history) { this.dirty.add('history'); this.dirty.add('favicons'); }
		} else { for (const id of entryIds) { this.entries.delete(id); } }
		await this.flushNow();
	}

	/** Enqueue current snapshots synchronously so the application's close barrier can include them. */
	flushNow(): Promise<void> {
		this.scheduledSave.cancel();
		const writes: Promise<unknown>[] = [];
		for (const part of this.dirty) {
			const key = this.storageKeys[part]!;
			const snapshot = part === 'history' ? this.entries.serialize() : this.favicons.serialize();
			const empty = part === 'history' ? this.entries.items.length === 0 : Object.keys(this.favicons.serialize().map).length === 0;
			try {
				writes.push(this.storage.updateItems(applicationStorage, key, empty ? null : { value: JSON.stringify(snapshot), target: StorageTarget.MACHINE }).catch(error => {
					this.dirty.add(part);
					throw error;
				}));
				this.dirty.delete(part);
			} catch (error) { writes.push(Promise.reject(error)); }
		}
		const writing = Promise.all([this.writing, ...writes]).then(() => undefined);
		this.writing = writing.catch(() => { });
		return writing;
	}

	private saveInBackground(): void {
		void this.flushNow().catch(error => this.logService.error('browserHistory', 'Failed to save browser history', error));
	}

	protected override disposeCore(): void {
		this.saveInBackground();
		super.disposeCore();
	}
}

function parse(raw: string | undefined): Record<string, unknown> | undefined {
	if (!raw || raw.length > 16 * 1024 * 1024) { return undefined; }
	try { const value: unknown = JSON.parse(raw); return isRecord(value) ? value : undefined; }
	catch { return undefined; }
}

function decodeFavicons(raw: string | undefined): ISerializedBrowserFaviconsSnapshot {
	const value = parse(raw)?.map;
	const map: Record<string, string> = Object.create(null);
	if (isRecord(value)) {
		for (const [hash, image] of Object.entries(value)) {
			if (/^[0-9a-f]{40}$/.test(hash) && typeof image === 'string' && image.startsWith('data:image/') && image.length <= 64 * 1024) { map[hash] = image; }
		}
	}
	return { map };
}

function decodeEntries(raw: string | undefined, favicons: ISerializedBrowserFaviconsSnapshot, maxEntries: number): ISerializedBrowserHistoryEntriesSnapshot {
	const value = parse(raw)?.items;
	const items: ISerializedBrowserHistoryEntriesSnapshot['items'][number][] = [];
	const ids = new Set<number>();
	if (!Array.isArray(value)) { return { items }; }
	for (const entry of value.slice(-maxEntries)) {
		if (!isRecord(entry) || !Number.isSafeInteger(entry.id) || (entry.id as number) < 1 || (entry.id as number) >= Number.MAX_SAFE_INTEGER || ids.has(entry.id as number)
			|| typeof entry.time !== 'number' || !Number.isFinite(entry.time) || entry.time < 0 || typeof entry.title !== 'string') { continue; }
		try {
			const url = normalizeBrowserViewUrl(entry.url);
			if (url === 'about:blank') { continue; }
			ids.add(entry.id as number);
			items.push({
				id: entry.id as number, url, time: entry.time, title: entry.title,
				...(entry.explicit === true ? { explicit: true } : {}),
				...(typeof entry.icon === 'string' && Object.hasOwn(favicons.map, entry.icon) ? { icon: entry.icon } : {}),
			});
		} catch { /* Invalid persisted URLs cannot become navigation suggestions. */ }
	}
	return { items };
}

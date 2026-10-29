import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { StringSHA1 } from '../../../base/common/hash.js';

export interface ISerializedBrowserHistoryEntry {
	readonly id: number;
	readonly url: string;
	readonly time: number;
	readonly title: string;
	readonly icon?: string;
	readonly explicit?: true;
}

export interface IBrowserHistoryEntry extends ISerializedBrowserHistoryEntry {}

export interface IBrowserHistoryUpdate {
	readonly url?: string;
	readonly title?: string;
	readonly favicon?: string | null;
}

export interface IBrowserHistoryItemHandle {
	readonly id: number;
	update(patch: IBrowserHistoryUpdate): void;
	delete(): void;
}

export interface ISerializedBrowserHistoryEntriesSnapshot {
	readonly items: readonly ISerializedBrowserHistoryEntry[];
}

export interface ISerializedBrowserFaviconsSnapshot {
	readonly map: Readonly<Record<string, string>>;
}

/** Bounded visit history; Chromium remains the owner of Back/Forward navigation. */
export class BrowserHistoryEntriesStore extends Disposable {
	private visits: IBrowserHistoryEntry[] = [];
	private nextId = 1;
	private limit: number;
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;

	constructor(maxEntries = 200) {
		super();
		this.limit = maxEntries;
	}

	get items(): readonly IBrowserHistoryEntry[] {
		return this.visits.slice();
	}
	get maxEntries(): number {
		return this.limit;
	}

	add(url: string, title: string, faviconHash: string | undefined, userInitiated: boolean): IBrowserHistoryEntry {
		const entry: IBrowserHistoryEntry = Object.freeze({
			id: this.nextId++,
			url,
			title,
			time: Date.now(),
			...(faviconHash ? { icon: faviconHash } : {}),
			...(userInitiated ? { explicit: true as const } : {}),
		});
		if (this.limit > 0) {
			this.visits.push(entry);
			this.visits = this.visits.slice(-this.limit);
			this.changes.fire();
		}
		return entry;
	}

	update(id: number, patch: { url?: string; title?: string; faviconHash?: string | null }): boolean {
		const index = this.visits.findIndex(entry => entry.id === id);
		const entry = this.visits[index];
		const icon = patch.faviconHash === null ? undefined : (patch.faviconHash ?? entry?.icon);
		if (!entry || ((patch.url ?? entry.url) === entry.url && (patch.title ?? entry.title) === entry.title && icon === entry.icon)) {
			return false;
		}
		const { icon: previousIcon, ...rest } = entry;
		this.visits[index] = Object.freeze({
			...rest,
			url: patch.url ?? entry.url,
			title: patch.title ?? entry.title,
			...(icon ? { icon } : {}),
		});
		this.changes.fire();
		return true;
	}

	delete(id: number): boolean {
		const remaining = this.visits.filter(entry => entry.id !== id);
		if (remaining.length === this.visits.length) {
			return false;
		}
		this.visits = remaining;
		this.changes.fire();
		return true;
	}

	clear(): void {
		if (!this.visits.length) {
			return;
		}
		this.visits = [];
		this.changes.fire();
	}

	setMaxEntries(max: number): void {
		this.limit = Math.max(0, Math.floor(max));
		if (this.visits.length > this.limit) {
			this.visits = this.limit ? this.visits.slice(-this.limit) : [];
			this.changes.fire();
		}
	}

	serialize(): ISerializedBrowserHistoryEntriesSnapshot {
		return { items: this.items };
	}

	hydrate(snapshot: ISerializedBrowserHistoryEntriesSnapshot | undefined): void {
		// The session owner transfers this typed snapshot when its last UI lease retires.
		this.visits = this.limit > 0 ? (snapshot?.items ?? []).slice(-this.limit).map(entry => Object.freeze({ ...entry })) : [];
		this.nextId = Math.max(this.nextId, ...this.visits.map(entry => entry.id + 1));
		this.changes.fire();
	}
}

/** Content addressing deduplicates inline favicons without retaining discarded visits. */
export class BrowserFaviconsStore extends Disposable {
	private readonly images = new Map<string, string>();
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;

	get(hash: string): string | undefined {
		return this.images.get(hash);
	}

	register(dataUri: string): string {
		const digest = new StringSHA1();
		digest.update(dataUri);
		const hash = digest.digest();
		if (!this.images.has(hash)) {
			this.images.set(hash, dataUri);
			this.changes.fire();
		}
		return hash;
	}

	gc(referenced: ReadonlySet<string>): void {
		let changed = false;
		for (const key of this.images.keys()) {
			if (!referenced.has(key)) {
				this.images.delete(key);
				changed = true;
			}
		}
		if (changed) {
			this.changes.fire();
		}
	}

	clear(): void {
		if (!this.images.size) {
			return;
		}
		this.images.clear();
		this.changes.fire();
	}

	serialize(): ISerializedBrowserFaviconsSnapshot {
		return { map: Object.fromEntries(this.images) };
	}

	hydrate(snapshot: ISerializedBrowserFaviconsSnapshot | undefined): void {
		this.images.clear();
		for (const [hash, image] of Object.entries(snapshot?.map ?? {})) {
			this.images.set(hash, image);
		}
		this.changes.fire();
	}
}

export class BrowserHistoryStore extends Disposable {
	readonly entries: BrowserHistoryEntriesStore;
	readonly favicons = this._register(new BrowserFaviconsStore());
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;

	constructor(maxEntries?: number) {
		super();
		this.entries = this._register(new BrowserHistoryEntriesStore(maxEntries));
		this._register(
			this.entries.onDidChange(() => {
				this.favicons.gc(new Set(this.entries.items.flatMap(entry => (entry.icon ? [entry.icon] : []))));
				this.changes.fire();
			}),
		);
	}

	add(url: string, title: string, favicon?: string, userInitiated = false): IBrowserHistoryItemHandle {
		if (this.entries.maxEntries === 0) {
			return { id: -1, update: () => {}, delete: () => {} };
		}
		const icon = favicon && this.entries.maxEntries > 0 ? this.favicons.register(favicon) : undefined;
		const { id } = this.entries.add(url, title, icon, userInitiated);
		return {
			id,
			update: patch => {
				if (!this.entries.items.some(entry => entry.id === id)) {
					return;
				}
				const faviconHash = patch.favicon === null ? null : patch.favicon === undefined ? undefined : this.favicons.register(patch.favicon);
				this.entries.update(id, { url: patch.url, title: patch.title, faviconHash });
			},
			delete: () => {
				this.entries.delete(id);
			},
		};
	}

	clear(): void {
		this.entries.clear();
	}
	setMaxEntries(max: number): void {
		this.entries.setMaxEntries(max);
	}
}

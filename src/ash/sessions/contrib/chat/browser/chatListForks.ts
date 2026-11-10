import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';
import type { ChatListEntry, ChatListForkEvidence, ChatListForkReference, ChatListSource } from './chatListModel.js';

const storagePrefix = 'sessions.chat.forkSource:';

/** Owns Ash's local lineage for sources that don't expose it in their catalog. */
export class ChatListForks extends Disposable {
	private readonly lifetime = new AbortController();
	private readonly changed;

	constructor(sources: readonly ChatListSource[], private readonly storage: IStorageService) {
		super();
		this._register(toDisposable(() => this.lifetime.abort()));
		this.changed = observableSignalFromEvent(this, listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(storagePrefix)) listener(event);
		}));
		for (const source of sources) {
			if (source.onDidCreateFork) this._register(source.onDidCreateFork(({ key, parent }) => this.save(key, parent)));
			if (source.onDidRetirePreferenceIdentity) {
				this._register(source.onDidRetirePreferenceIdentity(({ key, replacementKey }) => {
					if (key === replacementKey) return;
					const parent = this.read(key);
					if (parent && replacementKey) this.save(replacementKey, parent);
					if (parent) this.storage.remove(storagePrefix + key, StorageScope.PROFILE);
				}));
			}
			const checked = new Map<string, number>();
			let running = false;
			this._register(autorun(reader => {
				const entries = source.snapshot.read(reader).entries;
				if (running || !entries.some(entry => entry.loadForkEvidence)) return;
				running = true;
				void this.recover(source, entries, checked).finally(() => { running = false; });
			}));
		}
	}

	project(entries: readonly ChatListEntry[], reader: IReader): readonly ChatListEntry[] {
		this.changed.read(reader);
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		const byKey = new Map(entries.map(entry => [entry.preferenceKey, entry]));
		return entries.map(entry => {
			const source = !entry.forkSource && entry.preferenceKey ? this.read(entry.preferenceKey) : undefined;
			if (!source) return entry;
			const parent = source.preferenceKey ? byKey.get(source.preferenceKey) : byId.get(source.id);
			const open = entry.openForkSource;
			return {
				...entry,
				forkSource: {
					id: parent?.id ?? source.id,
					title: parent?.title || source.title || localize('sessions.list.forkSourceUnavailable', 'Source conversation unavailable'),
					open: parent?.open ?? (open && (signal => open(source, signal))),
				},
			};
		});
	}

	private async recover(catalog: ChatListSource, entries: readonly ChatListEntry[], checked: Map<string, number>): Promise<void> {
		const byTitle = new Map<string, ChatListEntry | undefined>();
		for (const entry of entries) byTitle.set(entry.title, byTitle.has(entry.title) ? undefined : entry);
		const reads = new Map<string, Promise<ChatListForkEvidence>>();
		const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]);
		const evidence = (entry: ChatListEntry) => {
			let read = reads.get(entry.id);
			if (!read) {
				read = entry.loadForkEvidence!(signal);
				reads.set(entry.id, read);
			}
			return read;
		};
		let count = 0;
		for (const entry of entries) {
			if (signal.aborted || count === 4) break;
			const key = entry.preferenceKey;
			const separator = entry.title.indexOf(' · ');
			const parent = separator > 0 ? byTitle.get(entry.title.slice(separator + 3)) : undefined;
			if (!key || !entry.loadForkEvidence || !parent?.loadForkEvidence || !parent.preferenceKey
				|| entry.forkSource || this.read(key)) continue;
			// Titles narrow the lookup. A provider marker and shared history establish the relationship.
			const pair = JSON.stringify([key, parent.preferenceKey]);
			if ((checked.get(pair) ?? 0) > Date.now()) continue;
			count++;
			try {
				const child = await evidence(entry);
				let source = child.source;
				if (!source && child.hasMarker && child.createdAt !== undefined) {
					const candidate = await evidence(parent);
					const createdAt = candidate.createdAt;
					const forkedAt = child.createdAt;
					// A copied message authored after the candidate's creation distinguishes it from an older ancestor.
					if (createdAt !== undefined && [...child.messages].some(([id, time]) =>
						time >= createdAt && time < forkedAt && candidate.messages.get(id) === time)) {
						source = { id: parent.id, title: parent.title, preferenceKey: parent.preferenceKey };
					}
				}
				if (signal.aborted) break;
				checked.set(pair, Infinity);
				const current = catalog.snapshot.get().entries;
				if (source && source.id !== entry.id && !this.read(key)
					&& current.some(row => row.preferenceKey === key && (child.source || row.title === entry.title))
					&& (child.source || current.some(row => row.preferenceKey === parent.preferenceKey && row.title === parent.title))) {
					this.save(key, source);
				}
			} catch {
				// A background lookup cannot make an otherwise usable catalog fail.
				if (!signal.aborted) checked.set(pair, Date.now() + 60_000);
				break;
			}
		}
	}

	private read(key: string): ChatListForkReference | undefined {
		const raw = this.storage.get(storagePrefix + key, StorageScope.PROFILE);
		if (!raw) return undefined;
		let value: unknown;
		try { value = JSON.parse(raw); } catch { return undefined; }
		if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return undefined;
		return {
			id: value.id,
			title: typeof value.title === 'string' ? value.title : undefined,
			preferenceKey: typeof value.preferenceKey === 'string' ? value.preferenceKey : undefined,
		};
	}

	private save(key: string, source: ChatListForkReference): void {
		this.storage.store(storagePrefix + key, JSON.stringify(source), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

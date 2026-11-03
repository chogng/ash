import { isRecord } from '../../../../base/common/types.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';
import type { SessionId, ThreadId } from '../common/session.js';

export interface SessionRecencyEntry {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
}

export function getRecencyEntryKey(entry: SessionRecencyEntry): string {
	return JSON.stringify([entry.sessionId, entry.threadId]);
}

type CustomViewVisit = { readonly kind: 'customView'; readonly id: string; readonly state?: string; };
type RecentVisit = SessionRecencyEntry | CustomViewVisit;

function visitKey(visit: RecentVisit): string {
	return 'kind' in visit ? JSON.stringify([visit.kind, visit.id, visit.state]) : getRecencyEntryKey(visit);
}

const storageKey = 'sessions.recencyHistory';
const viewedPrefix = 'sessions.lastViewed.';
const limit = 100;

/** Workspace-local MRU for durable conversations and custom views, independent of the window's traversal cursor. */
export class SessionsRecencyHistory {
	private history: readonly RecentVisit[];

	constructor(private readonly storage: IStorageService) {
		this.history = this.load();
	}

	get entries(): readonly RecentVisit[] {
		return this.history;
	}

	markOpened(entry: RecentVisit): void {
		const key = visitKey(entry);
		if (!('kind' in entry)) this.markViewed(entry);
		if (this.history[0] && visitKey(this.history[0]) === key) {
			return;
		}
		this.history = [entry, ...this.history.filter(candidate => visitKey(candidate) !== key)].slice(0, limit);
		this.storage.store(storageKey, JSON.stringify(this.history), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	markViewed(entry: SessionRecencyEntry): void {
		this.storage.store(viewedPrefix + getRecencyEntryKey(entry), Date.now(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	getLastViewedAt(entry: SessionRecencyEntry): number | undefined {
		const timestamp = this.storage.getNumber(viewedPrefix + getRecencyEntryKey(entry), StorageScope.WORKSPACE);
		return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
	}

	private load(): readonly RecentVisit[] {
		try {
			const value: unknown = JSON.parse(this.storage.get(storageKey, StorageScope.WORKSPACE) ?? '[]');
			if (!Array.isArray(value)) {
				return [];
			}
			const entries = new Map<string, RecentVisit>();
			for (const item of value) {
				if (!isRecord(item)) continue;
				let entry: RecentVisit;
				if (item.kind === 'customView' && typeof item.id === 'string' && item.id
					&& (item.state === undefined || typeof item.state === 'string')) {
					entry = { kind: 'customView', id: item.id, state: item.state };
				} else if (typeof item.sessionId === 'string' && item.sessionId && typeof item.threadId === 'string' && item.threadId) {
					entry = { sessionId: item.sessionId, threadId: item.threadId };
				} else {
					continue;
				}
				entries.set(visitKey(entry), entry);
				if (entries.size === limit) break;
			}
			return [...entries.values()];
		} catch {
			return [];
		}
	}
}

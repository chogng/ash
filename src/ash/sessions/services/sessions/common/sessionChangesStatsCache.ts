import { isRecord } from '../../../../base/common/types.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

type SessionChangesStats = { readonly files: number; readonly additions: number; readonly deletions: number; };
const key = 'sessions.changes.lastKnownStatistics';
const limit = 30;

/** Last successful conversation totals, for presentation while the provider is unavailable. */
export class SessionChangesStatsCache {
	constructor(private readonly storage: IStorageService) { }

	get(owner: string): SessionChangesStats | undefined {
		return this.read().get(owner);
	}

	set(owner: string, stats: SessionChangesStats): void {
		const entries = this.read();
		const previous = entries.get(owner);
		if (previous?.files === stats.files && previous.additions === stats.additions && previous.deletions === stats.deletions
			&& [...entries.keys()].at(-1) === owner) { return; }
		entries.delete(owner);
		entries.set(owner, stats);
		if (entries.size > limit) { entries.delete(entries.keys().next().value!); }
		this.storage.store(key, JSON.stringify([...entries]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private read(): Map<string, SessionChangesStats> {
		const entries = new Map<string, SessionChangesStats>();
		try {
			const value: unknown = JSON.parse(this.storage.get(key, StorageScope.WORKSPACE) ?? '[]');
			if (!Array.isArray(value) || value.length > limit) { return entries; }
			const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
			for (const entry of value) {
				if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !isRecord(entry[1])) { continue; }
				const { files, additions, deletions } = entry[1];
				if (isCount(files) && isCount(additions) && isCount(deletions)) {
					entries.set(entry[0], { files, additions, deletions });
				}
			}
		} catch { /* The ledger remains authoritative when cached presentation data is invalid. */ }
		return entries;
	}
}

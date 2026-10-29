import { isRecord } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { ChatEditOutcome, ChatEditSource } from '../../../../services/chat/common/chatService.js';

export interface StoredFileReview {
	readonly resource: string;
	readonly original: string | null;
	readonly current: string | null;
}

export interface StoredReviewSource extends ChatEditSource {
	readonly outcome: ChatEditOutcome | 'pending';
}

export type StoredReviewEntry = { readonly sources: readonly StoredReviewSource[] } & (
	| {
			readonly kind: 'text';
			readonly resource: string;
			readonly original: string;
			readonly current: string;
			readonly pendingSaveSource?: string;
	  }
	| { readonly kind: 'files'; readonly files: readonly StoredFileReview[] }
);

export interface StoredSessionState {
	readonly version: 1;
	readonly entries: readonly StoredReviewEntry[];
}

const storageKey = 'chatEditing.sessions';
const maxContentLength = 32 * 1024 * 1024;

/** Stores editor-owned review baselines; backend checkpoints remain the history authority. */
export class ChatEditingSessionStorage {
	private previous: string | undefined;
	private needsFlush = false;

	constructor(@IStorageService private readonly storage: IStorageService) {}

	public restoreState(): StoredSessionState | undefined {
		const value = this.storage.get(storageKey, StorageScope.WORKSPACE);
		this.previous = value;
		if (value === undefined) {
			return undefined;
		}
		if (value.length > maxContentLength) {
			throw new Error(localize('chatEditing.invalidStorage', 'Saved Agent review data is invalid or too large.'));
		}
		const state: unknown = JSON.parse(value);
		validateState(state);
		return state;
	}

	public async storeState(state: StoredSessionState): Promise<void> {
		if (this.storage.get(storageKey, StorageScope.WORKSPACE) !== this.previous) {
			throw new Error(localize('chatEditing.storageConflict', 'Another window changed the saved Agent reviews. Local reviews were kept.'));
		}
		const value = state.entries.length === 0 ? undefined : JSON.stringify(state);
		if (value !== undefined && value.length > maxContentLength) {
			throw new Error(localize('chatEditing.invalidStorage', 'Saved Agent review data is invalid or too large.'));
		}
		if (value === this.previous && !this.needsFlush) return;
		// A failed flush still needs retrying even when the window cache already
		// holds this value, including removal of the final review.
		this.needsFlush = true;
		if (state.entries.length === 0) {
			this.storage.remove(storageKey, StorageScope.WORKSPACE);
			this.previous = undefined;
		} else {
			this.storage.store(storageKey, value, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this.previous = value;
		}
		await this.storage.flush();
		this.needsFlush = false;
	}
}

function validateState(value: unknown): asserts value is StoredSessionState {
	function invalid(): never {
		throw new Error(localize('chatEditing.invalidStorage', 'Saved Agent review data is invalid or too large.'));
	}
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 1024) {
		invalid();
	}
	const resources = new Set<string>();
	const claimResource = (resource: unknown): void => {
		if (typeof resource !== 'string' || resource.length > 8192) {
			invalid();
		}
		const uri = URI.parse(resource);
		if (!uri.scheme || !uri.path.startsWith('/') || resources.has(uri.toString())) {
			invalid();
		}
		resources.add(uri.toString());
	};
	for (const entry of value.entries) {
		if (!isRecord(entry) || !Array.isArray(entry.sources) || entry.sources.length === 0 || entry.sources.length > 4096) {
			invalid();
		}
		const sources = new Set<string>();
		for (const source of entry.sources) {
			if (
				!isRecord(source) ||
				typeof source.threadId !== 'string' ||
				!source.threadId ||
				source.threadId.length > 512 ||
				typeof source.turnId !== 'string' ||
				!source.turnId ||
				source.turnId.length > 512 ||
				!['pending', 'completed', 'failed', 'interrupted'].includes(String(source.outcome))
			) {
				invalid();
			}
			const key = JSON.stringify([source.threadId, source.turnId]);
			if (sources.has(key)) {
				invalid();
			}
			sources.add(key);
		}
		if (entry.kind === 'text') {
			claimResource(entry.resource);
			if (typeof entry.original !== 'string' || typeof entry.current !== 'string' || (entry.pendingSaveSource !== undefined && typeof entry.pendingSaveSource !== 'string')) {
				invalid();
			}
		} else if (entry.kind === 'files') {
			if (!Array.isArray(entry.files) || entry.files.length === 0 || entry.files.length > 256) {
				invalid();
			}
			for (const file of entry.files) {
				if (!isRecord(file)) {
					invalid();
				}
				claimResource(file.resource);
				if ((file.original !== null && typeof file.original !== 'string') || (file.current !== null && typeof file.current !== 'string')) {
					invalid();
				}
			}
		} else {
			invalid();
		}
	}
}

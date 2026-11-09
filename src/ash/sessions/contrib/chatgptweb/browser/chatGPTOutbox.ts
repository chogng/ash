import { isRecord } from '../../../../base/common/types.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface PendingChatGPTCreation {
	readonly localId: string;
	readonly messageId: string;
	readonly parentId: string;
	readonly text: string;
	readonly model?: string;
	readonly thinkingEffort?: string;
	readonly projectId?: string;
	readonly ashProjectId?: string;
	readonly submittedAgainst?: readonly string[];
	readonly remoteId?: string;
	readonly cancelled?: boolean;
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,240}$/u.test(value);
}

function isCreation(value: unknown): value is PendingChatGPTCreation {
	return isRecord(value) && isId(value.localId) && isId(value.messageId) && isId(value.parentId)
		&& typeof value.text === 'string' && value.text.length > 0
		&& (value.model === undefined || typeof value.model === 'string')
		&& (value.thinkingEffort === undefined || typeof value.thinkingEffort === 'string')
		&& (value.projectId === undefined || isId(value.projectId))
		&& (value.ashProjectId === undefined || value.projectId === undefined && isId(value.ashProjectId))
		&& (value.submittedAgainst === undefined || Array.isArray(value.submittedAgainst) && value.submittedAgainst.every(isId))
		&& (value.remoteId === undefined || isId(value.remoteId) && Array.isArray(value.submittedAgainst))
		&& (value.cancelled === undefined || typeof value.cancelled === 'boolean');
}

/** A single account-scoped record lets a cancelled creation become a tombstone atomically. */
export class ChatGPTOutbox {
	private readonly key: string;
	private readonly creates = new Map<string, PendingChatGPTCreation>();
	private readonly deletes = new Map<string, boolean>();

	constructor(private readonly storage: IStorageService, scope: string) {
		this.key = `sessions.chatgpt.outbox.v1:${scope}`;
		const raw = storage.get(this.key, StorageScope.PROFILE);
		if (!raw) { return; }
		let value: unknown;
		try { value = JSON.parse(raw); }
		catch { return; }
		if (!isRecord(value)) { return; }
		if (Array.isArray(value.creates)) {
			for (const entry of value.creates) {
				if (isCreation(entry)) { this.creates.set(entry.localId, entry); }
			}
		}
		if (Array.isArray(value.deletes)) {
			for (const entry of value.deletes) {
				if (Array.isArray(entry) && entry.length === 2 && isId(entry[0]) && typeof entry[1] === 'boolean') {
					this.deletes.set(entry[0], entry[1]);
				}
			}
		}
	}

	creations(): readonly PendingChatGPTCreation[] { return [...this.creates.values()]; }
	creation(localId: string): PendingChatGPTCreation | undefined { return this.creates.get(localId); }
	hasPending(): boolean {
		if (this.creates.size > 0) { return true; }
		for (const confirmed of this.deletes.values()) {
			if (!confirmed) { return true; }
		}
		return false;
	}
	isDeleted(id: string): boolean { return this.deletes.has(id); }
	pendingDeletes(): readonly string[] { return [...this.deletes].filter(([, confirmed]) => !confirmed).map(([id]) => id); }

	saveCreation(entry: PendingChatGPTCreation): void {
		this.creates.set(entry.localId, entry);
		this.save();
	}

	removeCreation(localId: string): void {
		this.creates.delete(localId);
		this.save();
	}

	deleteConversation(id: string, localId?: string): void {
		if (localId) { this.creates.delete(localId); }
		if (!this.deletes.has(id)) { this.deletes.set(id, false); }
		this.save();
	}

	confirmDeletion(id: string): void {
		// Keep only the ID after acknowledgement so a stale catalog cannot resurrect the row.
		this.deletes.set(id, true);
		this.save();
	}

	private save(): void {
		this.storage.store(this.key, JSON.stringify({ creates: this.creations(), deletes: [...this.deletes] }), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

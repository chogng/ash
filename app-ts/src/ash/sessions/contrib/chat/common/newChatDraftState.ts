import { isRecord } from '../../../../base/common/types.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

type ChatDraft = NonNullable<IOpenAgentsWindowOptions['draft']>;

function draftPrefix(page: 'chat' | 'code'): string {
	return page === 'chat' ? 'sessions.draftState' : 'sessions.codeDraftState';
}

/** Draft identities are page-local: a Thread id or an `untitled:` slot id. */
export function readNewChatDraftState(storage: IStorageService, page: 'chat' | 'code', draftId: string): ChatDraft | undefined {
	const raw = storage.get(`${draftPrefix(page)}:${draftId}`, StorageScope.WORKSPACE);
	return raw === undefined ? undefined : parseChatDraft(raw);
}

function parseChatDraft(raw: string): ChatDraft {
	const draft: unknown = JSON.parse(raw);
	if (!isRecord(draft) || !['agent', 'plan', 'debug', 'multitask', 'ask'].includes(draft.mode as string)
		|| typeof draft.text !== 'string' || !Array.isArray(draft.contexts)
		|| !draft.contexts.every(context => isRecord(context) && typeof context.id === 'string'
			&& typeof context.kind === 'string' && typeof context.name === 'string' && typeof context.content === 'string')) {
		throw new TypeError('Invalid stored Chat draft');
	}
	return draft as unknown as ChatDraft;
}

export function writeNewChatDraftState(storage: IStorageService, page: 'chat' | 'code', draft: ChatDraft | undefined, draftId: string): void {
	const key = `${draftPrefix(page)}:${draftId}`;
	if (!draft || (!draft.text && draft.contexts.length === 0)) {
		storage.remove(key, StorageScope.WORKSPACE);
	} else {
		storage.store(key, JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

/** The first untitled slot claims the old page-wide draft once; all subsequent writes use its identity. */
export function migrateNewChatDraftState(storage: IStorageService, page: 'chat' | 'code', untitledSessionId: string): void {
	const key = draftPrefix(page);
	const raw = storage.get(key, StorageScope.WORKSPACE);
	if (raw === undefined) {
		return;
	}
	const legacy = parseChatDraft(raw);
	const identity = `untitled:${untitledSessionId}`;
	const current = readNewChatDraftState(storage, page, identity);
	if (current && JSON.stringify(current) !== JSON.stringify(legacy)) {
		throw new Error('Conflicting stored Sessions drafts');
	}
	writeNewChatDraftState(storage, page, legacy, identity);
	// Both entries belong to one workspace state document, committed by the same flush.
	storage.remove(key, StorageScope.WORKSPACE);
}

import { isRecord } from '../../../../base/common/types.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

type ChatDraft = NonNullable<IOpenAgentsWindowOptions['draft']>;

function draftKey(threadId: string | undefined): string {
	return threadId === undefined ? 'sessions.draftState' : `sessions.draftState:${threadId}`;
}

/** A new composer restores the last visible new-session draft; durable Threads have separate drafts. */
export function readNewChatDraftState(storage: IStorageService, threadId?: string): ChatDraft | undefined {
	const raw = storage.get(draftKey(threadId), StorageScope.WORKSPACE);
	if (raw === undefined) return undefined;
	const draft: unknown = JSON.parse(raw);
	if (!isRecord(draft) || !['agent', 'plan', 'debug', 'multitask', 'ask'].includes(draft.mode as string)
		|| typeof draft.text !== 'string' || !Array.isArray(draft.contexts)
		|| !draft.contexts.every(context => isRecord(context) && typeof context.id === 'string'
			&& typeof context.kind === 'string' && typeof context.name === 'string' && typeof context.content === 'string')) {
		throw new TypeError('Invalid stored Chat draft');
	}
	return draft as unknown as ChatDraft;
}

export function writeNewChatDraftState(storage: IStorageService, draft: ChatDraft | undefined, threadId?: string): void {
	const key = draftKey(threadId);
	if (!draft || (!draft.text && draft.contexts.length === 0)) storage.remove(key, StorageScope.WORKSPACE);
	else storage.store(key, JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

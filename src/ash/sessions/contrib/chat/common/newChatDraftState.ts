import { isRecord } from '../../../../base/common/types.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

type ChatDraft = NonNullable<IOpenAgentsWindowOptions['draft']>;

/** A draft belongs to a Thread or an `untitled:` session identity, regardless of layout. */
export function readNewChatDraftState(storage: IStorageService, draftId: string): ChatDraft | undefined {
	const raw = storage.get(`sessions.inputDraft:${draftId}`, StorageScope.WORKSPACE);
	return raw === undefined ? undefined : parseChatDraft(raw);
}

function parseChatDraft(raw: string): ChatDraft {
	const draft: unknown = JSON.parse(raw);
	if (!isRecord(draft) || !['agent', 'plan', 'debug', 'multitask', 'ask'].includes(draft.mode as string)
		|| typeof draft.text !== 'string' || !Array.isArray(draft.contexts)
		|| !draft.contexts.every(context => isRecord(context) && typeof context.id === 'string'
			&& typeof context.kind === 'string' && typeof context.name === 'string' && typeof context.content === 'string'
			&& (context.resource === undefined || typeof context.resource === 'string'))) {
		throw new TypeError('Invalid stored Chat draft');
	}
	return draft as unknown as ChatDraft;
}

export function writeNewChatDraftState(storage: IStorageService, draft: ChatDraft | undefined, draftId: string): void {
	const key = `sessions.inputDraft:${draftId}`;
	if (!draft || (!draft.text && draft.contexts.length === 0)) {
		storage.remove(key, StorageScope.WORKSPACE);
	} else {
		storage.store(key, JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

/** Conflicting legacy drafts get their own session before their old entry is removed. */
export function migrateNewChatDraftState(storage: IStorageService): readonly { readonly draft: ChatDraft; readonly key: string; }[] {
	const prefixes = storage.get('sessions.activityBar.activePage', StorageScope.WORKSPACE) === 'code'
		? ['sessions.codeDraftState', 'sessions.draftState'] : ['sessions.draftState', 'sessions.codeDraftState'];
	const recovered: { draft: ChatDraft; key: string; }[] = [];
	for (const prefix of prefixes) {
		for (const key of storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).filter(key => key === prefix || key.startsWith(`${prefix}:`))) {
			const draft = parseChatDraft(storage.get(key, StorageScope.WORKSPACE)!);
			const identity = key.slice(prefix.length + 1);
			const existing = identity ? readNewChatDraftState(storage, identity) : undefined;
			if (!identity || existing && JSON.stringify(existing) !== JSON.stringify(draft)) {
				recovered.push({ draft, key });
				continue;
			}
			writeNewChatDraftState(storage, draft, identity);
			storage.remove(key, StorageScope.WORKSPACE);
		}
	}
	return recovered;
}

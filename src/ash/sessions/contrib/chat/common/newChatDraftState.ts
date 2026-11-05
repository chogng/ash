import { structuralEquals } from '../../../../base/common/equals.js';
import { isRecord } from '../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../base/common/uuid.js';
import { validateOpenAgentsWindow, type IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

type ChatDraft = NonNullable<IOpenAgentsWindowOptions['draft']>;

/** Browser hosts supply the shared codec; storage scope and draft validation stay with Sessions. */
interface InputStatePersistence {
	serializeUntitledInputState(value: ChatDraft | undefined): string;
	deserializeUntitledInputState(value: string): ChatDraft | undefined;
	serializeUntitledInputAttachments(attachments: ChatDraft['contexts']): string;
	deserializeUntitledInputAttachments(value: string): ChatDraft['contexts'];
}

interface StoredInput {
	readonly state: string;
	readonly attachments?: string;
}

function storedInput(value: unknown): StoredInput | undefined {
	if (!isRecord(value) || typeof value.state !== 'string'
		|| Object.keys(value).some(key => key !== 'state' && key !== 'attachments')
		|| value.attachments !== undefined && !isUuid(value.attachments)) return undefined;
	return value as unknown as StoredInput;
}

function attachmentsKey(draftId: string, id: string): string {
	return `sessions.inputDraftAttachments:${draftId}:${id}`;
}

/** A draft belongs to a Thread or an `untitled:` session identity, regardless of layout. */
export function readNewChatDraftState(storage: IStorageService, draftId: string, persistence: InputStatePersistence): ChatDraft | undefined {
	const stored = readStoredDraft(storage, draftId, persistence);
	if (stored?.combined) writeNewChatDraftState(storage, stored.draft, draftId, persistence);
	return stored?.draft;
}

/** Migration compares destinations without rewriting a conflicting record. */
function readStoredDraft(storage: IStorageService, draftId: string, persistence: InputStatePersistence): { readonly draft: ChatDraft; readonly combined: boolean; } | undefined {
	const raw = storage.get(`sessions.inputDraft:${draftId}`, StorageScope.WORKSPACE);
	if (raw === undefined) return undefined;
	const value: unknown = JSON.parse(raw);
	const stored = storedInput(value);
	if (!stored) {
		return { draft: validateChatDraft(value), combined: true };
	}
	const state = persistence.deserializeUntitledInputState(stored.state);
	if (!isRecord(state) || !Array.isArray(state.contexts) || state.contexts.length !== 0) throw new TypeError('Invalid stored Chat input state');
	let contexts: ChatDraft['contexts'] = [];
	if (stored.attachments) {
		const payload = storage.get(attachmentsKey(draftId, stored.attachments), StorageScope.WORKSPACE);
		if (payload === undefined) throw new TypeError('Missing stored Chat draft attachments');
		contexts = persistence.deserializeUntitledInputAttachments(payload);
	}
	return { draft: validateChatDraft({ ...state, contexts }), combined: false };
}

function validateChatDraft(draft: unknown): ChatDraft {
	if (!isRecord(draft) || !['agent', 'plan', 'debug', 'multitask', 'ask'].includes(draft.mode as string)
		|| typeof draft.text !== 'string' || !Array.isArray(draft.contexts)
		|| !draft.contexts.every(context => isRecord(context) && typeof context.id === 'string'
			&& typeof context.kind === 'string' && typeof context.name === 'string' && typeof context.content === 'string'
			&& (context.resource === undefined || typeof context.resource === 'string'))) {
		throw new TypeError('Invalid stored Chat draft');
	}
	validateOpenAgentsWindow({ draft });
	return draft as unknown as ChatDraft;
}

export function writeNewChatDraftState(storage: IStorageService, draft: ChatDraft | undefined, draftId: string, persistence: InputStatePersistence): void {
	const key = `sessions.inputDraft:${draftId}`;
	let previous: StoredInput | undefined;
	try { previous = storedInput(JSON.parse(storage.get(key, StorageScope.WORKSPACE) ?? 'null')); }
	catch { /* A user edit may replace an unreadable draft; never guess its attachment identity. */ }
	if (!draft || (!draft.text.trim() && draft.contexts.length === 0)) {
		storage.remove(key, StorageScope.WORKSPACE);
		if (previous?.attachments) storage.remove(attachmentsKey(draftId, previous.attachments), StorageScope.WORKSPACE);
		return;
	}
	const state = persistence.serializeUntitledInputState(draft);
	const payload = draft.contexts.length ? persistence.serializeUntitledInputAttachments(draft.contexts) : undefined;
	let attachments = previous?.attachments;
	const reuse = attachments !== undefined && storage.get(attachmentsKey(draftId, attachments), StorageScope.WORKSPACE) === payload;
	if (!reuse) attachments = payload === undefined ? undefined : generateUuid();
	// Publish the small state only after its immutable payload exists. A failed write
	// leaves the previous record usable, including during legacy migration.
	if (attachments && !reuse) storage.store(attachmentsKey(draftId, attachments), payload!, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	try {
		storage.store(key, JSON.stringify({ state, attachments }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	} catch (error) {
		if (attachments && !reuse) storage.remove(attachmentsKey(draftId, attachments), StorageScope.WORKSPACE);
		throw error;
	}
	if (previous?.attachments && previous.attachments !== attachments) storage.remove(attachmentsKey(draftId, previous.attachments), StorageScope.WORKSPACE);
}

/** Conflicting legacy drafts get their own session before their old entry is removed. */
export function migrateNewChatDraftState(storage: IStorageService, persistence: InputStatePersistence, onError?: (error: unknown) => void): readonly { readonly draft: ChatDraft; readonly key: string; }[] {
	const prefixes = storage.get('sessions.activityBar.activePage', StorageScope.WORKSPACE) === 'code'
		? ['sessions.codeDraftState', 'sessions.draftState'] : ['sessions.draftState', 'sessions.codeDraftState'];
	const recovered: { draft: ChatDraft; key: string; }[] = [];
	for (const prefix of prefixes) {
		for (const key of storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).filter(key => key === prefix || key.startsWith(`${prefix}:`))) {
			try {
				const draft = validateChatDraft(persistence.deserializeUntitledInputState(storage.get(key, StorageScope.WORKSPACE)!));
				const identity = key.slice(prefix.length + 1);
				const existing = identity ? readStoredDraft(storage, identity, persistence)?.draft : undefined;
				if (!identity || existing && !structuralEquals(existing, draft)) {
					recovered.push({ draft, key });
					continue;
				}
				writeNewChatDraftState(storage, draft, identity, persistence);
				storage.remove(key, StorageScope.WORKSPACE);
			} catch (error) {
				// One corrupt entry must not block other drafts or remove recoverable storage.
				onError?.(error);
			}
		}
	}
	return recovered;
}

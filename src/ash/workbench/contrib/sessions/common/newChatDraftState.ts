import { isRecord } from '../../../../base/common/types.js';
import { generateUuid, isUuid } from '../../../../base/common/uuid.js';
import { validateOpenAgentsWindow, type IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';
import { deserializeUntitledInputAttachments, deserializeUntitledInputState, serializeUntitledInputAttachments, serializeUntitledInputState } from './chatInputStatePersistence.js';

type ChatDraft = NonNullable<IOpenAgentsWindowOptions['draft']>;

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
export function readNewChatDraftState(storage: IStorageService, draftId: string): ChatDraft | undefined {
	const raw = storage.get(`sessions.inputDraft:${draftId}`, StorageScope.WORKSPACE);
	if (raw === undefined) return undefined;
	const stored = storedInput(JSON.parse(raw));
	if (!stored) throw new TypeError('Invalid stored Chat draft');
	const state = deserializeUntitledInputState(stored.state);
	if (!isRecord(state) || !Array.isArray(state.contexts) || state.contexts.length !== 0) throw new TypeError('Invalid stored Chat input state');
	let contexts: ChatDraft['contexts'] = [];
	if (stored.attachments) {
		const payload = storage.get(attachmentsKey(draftId, stored.attachments), StorageScope.WORKSPACE);
		if (payload === undefined) throw new TypeError('Missing stored Chat draft attachments');
		contexts = deserializeUntitledInputAttachments(payload);
	}
	const draft = { ...state, contexts };
	validateOpenAgentsWindow({ draft });
	return draft;
}

export function writeNewChatDraftState(storage: IStorageService, draft: ChatDraft | undefined, draftId: string): void {
	const key = `sessions.inputDraft:${draftId}`;
	let previous: StoredInput | undefined;
	try { previous = storedInput(JSON.parse(storage.get(key, StorageScope.WORKSPACE) ?? 'null')); }
	catch { /* A user edit may replace an unreadable draft; never guess its attachment identity. */ }
	if (!draft || (!draft.text.trim() && draft.contexts.length === 0)) {
		storage.remove(key, StorageScope.WORKSPACE);
		if (previous?.attachments) storage.remove(attachmentsKey(draftId, previous.attachments), StorageScope.WORKSPACE);
		return;
	}
	const state = serializeUntitledInputState(draft);
	const payload = draft.contexts.length ? serializeUntitledInputAttachments(draft.contexts) : undefined;
	let attachments = previous?.attachments;
	const reuse = attachments !== undefined && storage.get(attachmentsKey(draftId, attachments), StorageScope.WORKSPACE) === payload;
	if (!reuse) attachments = payload === undefined ? undefined : generateUuid();
	// Publish the small state only after its immutable payload exists. A failed write
	// leaves the previous record usable.
	if (attachments && !reuse) storage.store(attachmentsKey(draftId, attachments), payload!, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	try {
		storage.store(key, JSON.stringify({ state, attachments }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	} catch (error) {
		if (attachments && !reuse) storage.remove(attachmentsKey(draftId, attachments), StorageScope.WORKSPACE);
		throw error;
	}
	if (previous?.attachments && previous.attachments !== attachments) storage.remove(attachmentsKey(draftId, previous.attachments), StorageScope.WORKSPACE);
}

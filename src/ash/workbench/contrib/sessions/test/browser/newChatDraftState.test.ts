import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../../common/newChatDraftState.js';

const draft = { text: 'Recover this task', contexts: [{ id: 'source', kind: 'file', name: 'task.ts', content: 'selected snapshot', resource: 'file:///project/task.ts' }] };

function createStorage() {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	const storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'draft-test', flushInterval: 0 });
	return { storage, [Symbol.dispose]() { storage.dispose(); dom.window.close(); } };
}

test('stored drafts retain code reference positions and reject references to different text', () => {
	using fixture = createStorage();
	const selected = { text: 'Explain task.ts (6-9)', contexts: [{ id: 'selection', kind: 'codeSelection', name: 'task.ts (6-9)', content: 'Unsaved code', resource: 'file:///project/task.ts#6,1-9,2', reference: { start: 8, end: 21 } }] };
	writeNewChatDraftState(fixture.storage, selected, 'selection');
	assert.deepEqual(readNewChatDraftState(fixture.storage, 'selection'), selected);
	const stored = JSON.parse(fixture.storage.get('sessions.inputDraft:selection', StorageScope.WORKSPACE)!);
	stored.state = JSON.stringify({ text: 'Explain other.ts (6-9)', contexts: [] });
	fixture.storage.store('sessions.inputDraft:selection', JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.throws(() => readNewChatDraftState(fixture.storage, 'selection'), /Invalid Agents Window context reference/);
});

test('stored drafts reject unknown fields', () => {
	using fixture = createStorage();
	const { storage } = fixture;
	const invalid = JSON.stringify({ state: JSON.stringify({ ...draft, unknownField: true, contexts: [] }) });
	storage.store('sessions.inputDraft:invalid', invalid, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.throws(() => readNewChatDraftState(storage, 'invalid'), /Invalid Agents Window draft/);
	assert.equal(storage.get('sessions.inputDraft:invalid', StorageScope.WORKSPACE), invalid);
});

test('a stored Swarm draft keeps its separate attachment after editing', () => {
	using fixture = createStorage();
	const { storage } = fixture;
	const attachments = '34d83c82-ca55-4745-ae31-94faf41b034f';
	const draftKey = 'sessions.inputDraft:untitled:upgrade';
	const attachmentKey = `sessions.inputDraftAttachments:untitled:upgrade:${attachments}`;
	const swarmDraft = { ...draft, text: '/swarm Recover this task' };
	const state = JSON.stringify({ ...swarmDraft, contexts: [] });
	const record = JSON.stringify({ state, attachments });
	const payload = JSON.stringify(draft.contexts);
	storage.store(attachmentKey, payload, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store(draftKey, record, StorageScope.WORKSPACE, StorageTarget.MACHINE);

	assert.deepEqual(readNewChatDraftState(storage, 'untitled:upgrade'), swarmDraft);
	assert.equal(storage.get(draftKey, StorageScope.WORKSPACE), record);

	const edited = { ...swarmDraft, text: '/swarm Updated task' };
	writeNewChatDraftState(storage, edited, 'untitled:upgrade');
	assert.deepEqual(JSON.parse(storage.get(draftKey, StorageScope.WORKSPACE)!), {
		state: JSON.stringify({ ...edited, contexts: [] }), attachments,
	});
	assert.equal(storage.get(attachmentKey, StorageScope.WORKSPACE), payload);
	assert.deepEqual(readNewChatDraftState(storage, 'untitled:upgrade'), edited);
});

test('editing text reuses the image payload while the input record stays small', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const image = { id: 'image', kind: 'image', name: 'screen.png', content: `data:image/png;base64,${'A'.repeat(64 * 1024)}` };
	const saved = { ...draft, contexts: [image] };
	const changed: string[] = [];
	using listener = storage.onDidChangeValue(event => changed.push(event.key));
	writeNewChatDraftState(storage, saved, 'image');
	const first = storage.get('sessions.inputDraft:image', StorageScope.WORKSPACE)!;
	writeNewChatDraftState(storage, { ...saved, text: '/ask Updated question' }, 'image');
	const second = storage.get('sessions.inputDraft:image', StorageScope.WORKSPACE)!;
	assert.ok(first.length < 1024 && second.length < 1024);
	assert.equal(changed.filter(key => key.startsWith('sessions.inputDraftAttachments:')).length, 1);
	assert.deepEqual(readNewChatDraftState(storage, 'image'), { ...saved, text: '/ask Updated question' });
});

test('attachment replacement and draft removal release only their owned payloads', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	writeNewChatDraftState(storage, draft, 'one');
	writeNewChatDraftState(storage, draft, 'two');
	const oldPayload = storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).find(key => key.startsWith('sessions.inputDraftAttachments:one:'))!;
	const updated = { ...draft, contexts: [{ ...draft.contexts[0]!, content: 'A new captured snapshot' }] };
	writeNewChatDraftState(storage, updated, 'one');
	assert.equal(storage.get(oldPayload, StorageScope.WORKSPACE), undefined);
	assert.deepEqual(readNewChatDraftState(storage, 'one'), updated);
	writeNewChatDraftState(storage, { ...updated, contexts: [] }, 'one');
	assert.equal(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).filter(key => key.startsWith('sessions.inputDraftAttachments:one:')).length, 0);
	writeNewChatDraftState(storage, undefined, 'one');
	assert.equal(readNewChatDraftState(storage, 'one'), undefined);
	assert.deepEqual(readNewChatDraftState(storage, 'two'), draft);
	writeNewChatDraftState(storage, undefined, 'two');
	assert.deepEqual(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE), []);
});

test('a failed state publication retains the previous attachment and removes the unpublished payload', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	writeNewChatDraftState(storage, draft, 'safe');
	const keys = storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const stored = storage.get('sessions.inputDraft:safe', StorageScope.WORKSPACE);
	const originalStore = storage.store;
	const failure = new Error('State publication failed');
	storage.store = function (key, value, scope, target) {
		if (key === 'sessions.inputDraft:safe') throw failure;
		originalStore.call(this, key, value, scope, target);
	};
	try {
		assert.throws(() => writeNewChatDraftState(storage, { ...draft, contexts: [{ ...draft.contexts[0]!, content: 'Changed snapshot' }] }, 'safe'), error => error === failure);
	} finally { storage.store = originalStore; }
	assert.equal(storage.get('sessions.inputDraft:safe', StorageScope.WORKSPACE), stored);
	assert.deepEqual(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE), keys);
	assert.deepEqual(readNewChatDraftState(storage, 'safe'), draft);
});

test('missing or invalid attachment payloads fail restoration without rewriting stored data', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	writeNewChatDraftState(storage, draft, 'broken');
	const key = storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).find(key => key.startsWith('sessions.inputDraftAttachments:broken:'))!;
	const stored = storage.get('sessions.inputDraft:broken', StorageScope.WORKSPACE);
	storage.store(key, JSON.stringify([{ ...draft.contexts[0], resource: 42 }]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.throws(() => readNewChatDraftState(storage, 'broken'), TypeError);
	storage.remove(key, StorageScope.WORKSPACE);
	assert.throws(() => readNewChatDraftState(storage, 'broken'), /Missing stored Chat draft attachments/);
	assert.equal(storage.get('sessions.inputDraft:broken', StorageScope.WORKSPACE), stored);
});

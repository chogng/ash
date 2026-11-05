import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { migrateNewChatDraftState, readNewChatDraftState, writeNewChatDraftState } from '../../common/newChatDraftState.js';

const draft = { mode: 'plan' as const, text: 'Recover this task', contexts: [{ id: 'source', kind: 'file', name: 'task.ts', content: 'selected snapshot', resource: 'file:///project/task.ts' }] };

function createStorage() {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	const storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'draft-test', flushInterval: 0 });
	return { storage, [Symbol.dispose]() { storage.dispose(); dom.window.close(); } };
}

test('stored drafts retain code reference positions and reject references to different text', () => {
	using fixture = createStorage();
	const selected = { mode: 'agent' as const, text: 'Explain task.ts (6-9)', contexts: [{ id: 'selection', kind: 'codeSelection', name: 'task.ts (6-9)', content: 'Unsaved code', resource: 'file:///project/task.ts#6,1-9,2', reference: { start: 8, end: 21 } }] };
	writeNewChatDraftState(fixture.storage, selected, 'selection', chatInputStatePersistence);
	assert.deepEqual(readNewChatDraftState(fixture.storage, 'selection', chatInputStatePersistence), selected);
	fixture.storage.store('sessions.inputDraft:selection', JSON.stringify({ ...selected, text: 'Explain other.ts (6-9)' }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.throws(() => readNewChatDraftState(fixture.storage, 'selection', chatInputStatePersistence), /Invalid Agents Window context reference/);
});

test('malformed legacy drafts preserve their raw entries while valid drafts still migrate', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const malformed = '{unfinished';
	storage.store('sessions.draftState:broken', malformed, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.codeDraftState:valid', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const errors: unknown[] = [];
	assert.deepEqual(migrateNewChatDraftState(storage, chatInputStatePersistence, error => errors.push(error)), []);
	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof SyntaxError);
	assert.equal(storage.get('sessions.draftState:broken', StorageScope.WORKSPACE), malformed);
	assert.equal(storage.get('sessions.codeDraftState:valid', StorageScope.WORKSPACE), undefined);
	assert.deepEqual(readNewChatDraftState(storage, 'valid', chatInputStatePersistence), draft);
});

test('migration deduplicates matching drafts with differently ordered fields', () => {
	using fixture = createStorage();
	const { storage } = fixture;
	writeNewChatDraftState(storage, draft, 'same', chatInputStatePersistence);
	storage.store('sessions.draftState:same', JSON.stringify({ contexts: draft.contexts, text: draft.text, mode: draft.mode }), StorageScope.WORKSPACE, StorageTarget.MACHINE);

	assert.deepEqual(migrateNewChatDraftState(storage, chatInputStatePersistence), []);
	assert.equal(storage.get('sessions.draftState:same', StorageScope.WORKSPACE), undefined);
	assert.deepEqual(readNewChatDraftState(storage, 'same', chatInputStatePersistence), draft);
});

test('a corrupt destination preserves both copies and does not block another draft', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const invalid = JSON.stringify({ ...draft, contexts: [{ ...draft.contexts[0], resource: 42 }] });
	storage.store('sessions.inputDraft:conflict', invalid, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.draftState:conflict', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.draftState:valid', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const errors: unknown[] = [];
	migrateNewChatDraftState(storage, chatInputStatePersistence, error => errors.push(error));
	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof TypeError);
	assert.equal(storage.get('sessions.inputDraft:conflict', StorageScope.WORKSPACE), invalid);
	assert.equal(storage.get('sessions.draftState:conflict', StorageScope.WORKSPACE), JSON.stringify(draft));
	assert.deepEqual(readNewChatDraftState(storage, 'valid', chatInputStatePersistence), draft);
});

test('migration keeps a legacy entry when writing its replacement fails', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const failure = new Error('Storage write failed');
	storage.store('sessions.draftState:source', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const originalStore = storage.store;
	storage.store = () => { throw failure; };
	const errors: unknown[] = [];
	try { migrateNewChatDraftState(storage, chatInputStatePersistence, error => errors.push(error)); } finally { storage.store = originalStore; }
	assert.deepEqual(errors, [failure]);
	assert.equal(storage.get('sessions.draftState:source', StorageScope.WORKSPACE), JSON.stringify(draft));
	assert.equal(readNewChatDraftState(storage, 'source', chatInputStatePersistence), undefined);
});

test('editing text reuses the image payload while the input record stays small', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const image = { id: 'image', kind: 'image', name: 'screen.png', content: `data:image/png;base64,${'A'.repeat(64 * 1024)}` };
	const saved = { ...draft, contexts: [image] };
	const changed: string[] = [];
	using listener = storage.onDidChangeValue(event => changed.push(event.key));
	writeNewChatDraftState(storage, saved, 'image', chatInputStatePersistence);
	const first = storage.get('sessions.inputDraft:image', StorageScope.WORKSPACE)!;
	writeNewChatDraftState(storage, { ...saved, text: 'Updated question', mode: 'ask' }, 'image', chatInputStatePersistence);
	const second = storage.get('sessions.inputDraft:image', StorageScope.WORKSPACE)!;
	assert.ok(first.length < 1024 && second.length < 1024);
	assert.equal(changed.filter(key => key.startsWith('sessions.inputDraftAttachments:')).length, 1);
	assert.deepEqual(readNewChatDraftState(storage, 'image', chatInputStatePersistence), { ...saved, text: 'Updated question', mode: 'ask' });
});

test('attachment replacement and draft removal release only their owned payloads', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	writeNewChatDraftState(storage, draft, 'one', chatInputStatePersistence);
	writeNewChatDraftState(storage, draft, 'two', chatInputStatePersistence);
	const oldPayload = storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).find(key => key.startsWith('sessions.inputDraftAttachments:one:'))!;
	const updated = { ...draft, contexts: [{ ...draft.contexts[0]!, content: 'A new captured snapshot' }] };
	writeNewChatDraftState(storage, updated, 'one', chatInputStatePersistence);
	assert.equal(storage.get(oldPayload, StorageScope.WORKSPACE), undefined);
	assert.deepEqual(readNewChatDraftState(storage, 'one', chatInputStatePersistence), updated);
	writeNewChatDraftState(storage, { ...updated, contexts: [] }, 'one', chatInputStatePersistence);
	assert.equal(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).filter(key => key.startsWith('sessions.inputDraftAttachments:one:')).length, 0);
	writeNewChatDraftState(storage, undefined, 'one', chatInputStatePersistence);
	assert.equal(readNewChatDraftState(storage, 'one', chatInputStatePersistence), undefined);
	assert.deepEqual(readNewChatDraftState(storage, 'two', chatInputStatePersistence), draft);
	writeNewChatDraftState(storage, undefined, 'two', chatInputStatePersistence);
	assert.deepEqual(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE), []);
});

test('reading an existing combined draft migrates it once without changing its content', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	storage.store('sessions.inputDraft:existing', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.deepEqual(readNewChatDraftState(storage, 'existing', chatInputStatePersistence), draft);
	const keys = storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const stored = storage.get('sessions.inputDraft:existing', StorageScope.WORKSPACE)!;
	assert.equal(stored.includes('selected snapshot'), false);
	assert.deepEqual(readNewChatDraftState(storage, 'existing', chatInputStatePersistence), draft);
	assert.deepEqual(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE), keys);
	assert.equal(storage.get('sessions.inputDraft:existing', StorageScope.WORKSPACE), stored);
});

test('a failed state publication retains the previous attachment and removes the unpublished payload', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	writeNewChatDraftState(storage, draft, 'safe', chatInputStatePersistence);
	const keys = storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const stored = storage.get('sessions.inputDraft:safe', StorageScope.WORKSPACE);
	const originalStore = storage.store;
	const failure = new Error('State publication failed');
	storage.store = function (key, value, scope, target) {
		if (key === 'sessions.inputDraft:safe') throw failure;
		originalStore.call(this, key, value, scope, target);
	};
	try {
		assert.throws(() => writeNewChatDraftState(storage, { ...draft, contexts: [{ ...draft.contexts[0]!, content: 'Changed snapshot' }] }, 'safe', chatInputStatePersistence), error => error === failure);
	} finally { storage.store = originalStore; }
	assert.equal(storage.get('sessions.inputDraft:safe', StorageScope.WORKSPACE), stored);
	assert.deepEqual(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE), keys);
	assert.deepEqual(readNewChatDraftState(storage, 'safe', chatInputStatePersistence), draft);
});

test('missing or invalid attachment payloads fail restoration without rewriting stored data', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	writeNewChatDraftState(storage, draft, 'broken', chatInputStatePersistence);
	const key = storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).find(key => key.startsWith('sessions.inputDraftAttachments:broken:'))!;
	const stored = storage.get('sessions.inputDraft:broken', StorageScope.WORKSPACE);
	storage.store(key, JSON.stringify([{ ...draft.contexts[0], resource: 42 }]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.throws(() => readNewChatDraftState(storage, 'broken', chatInputStatePersistence), TypeError);
	storage.remove(key, StorageScope.WORKSPACE);
	assert.throws(() => readNewChatDraftState(storage, 'broken', chatInputStatePersistence), /Missing stored Chat draft attachments/);
	assert.equal(storage.get('sessions.inputDraft:broken', StorageScope.WORKSPACE), stored);
});

test('a conflicting legacy migration leaves a valid combined destination unchanged', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const destination = JSON.stringify({ ...draft, text: 'The destination draft' });
	const source = JSON.stringify(draft);
	storage.store('sessions.inputDraft:conflict', destination, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.draftState:conflict', source, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.deepEqual(migrateNewChatDraftState(storage, chatInputStatePersistence), [{ draft, key: 'sessions.draftState:conflict' }]);
	assert.equal(storage.get('sessions.inputDraft:conflict', StorageScope.WORKSPACE), destination);
	assert.equal(storage.get('sessions.draftState:conflict', StorageScope.WORKSPACE), source);
	assert.equal(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 2);
});

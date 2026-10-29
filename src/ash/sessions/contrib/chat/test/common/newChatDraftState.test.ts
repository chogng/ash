import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import {
	migrateNewChatDraftState,
	readNewChatDraftState,
	writeNewChatDraftState,
} from '../../common/newChatDraftState.js';

const draft = {
	mode: 'plan' as const,
	text: 'Recover this task',
	contexts: [
		{
			id: 'source',
			kind: 'file',
			name: 'task.ts',
			content: 'selected snapshot',
			resource: 'file:///project/task.ts',
		},
	],
};

function createStorage() {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	const storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'draft-test',
		flushInterval: 0,
	});
	return {
		storage,
		[Symbol.dispose]() {
			storage.dispose();
			dom.window.close();
		},
	};
}

test('stored drafts retain code reference positions and reject references to different text', () => {
	using fixture = createStorage();
	const selected = {
		mode: 'agent' as const,
		text: 'Explain task.ts (6-9)',
		contexts: [
			{
				id: 'selection',
				kind: 'codeSelection',
				name: 'task.ts (6-9)',
				content: 'Unsaved code',
				resource: 'file:///project/task.ts#6,1-9,2',
				reference: { start: 8, end: 21 },
			},
		],
	};
	writeNewChatDraftState(fixture.storage, selected, 'selection');
	assert.deepEqual(readNewChatDraftState(fixture.storage, 'selection'), selected);
	fixture.storage.store(
		'sessions.inputDraft:selection',
		JSON.stringify({ ...selected, text: 'Explain other.ts (6-9)' }),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
	assert.throws(() => readNewChatDraftState(fixture.storage, 'selection'), /Invalid Agents Window context reference/);
});

test('malformed legacy drafts preserve their raw entries while valid drafts still migrate', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const malformed = '{unfinished';
	storage.store('sessions.draftState:broken', malformed, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store(
		'sessions.codeDraftState:valid',
		JSON.stringify(draft),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
	const errors: unknown[] = [];
	assert.deepEqual(
		migrateNewChatDraftState(storage, error => errors.push(error)),
		[],
	);
	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof SyntaxError);
	assert.equal(storage.get('sessions.draftState:broken', StorageScope.WORKSPACE), malformed);
	assert.equal(storage.get('sessions.codeDraftState:valid', StorageScope.WORKSPACE), undefined);
	assert.deepEqual(readNewChatDraftState(storage, 'valid'), draft);
});

test('a corrupt destination preserves both copies and does not block another draft', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const invalid = JSON.stringify({ ...draft, contexts: [{ ...draft.contexts[0], resource: 42 }] });
	storage.store('sessions.inputDraft:conflict', invalid, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.draftState:conflict', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.store('sessions.draftState:valid', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const errors: unknown[] = [];
	migrateNewChatDraftState(storage, error => errors.push(error));
	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof TypeError);
	assert.equal(storage.get('sessions.inputDraft:conflict', StorageScope.WORKSPACE), invalid);
	assert.equal(storage.get('sessions.draftState:conflict', StorageScope.WORKSPACE), JSON.stringify(draft));
	assert.deepEqual(readNewChatDraftState(storage, 'valid'), draft);
});

test('migration keeps a legacy entry when writing its replacement fails', () => {
	using fixture = createStorage();
	const storage = fixture.storage;
	const failure = new Error('Storage write failed');
	storage.store('sessions.draftState:source', JSON.stringify(draft), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const originalStore = storage.store;
	storage.store = () => {
		throw failure;
	};
	const errors: unknown[] = [];
	try {
		migrateNewChatDraftState(storage, error => errors.push(error));
	} finally {
		storage.store = originalStore;
	}
	assert.deepEqual(errors, [failure]);
	assert.equal(storage.get('sessions.draftState:source', StorageScope.WORKSPACE), JSON.stringify(draft));
	assert.equal(readNewChatDraftState(storage, 'source'), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../base/common/event.js';
import type { IStorageService } from '../../../platform/storage/common/storage.js';
import { createAgentSessionsModel } from '../../browser/agentSessionsModel.js';
import type { ISession } from '../../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import type { ISessionGroupsService } from '../../services/sessions/browser/sessionGroupsService.js';

test('The Chat session catalog shows current activity and restores its workspace when work finishes', () => {
	using changed = new Emitter<void>();
	const threadId = 'root';
	let session: ISession = {
		sessionId: 'session', providerId: 'provider', title: 'Review', status: 'active', nextApprovalMode: 'manual',
		workspace: { root: '/workspace', authorityId: 'local' },
		chats: [{ threadId, status: 'active', origin: { type: 'root' }, management: { status: 'working', statusChangedAtUnixMs: 0, activity: { type: 'operation', text: 'Reading files' } } }],
	};
	const opened: string[][] = [];
	const sessions = {
		onDidChange: changed.event, untitledSessions: [], state: 'ready',
		get sessions() { return [session]; },
		get active() { return { session, threadId }; },
		selectThread: (sessionId: string, threadId: string) => { opened.push([sessionId, threadId]); },
	} as unknown as ISessionsManagementService;
	const storage = { getBoolean: () => false, onDidChangeValue: Event.None } as unknown as IStorageService;
	const groups = { groups: [], onDidChange: Event.None } as unknown as ISessionGroupsService;
	const model = createAgentSessionsModel(sessions, storage, groups, () => []);
	let updates = 0;
	using listener = model.onDidChange(() => { updates++; });
	assert.equal(model.items[0]!.description, 'Reading files');
	model.items[0]!.open();
	assert.deepEqual(opened, [['session', 'root']]);
	session = { ...session, chats: [{ ...session.chats[0]!, management: { status: 'completed', statusChangedAtUnixMs: 1, activity: { type: 'operation', text: 'Old operation' } } }] };
	changed.fire();
	assert.equal(updates, 1);
	assert.equal(model.items[0]!.description, '/workspace');
});

import { Emitter, Event } from '../../../base/common/event.js';
import type { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { SessionGroupsService } from '../../services/sessions/browser/sessionGroupsService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();
test('session groups persist moves, validate complete ordering and retain tasks after deletion', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'groups', flushInterval: 0 });
		using groups = new SessionGroupsService(storage, { sessions: [], onDidChange: Event.None } as unknown as ISessionsManagementService);
		const first = await groups.create('Review');
		const second = await groups.create('Release');
		await groups.move('session-1', first.sectionId);
		await groups.move('session-2', first.sectionId);
		await assert.rejects(groups.reorder(first.sectionId, ['session-1', 'session-1']));
		await assert.rejects(groups.reorder(first.sectionId, ['session-1']));
		await groups.reorder(first.sectionId, ['session-2', 'session-1']);
		await groups.move('session-1', second.sectionId);
		assert.deepEqual(groups.groups.map(group => group.sessionIds), [['session-2'], ['session-1']]);
		using restored = new SessionGroupsService(storage, { sessions: [], onDidChange: Event.None } as unknown as ISessionsManagementService);
		assert.deepEqual(restored.groups, groups.groups);
		await restored.rename(second.sectionId, 'Ship');
		assert.equal(groups.groups[1].name, 'Ship');
		await restored.delete(first.sectionId);
		assert.equal(groups.groups.length, 1);
		await restored.move('session-1', null);
		assert.deepEqual(groups.groups[0].sessionIds, []);
		await assert.rejects(groups.move('session-1', 'unknown'));
		await assert.rejects(groups.create(' '));
	} finally { dom.window.close(); }
});

test('cancelled group writes leave saved state unchanged', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'cancelled-groups', flushInterval: 0 });
		using groups = new SessionGroupsService(storage, { sessions: [], onDidChange: Event.None } as unknown as ISessionsManagementService);
		const abort = new AbortController();
		const created = groups.create('Cancelled', abort.signal);
		abort.abort();
		await assert.rejects(created);
		assert.deepEqual(groups.groups, []);
		using restored = new SessionGroupsService(storage, { sessions: [], onDidChange: Event.None } as unknown as ISessionsManagementService);
		assert.deepEqual(restored.groups, []);
	} finally { dom.window.close(); }
});

test('archiving removes group membership and restoring permits reassignment', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using changed = new Emitter<void>();
		let sessions = [{ sessionId: 'session-1', status: 'active' }];
		const management = { get sessions() { return sessions; }, onDidChange: changed.event } as unknown as ISessionsManagementService;
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'archived-groups', flushInterval: 0 });
		using groups = new SessionGroupsService(storage, management);
		const group = await groups.create('Review');
		await groups.move('session-1', group.sectionId);
		sessions = [{ sessionId: 'session-1', status: 'archived' }];
		changed.fire();
		await groups.rename(group.sectionId, 'Review later');
		assert.deepEqual(groups.groups[0].sessionIds, []);
		await assert.rejects(groups.move('session-1', group.sectionId));
		sessions = [{ sessionId: 'session-1', status: 'active' }];
		changed.fire();
		await groups.move('session-1', group.sectionId);
		assert.deepEqual(groups.groups[0].sessionIds, ['session-1']);
	} finally { dom.window.close(); }
});

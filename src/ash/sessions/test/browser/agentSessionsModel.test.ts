import { ISessionsListModelService, SessionsListModelService } from '../../services/sessions/browser/sessionsListModelService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, type IStorageValueChangeEvent } from '../../../platform/storage/common/storage.js';
import { URI } from '../../../base/common/uri.js';
import { ChatHistoryModel } from '../../browser/chatHistoryModel.js';
import type { ISession } from '../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionGroupsService, type SessionGroup } from '../../services/sessions/browser/sessionGroupsService.js';

function fixture() {
	const resources = new DisposableStore();
	const changed = resources.add(new Emitter<void>());
	const storageChanged = resources.add(new Emitter<IStorageValueChangeEvent>());
	const groupChanged = resources.add(new Emitter<void>());
	const services = resources.add(new InstantiationService());
	let sessions: ISession[] = [{
		sessionId: 'session', providerId: 'provider', title: 'Review', status: 'active', nextApprovalMode: 'manual',
		workspace: { root: '/workspace', authorityId: 'local' },
		chats: [
			{ threadId: 'root', status: 'active', origin: { type: 'root' }, management: { status: 'working', statusChangedAtUnixMs: 0, activity: { type: 'operation', text: 'Reading files' } } },
			{ threadId: 'peer', title: 'Peer', status: 'active', updatedAt: new Date(123_000), origin: { type: 'fork', parentThreadId: 'root', parentSequence: 1 } },
		],
	}];
	let selected = 'root';
	let pinned = false;
	let groups: readonly SessionGroup[] = [];
	let refreshes = 0;
	const opened: string[][] = [];
	services.registerInstance(ISessionsManagementService, {
		onDidChange: changed.event, untitledSessions: [], state: 'ready', error: undefined,
		get sessions() { return sessions; },
		get active() { return { session: sessions[0]!, threadId: selected }; },
		selectThread: (sessionId: string, threadId: string) => { opened.push([sessionId, threadId]); selected = threadId; changed.fire(); },
		refresh: async () => { refreshes++; changed.fire(); },
	} as unknown as ISessionsManagementService);
	services.registerInstance(IStorageService, { getBoolean: () => pinned, onDidChangeValue: storageChanged.event } as unknown as IStorageService);
	services.registerSingleton(ISessionsListModelService, () => services.createInstance(SessionsListModelService));
	services.registerInstance(ISessionGroupsService, { get groups() { return groups; }, onDidChange: groupChanged.event } as ISessionGroupsService);
	services.registerInstance(ICommandService, { onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async () => { throw new Error('Unexpected mutation'); } });
	const catalog = services.createInstance(ChatHistoryModel);
	return Object.assign(resources, {
		catalog, opened,
		setSessions(value: ISession[]) { sessions = value; changed.fire(); },
		getRefreshes: () => refreshes,
		finish() { sessions = [{ ...sessions[0]!, chats: [{ ...sessions[0]!.chats[0]!, management: { status: 'completed', statusChangedAtUnixMs: 1 } }, sessions[0]!.chats[1]!] }]; changed.fire(); },
		pin() { pinned = true; storageChanged.fire({ scope: StorageScope.PROFILE, key: 'sessions.list.pinned.session', target: undefined, external: false }); },
		group() { groups = [{ sectionId: 'team', name: 'Team', sessionIds: ['session'] }]; groupChanged.fire(); },
		archive() { sessions = [{ ...sessions[0]!, status: 'archived' }]; changed.fire(); },
	});
}

suite('Shared Agent Sessions catalog', () => {
	test('list and history borrow one Session and its exact Thread targets', () => {
		using f = fixture();
		const model = f.catalog.model;
		assert.equal(model, f.catalog);
		const parent = model.sessions[0]!;
		assert.equal(parent.description, 'Reading files');
		assert.deepEqual(parent.children?.map(child => child.target), [{ sessionId: 'session', threadId: 'root' }, { sessionId: 'session', threadId: 'peer' }]);
		assert.equal(model.getSession(parent.resource)?.id, parent.id);
		const peer = parent.children![1]!;
		assert.equal(f.catalog.getSession(URI.parse(peer.resource.toString()))?.updatedAt, 123_000);
		assert.equal(peer.parentSession?.resource.toString(), parent.resource.toString());
		peer.open();
		model.sessions[0]!.open({ preserveFocus: true });
		assert.deepEqual(f.opened, [['session', 'peer'], ['session', 'peer']]);
		f.finish();
		assert.equal(model.sessions[0]!.description, '/workspace');
		assert.equal(f.catalog.getSession(URI.parse('unknown:/missing')), undefined);
	});

	test('same-title conversations expose distinct hosts and open the selected host identity', () => {
		using f = fixture();
		const remote = (host: string): ISession => ({
			sessionId: `${host}/session`, providerId: host, providerLabel: host, title: 'Review', status: 'active', nextApprovalMode: 'manual',
			workspace: { root: '/workspace', authorityId: host },
			chats: [{ threadId: `${host}/root`, status: 'active', origin: { type: 'root' } }],
		});
		f.setSessions([remote('Build A'), remote('Build B')]);
		const [a, b] = f.catalog.sessions;
		assert.equal(a?.label, b?.label);
		assert.equal(a?.description, 'Build A · /workspace');
		assert.equal(b?.description, 'Build B · /workspace');
		assert.equal(b?.providerLabel, 'Build B');
		f.catalog.getSession(b!.children![0]!.resource)?.open();
		assert.deepEqual(f.opened, [['Build B/session', 'Build B/root']]);
	});

	test('both consumers observe pinning, grouping, refresh and archive through the same owner', async () => {
		using f = fixture();
		let changes = 0;
		using listener = f.catalog.model.onDidChangeSessions(() => { changes++; });
		const resource = f.catalog.model.sessions[0]!.resource;
		f.pin();
		assert.equal(f.catalog.getSession(resource)?.isPinned(), true);
		f.group();
		assert.equal(f.catalog.getSession(resource)?.group?.sectionId, 'team');
		await f.catalog.model.refresh!();
		assert.equal(f.getRefreshes(), 1);
		f.archive();
		assert.equal(f.catalog.getSession(resource)?.isArchived(), true);
		assert.equal(f.catalog.getSession(resource)?.children, undefined);
		assert.equal(changes, 4);
	});
});

import { sessionIdentity } from '../../services/sessions/common/sessionIdentity.js';
import type { ISession } from '../../services/sessions/common/session.js';
import { SessionSectionOrderService } from '../../services/sessions/browser/sessionSectionOrderService.js';
import { SessionsListModelService } from '../../services/sessions/browser/sessionsListModelService.js';
import * as chatInputStatePersistence from '../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import type { IContextMenuDelegate } from '../../../base/browser/contextmenu.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import type { ISessionGroupsService } from '../../services/sessions/browser/sessionGroupsService.js';
import type { IProjectService } from '../../../platform/projects/common/projectService.js';
import type { ICommandService } from '../../../platform/commands/common/commands.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import { observableValue } from '../../../base/common/observable.js';
import type { ICustomViewService } from '../../services/customView/browser/customViewService.js';
import type { IMenuService } from '../../../platform/actions/common/actions.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, setNlsResolver, resetNlsResolver } from '../../../nls.js';
import { sessionManagementLabel } from '../../browser/sessionManagementLabels.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { computePullRequestIcon } from '../../../workbench/common/chatPullRequest.js';
import type { IResolvedSessionPullRequest } from '../../contrib/github/common/types.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../base/common/event.js';
import { DeferredPromise } from '../../../base/common/async.js';
import type { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { SessionsList } from '../../browser/parts/sidebar/sessionsList.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../../contrib/chat/common/newChatDraftState.js';


const listCustomViews = { activeCustomView: observableValue('testCustomView', undefined) } as unknown as ICustomViewService;
const listMenus = { createMenu: () => ({ getActions: () => [], onDidChange: Event.None, ...toDisposable(() => { }) }) } as unknown as IMenuService;
const listNotifications = { error: (error: unknown) => { throw error; } } as unknown as INotificationService;
const emptyGroups = { groups: [], onDidChange: Event.None } as unknown as ISessionGroupsService;
const emptyProjects = { onDidChange: Event.None, list: async () => [] } as unknown as IProjectService;
const listCommands = { executeCommand: async () => undefined } as unknown as ICommandService;
const listContextMenus = { showContextMenu() { } } as unknown as IContextMenuService;

test('SessionsList keeps session buttons and focus while refreshing', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	const opened: string[] = [];
	let untitledSessions = [
		{ untitledSessionId: 'first', title: 'First' },
		{ untitledSessionId: 'second', title: 'Second' },
	];
	for (const session of untitledSessions) {
		writeNewChatDraftState(storage, { mode: 'agent', text: session.title, contexts: [] }, `untitled:${session.untitledSessionId}`, chatInputStatePersistence);
	}
	const sessionService = {
		get untitledSessions() { return untitledSessions; },
		sessions: [],
		state: 'ready', onDidChange: changes.event,
		error: undefined,
	} as unknown as ISessionsManagementService;
	const viewService = {
		onDidChange: changes.event,
		activeSelection: undefined,
		get visibleSelections() { return untitledSessions.map(session => ({ kind: 'untitled', session })); },
		openNewSession() { },
		openUntitledSession(id: string) { opened.push(id); },
	} as unknown as ISessionsService;
	let menu: IContextMenuDelegate | undefined;
	const executed: unknown[][] = [];
	const contextMenus = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const commands = { executeCommand: async (...args: unknown[]) => { executed.push(args); } } as ICommandService;
	const list = new SessionsList(dom.window.document.body, 'Sessions', 'chat', sessionService, viewService, { onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } }, emptyGroups, storage, emptyProjects, commands, contextMenus, listCustomViews, listMenus, listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage));
	const buttons = [...list.domNode.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')];
	list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-actions button')!.click();
	const actions = menu!.getActions().filter(action => action.id !== 'ash.actions.separator');
	assert.equal(actions.length, 7);
	assert.ok(actions.every(action => action.enabled), 'Every new chat item exposes all actions before sending');
	for (const action of actions.slice(0, 5)) await action.run();
	assert.deepEqual(executed.map(args => args[1]), Array.from({ length: 5 }, () => ({ untitledSessionId: 'first' })));
	menu!.onHide?.(false);

	buttons[0].focus();
	untitledSessions = [
		{ untitledSessionId: 'first', title: 'Renamed' },
		{ untitledSessionId: 'second', title: 'Second' },
	];
	changes.fire();

	const refreshed = [...list.domNode.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')];
	assert.equal(refreshed[0], buttons[0]);
	assert.equal(refreshed[1], buttons[1]);
	assert.equal(dom.window.document.activeElement, buttons[0]);
	assert.equal(refreshed[0].textContent, 'Renamed (draft)');
	refreshed[0].click();
	assert.deepEqual(opened, ['first']);
	assert.equal(list.domNode.querySelector('input[type=search]'), null);

	untitledSessions = [untitledSessions[1]];
	changes.fire();
	assert.deepEqual([...list.domNode.querySelectorAll('.ash-sessions-list-item')], [buttons[1]]);
	buttons[0].click();
	assert.deepEqual(opened, ['first']);
	untitledSessions = [];
	changes.fire();
	list.focus();
	assert.equal(list.domNode.querySelector('.ash-sessions-list-section'), null);
	assert.equal(dom.window.document.activeElement, list.domNode);

	list.dispose();
	changes.dispose();
	dom.window.close();
});

for (const mode of ['chat', 'code'] as const) {
	for (const locale of ['en', 'zh-CN']) {
		test(`SessionsList hides empty drafts and retains content drafts in ${mode} in ${locale}`, () => {
			const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
			setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(locale === 'zh-CN' ? chinese.bundles[bundle]?.[key] ?? fallback : fallback, parameters));
			try {
				const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
				using domLifetime = toDisposable(() => dom.window.close());
				using changes = new Emitter<void>();
				using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'draft-list', flushInterval: 0 });
				const blank = { untitledSessionId: 'blank', title: '' };
				const attachment = { untitledSessionId: 'attachment', title: 'Attachment' };
				const corrupt = { untitledSessionId: 'corrupt', title: 'Unreadable' };
				let drafts = [blank, attachment, corrupt];
				const saved = { sessionId: 'saved', title: 'Saved conversation', status: 'active', chats: [{ threadId: 'root', origin: { type: 'root' }, status: 'active' }] };
				const management = { get untitledSessions() { return drafts; }, sessions: [saved], state: 'ready', onDidChange: changes.event } as unknown as ISessionsManagementService;
				const opened: string[] = [];
				const view = {
					onDidChange: changes.event,
					activeSelection: { kind: 'untitled', session: blank },
					visibleSelections: [{ kind: 'untitled', session: blank }],
					openUntitledSession(id: string) { opened.push(id); },
				} as unknown as ISessionsService;
				using list = new SessionsList(dom.window.document.body, 'Sessions', mode, management, view, { onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } }, emptyGroups, storage, emptyProjects, listCommands, listContextMenus, listCustomViews, listMenus, listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage));
				const rowIds = (): string[] => [...list.domNode.querySelectorAll<HTMLElement>('[data-item]')].map(row => row.dataset.item!);
				assert.deepEqual(rowIds(), ['session:saved']);
				writeNewChatDraftState(storage, { mode: 'agent', text: ' \n\t', contexts: [] }, 'untitled:blank', chatInputStatePersistence);
				assert.deepEqual(rowIds(), ['session:saved']);

				writeNewChatDraftState(storage, { mode: 'agent', text: 'Keep this draft', contexts: [] }, 'untitled:blank', chatInputStatePersistence);
				assert.deepEqual(rowIds(), ['untitled:blank', 'session:saved']);
				const button = list.domNode.querySelector<HTMLButtonElement>('[data-item="untitled:blank"] .ash-sessions-list-item')!;
				const label = locale === 'zh-CN' ? '新建会话（草稿）' : 'New Session (draft)';
				assert.equal(button.textContent, label);
				assert.equal(button.getAttribute('aria-label'), label);
				assert.equal(button.getAttribute('aria-current'), 'page');
				button.focus();
				writeNewChatDraftState(storage, { mode: 'agent', text: 'Keep this draft updated', contexts: [] }, 'untitled:blank', chatInputStatePersistence);
				assert.equal(dom.window.document.activeElement, button);
				assert.equal(list.domNode.querySelector('[data-item="untitled:blank"] .ash-sessions-list-item'), button);

				// The attachment-only draft is parked outside the visible arrangement.
				writeNewChatDraftState(storage, { mode: 'agent', text: '', contexts: [{ id: 'source', kind: 'file', name: 'source.txt', content: 'Synthetic attachment' }] }, 'untitled:attachment', chatInputStatePersistence);
				assert.deepEqual(rowIds(), ['untitled:blank', 'untitled:attachment', 'session:saved']);
				list.domNode.querySelector<HTMLButtonElement>('[data-item="untitled:attachment"] .ash-sessions-list-item')!.click();
				assert.deepEqual(opened, ['attachment']);
				storage.store('sessions.inputDraft:untitled:corrupt', 'invalid JSON', StorageScope.WORKSPACE, StorageTarget.MACHINE);
				assert.deepEqual(rowIds(), ['untitled:blank', 'untitled:attachment', 'session:saved']);

				writeNewChatDraftState(storage, undefined, 'untitled:blank', chatInputStatePersistence);
				assert.deepEqual(rowIds(), ['untitled:attachment', 'session:saved']);
				drafts = [blank, corrupt];
				changes.fire();
				assert.deepEqual(rowIds(), ['session:saved']);
				assert.equal(readNewChatDraftState(storage, 'untitled:attachment', chatInputStatePersistence)?.contexts[0]?.name, 'source.txt');
			} finally { resetNlsResolver(); }
		});
	}
}


test('SessionsList updates passive status without changing row identity or selection', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	const opened: string[] = [];
	const executed: unknown[][] = [];
	let menu: IContextMenuDelegate | undefined;
	const contextMenus = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const commands = {
		executeCommand: async (...args: unknown[]) => {
			executed.push(args);
			if (args[0] === 'sessions.list.togglePin') { storage.store('sessions.list.pinned.background', true, StorageScope.PROFILE, StorageTarget.USER); return 'background'; }
		}
	} as ICommandService;
	let session = {
		sessionId: 'background', title: 'Background session', status: 'active' as const, nextApprovalMode: 'manual' as const,
		chats: [{ threadId: 'root', origin: { type: 'root' as const }, status: 'active' as const }],
		management: { status: 'working', statusChangedAtUnixMs: 10 },
	};
	const sessionService = { get sessions() { return [session]; }, untitledSessions: [], state: 'ready', onDidChange: changes.event } as unknown as ISessionsManagementService;
	const viewService = { onDidChange: changes.event, activeSelection: undefined, visibleSelections: [], openSession(id: string) { opened.push(id); } } as unknown as ISessionsService;
	const request: IResolvedSessionPullRequest = { uri: URI.parse('https://github.com/fixture/repo/pull/7'), owner: 'fixture', repo: 'repo', number: 7, title: 'Synthetic PR', state: 'open', status: { hasFailingChecks: true }, icon: computePullRequestIcon('open', { hasFailingChecks: true }) };
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'chat', sessionService, viewService, { onDidChange: Event.None, getSessionPullRequests: () => [request], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } }, emptyGroups, storage, emptyProjects, commands, contextMenus, listCustomViews, listMenus, listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage));
	const button = list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-item')!;
	button.focus();
	const items = list.domNode.querySelector<HTMLDivElement>('.ash-sessions-list-items')!;
	items.scrollTop = 37;
	assert.equal(button.querySelector('.ash-sessions-list-management')?.textContent, 'Working');

	session = { ...session, management: { status: 'needsInput', statusChangedAtUnixMs: 20 } };
	changes.fire();
	assert.equal(list.domNode.querySelector('.ash-sessions-list-item'), button);
	assert.equal(button.querySelector('.ash-sessions-list-management')?.textContent, 'Needs input');
	assert.equal(button.getAttribute('aria-label'), 'Background session. Needs input. fixture/repo #7 · Synthetic PR · Open · Checks failed');
	assert.equal(button.querySelector('[data-ash-icon-id="git-pull-request-error"]')?.getAttribute('aria-hidden'), 'true');
	assert.equal(button.getAttribute('aria-current'), 'false');
	assert.equal(dom.window.document.activeElement, button);
	assert.equal(items.scrollTop, 37);
	assert.deepEqual(opened, []);
	const more = list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-actions button')!;
	assert.equal(more.getAttribute('aria-haspopup'), 'menu');
	more.click();
	assert.deepEqual(opened, [], 'opening More must not select the chat');
	assert.equal(more.getAttribute('aria-expanded'), 'true');
	const actions = menu!.getActions().filter(action => action.id !== 'ash.actions.separator');
	assert.deepEqual(actions.map(action => action.id), [
		'sessions.list.togglePin', 'agentSession.rename', 'agentSession.archive',
		'agentSession.addToProject', 'agentSession.moveToGroup', 'agentSession.delete', 'sessions.openInNewWindow',
	]);
	actions[1]!.run();
	assert.deepEqual(executed, [['agentSession.rename', 'background']]);
	menu!.onHide?.(true);
	assert.equal(more.getAttribute('aria-expanded'), 'false');
	button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	assert.equal(more.getAttribute('aria-expanded'), 'true');
	await menu!.getActions()[0]!.run();
	assert.ok(button.closest('[data-section="pinned"]'));
	assert.equal(dom.window.document.activeElement, button);
	menu!.onHide?.(false);
	list.dispose();
	dom.window.close();
});


for (const outcome of ['confirmed', 'cancelled', 'failed', 'disposed'] as const) test(`archive click feedback follows the completed operation (${outcome})`, async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'feedback', flushInterval: 0 });
	const pending = new DeferredPromise<unknown>();
	const animations: Array<{ cancelled: boolean; }> = [];
	Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', {
		value: () => {
			const animation = { cancelled: false, finished: new Promise(() => { }), cancel() { this.cancelled = true; } };
			animations.push(animation);
			return animation;
		}
	});
	let drafts = [{ untitledSessionId: 'feedback', title: 'Synthetic feedback' }];
	writeNewChatDraftState(storage, { mode: 'agent', text: 'Synthetic draft', contexts: [] }, 'untitled:feedback', chatInputStatePersistence);
	const sessions = { sessions: [], get untitledSessions() { return drafts; }, state: 'ready', onDidChange: changes.event } as unknown as ISessionsManagementService;
	const views = { onDidChange: changes.event, activeSelection: undefined, visibleSelections: [] } as unknown as ISessionsService;
	let menu: IContextMenuDelegate | undefined;
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'code', sessions, views,
		{ onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { }, invokePullRequestArtifact: async () => { } },
		emptyGroups, storage, emptyProjects, { executeCommand: () => pending.p } as unknown as ICommandService,
		{ showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService, listCustomViews, listMenus, listNotifications, new SessionsListModelService(storage), new SessionSectionOrderService(storage));
	const row = list.domNode.querySelector<HTMLElement>('.ash-sessions-list-row')!;
	Object.defineProperty(row, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(10, 48, 240, 28) });
	row.querySelector<HTMLButtonElement>('.ash-sessions-list-actions button')!.click();
	const run = Promise.resolve(menu!.getActions().find(action => action.id === 'agentSession.archive')!.run());
	assert.equal(dom.window.document.querySelector('.ash-click-confetti'), null, 'Pending confirmation produces no celebration');
	if (outcome === 'confirmed') {
		drafts = [];
		changes.fire();
		assert.equal(row.isConnected, false);
	}
	if (outcome === 'disposed') list.dispose();
	if (outcome === 'failed') {
		await pending.error(new Error('Synthetic archive failure'));
		await assert.rejects(run, /Synthetic archive failure/);
	} else {
		await pending.complete(outcome !== 'cancelled');
		await run;
	}
	const overlay = dom.window.document.querySelector<HTMLElement>('.ash-click-confetti');
	assert.equal(!!overlay, outcome === 'confirmed');
	if (overlay) assert.deepEqual([overlay.style.left, overlay.style.top], ['10px', '48px']);
	list.dispose();
	assert.equal(dom.window.document.querySelector('.ash-click-confetti'), null);
	assert.ok(animations.every(animation => animation.cancelled));
});

test('passive management labels use the installed Chinese catalog and retain unknown states', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const statuses = ['idle', 'needsInput', 'working', 'readyForReview', 'completed', 'failed', 'stopped'] as const;
		assert.deepEqual(statuses.map(status => sessionManagementLabel({ status, statusChangedAtUnixMs: 10 })), ['空闲', '需要回应', '进行中', '待审阅', '已完成', '失败', '已停止']);
		assert.equal(sessionManagementLabel(undefined), undefined);
	} finally { resetNlsResolver(); }
});

test('Sidebar keyboard menus move sections and durable rows independently across refresh and recreation', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);
	using changed = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	const catalog = ['one', 'two', 'three'].map(sessionId => ({
		sessionId, title: sessionId, status: 'active' as const, nextApprovalMode: 'manual' as const,
		chats: [{ threadId: 'root', status: 'active' as const, origin: { type: 'root' as const } }],
	}));
	let sessions = catalog;
	const management = { get sessions() { return sessions; }, untitledSessions: [], state: 'ready', onDidChange: changed.event } as unknown as ISessionsManagementService;
	const view = { onDidChange: Event.None } as unknown as ISessionsService;
	using groupsChanged = new Emitter<void>();
	let groupEntries = [
		{ sectionId: 'quality', name: 'Quality', sessionIds: ['one', 'two'] },
		{ sectionId: 'release', name: 'Release', sessionIds: ['three'] },
	];
	const groups = {
		get groups() { return groupEntries; },
		onDidChange: groupsChanged.event,
		async move(id: string, sectionId: string) {
			groupEntries = groupEntries.map(group => ({
				...group,
				sessionIds: [...group.sessionIds.filter(value => value !== id), ...(group.sectionId === sectionId ? [id] : [])],
			}));
			groupsChanged.fire();
		},
	} as unknown as ISessionGroupsService;
	const github = { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as import('../../contrib/github/browser/githubService.js').IGitHubService;
	let menu: IContextMenuDelegate | undefined;
	const context = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const makeList = (mode: 'chat' | 'code') => new SessionsList(dom.window.document.body, 'Sessions', mode, management, view,
		github, groups, storage, emptyProjects, listCommands, context, listCustomViews, listMenus, listNotifications,
		new SessionsListModelService(storage), new SessionSectionOrderService(storage));
	const sectionNames = (list: SessionsList) => Array.from(list.domNode.querySelectorAll('[data-section^="group:"] > h3'), heading => heading.textContent);
	const rows = (list: SessionsList) => Array.from(list.domNode.querySelectorAll('[data-section="group:quality"] [data-row-order-id]'), row => row.getAttribute('data-row-order-id'));
	const moveUp = async (button: HTMLButtonElement) => {
		button.focus();
		button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		const action = menu?.getActions().find(candidate => candidate.id === 'sessions.list.moveUp');
		assert.ok(action?.enabled);
		assert.equal(action.label, '上移');
		assert.equal(menu?.getActions().find(candidate => candidate.id === 'sessions.list.moveDown')?.label, '下移');
		await action.run();
		assert.equal(dom.window.document.activeElement, button);
		menu = undefined;
	};
	{
		using list = makeList('code');
		assert.deepEqual(sectionNames(list), ['Quality', 'Release']);
		await moveUp(list.domNode.querySelector<HTMLButtonElement>('[data-section="group:release"] > h3 button')!);
		await moveUp(list.domNode.querySelector<HTMLButtonElement>('[data-item="session:two"] button')!);
		assert.deepEqual(sectionNames(list), ['Release', 'Quality']);
		assert.deepEqual(rows(list), ['two', 'one']);
		const firstRow = list.domNode.querySelector<HTMLElement>('[data-row-order-id="two"]')!;
		const secondRow = list.domNode.querySelector<HTMLElement>('[data-row-order-id="one"]')!;
		firstRow.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }));
		secondRow.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true }));
		assert.deepEqual(rows(list), ['one', 'two']);
		await moveUp(list.domNode.querySelector<HTMLButtonElement>('[data-item="session:two"] button')!);
		sessions = catalog.filter(session => session.sessionId !== 'two');
		changed.fire();
		assert.deepEqual(rows(list), ['one']);
		sessions = catalog;
		changed.fire();
		assert.deepEqual(rows(list), ['two', 'one']);
	}
	using restored = makeList('code');
	assert.deepEqual(sectionNames(restored), ['Release', 'Quality']);
	assert.deepEqual(rows(restored), ['two', 'one']);
	using chat = makeList('chat');
	assert.deepEqual(sectionNames(chat), ['Quality', 'Release']);
	assert.deepEqual(rows(chat), ['one', 'two']);

	const listModel = new SessionsListModelService(storage);
	listModel.setSortMode('created');
	assert.deepEqual(rows(restored), ['one', 'two']);
	await moveUp(restored.domNode.querySelector<HTMLButtonElement>('[data-item="session:two"] button')!);
	assert.deepEqual(rows(restored), ['two', 'one']);
	listModel.moveSession('code:group:quality', ['two', 'one'], 'one', 'two');
	assert.deepEqual(rows(restored), ['one', 'two']);
	listModel.setSortMode('updated');
	assert.deepEqual(rows(restored), ['two', 'one']);
	const source = restored.domNode.querySelector<HTMLElement>('[data-row-order-id="two"]')!;
	const destination = restored.domNode.querySelector<HTMLElement>('[data-section="group:release"] > h3 button')!;
	source.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }));
	destination.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true }));
	await Promise.resolve();
	assert.deepEqual(rows(restored), ['one']);
	assert.equal(restored.domNode.querySelector('[data-section="group:release"] [data-row-order-id="two"]'), source);

});

test('The sidebar filters durable automation metadata and preserves the active session and same-ID sessions on other hosts', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'list', flushInterval: 0 });
	using selectionChanged = new Emitter<void>();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);

	const local = 'local-agent-host';
	const remote = 'remote-agent-host';
	const remoteId = sessionIdentity(remote, 'run', local);
	const makeSession = (sessionId: string): ISession => ({
		sessionId, title: sessionId, status: 'active', nextApprovalMode: 'manual',
		chats: [{ threadId: 'root', status: 'active', origin: { type: 'root' } }],
	});
	const manual = makeSession('manual');
	const automated: ISession = { ...makeSession(remoteId), source: 'automation' };
	const catalog = [manual, makeSession('run'), automated];
	const management = { sessions: catalog, untitledSessions: [], state: 'ready', onDidChange: Event.None } as unknown as ISessionsManagementService;
	let activeSelection: ISessionsService['activeSelection'];
	const view = { onDidChange: selectionChanged.event, get activeSelection() { return activeSelection; } } as unknown as ISessionsService;
	const github = { onDidChange: Event.None, getSessionPullRequests: () => [] } as unknown as import('../../contrib/github/browser/githubService.js').IGitHubService;
	let menu: IContextMenuDelegate | undefined;
	const context = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const makeList = (mode: 'chat' | 'code') => new SessionsList(dom.window.document.body, 'Sessions', mode, management, view,
		github, emptyGroups, storage, emptyProjects, listCommands, context, listCustomViews, listMenus, listNotifications,
		new SessionsListModelService(storage), new SessionSectionOrderService(storage));
	const rows = (list: SessionsList) => Array.from(list.domNode.querySelectorAll<HTMLElement>('[data-row-order-id]'), row => row.dataset.rowOrderId);
	const filter = (list: SessionsList) => {
		list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-more')!.click();
		const action = menu?.getActions().find(candidate => candidate.id === 'sessions.list.toggleAutomationSessions');
		assert.equal(action?.label, '显示自动化会话');
		return action!;
	};

	using code = makeList('code');
	assert.deepEqual(rows(code), ['manual', 'run']);
	assert.equal(filter(code).checked, false);
	await filter(code).run();
	assert.deepEqual(rows(code), ['manual', 'run', remoteId]);

	using chat = makeList('chat');
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);
	assert.equal(filter(chat).checked, true);
	activeSelection = { kind: 'session', active: { session: automated, threadId: 'root' } };
	selectionChanged.fire();
	await filter(chat).run();
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);
	activeSelection = undefined;
	selectionChanged.fire();
	assert.deepEqual(rows(code), ['manual', 'run']);
	assert.deepEqual(rows(chat), ['manual', 'run']);

	chat.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-more')!.click();
	await menu!.getActions().find(action => action.id === 'sessions.list.showAutomationSessionsAfterReply')!.run();
	assert.deepEqual(rows(chat), ['manual', 'run']);
	const listModel = new SessionsListModelService(storage);
	listModel.recordAutomationSessionReply(automated);
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);

	const automationRow = chat.domNode.querySelector<HTMLElement>(`[data-row-order-id="${remoteId}"]`)!;
	automationRow.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
	await menu!.getActions().find(action => action.id === 'sessions.list.overrideAutomationVisibility')!.run();
	assert.deepEqual(rows(chat), ['manual', 'run']);
	listModel.recordAutomationSessionReply(automated);
	assert.deepEqual(rows(chat), ['manual', 'run']);
	listModel.setAutomationSessionsMode('always');
	assert.deepEqual(rows(chat), ['manual', 'run']);
	listModel.setAutomationSessionOverride(automated, undefined);
	assert.deepEqual(rows(chat), ['manual', 'run', remoteId]);
});

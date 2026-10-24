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
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event } from "../../../base/common/event.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { SessionsList } from "../../browser/parts/sidebar/sessionsList.js";


const listCustomViews = { activeCustomView: observableValue('testCustomView', undefined) } as unknown as ICustomViewService;
const listMenus = { createMenu: () => ({ getActions: () => [], onDidChange: Event.None, ...toDisposable(() => { }) }) } as unknown as IMenuService;
const listNotifications = { error: (error: unknown) => { throw error; } } as unknown as INotificationService;
const emptyGroups = { groups: [], onDidChange: Event.None } as unknown as ISessionGroupsService;
const emptyProjects = { onDidChange: Event.None, list: async () => [] } as unknown as IProjectService;
const listCommands = { executeCommand: async () => undefined } as unknown as ICommandService;
const listContextMenus = { showContextMenu() { } } as unknown as IContextMenuService;

test("SessionsList keeps session buttons and focus while refreshing", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: "list", flushInterval: 0 });
	const opened: string[] = [];
	let untitledSessions = [
		{ untitledSessionId: "first", title: "First" },
		{ untitledSessionId: "second", title: "Second" },
	];
	const sessionService = {
		get untitledSessions() { return untitledSessions; },
		sessions: [],
		state: "ready", onDidChange: changes.event,
		error: undefined,
	} as unknown as ISessionsManagementService;
	const viewService = {
		onDidChange: changes.event,
		activeSelection: undefined,
		get visibleSelections() { return untitledSessions.map(session => ({ kind: "untitled", session })); },
		openNewSession() { },
		openUntitledSession(id: string) { opened.push(id); },
	} as unknown as ISessionsService;
	let menu: IContextMenuDelegate | undefined;
	const executed: unknown[][] = [];
	const contextMenus = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as IContextMenuService;
	const commands = { executeCommand: async (...args: unknown[]) => { executed.push(args); } } as ICommandService;
	const list = new SessionsList(dom.window.document.body, "Sessions", "chat", sessionService, viewService, { onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { } }, emptyGroups, storage, emptyProjects, commands, contextMenus, listCustomViews, listMenus, listNotifications);
	const buttons = [...list.domNode.querySelectorAll<HTMLButtonElement>(".ash-sessions-list-item")];
	list.domNode.querySelector<HTMLButtonElement>('.ash-sessions-list-actions button')!.click();
	const actions = menu!.getActions().filter(action => action.id !== 'ash.actions.separator');
	assert.equal(actions.length, 7);
	assert.ok(actions.every(action => action.enabled), 'Every new chat item exposes all actions before sending');
	for (const action of actions.slice(0, 5)) await action.run();
	assert.deepEqual(executed.map(args => args[1]), Array.from({ length: 5 }, () => ({ untitledSessionId: 'first' })));
	menu!.onHide?.(false);

	buttons[0].focus();
	untitledSessions = [
		{ untitledSessionId: "first", title: "Renamed" },
		{ untitledSessionId: "second", title: "Second" },
	];
	changes.fire();

	const refreshed = [...list.domNode.querySelectorAll<HTMLButtonElement>(".ash-sessions-list-item")];
	assert.equal(refreshed[0], buttons[0]);
	assert.equal(refreshed[1], buttons[1]);
	assert.equal(dom.window.document.activeElement, buttons[0]);
	assert.equal(refreshed[0].textContent, "Renamed");
	refreshed[0].click();
	assert.deepEqual(opened, ["first"]);
	assert.equal(list.domNode.querySelector('input[type=search]'), null);

	untitledSessions = [untitledSessions[1]];
	changes.fire();
	assert.deepEqual([...list.domNode.querySelectorAll(".ash-sessions-list-item")], [buttons[1]]);
	buttons[0].click();
	assert.deepEqual(opened, ["first"]);
	untitledSessions = [];
	changes.fire();
	list.focus();
	assert.equal(list.domNode.querySelector('.ash-sessions-list-section'), null);
	assert.equal(dom.window.document.activeElement, list.domNode);

	list.dispose();
	changes.dispose();
	dom.window.close();
});


test('SessionsList updates passive status without changing row identity or selection', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using domLifetime = toDisposable(() => dom.window.close());
	using changes = new Emitter<void>();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: "list", flushInterval: 0 });
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
	using list = new SessionsList(dom.window.document.body, 'Sessions', 'chat', sessionService, viewService, { onDidChange: Event.None, getSessionPullRequests: () => [request], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { } }, emptyGroups, storage, emptyProjects, commands, contextMenus, listCustomViews, listMenus, listNotifications);
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


test('passive management labels use the installed Chinese catalog and retain unknown states', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const statuses = ['idle', 'needsInput', 'working', 'readyForReview', 'completed', 'failed', 'stopped'] as const;
		assert.deepEqual(statuses.map(status => sessionManagementLabel({ status, statusChangedAtUnixMs: 10 })), ['空闲', '需要回应', '进行中', '待审阅', '已完成', '失败', '已停止']);
		assert.equal(sessionManagementLabel(undefined), undefined);
	} finally { resetNlsResolver(); }
});

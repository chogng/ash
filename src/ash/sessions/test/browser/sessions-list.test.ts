import { builtinLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
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

test("SessionsList keeps session buttons and focus while refreshing", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const changes = new Emitter<void>();
	const opened: string[] = [];
	let untitledSessions = [
		{ untitledSessionId: "first", title: "First" },
		{ untitledSessionId: "second", title: "Second" },
	];
	const sessionService = {
		get untitledSessions() { return untitledSessions; },
		sessions: [],
		state: "ready",
		error: undefined,
	} as unknown as ISessionsManagementService;
	const viewService = {
		onDidChange: changes.event,
		activeSelection: undefined,
		get visibleSelections() { return untitledSessions.map(session => ({ kind: "untitled", session })); },
		openNewSession() { },
		openUntitledSession(id: string) { opened.push(id); },
	} as unknown as ISessionsService;
	const list = new SessionsList(dom.window.document.body, sessionService, viewService, "Sessions", "New Session", { onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { } });
	const buttons = [...list.domNode.querySelectorAll<HTMLButtonElement>(".ash-sessions-list-item")];
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
	const search = list.domNode.querySelector<HTMLInputElement>('input[type="search"]')!;
	search.value = 'second';
	search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.deepEqual([...list.domNode.querySelectorAll('.ash-sessions-list-item')], [buttons[1]]);
	search.value = 'missing';
	search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.equal(list.domNode.querySelector('.ash-sessions-empty')?.textContent, 'No matching sessions');
	search.value = '';
	search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

	untitledSessions = [untitledSessions[1]];
	changes.fire();
	assert.deepEqual([...list.domNode.querySelectorAll(".ash-sessions-list-item")], [buttons[1]]);
	buttons[0].click();
	assert.deepEqual(opened, ["first"]);

	list.dispose();
	changes.dispose();
	dom.window.close();
});


test('SessionsList updates passive status without changing row identity or selection', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using domLifetime = toDisposable(() => dom.window.close());
	using changes = new Emitter<void>();
	const opened: string[] = [];
	let session = {
		sessionId: 'background', title: 'Background session', status: 'active' as const, nextApprovalMode: 'manual' as const,
		chats: [{ threadId: 'root', origin: { type: 'root' as const }, status: 'active' as const }],
		management: { status: 'working', statusChangedAtUnixMs: 10 },
	};
	const sessionService = { get sessions() { return [session]; }, untitledSessions: [], state: 'ready' } as unknown as ISessionsManagementService;
	const viewService = { onDidChange: changes.event, activeSelection: undefined, visibleSelections: [], openSession(id: string) { opened.push(id); } } as unknown as ISessionsService;
	const request: IResolvedSessionPullRequest = { uri: URI.parse('https://github.com/fixture/repo/pull/7'), owner: 'fixture', repo: 'repo', number: 7, title: 'Synthetic PR', state: 'open', status: { hasFailingChecks: true }, icon: computePullRequestIcon('open', { hasFailingChecks: true }) };
	using list = new SessionsList(dom.window.document.body, sessionService, viewService, 'Sessions', 'New Session', { onDidChange: Event.None, getSessionPullRequests: () => [request], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { } });
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
	assert.equal(button.querySelector('svg[data-ash-icon-id="git-pull-request-error"]')?.getAttribute('aria-hidden'), 'true');
	assert.equal(button.getAttribute('aria-current'), 'false');
	assert.equal(dom.window.document.activeElement, button);
	assert.equal(items.scrollTop, 37);
	assert.deepEqual(opened, []);
	list.dispose();
	dom.window.close();
});


test('passive management labels use the installed Chinese catalog and retain unknown states', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const statuses = ['idle', 'needsInput', 'working', 'readyForReview', 'completed', 'failed', 'stopped'] as const;
		assert.deepEqual(statuses.map(status => sessionManagementLabel({ status, statusChangedAtUnixMs: 10 })), ['空闲', '需要回应', '进行中', '待审阅', '已完成', '失败', '已停止']);
		assert.equal(sessionManagementLabel(undefined), undefined);
	} finally { resetNlsResolver(); }
});

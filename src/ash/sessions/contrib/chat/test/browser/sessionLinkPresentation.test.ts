import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { HoverContent } from '../../../../../base/browser/ui/hover/hover.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ILinkPresentationService } from '../../../../../platform/dataChannel/common/dataChannel.js';
import { IHoverService, type HoverSetupOptions } from '../../../../../platform/hover/browser/hoverService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { ISessionSummaryHoverService, SessionSummaryHoverService } from '../../../../../workbench/contrib/chat/browser/agentSessions/sessionSummaryHoverService.js';
import { ChatMarkdownDecorationsRenderer } from '../../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownDecorationsRenderer.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { ThreadChangesSummary } from '../../../../../workbench/services/chat/common/chatService.js';
import { computePullRequestIcon } from '../../../../../workbench/common/chatPullRequest.js';
import { LinkPresentationService } from '../../../../../workbench/services/dataChannel/browser/dataChannelService.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { sessionIdentity, sessionProviderAuthority } from '../../../../services/sessions/common/sessionIdentity.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IGitHubService } from '../../../github/browser/githubService.js';
import type { IResolvedSessionPullRequest } from '../../../github/common/types.js';
import '../../browser/chat.contribution.js';

test('Conversation link previews follow the matching host catalog for the contribution lifetime', async () => {
	const dom = new JSDOM('<!doctype html><body><a>Original link</a></body>');
	using domLifetime = toDisposable(() => dom.window.close());
	using changes = new Emitter<void>();
	using pullRequestsChanged = new Emitter<void>();
	using services = new InstantiationService();
	using contexts = new ContextKeyService();
	using links = new LinkPresentationService(contexts);
	services.registerSingleton(ISessionSummaryHoverService, () => services.createInstance(SessionSummaryHoverService));
	using configuration = new InMemoryConfigurationService();
	let hoverContent: HoverContent;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IHoverService, {
		setupHover({ content }: HoverSetupOptions) {
			hoverContent = content;
			return Object.assign(toDisposable(() => { hoverContent = undefined; }), {
				visible: false, show() { }, hide() { }, update(content: HoverContent) { hoverContent = content; },
			});
		},
	} as IHoverService);
	const providerId = 'remote';
	const identity = (id: string) => sessionIdentity(providerId, id, LOCAL_AGENT_HOST_PROVIDER_ID);
	const reads: unknown[][] = [];
	const statistics = { files: 2, additions: 4, deletions: 1 };
	const summary: ThreadChangesSummary = { sequence: 1, revision: 'rev', statistics, repositories: [], warnings: [] };
	const worktreeSummary = { ...summary, worktreePath: '/managed/thread-checkout' };
	let changesResult = Promise.resolve(summary);
	const scope = {
		assertCurrent() { },
		backendIdentity: (id: string) => id === identity('same') ? 'same' : 'root',
		services: {
			host: {
				localGit: {
					readRepositoryContexts: async (directory: unknown) => {
						reads.push(['git', directory]);
						return [{ rootPath: '/project', head: { type: 'branch', name: 'topic' } }];
					}
				}
			},
			chat: {
				readThreadChanges: async (sessionId: string, threadId: string) => {
					reads.push(['changes', sessionId, threadId]);
					return changesResult;
				}
			},
		},
	} as unknown as ISessionProviderScope;
	let pullRequests: readonly IResolvedSessionPullRequest[] = [];
	services.registerInstance(ISessionProviderScopeService, {
		getScope: sessionId => {
			assert.equal(sessionId, identity('same'));
			return scope;
		}
	} as ISessionProviderScopeService);
	services.registerInstance(IGitHubService, {
		onDidChange: pullRequestsChanged.event,
		getSessionPullRequests: sessionId => { assert.equal(sessionId, identity('same')); return pullRequests; },
	} as IGitHubService);
	let sessions: readonly ISession[] = [{
		providerId, sessionId: identity('same'), kind: 'code' as const, title: 'Remote session', status: 'active', nextApprovalMode: 'manual',
		chats: [{ threadId: identity('root'), origin: { type: 'root' }, status: 'active', title: 'Remote chat' }],
	}];
	services.registerInstance(ILinkPresentationService, links);
	services.registerInstance(IOpenerService, { registerOpener: () => toDisposable(() => { }) } as unknown as IOpenerService);
	services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
	services.registerInstance(ISessionsManagementService, { get sessions() { return sessions; }, onDidChange: changes.event } as ISessionsManagementService);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.openSessionLinkOpener']);
	host.advance(WorkbenchPhase.BlockRestore);

	const resource = buildOpenSessionLinkUri('same', 'root', sessionProviderAuthority(providerId, LOCAL_AGENT_HOST_PROVIDER_ID));
	const document = dom.window.document;
	const anchor = document.querySelector('a')!;
	anchor.href = resource.toString();
	using decorations = services.createInstance(ChatMarkdownDecorationsRenderer, document.body);
	const rule = links.getLinkPresentationRule(resource)!;
	using remote = links.createLinkPresentationWatcher(rule.id, resource)!;
	using local = links.createLinkPresentationWatcher(rule.id, buildOpenSessionLinkUri('same', 'root', 'local'))!;
	assert.equal(remote.presentation.get()?.title, 'Remote chat');
	assert.equal(local.presentation.get(), undefined);
	const readCard = (token: CancellationToken): HTMLElement => {
		assert.ok(typeof hoverContent === 'function');
		const node = hoverContent(token);
		assert.ok(node && typeof node !== 'string');
		return node;
	};
	const waitForDetails = (card: HTMLElement): Promise<void> => new Promise(resolve => {
		const observer = new dom.window.MutationObserver(() => { observer.disconnect(); resolve(); });
		observer.observe(card, { childList: true });
	});
	assert.equal(anchor.textContent, 'Remote chat');
	assert.deepEqual(reads, []);
	assert.equal(pullRequestsChanged.hasListeners(), false);
	using cancelled = new CancellationTokenSource();
	const titleOnly = readCard(cancelled.token);
	assert.equal(titleOnly.className, 'ash-session-summary-hover');
	assert.deepEqual([...titleOnly.children].map(row => row.textContent), ['Remote chat']);
	cancelled.cancel();
	assert.equal(pullRequestsChanged.hasListeners(), false);
	reads.length = 0;

	sessions = [{ ...sessions[0]!, workspace: { authorityId: 'remote', root: '/project' }, providerLabel: 'Remote provider' }];
	changesResult = Promise.resolve(worktreeSummary);
	changes.fire();
	using open = new CancellationTokenSource();
	const card = readCard(open.token);
	assert.deepEqual([...card.children].map(row => row.textContent), [
		'Remote chat', 'Project folder: /project', 'Provider: Remote provider',
	]);
	assert.deepEqual(reads, [['git', { sessionId: 'same', path: '/project' }], ['changes', 'same', 'root']]);
	const session = sessions[0]!;
	sessions = [{ ...session, chats: [{ ...session.chats[0]!, workspace: { authorityId: 'remote', root: worktreeSummary.worktreePath } }] }];
	changes.fire();
	assert.equal(card.children[1]?.textContent, 'Project folder: /project');
	assert.deepEqual(reads.slice(-2), [['git', { sessionId: 'same', path: worktreeSummary.worktreePath }], ['changes', 'same', 'root']]);

	pullRequests = [{
		uri: URI.parse('https://github.com/team/repo/pull/7'), owner: 'team', repo: 'repo', number: 7,
		title: 'Review', state: 'open', status: {}, icon: computePullRequestIcon('open', {})
	}];
	pullRequestsChanged.fire();
	assert.equal(card.children[3]?.textContent, 'team/repo #7 · Review · Open');
	await waitForDetails(card);
	assert.deepEqual([...card.children].map(row => row.textContent), [
		'Remote chat', 'Project folder: /project', 'Provider: Remote provider', 'team/repo #7 · Review · Open',
		'Worktree: /managed/thread-checkout', 'Branch: topic', 'Changed files: 2 (+4 / −1)',
	]);
	assert.equal(titleOnly.children.length, 1);
	open.cancel();
	assert.equal(pullRequestsChanged.hasListeners(), false);

	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using locale = toDisposable(resetNlsResolver);
	const delayed = new DeferredPromise<ThreadChangesSummary>();
	changesResult = delayed.p;
	using closed = new CancellationTokenSource();
	const closedCard = readCard(closed.token);
	closed.cancel();
	using reopened = new CancellationTokenSource();
	const localized = readCard(reopened.token);
	const localizedDetails = waitForDetails(localized);
	await delayed.complete(worktreeSummary);
	await localizedDetails;
	assert.deepEqual([...localized.children].slice(-3).map(row => row.textContent), ['工作树：/managed/thread-checkout', '分支：topic', '更改的文件：2（+4 / −1）']);
	assert.equal(closedCard.children.length, 4);
	reopened.cancel();
	changesResult = Promise.resolve(summary);
	using noWorktree = new CancellationTokenSource();
	const unbound = readCard(noWorktree.token);
	await waitForDetails(unbound);
	assert.doesNotMatch(unbound.textContent ?? '', /工作树|managed\/thread-checkout/u);

	sessions = [];
	changes.fire();
	assert.equal(remote.presentation.get(), undefined);
	assert.equal(hoverContent, undefined);
	assert.equal(anchor.textContent, 'Original link');
	host.dispose();
	assert.equal(links.getLinkPresentationRule(resource), undefined);
	assert.equal(changes.hasListeners(), false);
	assert.equal(pullRequestsChanged.hasListeners(), false);
});

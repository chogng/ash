import { ChecksOperationService } from '../../../../changes/browser/checksOperationService.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { IChecksOperationService } from '../../../../changes/common/checksOperationService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ChecksWidget } from '../../../../changes/browser/checksWidget.js';
import { IChangesViewService } from '../../../../changes/common/changesViewService.js';
import { IChatService, type StartTurnOptions } from '../../../../../../workbench/services/chat/common/chatService.js';
import { IGitHubService as IGitHubApi } from '../../../../../../platform/github/common/githubService.js';
import { IGitHubService as ISessionGitHubService } from '../../../browser/githubService.js';
import { createDisconnectedRendererApi } from '../../../../../../workbench/browser/rendererApi.js';
import type { IRendererHost } from '../../../../../../platform/renderer/common/rendererHost.js';
import type { ISessionProviderScope, ISessionProviderScopeService, SessionProviderServices } from '../../../../../browser/agentHost/sessionProviderScopeService.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import type { ICustomViewService } from '../../../../../services/customView/browser/customViewService.js';
import type { IMenuService } from '../../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, type ICommandService } from '../../../../../../platform/commands/common/commands.js';
import type { ISCMService } from '../../../../../../workbench/contrib/scm/common/scm.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { setNlsMessages } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { AppServerProtocolClient } from '../../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../../../../platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../../../../platform/agentHost/test/common/testAppServerProtocol.js';
import { AppServerGitHubService } from '../../../../../../platform/github/browser/appServerGitHubService.js';
import { IAccountService, type AccountState } from '../../../../../../platform/accounts/common/accountService.js';
import { ConsoleLogger } from '../../../../../../platform/log/common/log.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme, highContrastDarkColorTheme, lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';

import { ISessionsService, type SessionsViewSelection } from '../../../../../services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../../../../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../../../../services/sessions/common/session.js';
import { GitHubService } from '../../../browser/githubService.js';
import { SessionChatInputToolbar } from '../../../../chat/browser/sessionChatInputToolbar.js';
import { SessionsList } from '../../../../../browser/parts/sidebar/sessionsList.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { GitHubPullRequestReference, GitHubIssueReference } from '../../../../../../platform/github/common/githubService.js';


const listCustomViews = { activeCustomView: observableValue('testCustomView', undefined) } as unknown as ICustomViewService;
const listMenus = { createMenu: () => ({ getActions: () => [], onDidChange: Event.None, ...toDisposable(() => { }) }) } as unknown as IMenuService;
const listNotifications = { error: (error: unknown) => { throw error; } } as unknown as INotificationService;
interface Request { readonly id: number; readonly method: string; readonly params: Record<string, unknown>; }
type State = 'open' | 'draft' | 'closed' | 'merged';

class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	public readonly requests: Request[] = [];
	public readonly states = new Map<number, State>([[7, 'open'], [8, 'draft']]);
	public readonly issueStates = new Map<number, { state: string; stateReason?: string; }>([[11, { state: 'open' }], [12, { state: 'closed', stateReason: 'completed' }]]);
	private issueReferences: GitHubIssueReference[] = JSON.parse(sessionStorage.getItem('test-backend-issue-references') ?? '[]');
	public failingChecks = false;
	public unresolvedComments = false;
	public mergeable: boolean | null = null;
	public signedIn = true;
	private references: GitHubPullRequestReference[] = JSON.parse(sessionStorage.getItem('test-backend-pr-references') ?? '[]');
	public on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
		listeners.add(listener);
	}
	public off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(payload); } }
	private reply(request: Request, result: unknown): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }); }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'sessions-pr-test', workspaceRoot: '/workspace' });
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as Request;
		this.requests.push(request);
		const repository = request.params.repository as { name: string; } | undefined;
		const number = repository?.name === 'two' ? 8 : 7;
		const state = this.states.get(number)!;
		const pr = { number, title: `Changes in ${repository?.name}`, body: '', url: `https://github.com/team/${repository?.name}/pull/${number}`, state: state === 'closed' || state === 'merged' ? 'closed' : 'open', draft: state === 'draft', mergedAt: state === 'merged' ? '2026-10-06' : null, mergeable: this.mergeable, headCommit: String(number).repeat(40), headBranch: 'feature', headRepository: `team/${repository?.name}`, baseBranch: 'main', autoMerge: false };
		switch (request.method) {
			case 'github/session/pullRequests': this.reply(request, { references: this.references }); break;
			case 'github/session/pullRequest/attach': {
				const reference = request.params.reference as GitHubPullRequestReference;
				if (!this.references.some(item => JSON.stringify(item) === JSON.stringify(reference))) { this.references.push(reference); }
				this.persistReferences(request);
				break;
			}
			case 'github/session/pullRequest/detach': {
				const reference = request.params.reference as GitHubPullRequestReference;
				this.references = this.references.filter(item => JSON.stringify(item) !== JSON.stringify(reference));
				this.persistReferences(request);
				break;
			}
			case 'github/session/issues': this.reply(request, { references: this.issueReferences }); break;
			case 'github/session/issue/attach': {
				const reference = request.params.reference as GitHubIssueReference;
				if (!this.issueReferences.some(item => JSON.stringify(item) === JSON.stringify(reference))) { this.issueReferences.push(reference); }
				this.persistIssues(request);
				break;
			}
			case 'github/session/issue/detach': {
				const reference = request.params.reference as GitHubIssueReference;
				this.issueReferences = this.issueReferences.filter(item => JSON.stringify(item) !== JSON.stringify(reference));
				this.persistIssues(request);
				break;
			}
			case 'github/issue/read': {
				const number = Number(request.params.number);
				const state = this.issueStates.get(number);
				if (!state) {
					this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32070, message: 'GitHubNotFound', data: { kind: 'GitHubNotFound' } } }) });
				} else {
					this.reply(request, { issue: { number, url: `https://github.com/team/one/issues/${number}`, title: `Issue ${number} ${'long title '.repeat(12)}`, ...state, updatedAt: '2026-10-08', labels: [], assignees: [] }, body: '', comments: [] });
				}
				break;
			}
			case 'initialize': this.reply(request, createTestInitializeResult()); break;
			case 'github/account/list': this.reply(request, { accounts: this.signedIn ? [{ id: 'account', host: 'github.com', login: 'User', status: 'ready', credentialRevision: '1' }] : [] }); break;
			case 'github/pullRequest/list': this.reply(request, { pullRequests: request.params.state === pr.state ? [pr] : [], nextPage: null }); break;
			case 'github/pullRequest/read': this.reply(request, pr); break;
			case 'github/check/details': this.reply(request, { title: 'Build failure', summary: 'Compiler error', text: '<script>untrusted output</script>', annotations: [{ path: 'src/main.rs', startLine: 3, endLine: 4, annotationLevel: 'failure', message: `Error page ${request.params.page}`, title: null }], nextPage: request.params.page === 1 ? 2 : null, actionsJob: true }); break;
			case 'github/check/log': this.reply(request, { url: 'https://productionresults.blob.core.windows.net/logs?sig=fixture' }); break;
			case 'github/check/rerun': this.reply(request, null); break;
			case 'github/checks': this.reply(request, { state: 'pending', statuses: [], checks: Number(request.params.page) === 1 ? [{ id: 1, name: 'waiting', status: 'in_progress', conclusion: null, detailsUrl: null }] : [{ id: 2, name: 'build', status: 'completed', conclusion: this.failingChecks ? 'failure' : 'success', detailsUrl: null }], nextPage: Number(request.params.page) === 1 ? 2 : null }); break;
			case 'github/pullRequest/threads': this.reply(request, { threads: request.params.cursor === null ? [] : [{ id: 'review-thread', path: 'file.ts', line: null, side: 'RIGHT', resolved: !this.unresolvedComments, outdated: false, canResolve: true, comments: { comments: [], nextCursor: null } }], nextCursor: request.params.cursor === null ? 'second' : null }); break;
			case 'github/cancel': this.reply(request, {}); break;
			default: throw new Error(`Unexpected session PR request: ${request.method}`);
		}
	}
	public changeIssue(number: number, state: string, stateReason?: string): void {
		if (state === 'unavailable') { this.issueStates.delete(number); }
		else { this.issueStates.set(number, { state, stateReason }); }
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'session/changed', params: { sessionId: 'session', agentTreeChanged: false } }) });
	}
	private persistIssues(request: Request): void {
		sessionStorage.setItem('test-backend-issue-references', JSON.stringify(this.issueReferences));
		this.reply(request, null);
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'session/changed', params: { sessionId: request.params.sessionId, agentTreeChanged: false } }) });
	}
	private persistReferences(request: Request): void {
		sessionStorage.setItem('test-backend-pr-references', JSON.stringify(this.references));
		this.reply(request, null);
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'session/changed', params: { sessionId: request.params.sessionId, agentTreeChanged: false } }) });
	}
}

const resources = new DisposableStore();
resources.add(setARIAContainer(document.body));
if (new URL(location.href).searchParams.get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}
const transport = new Transport();
const client = new AppServerProtocolClient(transport);
resources.add(toDisposable(() => client.dispose()));
await client.connect();
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const selected = resources.add(new Emitter<void>());
const statusChanged = resources.add(new Emitter<ReturnType<typeof gitStatus>>());
const accountsChanged = resources.add(new Emitter<AccountState>());
const session: ISession = { sessionId: 'session', title: 'Implement PR integration', status: 'active', workspace: new URL(location.href).searchParams.has('noWorkspace') ? null : { authorityId: 'local', root: '/workspace' }, nextApprovalMode: 'manual', chats: [{ threadId: 'thread', origin: { type: 'root' }, status: 'active' }] };
let selection: SessionsViewSelection | undefined = { kind: 'session', active: { session, threadId: 'thread' } };
let branch = 'feature';
const gitStatus = (id: string) => ({ repositoryId: id, streamInstanceId: 'stream', historyRevision: 1, revision: 1, workspacePath: '/workspace', head: { type: 'branch' as const, name: branch, objectId: 'a'.repeat(40), upstream: undefined }, changes: [] });
const git = {
	repositories: ['one', 'two'].map(id => ({ id, label: id, path: id, root: URI.file(`/workspace/${id}`) })),
	onDidChangeRepositories: Event.None, onDidChangeRepositoryStatus: statusChanged.event,
	status: async (id: string) => gitStatus(id),
	graph: async (_query: unknown, id: string) => ({ commits: [], references: [], remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: id } }], hasMore: false, nextCursor: undefined }),
};
const management = { sessions: [session], state: 'ready' } as unknown as ISessionsManagementService;
const sessions = { get activeSelection() { return selection; }, get visibleSelections() { return selection ? [selection] : []; }, onDidChange: selected.event, openSession: () => { }, openNewSession: () => { } } as unknown as ISessionsService;
resources.add(CommandsRegistry.register('git.getRepositoryContexts', () => undefined));
const repositoryCommands = { executeCommand: async () => Promise.all(git.repositories.map(async repository => ({ ...repository, root: repository.root.toString(), head: (await git.status(repository.id)).head, remotes: (await git.graph({ limit: 1 }, repository.id)).remotes }))) } as unknown as ICommandService;
const scm = { onDidAddRepository: Event.None, onDidRemoveRepository: Event.None, repositories: git.repositories.map(repository => ({ provider: { id: repository.id, onDidChangeResources: (listener: () => void) => statusChanged.event(() => listener()) } })) } as unknown as ISCMService;
const baseHost = createDisconnectedRendererApi();
const hostEvents = resources.add(new Emitter<Parameters<Parameters<IRendererHost['events']['subscribe']>[0]>[0]>());
resources.add(accountsChanged.event(() => hostEvents.fire({ method: 'account/updated', params: {} } as never)));
const host: IRendererHost = {
	...baseHost, github: new AppServerGitHubService(client), events: { subscribe: hostEvents.event },
	appServer: { ...baseHost.appServer, getConnectionState: async () => 'ready', onConnectionState: listener => client.onStateChange(listener) },
	localGit: {
		...baseHost.localGit, readRepositoryContexts: async () => Promise.all(git.repositories.map(async repository => ({
			id: repository.id, label: repository.label, path: repository.path, rootPath: repository.root.fsPath,
			head: (await git.status(repository.id)).head, remotes: (await git.graph({ limit: 1 }, repository.id)).remotes,
		})))
	},
};
const scope: ISessionProviderScope = { providerId: 'primary', services: { host } as SessionProviderServices, thread: host.thread, identity: value => value, backendIdentity: value => value, assertCurrent: () => { } };
const scopes = { getScopes: () => [scope], getScope: () => scope, onDidChangeScopes: Event.None } as unknown as ISessionProviderScopeService;
const github = resources.add(new GitHubService(sessions, management, scm, scopes, new ConsoleLogger('sessions-pr-test')));
const main = document.createElement('main');
main.style.width = '320px';
document.body.append(main);
const opened: string[] = [];
const opener = { open: async (uri: URI) => { opened.push(uri.toString()); return true; } } as IOpenerService;
const notifications = { error: (error: unknown) => { throw error; } } as unknown as INotificationService;
const quickInput = resources.add(new TestQuickInputService({ container: document.body }));
const toolbar = resources.add(new SessionChatInputToolbar(main, { sessionId: 'session', onDidChange: Event.None }, github, opener, notifications, quickInput, { openEditor: async input => { opened.push(input.resource.toString()); } } as IEditorService));
toolbar.render();
const list = resources.add(new SessionsList(main, management, sessions, 'Sessions', github, undefined, listCustomViews, listMenus, listNotifications));
const submissions: Record<string, unknown>[] = [];
if (new URL(location.href).searchParams.has('checks')) {
	transport.failingChecks = true;
	const services = resources.add(new InstantiationService());
	services.registerInstance(ISessionsService, sessions);
	services.registerInstance(ISessionGitHubService, github);
	services.registerInstance(IGitHubApi, host.github);
	services.registerInstance(IAccountService, { onDidChangeAccounts: accountsChanged.event } as IAccountService);
	services.registerInstance(IOpenerService, opener);
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IChangesViewService, {
		activeSessionSectionCollapseStateObs: observableValue('testChecksCollapse', { checks: false }),
		setSectionCollapsed: () => { },
	} as unknown as IChangesViewService);
	services.registerInstance(IChatService, {
		readThread: async () => ({ thread: { status: 'active', sequence: 3, turns: [] } }),
		startTurn: async (options: StartTurnOptions) => { submissions.push({ ...options }); },
		queueTurn: async (options: StartTurnOptions) => { submissions.push({ ...options, queued: true }); },
	} as unknown as IChatService);
	services.registerInstance(IChecksOperationService, resources.add(new ChecksOperationService()));
	resources.add(services.createInstance(ChecksWidget, main));
}
github.initialize();

window.ashSessionGitHub = {
	opened, requests: transport.requests, submissions,
	setIssueState: (number: number, state: string, reason?: string) => transport.changeIssue(number, state, reason),
	setState: (state: State) => { transport.states.set(7, state); statusChanged.fire(gitStatus('one')); },
	setAttention: (attention: 'comments' | 'checks' | 'conflicts' | 'none') => {
		transport.unresolvedComments = attention === 'comments';
		transport.failingChecks = attention === 'checks';
		transport.mergeable = attention === 'conflicts' ? false : null;
		statusChanged.fire(gitStatus('one'));
	},
	changeBranch: () => { branch = 'another'; statusChanged.fire(gitStatus('one')); },
	signOut: () => { transport.signedIn = false; accountsChanged.fire({ revision: 2n, accounts: [] }); },
	selectDraft: () => { selection = undefined; selected.fire(); },
	theme: (name: string) => theme.setColorTheme(name === 'light' ? lightColorTheme : highContrastDarkColorTheme),
	dispose: () => { resources.dispose(); list.domNode.remove(); },
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
declare global { interface Window { ashSessionGitHub: { submissions: Record<string, unknown>[]; opened: string[]; requests: Request[]; setIssueState(number: number, state: string, reason?: string): void; setState(state: State): void; setAttention(attention: 'comments' | 'checks' | 'conflicts' | 'none'): void; changeBranch(): void; signOut(): void; selectDraft(): void; theme(name: string): void; dispose(): void; }; } }

import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/agentHost/test/common/testAppServerProtocol.js';
import { AppServerGitHubService } from '../../../src/ash/platform/github/browser/appServerGitHubService.js';
import type { IAccountService, AccountState } from '../../../src/ash/platform/accounts/common/accountService.js';
import { ConsoleLogger } from '../../../src/ash/platform/log/common/log.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, highContrastDarkColorTheme, lightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import type { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import type { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import type { IGitService, GitStatus } from '../../../src/ash/workbench/contrib/git/common/gitService.js';
import type { ISessionsService, SessionsViewSelection } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../../src/ash/sessions/services/sessions/common/session.js';
import { GitHubService } from '../../../src/ash/sessions/contrib/github/browser/githubService.js';
import { SessionChatInputToolbar } from '../../../src/ash/sessions/contrib/chat/browser/sessionChatInputToolbar.js';
import { SessionsList } from '../../../src/ash/sessions/browser/parts/sidebar/sessionsList.js';
import { QuickInputController } from '../../../src/ash/platform/quickinput/browser/quickInputController.js';
import type { GitHubPullRequestReference } from '../../../src/ash/platform/github/common/githubService.js';

interface Request { readonly id: number; readonly method: string; readonly params: Record<string, unknown>; }
type State = 'open' | 'draft' | 'closed' | 'merged';

class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	public readonly requests: Request[] = [];
	public readonly states = new Map<number, State>([[7, 'open'], [8, 'draft']]);
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
			case 'initialize': this.reply(request, createTestInitializeResult()); break;
			case 'github/account/list': this.reply(request, { accounts: this.signedIn ? [{ id: 'account', host: 'github.com', login: 'User', status: 'ready', credentialRevision: '1' }] : [] }); break;
			case 'github/pullRequest/list': this.reply(request, { pullRequests: request.params.state === pr.state ? [pr] : [], nextPage: null }); break;
			case 'github/pullRequest/read': this.reply(request, pr); break;
			case 'github/checks': this.reply(request, { state: 'pending', statuses: [], checks: Number(request.params.page) === 1 ? [{ id: 1, name: 'waiting', status: 'in_progress', conclusion: null, detailsUrl: null }] : [{ id: 2, name: 'build', status: 'completed', conclusion: this.failingChecks ? 'failure' : 'success', detailsUrl: null }], nextPage: Number(request.params.page) === 1 ? 2 : null }); break;
			case 'github/pullRequest/threads': this.reply(request, { threads: request.params.cursor === null ? [] : [{ id: 'review-thread', path: 'file.ts', line: null, side: 'RIGHT', resolved: !this.unresolvedComments, outdated: false, canResolve: true, comments: { comments: [], nextCursor: null } }], nextCursor: request.params.cursor === null ? 'second' : null }); break;
			case 'github/cancel': this.reply(request, {}); break;
			default: throw new Error(`Unexpected session PR request: ${request.method}`);
		}
	}
	private persistReferences(request: Request): void {
		sessionStorage.setItem('test-backend-pr-references', JSON.stringify(this.references));
		this.reply(request, null);
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'session/changed', params: { sessionId: request.params.sessionId, agentTreeChanged: false } }) });
	}
}

const resources = new DisposableStore();
if (new URL(location.href).searchParams.get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}
const transport = new Transport();
const client = new AppServerProtocolClient(transport);
resources.add(toDisposable(() => client.dispose()));
await client.connect();
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindColorTheme(theme, document.body));
const selected = resources.add(new Emitter<void>());
const statusChanged = resources.add(new Emitter<GitStatus>());
const accountsChanged = resources.add(new Emitter<AccountState>());
const session: ISession = { sessionId: 'session', title: 'Implement PR integration', status: 'active', workspace: new URL(location.href).searchParams.has('noWorkspace') ? null : { authorityId: 'local', root: '/workspace' }, nextApprovalMode: 'manual', chats: [{ threadId: 'thread', origin: { type: 'root' }, status: 'active' }] };
let selection: SessionsViewSelection | undefined = { kind: 'session', active: { session, threadId: 'thread' } };
let branch = 'feature';
const gitStatus = (id: string): GitStatus => ({ repositoryId: id, streamInstanceId: 'stream', revision: 1, workspacePath: '/workspace', head: { type: 'branch', name: branch, objectId: 'a'.repeat(40), upstream: undefined }, changes: [] });
const git = {
	repositories: ['one', 'two'].map(id => ({ id, label: id, path: id, root: URI.file(`/workspace/${id}`) })),
	onDidChangeRepositories: Event.None, onDidChangeRepositoryStatus: statusChanged.event,
	status: async (id: string) => gitStatus(id),
	graph: async (_query: unknown, id: string) => ({ commits: [], references: [], remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: id } }], hasMore: false, nextCursor: undefined }),
} as unknown as IGitService;
const management = { sessions: [session], state: 'ready' } as unknown as ISessionsManagementService;
const sessions = { get activeSelection() { return selection; }, get visibleSelections() { return selection ? [selection] : []; }, onDidChange: selected.event, openSession: () => { }, openNewSession: () => { } } as unknown as ISessionsService;
const github = resources.add(new GitHubService(sessions, management, git, new AppServerGitHubService(client), { onDidChangeAccounts: accountsChanged.event } as IAccountService, new ConsoleLogger('sessions-pr-test')));
const main = document.createElement('main');
main.style.width = '320px';
document.body.append(main);
const opened: string[] = [];
const opener = { open: async (uri: URI) => { opened.push(uri.toString()); return true; } } as IOpenerService;
const notifications = { error: (error: unknown) => { throw error; } } as unknown as INotificationService;
const quickInput = resources.add(new QuickInputController(document.body));
const toolbar = resources.add(new SessionChatInputToolbar(main, { sessionId: 'session', onDidChange: Event.None }, github, opener, notifications, quickInput, { openEditor: async input => { opened.push(input.resource.toString()); } } as IEditorService));
toolbar.render();
const list = resources.add(new SessionsList(main, management, sessions, 'Sessions', 'New Session', github));
github.initialize();

window.ashSessionGitHub = {
	opened, requests: transport.requests,
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
declare global { interface Window { ashSessionGitHub: { opened: string[]; requests: Request[]; setState(state: State): void; setAttention(attention: 'comments' | 'checks' | 'conflicts' | 'none'): void; changeBranch(): void; signOut(): void; selectDraft(): void; theme(name: string): void; dispose(): void; }; } }

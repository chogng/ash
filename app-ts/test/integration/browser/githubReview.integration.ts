import type { EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import '../../../src/ash/editor/browser/widget/diffEditor/registrations.contribution.js';
import '../../../src/ash/workbench/contrib/github/browser/github.contribution.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { setIconResolver } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../src/ash/platform/theme/common/iconRegistry.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import messages from '../../../localization/zh-CN/github.json' with { type: 'json' };
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IAccountService, type AccountState } from '../../../src/ash/platform/accounts/common/accountService.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/app-server/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../src/ash/platform/app-server/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/app-server/test/common/testAppServerProtocol.js';
import { AppServerGitHubService } from '../../../src/ash/platform/github/browser/appServerGitHubService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IGitService, type GitCommand } from '../../../src/ash/workbench/contrib/git/common/gitService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { IGitHubService } from '../../../src/ash/platform/github/common/githubService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { IAccessibleViewService, type AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IEditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IDialogsModel, IWorkbenchDialogHandler } from '../../../src/ash/workbench/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { darkColorTheme, highContrastDarkColorTheme, lightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';

import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IGitHubConnectionService } from '../../../src/ash/workbench/services/accounts/common/gitHubConnectionService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';

if (new URL(location.href).searchParams.has('zh')) { setNlsMessages('zh-CN', messages); }
interface Request { id: number; method: string; params: Record<string, unknown>; }
const head = 'a'.repeat(40); const base = 'b'.repeat(40);
const file = { filename: 'new.rs', previousFilename: 'old.rs', status: 'renamed', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' };
const comment = { id: 'comment-1', author: 'Alice', body: 'Please explain', url: 'https://github.com/team/repo/pull/7#discussion', canUpdate: true, canDelete: true };
class ReviewTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	public readonly requests: Request[] = [];
	public accountCatalog = [{ id: 'alice', host: 'github.com', login: 'Alice', status: 'ready', credentialRevision: '1' }, { id: 'ghe.example/42', host: 'ghe.example', login: 'EnterpriseAlice', status: 'ready', credentialRevision: '1' }];
	public notificationRead = false;
	public notificationReadAll = false;
	public commentBody = comment.body;
	public users: string[] = ['reviewer'];
	public teams: string[] = [];
	public commit = head;
	public resolved = false;
	public merged = false;
	public failure: string | undefined;
	public heldMethod: string | undefined;
	private held: Request | undefined;
	public on(event: string, listener: (payload: unknown) => void): void { let listeners = this.listeners.get(event); if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); } listeners.add(listener); }
	public off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(payload); } }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'review-test', workspaceRoot: '/workspace' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as Request; this.requests.push(request);
		if (request.method === this.heldMethod) { this.held = request; return; }
		this.dispatch(request);
	}
	private pr(number = 7) { return { number, title: number === 7 ? '<img src=x onerror=alert(1)> Review change' : 'Another pull request', body: 'PR description', url: `https://github.com/team/repo/pull/${number}`, state: this.merged ? 'closed' : 'open', draft: false, mergedAt: this.merged ? 'now' : null, headCommit: this.commit, headBranch: 'feature', headRepository: 'contributor/fork', baseBranch: 'main', mergeable: null, autoMerge: false }; }
	private issue() { return { number: 9, title: 'Fix issue', url: 'https://github.com/team/repo/issues/9', state: 'open', labels: ['bug'], assignees: ['Alice'], updatedAt: 'now' }; }
	private dispatch(request: Request): void {
		if (this.failure && request.method === 'github/pullRequest/review') { this.respond(request, undefined, this.failure); return; }
		switch (request.method) {
			case 'initialize': this.respond(request, createTestInitializeResult()); break;
			case 'github/account/list': this.respond(request, { accounts: this.accountCatalog }); break;
			case 'github/notifications/list': this.respond(request, { notifications: this.notificationReadAll ? [] : [{ id: String(request.params.page), title: request.params.page === 1 ? 'Review requested' : 'Issue mentioned', subjectType: 'PullRequest', unread: !this.notificationRead, reason: 'review_requested', updatedAt: 'now', repository: { host: request.params.accountId === 'alice' ? 'github.com' : 'ghe.example', owner: 'team', name: 'repo' }, url: 'https://github.com/team/repo/pull/7' }], nextPage: request.params.page === 1 ? 2 : null }); break;
			case 'github/notifications/read': this.notificationRead = true; this.respond(request, null); break;
			case 'github/notifications/readAll': this.notificationReadAll = true; this.respond(request, null); break;
			case 'github/repository/fork': this.respond(request, { fullName: `${request.params.organization ?? 'Alice'}/${request.params.name}`, url: `https://github.com/${request.params.organization ?? 'Alice'}/${request.params.name}`, defaultBranch: 'main' }); break;
			case 'github/account/connect': { const account = { id: `${request.params.host}/99`, host: request.params.host as string, login: 'TokenUser', status: 'ready', credentialRevision: '1' }; this.accountCatalog = [...this.accountCatalog, account]; this.respond(request, account); break; }
			case 'github/pullRequest/reviewers': this.respond(request, { users: this.users, teams: this.teams }); break;
			case 'github/pullRequest/reviewers/change': this.users = request.params.change === 'request' ? [...this.users, ...request.params.users as string[]] : this.users.filter(user => !(request.params.users as string[]).includes(user)); this.teams = request.params.change === 'request' ? [...this.teams, ...request.params.teams as string[]] : this.teams.filter(team => !(request.params.teams as string[]).includes(team)); this.respond(request, { users: this.users, teams: this.teams }); break;
			case 'github/pullRequest/comment/update': this.commentBody = request.params.body as string; this.respond(request, { ...comment, body: this.commentBody }); break;
			case 'github/pullRequest/comment/delete': this.respond(request, null); break;
			case 'github/repository/read': this.respond(request, { fullName: 'team/repo', defaultBranch: 'main', allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false, allowAutoMerge: true }); break;
			case 'github/pullRequest/list': this.respond(request, { pullRequests: [this.pr(request.params.page === 1 ? 7 : 8)], nextPage: request.params.page === 1 ? 2 : null }); break;
			case 'github/pullRequest/read': this.respond(request, this.pr(Number(request.params.number))); break;
			case 'github/pullRequest/create': this.respond(request, { ...this.pr(10), title: request.params.title, body: request.params.body }); break;
			case 'github/pullRequest/update': this.respond(request, { ...this.pr(), title: request.params.title ?? this.pr().title, body: request.params.body ?? this.pr().body, state: request.params.state ?? 'open' }); break;
			case 'github/pullRequest/diff': this.respond(request, { baseCommit: base, files: { files: request.params.page === 1 ? [file] : [{ ...file, filename: 'binary.bin', previousFilename: null, status: 'added', patch: null }], nextPage: request.params.page === 1 ? 2 : null, limitReached: false } }); break;
			case 'github/file/read': this.respond(request, request.params.path === 'binary.bin' ? { kind: 'binary' } : { kind: 'text', text: request.params.commit === base ? 'old\n' : 'new\n' }); break;
			case 'github/checks': this.respond(request, { state: 'success', statuses: [], checks: [{ id: Number(request.params.page), name: request.params.page === 1 ? 'unit tests' : 'integration tests', status: 'completed', conclusion: 'success', detailsUrl: null }], nextPage: request.params.page === 1 ? 2 : null }); break;
			case 'github/pullRequest/reviews': this.respond(request, { reviews: [], nextPage: null }); break;
			case 'github/pullRequest/review': this.respond(request, { id: 1, body: request.params.body, state: 'COMMENTED', url: 'https://github.com/team/repo/pull/7#review', commit: request.params.commit, submittedAt: 'now' }); break;
			case 'github/pullRequest/threads': this.respond(request, { threads: request.params.cursor ? [] : [{ id: 'thread-1', path: 'new.rs', line: 1, side: 'RIGHT', resolved: this.resolved, outdated: false, canResolve: true, comments: { comments: [{ ...comment, body: this.commentBody }], nextCursor: 'comment-cursor' } }], nextCursor: request.params.cursor ? null : 'thread-cursor' }); break;
			case 'github/pullRequest/thread/read': this.respond(request, { comments: [{ ...comment, id: 'comment-2', body: 'More discussion' }], nextCursor: null }); break;
			case 'github/pullRequest/thread/reply': this.respond(request, { ...comment, id: 'reply', body: request.params.body }); break;
			case 'github/pullRequest/thread/resolve': this.resolved = request.params.state === 'resolved'; this.respond(request, null); break;
			case 'github/pullRequest/merge': this.merged = true; this.respond(request, { merged: true, commit: 'd'.repeat(40), message: 'Merged' }); break;
			case 'github/pullRequest/autoMerge': this.respond(request, null); break;
			case 'github/issue/list': this.respond(request, { issues: [this.issue()], nextPage: null, notice: '' }); break;
			case 'github/issue/read': this.respond(request, { issue: this.issue(), body: 'Issue description', comments: [] }); break;
			case 'github/comment/list': this.respond(request, { comments: [], nextPage: null }); break;
			case 'github/comment/create': this.respond(request, { id: 12, body: request.params.body, url: 'https://github.com/team/repo/issues/9#comment', updatedAt: 'now' }); break;
			case 'github/issue/create': case 'github/issue/update': this.respond(request, { issue: { ...this.issue(), title: request.params.title ?? 'Fix issue', state: request.params.state ?? 'open', labels: request.params.labels ?? ['bug'], assignees: request.params.assignees ?? ['Alice'] }, body: request.params.body ?? 'Issue description' }); break;
			case 'github/cancel': this.respond(request, { status: 'requested' }); break;
			default: throw new Error(`Unexpected method: ${request.method}`);
		}
	}
	private respond(request: Request, result: unknown, error?: string): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error: { code: -32070, message: error, data: { kind: error } } } : { result }) }) }); }
	public release(): void { const request = this.held!; this.held = undefined; this.heldMethod = undefined; this.dispatch(request); }
}

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'github-review', backend: window.localStorage, flushInterval: 0 })));
setIconResolver(document, icon => getIconDefinition(icon));
const theme = resources.add(new TestThemeService(darkColorTheme)); services.registerInstance(IThemeService, theme);
resources.add(bindColorTheme(theme, document.body));
const transport = new ReviewTransport(); const client = new AppServerProtocolClient(transport); resources.add(toDisposable(() => client.dispose())); await client.connect();
services.registerInstance(IGitHubService, new AppServerGitHubService(client));
const localRepository = { id: 'local-repo', label: 'Local repo', path: '/workspace', root: URI.file('/workspace') };
const gitRequests: { method: string; params: Record<string, unknown>; }[] = [];
let dirty = false;
services.registerInstance(IGitService, {
	listRepositories: async () => [localRepository],
	graph: async () => ({ remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' } }, { name: 'fork', identity: { provider: 'github', host: 'github.com', owner: 'contributor', repository: 'fork' } }], references: [], commits: [], hasMore: false, nextCursor: undefined }),
	status: async () => ({ repositoryId: 'local-repo', streamInstanceId: 'test', revision: 1, workspacePath: '/workspace', head: { type: 'branch', name: 'pr/7', objectId: 'd'.repeat(40), upstream: undefined }, changes: [] }),
	executeCommand: async (command: GitCommand, repositoryId?: string) => { gitRequests.push({ method: 'git/command', params: { command, repositoryId } }); return { outcome: 'completed', operation: undefined, status: await services.get(IGitService).status(repositoryId) }; },
} as unknown as IGitService);
services.registerInstance(IWorkingCopyService, { getAll: () => dirty ? [{ resource: URI.file('/workspace/a.rs'), isDirty: true }] : [] } as unknown as IWorkingCopyService);
const accounts = resources.add(new Emitter<AccountState>());
const loggedOut: { provider: string; accountId?: string; }[] = [];
const browserHosts: (string | undefined)[] = [];
const initialAccount: AccountState = { revision: 1n, accounts: [{ provider: 'github', accountId: 'alice', credentialRevision: 1n, status: 'ready' }] };
services.registerInstance(IAccountService, { onDidChangeAccounts: accounts.event, onDidCompleteLogin: Event.None, read: async () => initialAccount, startLogin: async () => { throw new Error('Not used'); }, cancelLogin: async () => { }, logout: async (provider, accountId) => { loggedOut.push({ provider, accountId }); transport.accountCatalog = transport.accountCatalog.filter(account => account.id !== accountId); accounts.fire({ revision: 2n, accounts: transport.accountCatalog.map(account => ({ provider: 'github', accountId: account.id, credentialRevision: BigInt(account.credentialRevision), status: 'ready' })) }); } });
services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async host => { browserHosts.push(host); }, cancel: async () => { } });
services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
services.registerInstance(ITextModelResourceService, resources.add(new BrowserTextModelService({ onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: request.bootstrapText!, revision: undefined }), save: async () => { throw new Error('Review snapshots are read-only'); } })));
const dialogs = resources.add(new DialogService()); services.registerInstance(IDialogService, dialogs); services.registerInstance(IDialogsModel, dialogs.model); services.registerInstance(IWorkbenchDialogHandler, new BrowserDialogHandler(document.body));
resources.add(new DialogHandlerContribution(dialogs.model, services.get(IWorkbenchDialogHandler)));
registerCodeEditorServices(services);
let pane: EditorPane | undefined;
services.registerInstance(IEditorPart, { get activePane() { return pane; } } as IEditorPart);
services.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], openEditor: async input => {
		if (pane) { pane.dispose(); }
		pane = EditorPanes.getEditorPane(input)!.create({ instantiationService: services }); pane.create(document.getElementById('github')!); pane.layout({ width: innerWidth, height: innerHeight }); await pane.setInput(input, new AbortController().signal); pane.focus();
	}, focusActiveEditor: () => pane!.focus()
});
const commands = resources.add(new CommandService(services));
window.ashGitHubReview = {
	requests: transport.requests, gitRequests, loggedOut, browserHosts, dirty: () => { dirty = true; }, open: () => commands.executeCommand('workbench.action.github.open'), close: () => { pane?.dispose(); pane = undefined; },
	changeHead: () => { transport.commit = 'c'.repeat(40); }, fail: () => { transport.failure = 'GitHubSubmissionUncertain'; },
	hold: method => { transport.heldMethod = method; }, release: () => transport.release(),
	replaceAccount: () => accounts.fire({ revision: 2n, accounts: [{ provider: 'github', accountId: 'bob', credentialRevision: 2n, status: 'ready' }] }),
	theme: name => theme.setColorTheme(name === 'light' ? lightColorTheme : highContrastDarkColorTheme),
	accessibleContent: type => AccessibleViewRegistry.getImplementations().find(item => item.name === `githubEditor.${type}`)!.getProvider(services)!.provideContent(),
};
window.addEventListener('pagehide', () => { pane?.dispose(); resources.dispose(); }, { once: true });
await window.ashGitHubReview.open();
declare global { interface Window { ashGitHubReview: { requests: Request[]; browserHosts: (string | undefined)[]; gitRequests: { method: string; params: Record<string, unknown>; }[]; loggedOut: { provider: string; accountId?: string; }[]; dirty(): void; open(): Promise<unknown>; close(): void; changeHead(): void; fail(): void; hold(method: string): void; release(): void; replaceAccount(): void; theme(name: 'light' | 'highContrast'): void; accessibleContent(type: AccessibleViewType): string; }; } }

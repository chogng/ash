import { IChangesViewService } from '../../../src/ash/sessions/contrib/changes/common/changesViewService.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { ChangesViewService } from '../../../src/ash/sessions/contrib/changes/browser/changesViewService.js';
import { Event, Emitter } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/browser/configurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IChatService, type TurnChangeDetails } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../src/ash/workbench/test/common/testEditorService.js';
import { registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import { ChangesViewPane } from '../../../src/ash/sessions/contrib/changes/browser/changesView.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import chinese from '../../../extensions/language-pack-zh-cn/translations/sessions.json' with { type: 'json' };
import { IGitHubService as ISessionGitHubService } from '../../../src/ash/sessions/contrib/github/browser/githubService.js';
import { IGitHubService as IGitHubApi } from '../../../src/ash/platform/github/common/githubService.js';
import { IAccountService, type AccountState } from '../../../src/ash/platform/accounts/common/accountService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { ICommandService, CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import '../../../src/ash/base/browser/ui/styles.css';

if (new URL(location.href).searchParams.get('locale') === 'zh-CN') { setNlsMessages('zh-CN', chinese); }

const resources = new DisposableStore();
const services = resources.add(registerTestComponentServices(new InstantiationService()));
services.registerInstance(ILogService, new NullLoggerService());
services.registerSingleton(IChangesViewService, () => resources.add(services.createInstance(ChangesViewService)));
const changed = resources.add(new Emitter<void>());
services.registerInstance(IConfigurationService, resources.add(new WorkbenchConfigurationService()));
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
const accountChanged = resources.add(new Emitter<AccountState>());
services.registerInstance(IAccountService, { onDidChangeAccounts: accountChanged.event } as unknown as IAccountService);
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindColorTheme(theme, document.body));
const created: unknown[] = [];
const attached: unknown[] = [];
const autoMergeCalls: unknown[] = [];
const notifications: string[] = [];
const agentRequests: unknown[] = [];
let activeTurn = false;
let publishedHead = 'commit';
services.registerInstance(ISessionGitHubService, {
	onDidChange: Event.None,
	getSessionPullRequests: () => [{ uri: URI.parse('https://github.com/team/repo/pull/7'), owner: 'team', repo: 'repo', number: 7, state: 'open' }],
} as unknown as ISessionGitHubService);
services.registerInstance(IGitHubApi, {
	listAccounts: async () => [{ id: 'account', host: 'github.com', status: 'ready', credentialRevision: 1n }],
	readRepository: async () => ({ defaultBranch: 'main', allowAutoMerge: true, allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false }),
	createPullRequest: async (repository: unknown, request: unknown) => { created.push({ repository, request }); return { number: 8, headCommit: publishedHead, url: 'https://github.com/team/repo/pull/8' }; },
	attachSessionPullRequest: async (sessionId: string, reference: unknown) => { attached.push({ sessionId, reference }); },
	enableAutoMerge: async (repository: unknown, number: number, merge: unknown) => { autoMergeCalls.push({ repository, number, merge }); },
	readPullRequest: async () => ({ headCommit: 'commit' }),
	readChecks: async (_repository: unknown, _commit: string, page: number) => ({ checks: [{ id: page, name: page === 1 ? 'Build' : 'Tests', status: 'completed', conclusion: page === 1 ? 'success' : 'failure', detailsUrl: 'https://github.com/team/repo/actions/runs/1' }], statuses: [], nextPage: page === 1 ? 2 : null }),
} as unknown as IGitHubApi);
services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
const gitCalls: string[] = [];
let branch = 'feature';
for (const command of ['git.getRepositoryContexts', 'git.pull', 'git.push', 'git.publish', 'git.openChangesSource']) {
	resources.add(CommandsRegistry.register(command, () => undefined));
}
services.registerInstance(ICommandService, {
	executeCommand: async (command: string, ...args: unknown[]) => {
		if (command === 'git.getRepositoryContexts') { return [{ id: 'repository', label: 'Session repository', path: '/workspace', root: URI.file('/workspace').toString(), head: { type: 'branch', name: branch, objectId: 'commit', upstream: { name: 'origin/feature', ahead: 2, behind: 1 } }, uncommittedChanges: 3, remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' } }] }]; }
		gitCalls.push(`${command}:${String(args[0])}`);
		return undefined;
	}
} as unknown as ICommandService);
let fail = false;
const details: TurnChangeDetails = {
	summary: { changeSetId: 'change', sessionId: 'session', threadId: 'thread', turnId: 'turn', repositoryId: 'repository', statistics: { files: 1, additions: 3, deletions: 2 }, captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1 },
	files: [{ path: 'src/a-long-directory-name/main.ts', kind: 'modified', binary: false, additions: 3, deletions: 2 }],
};
let ledger: readonly TurnChangeDetails[] = [details];
let sessionId = 'session';
services.registerInstance(ISessionsService, {
	onDidChange: changed.event,
	get activeSelection() { return { kind: 'session', active: { session: { sessionId, status: 'active', title: 'Test changes', chats: [{ threadId: 'thread', status: 'active', origin: { type: 'root' } }], workspace: { authorityId: 'local', root: '/workspace' } }, threadId: 'thread' } }; },
} as unknown as ISessionsService);
services.registerInstance(IChatService, {
	readThread: async () => ({ thread: { sessionId, threadId: 'thread', status: 'active', sequence: 7, turns: activeTurn ? [{ status: 'running' }] : [] } }),
	startTurn: async (request: unknown) => { agentRequests.push({ action: 'start', request }); },
	queueTurn: async (request: unknown) => { agentRequests.push({ action: 'queue', request }); },
	onDidBecomeReady: Event.None, onDidUpdateTurnChanges: Event.None,
	listTurnChanges: async () => { if (fail) { throw new Error('Repository unavailable'); } return ledger.map(entry => ({ ...entry.summary, sessionId })); },
	readTurnChange: async (_session: string, _thread: string, id: string) => {
		const entry = ledger.find(entry => entry.summary.changeSetId === id)!;
		return { ...entry, summary: { ...entry.summary, sessionId } };
	},
	readTurnChangeFile: async () => ({ path: details.files[0]!.path, binary: false, truncated: false, before: 'Before', after: 'After' }),
} as unknown as IChatService);
let opened = 0;
services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { opened++; } } as unknown as IEditorService);
services.registerInstance(INotificationService, { info: (message: string) => { notifications.push(message); }, error: (error: unknown) => { throw new Error(String(error)); } } as unknown as INotificationService);
services.registerInstance(IQuickInputService, { input: async () => undefined } as unknown as IQuickInputService);
services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.' } as unknown as IAccessibleViewService);
const container = document.querySelector<HTMLElement>('#changes')!;
container.style.cssText = 'width: 360px; height: 480px; --ash-spacing-size80: 8px; --ash-fontSize-body1: 13px; --ash-fontSize-body2: 11px; --ash-description-foreground: #666;';
const view = resources.add(services.createInstance(ChangesViewPane, container, { id: 'sessions.changes', title: 'Changes' }));
view.setVisible(true);
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

declare global {
	interface Window {
		ashChangesIntegration: {
			fail(value: boolean): void;
			multipleTurns(): void;
			revision(value: number): void;
			visible(value: boolean): void;
			selectSession(id: string): void;
			agentRequests(): readonly unknown[];
			activeTurn(value: boolean): void;
			setLocale(): void;
			opened(): number;
			content(): string;
			gitCalls(): readonly string[];
			created(): readonly unknown[];
			attached(): readonly unknown[];
			theme(name: string): void;
			branch(name: string): void;
			accountChanged(): void;
			publishedHead(head: string): void;
			autoMergeCalls(): readonly unknown[];
			notifications(): readonly string[];
		};
	}
}
window.ashChangesIntegration = {
	agentRequests: () => agentRequests,
	activeTurn: value => { activeTurn = value; },
	multipleTurns: () => {
		ledger = [details, { ...details, summary: { ...details.summary, changeSetId: 'second', turnId: 'second-turn' }, files: [{ ...details.files[0]!, path: 'tests/main.test.ts' }] }];
		changed.fire();
	},
	revision: value => { ledger = ledger.map(entry => ({ ...entry, summary: { ...entry.summary, revision: value } })); changed.fire(); },
	visible: value => view.setVisible(value),
	selectSession: id => { sessionId = id; changed.fire(); },
	fail: value => { fail = value; changed.fire(); },
	setLocale: () => { setNlsMessages('zh-CN', chinese); changed.fire(); },
	opened: () => opened,
	content: () => view.getAccessibleContent(),
	gitCalls: () => gitCalls,
	created: () => created,
	attached: () => attached,
	theme: name => theme.setColorTheme(name === 'light' ? lightColorTheme : name === 'contrast' ? highContrastDarkColorTheme : darkColorTheme),
	branch: name => { branch = name; },
	accountChanged: () => accountChanged.fire({ revision: 2n, accounts: [] }),
	publishedHead: head => { publishedHead = head; },
	autoMergeCalls: () => autoMergeCalls,
	notifications: () => notifications,
};
document.body.dataset.ready = 'true';

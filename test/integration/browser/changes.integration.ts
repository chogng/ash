import { IChangesViewService } from '../../../src/ash/sessions/contrib/changes/common/changesViewService.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { ChangesViewService } from '../../../src/ash/sessions/contrib/changes/browser/changesViewService.js';
import { ISessionChangesService } from '../../../src/ash/sessions/contrib/changes/common/sessionChangesService.js';
import { SessionChangesService } from '../../../src/ash/sessions/contrib/changes/browser/sessionChangesService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { SessionChangesEditorInput } from '../../../src/ash/sessions/contrib/changes/browser/sessionChangesEditorInput.js';
import { IDecorationsService } from '../../../src/ash/workbench/services/decorations/common/decorations.js';
import { DecorationsService } from '../../../src/ash/workbench/services/decorations/browser/decorationsService.js';
import { Event, Emitter } from '../../../src/ash/base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
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
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
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
const services = resources.add(new InstantiationService());
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'changes-integration', flushInterval: 0 })));
registerTestComponentServices(services);
services.registerInstance(ILogService, new NullLoggerService());
services.registerSingleton(IDecorationsService, () => services.createInstance(DecorationsService, document));
services.registerSingleton(IChangesViewService, () => resources.add(services.createInstance(ChangesViewService)));
services.registerSingleton(ISessionChangesService, () => services.createInstance(SessionChangesService));
services.registerInstance(ISessionsManagementService, {
	get sessions() {
		const selection = services.get(ISessionsService).activeSelection;
		return selection?.kind === 'session' ? [selection.active.session] : [];
	},
} as unknown as ISessionsManagementService);
services.registerInstance(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService);
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
function multipleTurns(): readonly TurnChangeDetails[] {
	return [details, { ...details, summary: { ...details.summary, changeSetId: 'second', turnId: 'second-turn' }, files: [{ ...details.files[0]!, path: 'tests/main.test.ts' }] }];
}
if (new URL(location.href).searchParams.has('multiple')) { ledger = multipleTurns(); }
let sessionId = 'session';
let threadId = 'thread';
let pendingLedger: Promise<void> | undefined;
let finishLedger: (() => void) | undefined;
let pendingFileFailure: Promise<never> | undefined;
let failFile: ((error: Error) => void) | undefined;
let fileReadStarted = false;
let holdNextLedger: { key: string; missingSecond: boolean; } | undefined;
const heldLedgers = new Map<string, { resolve(): void; reject(error: Error): void; }>();
services.registerInstance(ISessionsService, {
	onDidChange: changed.event,
	get activeSelection() { return { kind: 'session', active: { session: { sessionId, status: 'active', title: 'Test changes', chats: [{ threadId, status: 'active', origin: { type: 'root' } }], workspace: { authorityId: 'local', root: '/workspace' } }, threadId } }; },
} as unknown as ISessionsService);
services.registerInstance(IChatService, {
	readThread: async () => ({ thread: { sessionId, threadId: 'thread', status: 'active', sequence: 7, turns: activeTurn ? [{ status: 'running' }] : [] } }),
	startTurn: async (request: unknown) => { agentRequests.push({ action: 'start', request }); },
	queueTurn: async (request: unknown) => { agentRequests.push({ action: 'queue', request }); },
	onDidBecomeReady: Event.None, onDidUpdateTurnChanges: Event.None,
	listTurnChanges: async (sessionId: string, threadId: string) => {
		const held = holdNextLedger;
		holdNextLedger = undefined;
		const entries = held?.missingSecond ? ledger.filter(entry => entry.summary.changeSetId !== 'second') : ledger;
		const summaries = entries.map(entry => ({ ...entry.summary, sessionId, threadId }));
		if (held) { await new Promise<void>((resolve, reject) => { heldLedgers.set(held.key, { resolve, reject }); }); }
		if (pendingLedger) { await pendingLedger; }
		if (fail) { throw new Error('Repository unavailable'); }
		return summaries;
	},
	readTurnChange: async (sessionId: string, threadId: string, id: string) => {
		const entry = ledger.find(entry => entry.summary.changeSetId === id)!;
		return { ...entry, summary: { ...entry.summary, sessionId, threadId } };
	},
	readTurnChangeFile: async () => {
		if (pendingFileFailure) { fileReadStarted = true; return pendingFileFailure; }
		return { path: details.files[0]!.path, binary: false, truncated: false, before: 'Before', after: 'After' };
	},
} as unknown as IChatService);
let opened = 0;
const reviews: { resource: string; changesetId?: string; }[] = [];
services.registerInstance(IEditorService, {
	...emptyEditorServiceState, openEditor: async (input: IResourceEditorInput) => {
		opened++;
		if (input instanceof SessionChangesEditorInput) {
			reviews.push({ resource: input.resource.toString(), changesetId: input.changesetSelection?.kind === 'id' ? input.changesetSelection.id : undefined });
		}
	}
} as unknown as IEditorService);
services.registerInstance(INotificationService, { info: (message: string) => { notifications.push(message); }, error: (error: unknown) => { notifications.push(String(error)); } } as unknown as INotificationService);
services.registerInstance(IQuickInputService, { input: async () => undefined } as unknown as IQuickInputService);
services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => 'Press Alt+F1 for accessibility help.' } as unknown as IAccessibleViewService);
const container = document.querySelector<HTMLElement>('#changes')!;
container.style.cssText = 'width: 360px; height: 480px; --ash-spacing-size80: 8px; --ash-fontSize-body1: 13px; --ash-fontSize-body2: 11px; --ash-description-foreground: #666;';
const viewOwner = resources.add(new MutableDisposable<ChangesViewPane>());
let view = services.createInstance(ChangesViewPane, container, { id: 'sessions.changes', title: 'Changes' });
viewOwner.value = view;
view.setVisible(true);
window.addEventListener('pagehide', () => { viewOwner.clear(); resources.dispose(); }, { once: true });

declare global {
	interface Window {
		ashChangesIntegration: {
			fail(value: boolean): void;
			multipleTurns(): void;
			revision(value: number): void;
			visible(value: boolean): void;
			selectSession(id: string): void;
			selectThread(id: string): void;
			delayRefresh(): void;
			completeRefresh(): void;
			holdRefresh(key: string, missingSecond?: boolean): void;
			releaseRefresh(key: string, failed?: boolean): void;
			removeSecondTurn(): void;
			rebuild(): void;
			delayFileFailure(): void;
			fileReadStarted(): boolean;
			rejectFile(): void;
			agentRequests(): readonly unknown[];
			activeTurn(value: boolean): void;
			setLocale(): void;
			opened(): number;
			reviews(): readonly { resource: string; changesetId?: string; }[];
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
		ledger = multipleTurns();
		changed.fire();
	},
	revision: value => { ledger = ledger.map(entry => ({ ...entry, summary: { ...entry.summary, revision: value } })); changed.fire(); },
	visible: value => view.setVisible(value),
	selectSession: id => { sessionId = id; changed.fire(); },
	selectThread: id => { threadId = id; changed.fire(); },
	delayRefresh: () => { pendingLedger = new Promise<void>(resolve => { finishLedger = resolve; }); changed.fire(); },
	completeRefresh: () => { finishLedger!(); pendingLedger = undefined; finishLedger = undefined; },
	holdRefresh: (key, missingSecond = false) => { holdNextLedger = { key, missingSecond }; changed.fire(); },
	releaseRefresh: (key, failed = false) => {
		const request = heldLedgers.get(key)!;
		heldLedgers.delete(key);
		if (failed) { request.reject(new Error('Delayed catalogue failed')); }
		else { request.resolve(); }
	},
	removeSecondTurn: () => { ledger = [details]; changed.fire(); },
	rebuild: () => {
		viewOwner.clear();
		view = services.createInstance(ChangesViewPane, container, { id: 'sessions.changes', title: 'Changes' });
		viewOwner.value = view;
		view.setVisible(true);
	},
	delayFileFailure: () => { fileReadStarted = false; pendingFileFailure = new Promise<never>((_resolve, reject) => { failFile = reject; }); },
	fileReadStarted: () => fileReadStarted,
	rejectFile: () => { failFile!(new Error('Delayed file read failed')); pendingFileFailure = undefined; failFile = undefined; },
	fail: value => { fail = value; changed.fire(); },
	setLocale: () => { setNlsMessages('zh-CN', chinese); changed.fire(); },
	opened: () => opened,
	reviews: () => reviews,
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

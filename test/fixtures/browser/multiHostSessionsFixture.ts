import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { GitHubDiffSide } from '../../../src/ash/platform/github/common/githubService.js';
import { IAgentConnection } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { createServiceIdentifier } from '../../../src/ash/platform/instantiation/common/instantiation.js';
import { IAgentExecutionSettingsService } from '../../../src/ash/platform/agentHost/common/agentExecutionSettingsService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../src/ash/platform/storage/common/storage.js';
import { registerWorkbenchServiceContribution } from '../../../src/ash/workbench/browser/workbenchServiceContributions.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { AgentHostAutomationStore } from '../../../src/ash/sessions/contrib/providers/agentHost/browser/agentHostAutomationStore.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { IChatService, type ThreadRead, type Thread, type StartTurnOptions, type ModelCatalogEntry } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { IPromptsService, type IAgentSkill } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ISessionGroupsService } from '../../../src/ash/sessions/services/sessions/browser/sessionGroupsService.js';
import { ISessionComparisonService } from '../../../src/ash/sessions/services/sessions/browser/sessionComparisonService.js';
import { ISessionsProvidersService } from '../../../src/ash/sessions/services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import type { ISessionsProvider } from '../../../src/ash/sessions/services/sessions/common/sessionsProvider.js';
import type { AgentTreeNode, ISession, SessionWorkspaceSelection } from '../../../src/ash/sessions/services/sessions/common/session.js';
import { saveSessionGridState } from '../../../src/ash/sessions/services/sessions/browser/sessionGridState.js';
import { referenceForSelection } from '../../../src/ash/sessions/services/sessions/browser/visibleSessions.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { buildOpenSessionLinkUri } from '../../../src/ash/platform/agentHost/common/openSessionLink.js';
import { sessionIdentity, sessionProviderAuthority, threadIdentity } from '../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
import type { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';

const replacementAgent = { name: 'Agent B', sourceId: 'fixture', description: 'An alternative Agent' };
type Submission = { host: string; } & Pick<StartTurnOptions, 'text' | 'model' | 'skills' | 'contexts'>;

/** Exercises the complete browser Workbench bootstrap with domain-owned fake hosts. */
export function installMultiHostSessionsFixture(): {
	open(host: string, sideBySide?: boolean): Promise<void>;
	openLink(host: string, sideBySide?: boolean, threadId?: string): Promise<boolean>;
	disconnect(host: string): void;
	activeProvider(): string | undefined;
	showComparisonGroup(): Promise<void>;
	newChatInSession(): Promise<void>;
	openSideChat(): Promise<void>;
	saveLegacyNestedDraft(): Promise<void>;
	showAttentionDraft(): void;
	pauseNextRename(): void;
	rejectPausedRename(): void;
	completeRequiredCheck(): void;
	requiredCheckReads(): number;
	calls: { host: string; method: string; sessionId: string; threadId: string; }[];
	submissions: Submission[];
} {
	const calls: { host: string; method: string; sessionId: string; threadId: string; }[] = [];
	const submissions: Submission[] = [];
	let pausedRename: DeferredPromise<void> | undefined;
	let completeRequiredCheck = () => { };
	let requiredCheckReads = 0;
	let services: InstantiationService;
	const registrations = new Map<string, { dispose(): void; }>();
	const params = new URL(location.href).searchParams;
	const sideThreads = params.has('sideThreads');
	const nestedDraft = params.has('nestedDraft');
	const sideChatHostSwitch = params.has('sideChatHostSwitch');
	const background = params.has('backgroundActivities');
	const comparisonPreview = params.has('comparisonPreview');
	const botsInbox = params.has('botsInbox');
	registerWorkbenchServiceContribution({
		service: createServiceIdentifier<object>('test.multiHostSessionsFixture'),
		dependencies: [ISessionsProvidersService, ISessionsManagementService, ISessionsService],
		install: context => {
			services = context.container;
			const registry = services.get(ISessionsProvidersService);
			for (const name of comparisonPreview ? ['Host A', 'Host B', 'Judge'] : ['Host A', 'Host B']) {
				const lifetime = context.register(new DisposableStore());
				const child = lifetime.add(services.createChild());
				const host = createDisconnectedRendererApi();
				const model: ModelCatalogEntry = { model: { provider: 'fixture', model: name }, displayName: `${name} model`, longContext: null };
				const models: readonly ModelCatalogEntry[] = sideChatHostSwitch && name === 'Host B'
					? [model, { model: { provider: 'fixture', model: 'Host B alternative' }, displayName: 'Host B alternative', longContext: null }]
					: [model];
				const skillName = name === 'Host A' ? 'host-a-skill' : 'host-b-skill';
				const skills: readonly IAgentSkill[] = sideChatHostSwitch ? [{
					id: { source: name, name: skillName }, name: skillName, description: `Skill on ${name}`,
					contentDigest: skillName, enabled: true, compatible: true,
					uri: URI.from({ scheme: 'internal', authority: 'skill', path: `/${skillName}/SKILL.md` }),
				}] : [];
				const usage: Thread['usage'] = { modelInvocations: 0, inputTokens: { reported: 0, complete: true }, outputTokens: { reported: 0, complete: true }, cachedInputTokens: { reported: 0, complete: true }, cacheWriteInputTokens: { reported: 0, complete: true }, reasoningTokens: { reported: 0, complete: true } };
				const read = (sessionId: string, threadId: string): ThreadRead => ({
					thread: { advisor: { type: 'default' }, agentId: 'agent', origin: { type: 'root' }, sessionId, threadId, title: name, status: 'active', sequence: 1, usage, turns: [] },
					transcript: {
						sessionId, threadId, durableSequence: 1, revision: 1,
						entries: botsInbox && name === 'Host A' && threadId === 'side' ? [{
							type: 'item', entryId: 'review-reply', turnId: 'review-turn', transient: false,
							item: { type: 'agentMessage', itemId: 'reply', turnId: 'review-turn', text: 'I reviewed the change.' },
						}] : [],
					},
				});
				const record = (method: string, sessionId: string, threadId: string): void => { if (sessionId !== 'same' || (threadId !== 'same' && !((sideThreads || nestedDraft) && threadId === 'side'))) throw new Error('A qualified identity reached a host'); calls.push({ host: name, method, sessionId, threadId }); };
				const chat = {
					onDidSubmitRequest: Event.None, onDidChangeSession: Event.None, onDidUpdateThread: Event.None, onDidUpdateThreadTranscript: Event.None, onDidUpdateGoal: Event.None, onDidBecomeReady: Event.None, onDidUpdateTurnChanges: Event.None, onDidChangeQueue: Event.None, onDidChangeInteractionOffer: Event.None,
					getInteractionOffer: () => undefined, listSlashCommands: async () => [], readAdvisorDefault: async () => null,
					readThread: async (sessionId: string, threadId: string) => { record('read', sessionId, threadId); return read(sessionId, threadId); },
					subscribeThread: async (sessionId: string, threadId: string) => { record('subscribe', sessionId, threadId); return { ...read(sessionId, threadId), updates: [] }; },
					unsubscribeThread: async (sessionId: string, threadId: string) => { record('unsubscribe', sessionId, threadId); },
					readContextUsage: async () => ({ estimatedTokens: 0, categories: [] }), readQueue: async () => [],
					listTurnChanges: async () => [], readThreadChanges: async () => ({ sequence: 1, revision: '1', statistics: { files: 0, additions: 0, deletions: 0 }, repositories: [], warnings: [] }),
					readHistoryState: async () => ({ sequence: 1, canUndo: false, canRedo: false }), readCheckpoints: async () => [],
					startTurn: async (options: StartTurnOptions) => {
						record('send', options.sessionId, options.threadId);
						const { text, model, skills, contexts } = options;
						submissions.push({ host: name, text, model, skills, contexts });
					},
					queueTurn: async (options: StartTurnOptions) => { record('queue', options.sessionId, options.threadId); },
				} as unknown as IChatService;
				child.registerInstance(IChatService, chat);
				child.registerInstance(ILanguageModelsService, {
					onDidChangeModels: Event.None, listModels: async () => models, listModelCatalog: async () => models, listAdvisorModels: async () => [model],
					readModelDefaults: async () => ({ revision: 1, model: model.model, reasoningEffort: null }), getDefaultNewChatModel: () => model.model,
					rememberSelectedModel: async () => { }, saveReasoningEffort: async () => { }, isModelVisible: () => true,
					listModelProviders: async () => [], readApprovalReviewModel: async () => ({ type: 'automatic' }),
				} as unknown as ILanguageModelsService);
				child.registerInstance(IPromptsService, { onDidChangeSkills: Event.None, onDidChangeHooks: Event.None, findAgentSkills: async () => skills, getHooks: async () => [], dispose() { }, [Symbol.dispose]() { } } as unknown as IPromptsService);
				child.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
				const automation = name === 'Host A' && new URL(location.href).searchParams.has('search') ? globalThis.ashWebWorkbenchHost?.api.automation : undefined;
				const mergeReady = name === 'Host B' && params.has('inboxMergeReady');
				const pullRequestEvents = name === 'Host B' && params.has('inboxPullRequestEvents');
				const pullRequestNumbers = pullRequestEvents ? [7, 8] : mergeReady ? [7] : [];
				const pullRequestsChanged = mergeReady ? lifetime.add(new Emitter<string>()) : undefined;
				let checkReported = false;
				if (pullRequestsChanged) {
					completeRequiredCheck = () => {
						checkReported = true;
						pullRequestsChanged.fire('same');
					};
				}
				const repository = { host: 'github.com', owner: 'team', name: 'repo' };
				child.registerInstance(IAgentConnection, {
					...host,
					appServer: { ...host.appServer, getConnectionState: async () => 'ready' },
					localGit: { ...host.localGit, readRepositoryContexts: async () => [] },
					completions: sideChatHostSwitch ? {
						onDidChangeConnection: Event.None,
						getTriggerCharacters: () => ['$'],
						complete: async ({ text, offset }) => {
							const start = text.lastIndexOf('$', offset - 1);
							const skill = skills[0]!;
							if (start < 0 || !skill.name.startsWith(text.slice(start + 1, offset))) return [];
							return [{
								label: `$${skill.name}`, insertText: `$${skill.name} `, start, end: offset, preselect: true,
								value: { kind: 'skill', skill: { id: skill.id, version: { type: 'pinnedDigest', digest: skill.contentDigest } } },
							}];
						},
					} : host.completions,
					automation,
					agentCapabilities: {
						isAvailable: true,
						onDidChange: Event.None,
						read: async () => ({
							localProcessSandboxConfigured: true, sandboxBackends: [], sandboxDiagnostics: [], directoryGrantsReadable: false,
							sandboxPolicy: { profile: ':readOnly', fileSystem: 'readOnly', network: 'denied', hostRead: 'grantedRoots', managedConstraints: true, pathRuleCount: 0 },
						}),
					},
					github: {
						...host.github,
						listAccounts: async () => pullRequestNumbers.length ? [{ id: 'github', host: repository.host, login: 'owner', status: 'ready', credentialRevision: 1n }] : [],
						listSessionPullRequests: async () => pullRequestNumbers.map(number => ({ repository, number, isArtifact: true })),
						listSessionIssues: async () => [],
						...(pullRequestNumbers.length ? {
							readPullRequest: async (_repository, number) => ({
								number, title: 'Fixture PR', body: '', url: `https://github.com/team/repo/pull/${number}`,
								state: number === 8 ? 'closed' : 'open', draft: false,
								mergedAt: number === 8 ? '2026-10-06T11:00:00Z' : null, mergeable: true, headCommit: 'a'.repeat(40),
								headBranch: 'feature', headRepository: 'team/repo', baseBranch: 'main', autoMerge: false,
							}),
							onDidChangeSessionPullRequests: pullRequestsChanged?.event ?? Event.None,
							readPullRequestChecks: async () => {
								requiredCheckReads++;
								return pullRequestEvents
									? { status: 'failure', latestCheckAtUnixMs: Date.parse('2026-10-06T10:30:00Z') }
									: { status: checkReported ? 'success' : 'pending' };
							},
							listReviewThreads: async () => ({
								threads: pullRequestEvents ? [{
									id: 'thread', path: 'file.ts', line: 1, side: GitHubDiffSide.Right, resolved: false, outdated: false, canResolve: true,
									comments: { comments: [{
										id: 'comment', body: 'Please fix this.', url: 'https://github.com/team/repo/pull/7',
										author: 'copilot-pull-request-reviewer[bot]', createdAt: '2026-10-06T10:00:00Z', canUpdate: false, canDelete: false,
									}], nextCursor: null },
								}] : [],
								nextCursor: null,
							}),
						} : {}),
					},
				});
				const automations = automation ? lifetime.add(child.createInstance(AgentHostAutomationStore, name, observableValue<'connected'>('searchFixtureConnection', 'connected'))) : undefined;
				const title = comparisonPreview && name !== 'Judge' ? `Attempt ${name === 'Host A' ? 1 : 2} · ${name}` : `Task from ${name}`;
				let session: ISession = { sessionId: 'same', kind: 'code' as const, title, model: model.model, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'same', status: 'active', origin: { type: 'root' } }, ...(sideThreads ? [{ threadId: 'side', title: 'Follow-up chat', status: 'active' as const, origin: { type: 'fork' as const, parentThreadId: 'same', parentSequence: 1 } }] : [])], agentTree: background ? [{
					threadId: 'side', threadSequence: 1, title: 'Research worker',
					origin: { type: 'agentSpawn', parentThreadId: 'same', parentSequence: 1, delegationId: 'delegate' },
					membershipStatus: 'active', executionStatus: 'running', usage: { inputTokens: 0, outputTokens: 0 }, joins: [], children: [{
						threadId: 'nested', threadSequence: 1, title: 'Nested worker',
						origin: { type: 'agentSpawn', parentThreadId: 'side', parentSequence: 1, delegationId: 'nested' },
						membershipStatus: 'active', executionStatus: 'queued', usage: { inputTokens: 0, outputTokens: 0 }, joins: [], children: [],
					}],
				}] : [] };
				const sourceAgent: AgentTreeNode = {
					threadId: 'same', threadSequence: 1, title: session.title, origin: { type: 'root' },
					role: { name: 'Agent A', selectionReason: 'explicit' }, membershipStatus: 'active', executionStatus: 'idle',
					usage: { inputTokens: 0, outputTokens: 0 }, joins: [], children: [],
				};
				if (nestedDraft) session = { ...session, agentTree: [sourceAgent] };
				if (!params.has('directorylessSession') || name === 'Host A') {
					session = { ...session, workspace: { authorityId: 'local', root: name === 'Host A' ? '/workspace/host-a' : '/workspace/host-b' } };
				}
				if (params.has('inheritWorkspace') && name === 'Host A') {
					session = { ...session, workspace: { authorityId: 'local', root: '/workspace/inherited-project' } };
				}
				const catalogSession = () => nestedDraft ? { ...session, agentTree: undefined } : session;
				if (params.has('blockedTitlebar') && name === 'Host B') {
					session = { ...session, management: { status: 'needsInput', statusChangedAtUnixMs: 1 } };
				}
				if (botsInbox && name === 'Host A') {
					const sessionId = sessionIdentity(name, session.sessionId, 'local-agent-host');
					const repliedAt = Date.now() - 1000;
					session = {
						...session,
						chats: session.chats.map(thread => ({
							...thread,
							management: { status: 'completed', statusChangedAtUnixMs: repliedAt },
						})),
					};
					services.get(IStorageService).store('sessions.codeReview.' + JSON.stringify([sessionId, sessionId]), JSON.stringify({
						batches: [{
							id: 'ash-code-review-inbox', threadId: threadIdentity(name, 'side', 'local-agent-host'), createdAt: repliedAt - 1000,
							files: [{ key: 'file', path: 'file.ts', before: 'old', after: 'new' }],
							comments: [{ id: 'comment', file: 'file', side: 'modified', line: 1, text: 'Please check this change' }],
						}],
					}), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				} else if (params.has('inbox')) {
					const status = name === 'Host A' ? 'completed' : 'needsInput';
					const age = params.has('inboxActions') && name === 'Host A' ? 500 : 1000;
					const management = { status, statusChangedAtUnixMs: Date.now() - age } as const;
					session = botsInbox
						? { ...session, chats: session.chats.map(thread => thread.threadId === 'same' ? { ...thread, management } : thread) }
						: { ...session, management };
				}
				const provider = Object.assign(lifetime.add(new class extends Disposable { }()), {
					automations,
					id: name, label: name, order: 1, instantiationService: child, onDidChangeCatalog: Event.None, onDidChangeSession: Event.None,
					list: async () => [catalogSession()], listAgents: async () => nestedDraft ? [replacementAgent] : [],
					currentWorkspace: (): SessionWorkspaceSelection => sideChatHostSwitch
						? { type: 'local', root: name === 'Host A' ? '/workspace/host-a' : '/workspace/host-b' }
						: { type: 'current' },
					readCatalog: async () => catalogSession(), subscribe: async () => session, unsubscribe: async () => { },
					renameSession: async (target: ISession, title: string) => {
						record('rename', target.sessionId, 'same');
						await pausedRename?.p;
						session = { ...session, title };
						return session;
					},
					create: async () => ({ session, threadId: 'same' }), setModel: async () => { },
					forkChat: nestedDraft ? async (sessionId: string, source: string, title: string) => {
						record('fork', sessionId, source);
						const origin = { type: 'fork' as const, parentThreadId: source, parentSequence: 1 };
						const fork: AgentTreeNode = { ...sourceAgent, threadId: 'side', title, origin };
						session = {
							...session,
							chats: [...session.chats, { threadId: 'side', title, status: 'active', origin }],
							agentTree: [{ ...sourceAgent, children: [fork] }],
						};
						return { session, threadId: 'side' };
					} : undefined,
				}) as unknown as ISessionsProvider;
				const registration = lifetime.add(registry.registerProvider(provider));
				registrations.set(name, registration);
				lifetime.add(toDisposable(() => registrations.delete(name)));
			}
			context.blockRestorationUntil(services.get(ISessionsManagementService).initialize());
			return {};
		},
	});
	return {
		calls,
		submissions,
		pauseNextRename() {
			pausedRename = new DeferredPromise<void>();
		},
		rejectPausedRename() {
			const pending = pausedRename;
			if (!pending) throw new Error('No rename is paused');
			pausedRename = undefined;
			void pending.error(new Error('Synthetic rename failure'));
		},
		showAttentionDraft() {
			const view = services.get(ISessionsService);
			view.openNewSession();
			for (const selection of view.visibleSelections) {
				if (selection.kind === 'session') view.closeVisibleSelection(selection);
			}
		},
		newChatInSession: () => services.get(ICommandService).executeCommand<void>('sessions.chat.newInSession'),
		openSideChat: () => services.get(ICommandService).executeCommand<void>('ash.sessions.openSideChat'),
		async saveLegacyNestedDraft() {
			const selection = services.get(ISessionsService).activeSelection;
			if (selection?.kind !== 'untitled' || !selection.session.forkSource) throw new Error('Expected a nested draft');
			const storage = services.get(IStorageService);
			saveSessionGridState(storage, { references: [referenceForSelection(selection)], active: 0 }, [
				{ ...selection.session, agent: replacementAgent },
			]);
			await storage.flush();
		},
		async showComparisonGroup() {
			const groups = services.get(ISessionGroupsService);
			const group = await groups.create('Compare · Refactor the cache', undefined, 'comparison');
			const [first, second, judge] = ['Host A', 'Host B', 'Judge'].map(name => {
				const id = sessionIdentity(name, 'same', 'local-agent-host');
				return { sessionId: id, threadId: id };
			});
			for (const participant of [first, second, judge]) await groups.move(participant.sessionId, group.sectionId);
			await services.get(ISessionComparisonService).save({
				id: group.sectionId, providerId: 'Host A', source: first, sourceSequence: 1,
				task: 'Refactor the cache', isolated: true, judge, judgeFailed: true,
				attempts: [{ ...first, agent: 'Host A', number: 1 }, { ...second, agent: 'Host B', number: 2 }],
			});
		},
		activeProvider: () => services.get(ISessionsManagementService).activeUntitledSession?.providerId,
		open: async (name, sideBySide = false) => {
			const view = services.get(ISessionsService);
			if (sideBySide) {
				view.openNewSession(`${name} draft`, { sideBySide: true, providerId: name });
				return;
			}
			await view.openThread(sessionIdentity(name, 'same', 'local-agent-host'), sessionIdentity(name, 'same', 'local-agent-host'));
		},
		openLink: (name, sideBySide, threadId = 'same') => services.get(IOpenerService).open(
			buildOpenSessionLinkUri('same', threadId, sessionProviderAuthority(name, 'local-agent-host')), { openToSide: sideBySide }),
		disconnect: name => registrations.get(name)?.dispose(),
		completeRequiredCheck: () => completeRequiredCheck(),
		requiredCheckReads: () => requiredCheckReads,
	};
}

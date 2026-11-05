import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IAgentConnection } from '../../../src/ash/platform/agentHost/common/agentService.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { createServiceIdentifier } from '../../../src/ash/platform/instantiation/common/instantiation.js';
import { IAgentExecutionSettingsService } from '../../../src/ash/platform/agentHost/common/agentExecutionSettingsService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { registerWorkbenchServiceContribution } from '../../../src/ash/workbench/browser/workbenchServiceContributions.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { AgentHostAutomationStore } from '../../../src/ash/sessions/contrib/providers/agentHost/browser/agentHostAutomationStore.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { IChatService, type ThreadRead, type Thread, type StartTurnOptions, type ModelCatalogEntry } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { IPromptsService, type IAgentSkill } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ISessionGroupsService } from '../../../src/ash/sessions/services/sessions/browser/sessionGroupsService.js';
import { ISessionsProvidersService } from '../../../src/ash/sessions/services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import type { ISessionsProvider } from '../../../src/ash/sessions/services/sessions/common/sessionsProvider.js';
import type { AgentTreeNode, ISession, SessionWorkspaceSelection } from '../../../src/ash/sessions/services/sessions/common/session.js';
import { saveSessionGridState } from '../../../src/ash/sessions/services/sessions/browser/sessionGridState.js';
import { referenceForSelection } from '../../../src/ash/sessions/services/sessions/browser/visibleSessions.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { buildOpenSessionLinkUri } from '../../../src/ash/platform/agentHost/common/openSessionLink.js';
import { sessionIdentity, sessionProviderAuthority } from '../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
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
	calls: { host: string; method: string; sessionId: string; threadId: string; }[];
	submissions: Submission[];
} {
	const calls: { host: string; method: string; sessionId: string; threadId: string; }[] = [];
	const submissions: Submission[] = [];
	let services: InstantiationService;
	const registrations = new Map<string, { dispose(): void; }>();
	const params = new URL(location.href).searchParams;
	const sideThreads = params.has('sideThreads');
	const nestedDraft = params.has('nestedDraft');
	const sideChatHostSwitch = params.has('sideChatHostSwitch');
	const background = params.has('backgroundActivities');
	registerWorkbenchServiceContribution({
		service: createServiceIdentifier<object>('test.multiHostSessionsFixture'),
		dependencies: [ISessionsProvidersService, ISessionsManagementService, ISessionsService],
		install: context => {
			services = context.container;
			const registry = services.get(ISessionsProvidersService);
			for (const name of ['Host A', 'Host B']) {
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
				const read = (sessionId: string, threadId: string): ThreadRead => ({ thread: { advisor: { type: 'default' }, agentId: 'agent', origin: { type: 'root' }, sessionId, threadId, title: name, status: 'active', sequence: 1, usage, turns: [] }, transcript: { sessionId, threadId, durableSequence: 1, revision: 1, entries: [] } });
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
					github: { ...host.github, listAccounts: async () => [], listSessionPullRequests: async () => [], listSessionIssues: async () => [] },
				});
				const automations = automation ? lifetime.add(child.createInstance(AgentHostAutomationStore, name, observableValue<'connected'>('searchFixtureConnection', 'connected'))) : undefined;
				let session: ISession = { sessionId: 'same', title: params.has('comparisonPreview') ? `Attempt ${name === 'Host A' ? 1 : 2} · ${name}` : `Task from ${name}`, model: model.model, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'same', status: 'active', origin: { type: 'root' } }, ...(sideThreads ? [{ threadId: 'side', title: 'Follow-up chat', status: 'active' as const, origin: { type: 'fork' as const, parentThreadId: 'same', parentSequence: 1 } }] : [])], agentTree: background ? [{
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
				if (params.has('inheritWorkspace') && name === 'Host A') {
					session = { ...session, workspace: { authorityId: 'local', root: '/workspace/inherited-project' } };
				}
				const catalogSession = () => nestedDraft ? { ...session, agentTree: undefined } : session;
				if (params.has('blockedTitlebar') && name === 'Host B') {
					session = { ...session, management: { status: 'needsInput', statusChangedAtUnixMs: 1 } };
				}
				const provider = Object.assign(lifetime.add(new class extends Disposable { }()), {
					automations,
					id: name, label: name, order: 1, instantiationService: child, onDidChangeCatalog: Event.None, onDidChangeSession: Event.None,
					list: async () => [catalogSession()], listAgents: async () => nestedDraft ? [replacementAgent] : [],
					currentWorkspace: (): SessionWorkspaceSelection => ({ type: 'current' }),
					readCatalog: async () => catalogSession(), subscribe: async () => session, unsubscribe: async () => { },
					renameSession: async (target: ISession, title: string) => {
						record('rename', target.sessionId, 'same');
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
			for (const name of ['Host A', 'Host B']) {
				const id = sessionIdentity(name, 'same', 'local-agent-host');
				await groups.move(id, group.sectionId);
			}
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
	};
}

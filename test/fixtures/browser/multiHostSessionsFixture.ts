import { Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../src/ash/platform/instantiation/common/instantiation.js';
import { IAgentExecutionSettingsService } from '../../../src/ash/platform/agentHost/common/agentExecutionSettingsService.js';
import { IRendererHostService } from '../../../src/ash/platform/renderer/common/rendererHost.js';
import { registerWorkbenchServiceContribution } from '../../../src/ash/workbench/browser/workbenchServiceContributions.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { AgentHostAutomationStore } from '../../../src/ash/sessions/contrib/providers/agentHost/browser/agentHostAutomationStore.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { IChatService, type ThreadRead, type Thread, type StartTurnOptions, type ModelCatalogEntry } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ISessionsProvidersService } from '../../../src/ash/sessions/services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import type { ISessionsProvider } from '../../../src/ash/sessions/services/sessions/common/sessionsProvider.js';
import type { ISession, SessionWorkspaceSelection } from '../../../src/ash/sessions/services/sessions/common/session.js';
import { sessionIdentity } from '../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
import type { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';

/** Exercises the complete browser Workbench bootstrap with domain-owned fake hosts. */
export function installMultiHostSessionsFixture(): { open(host: string, sideBySide?: boolean): Promise<void>; disconnect(host: string): void; activeProvider(): string | undefined; calls: { host: string; method: string; sessionId: string; threadId: string; }[]; } {
	const calls: { host: string; method: string; sessionId: string; threadId: string; }[] = [];
	let services: InstantiationService;
	const registrations = new Map<string, { dispose(): void; }>();
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
				const usage: Thread['usage'] = { modelInvocations: 0, inputTokens: { reported: 0, complete: true }, outputTokens: { reported: 0, complete: true }, cachedInputTokens: { reported: 0, complete: true }, cacheWriteInputTokens: { reported: 0, complete: true }, reasoningTokens: { reported: 0, complete: true } };
				const read = (sessionId: string, threadId: string): ThreadRead => ({ thread: { advisor: { type: 'default' }, agentId: 'agent', origin: { type: 'root' }, sessionId, threadId, title: name, status: 'active', sequence: 1, usage, turns: [] }, transcript: { sessionId, threadId, durableSequence: 1, revision: 1, entries: [] } });
				const record = (method: string, sessionId: string, threadId: string): void => { if (sessionId !== 'same' || threadId !== 'same') throw new Error('A qualified identity reached a host'); calls.push({ host: name, method, sessionId, threadId }); };
				const chat = {
					onDidSubmitRequest: Event.None, onDidChangeSession: Event.None, onDidUpdateThread: Event.None, onDidUpdateThreadTranscript: Event.None, onDidUpdateGoal: Event.None, onDidBecomeReady: Event.None, onDidUpdateTurnChanges: Event.None, onDidChangeQueue: Event.None, onDidChangeInteractionOffer: Event.None,
					getInteractionOffer: () => undefined, listSlashCommands: async () => [], readAdvisorDefault: async () => null,
					readThread: async (sessionId: string, threadId: string) => { record('read', sessionId, threadId); return read(sessionId, threadId); },
					subscribeThread: async (sessionId: string, threadId: string) => { record('subscribe', sessionId, threadId); return { ...read(sessionId, threadId), updates: [] }; },
					unsubscribeThread: async (sessionId: string, threadId: string) => { record('unsubscribe', sessionId, threadId); },
					readContextUsage: async () => ({ estimatedTokens: 0, categories: [] }), queuedMessageCount: async () => 0,
					listTurnChanges: async () => [], readThreadChanges: async () => ({ sequence: 1, revision: '1', statistics: { files: 0, additions: 0, deletions: 0 }, repositories: [], warnings: [] }),
					readHistoryState: async () => ({ sequence: 1, canUndo: false, canRedo: false }), readCheckpoints: async () => [],
					startTurn: async (options: StartTurnOptions) => { record('send', options.sessionId, options.threadId); }, queueTurn: async (options: StartTurnOptions) => { record('queue', options.sessionId, options.threadId); },
				} as unknown as IChatService;
				child.registerInstance(IChatService, chat);
				child.registerInstance(ILanguageModelsService, {
					onDidChangeModels: Event.None, listModels: async () => [model], listModelCatalog: async () => [model], listAdvisorModels: async () => [model],
					readModelDefaults: async () => ({ revision: 1, model: model.model, reasoningEffort: null }), getDefaultNewChatModel: () => model.model,
					rememberSelectedModel: async () => { }, saveReasoningEffort: async () => { }, isModelVisible: () => true,
					listModelProviders: async () => [], readApprovalReviewModel: async () => ({ type: 'automatic' }),
				} as unknown as ILanguageModelsService);
				child.registerInstance(IPromptsService, { onDidChangeSkills: Event.None, onDidChangeHooks: Event.None, findAgentSkills: async () => [], getHooks: async () => [], dispose() { }, [Symbol.dispose]() { } } as unknown as IPromptsService);
				child.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
				const automation = name === 'Host A' && new URL(location.href).searchParams.has('search') ? globalThis.ashWebWorkbenchHost?.api.automation : undefined;
				child.registerInstance(IRendererHostService, { ...host, automation, github: { ...host.github, listAccounts: async () => [], listSessionPullRequests: async () => [], listSessionIssues: async () => [] } });
				const automations = automation ? lifetime.add(child.createInstance(AgentHostAutomationStore, name, observableValue<'connected'>('searchFixtureConnection', 'connected'))) : undefined;
				const session: ISession = { sessionId: 'same', title: `Task from ${name}`, model: model.model, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'same', status: 'active', origin: { type: 'root' } }], agentTree: [] };
				const provider = Object.assign(lifetime.add(new class extends Disposable { }()), {
					automations,
					id: name, label: name, order: 1, instantiationService: child, onDidChangeCatalog: Event.None, onDidChangeSession: Event.None,
					list: async () => [session], listAgents: async () => [], currentWorkspace: (): SessionWorkspaceSelection => ({ type: 'current' }),
					readCatalog: async () => session, subscribe: async () => session, unsubscribe: async () => { },
					create: async () => ({ session, threadId: 'same' }), setModel: async () => { },
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
		activeProvider: () => services.get(ISessionsManagementService).activeUntitledSession?.providerId,
		open: async (name, sideBySide = false) => {
			const view = services.get(ISessionsService);
			if (sideBySide) {
				view.openNewSession(`${name} draft`, { sideBySide: true, providerId: name });
				return;
			}
			await view.openThread(sessionIdentity(name, 'same', 'local-agent-host'), sessionIdentity(name, 'same', 'local-agent-host'));
		},
		disconnect: name => registrations.get(name)?.dispose(),
	};
}

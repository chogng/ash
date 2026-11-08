import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ModelCatalogEntry } from '../../../../platform/models/common/agentModels.js';
import { IChatService, type ChatAgent, type ThreadRead } from '../../../../workbench/services/chat/common/chatService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { IModelEvaluationTools, ModelEvaluationCaller, ModelEvaluationOperation, ModelEvaluationSelection } from '../../../services/appTools/browser/appTools.js';
import { comparisonTurn, ISessionComparisonService, type SessionComparisonService } from '../../../services/sessions/browser/sessionComparisonService.js';
import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { COMPARE_AGENTS_TOOLS_ENABLED_SETTING, type SessionComparison } from '../../../services/sessions/common/sessionComparison.js';
import type { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { readComparisonEvidence, startSessionComparison } from '../../chat/browser/agentHostDelegation.js';

/** Executes model evaluation against the initiating App Tools connection's Sessions scope. */
export class ModelEvaluationToolContribution implements IModelEvaluationTools {
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@ISessionComparisonService private readonly comparisons: SessionComparisonService,
		@IChatService private readonly chat: IChatService,
		@ILogService private readonly log: ILogService,
	) { }

	async execute(caller: ModelEvaluationCaller, operation: ModelEvaluationOperation, signal: AbortSignal): Promise<unknown> {
		this.checkEnabled();
		throwIfCancelled(signal);
		// app/request arrives on the primary host connection. Never resolve these raw
		// identities against whichever provider or conversation happens to be selected.
		const providerId = LOCAL_AGENT_HOST_PROVIDER_ID;
		const session = this.sessions.sessions.find(session => session.sessionId === caller.sessionId && (session.providerId ?? providerId) === providerId);
		if (!session || session.status !== 'active' || !session.chats.some(chat => chat.threadId === caller.threadId && chat.status === 'active')) {
			throw new Error(localize('sessions.compare.tools.callerUnavailable', 'The conversation that requested this evaluation is unavailable.'));
		}

		switch (operation.type) {
			case 'listModelComparisons': {
				const comparisons = this.comparisons.list().filter(comparison => comparison.providerId === providerId);
				return this.list(comparisons, operation);
			}
			case 'readModelComparison': {
				const comparison = this.comparisons.get(operation.comparisonId);
				if (!comparison || comparison.providerId !== providerId) {
					throw new Error(localize('sessions.compare.tools.missing', 'This model comparison is unavailable on the current host.'));
				}
				return this.read(comparison);
			}
			case 'getComparisonModels':
			case 'createModelComparison': {
				const provider = this.providers.getProvider(providerId);
				const scope = this.scopes.getProviderScope(providerId);
				const [agents, models, snapshot] = await Promise.all([
					provider?.listAgents() ?? [],
					scope.services.models.listModels(),
					this.chat.readThread(caller.sessionId, caller.threadId),
				]);
				scope.assertCurrent();
				throwIfCancelled(signal);
				const isolated = operation.workspaceMode === 'worktree';
				if (isolated && !snapshot.directory) {
					throw new Error(localize('sessions.compare.gitRequired', 'Code comparison requires a conversation with a Git workspace.'));
				}
				const candidates = isolated ? models.filter(model => model.capabilities?.agentMode !== 'unsupported') : models;
				if (operation.type === 'getComparisonModels') {
					return {
						workspaceMode: operation.workspaceMode,
						agents: agents.slice(0, 100).map(({ sourceId, name }) => ({ source_id: sourceId, agent: name })),
						models: candidates.slice(0, 250).map(model => ({
							model: model.model,
							label: model.displayName,
							reasoning_efforts: model.reasoningEffortOverride ? [model.reasoningEffortOverride] : model.supportedReasoningEfforts?.map(option => option.effort) ?? [],
						})),
						truncated: agents.length > 100 || candidates.length > 250,
					};
				}
				return this.create(caller, session, snapshot, agents, candidates, operation, signal);
			}
		}
	}

	private checkEnabled(): void {
		if (!this.configuration.getValue<boolean>(COMPARE_AGENTS_TOOLS_ENABLED_SETTING) || this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
			throw new Error(localize('sessions.compare.tools.disabled', 'Model evaluation tools are disabled in Settings.'));
		}
	}

	private async create(
		caller: ModelEvaluationCaller,
		session: ISession,
		snapshot: ThreadRead,
		agents: readonly ChatAgent[],
		models: readonly ModelCatalogEntry[],
		operation: Extract<ModelEvaluationOperation, { type: 'createModelComparison'; }>,
		signal: AbortSignal,
	): Promise<unknown> {
		this.checkEnabled();
		const turn = snapshot.thread.turns.find(turn => turn.turnId === caller.turnId);
		if (!turn || this.groups.groups.some(group => group.kind === 'comparison' && group.sessionIds.includes(caller.sessionId))
			|| turn.items.some(item => item.type === 'userContext' && isComparisonContext(item.content))) {
			throw new Error(localize('sessions.compare.tools.participant', 'Only an initiating conversation can launch an evaluation.'));
		}

		const select = (selection: ModelEvaluationSelection) => {
			const agent = agents.find(agent => agent.sourceId === selection.sourceId && agent.name === selection.agent);
			const model = models.find(model => model.model.provider === selection.model.provider && model.model.model === selection.model.model);
			const effort = selection.reasoningEffort;
			if (!agent || !model || effort && (model.reasoningEffortOverride
				? model.reasoningEffortOverride !== effort
				: !model.supportedReasoningEfforts?.some(option => option.effort === effort))) {
				throw new Error(localize('sessions.compare.tools.selection', 'The selected Agent, model, or reasoning effort is unavailable. Refresh the comparison model list.'));
			}
			return {
				agent,
				settings: { model: model.model, reasoningEffort: effort ?? model.effectiveReasoningEffort ?? model.defaultReasoningEffort, approvalMode: turn.approvalMode },
			};
		};
		const attempts = operation.attempts.map(select);
		const judge = operation.judge ? select(operation.judge) : undefined;
		const synthesis = operation.synthesizer ? select(operation.synthesizer) : undefined;
		const { comparisonId, attempts: launched } = await startSessionComparison({
			sessions: this.sessions, groups: this.groups, comparisons: this.comparisons, scopes: this.scopes, chat: this.chat,
		}, {
			session, providerId: LOCAL_AGENT_HOST_PROVIDER_ID, threadId: caller.threadId, snapshot, task: operation.prompt,
			isolated: operation.workspaceMode === 'worktree', folderless: operation.workspaceMode === 'folderless',
			attempts, judge, synthesis, signal,
			report: (name, error) => this.log.warn('Model comparison launch failed', name, error),
		});
		return {
			comparisonId: comparisonId ?? null,
			attempts: attempts.map(({ agent, settings }, index) => {
				const attempt = launched.find(attempt => attempt.number === index + 1);
				return { number: index + 1, agent: agent.name, settings, status: attempt ? 'launched' : 'launchFailed', target: attempt && threadTarget(attempt) };
			}),
		};
	}

	private list(comparisons: readonly SessionComparison[], options: Extract<ModelEvaluationOperation, { type: 'listModelComparisons'; }>) {
		const summaries = comparisons.map(comparison => this.summarize(comparison))
			.filter(comparison => (options.includeArchived || !comparison.archived)
				&& (options.workspace === null || options.workspace === comparison.workspace)
				&& (!options.comparisonIds.length || options.comparisonIds.includes(comparison.comparisonId)))
			.sort((left, right) => left.comparisonId.localeCompare(right.comparisonId));
		const { cursor } = options;
		const after = cursor === null ? summaries : summaries.filter(summary => summary.comparisonId.localeCompare(cursor) > 0);
		const page = after.slice(0, 20);
		return { comparisons: page, nextCursor: after.length > page.length ? page.at(-1)?.comparisonId : undefined };
	}

	private async read(comparison: SessionComparison) {
		const reads = await Promise.all(comparison.attempts.map(attempt => this.chat.readThread(attempt.sessionId, attempt.threadId).catch(() => undefined)));
		const attempts = comparison.attempts.map((attempt, index) => {
			const read = reads[index];
			const turn = read && comparisonTurn(read.thread, attempt, comparison.task);
			return {
				number: attempt.number,
				agent: attempt.agent,
				settings: attempt.settings,
				status: turn?.status ?? 'unavailable',
				usage: turn?.usage,
				target: read && threadTarget(attempt),
			};
		});
		const evidence = await readComparisonEvidence(this.chat, comparison, undefined, reads).catch(() => undefined);
		return {
			...this.summarize(comparison),
			task: comparison.task.slice(0, 16_000),
			attempts: [...attempts, ...(comparison.failedAttempts ?? []).map(attempt => ({ ...attempt, status: 'launchFailed' }))].sort((left, right) => left.number - right.number),
			evidence,
			judge: comparison.judge && threadTarget(comparison.judge),
			judgeFailed: comparison.judgeFailed ?? false,
			verdict: comparison.verdict,
			synthesis: comparison.synthesis && threadTarget(comparison.synthesis),
		};
	}

	private summarize(comparison: SessionComparison) {
		const source = this.sessions.sessions.find(session => session.sessionId === comparison.source.sessionId);
		const attemptSessions = comparison.attempts.map(attempt => this.sessions.sessions.find(session => session.sessionId === attempt.sessionId));
		return {
			comparisonId: comparison.id,
			workspace: comparison.workspace ?? (!comparison.folderless && source?.workspace ? sessionWorkspaceUri(source.workspace).toString() : null),
			workspaceMode: comparison.isolated ? 'worktree' : comparison.folderless ? 'folderless' : 'answers',
			scenario: comparison.task.slice(0, 160),
			attemptCount: comparison.attempts.length + (comparison.failedAttempts?.length ?? 0),
			archived: attemptSessions.every(session => session?.status === 'archived'),
		};
	}
}

function threadTarget({ sessionId, threadId }: { readonly sessionId: string; readonly threadId: string; }) {
	return { session_id: sessionId, thread_id: threadId };
}

function isComparisonContext(content: string): boolean {
	if (!content.includes('ash.attempt-comparison.v1')) return false;
	try {
		return JSON.parse(content)?.schema === 'ash.attempt-comparison.v1';
	} catch {
		return false;
	}
}

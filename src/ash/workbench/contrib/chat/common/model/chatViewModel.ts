import type { IChatToolInvocation } from '../chatService/chatService.js';
import type { IChatHookPart, ChatContentPart, LoadedTurnSkill, PlanUpdate, QueuedMessage, QueueMessageTarget, ThreadGoal, ThreadItem, ThreadTranscriptEntry, Turn, TurnChangeSetSummary, TurnError } from '../../../../services/chat/common/chatService.js';
import { getNLSLanguage, localize } from '../../../../../nls.js';
import { isChatResponseFeedbackTarget, type ChatResponseFeedbackTarget } from '../chatResponseFeedback.js';

/** Both Chat presentations describe the same backend-owned goal without translating user content. */
export function formatChatGoal(goal: ThreadGoal): string {
	const status: Record<ThreadGoal['status'], string> = {
		active: localize('chat.goal.active', 'Active'),
		paused: localize('chat.goal.paused', 'Paused'),
		blocked: localize('chat.goal.blocked', 'Blocked'),
		usageLimited: localize('chat.goal.usageLimited', 'Usage limit reached'),
		budgetLimited: localize('chat.goal.budgetLimited', 'Budget limit reached'),
		complete: localize('chat.goal.complete', 'Complete'),
	};
	const numbers = new Intl.NumberFormat(getNLSLanguage());
	const usage = goal.tokenBudget === null || goal.tokenBudget === undefined
		? localize('chat.goal.tokensUsed', '{0} tokens', numbers.format(goal.tokensUsed))
		: localize('chat.goal.tokenBudget', '{0}/{1} tokens', numbers.format(goal.tokensUsed), numbers.format(goal.tokenBudget));
	return localize('chat.goal.summary', 'Goal · {0} · {1} · {2}', status[goal.status], usage, goal.objective);
}

export type ChatTurnErrorAction =
	| { readonly type: 'retry'; readonly label: string; readonly turnId: string; }
	| { readonly type: 'chooseModel'; readonly label: string; }
	| { readonly type: 'startNewChat'; readonly label: string; }
	| { readonly type: 'revise'; readonly label: string; };

interface ChatTurnErrorListItemOptions {
	readonly actionsEnabled?: boolean;
}

/** One render-ready committed or transient Thread item. */
export interface IChatListItem {
	readonly feedbackSource?: ChatResponseFeedbackTarget;
	readonly canGiveModelFeedback?: boolean;
	readonly canForkAfterResponse?: boolean;
	readonly turnChanges?: TurnChangeSetSummary['statistics'];
	readonly loadedSkills?: readonly LoadedTurnSkill[];
	readonly queueTarget?: QueueMessageTarget;
	readonly historyRedoTarget?: { readonly sessionId: string; readonly threadId: string; readonly expectedSequence: number; };
	/** Initial accepted request identity; presentation entry IDs are not backend item IDs. */
	readonly requestSource?: { readonly sessionId: string; readonly threadId: string; readonly turnId: string; readonly itemId: string; };
	readonly canForkBeforeRequest?: boolean;
	readonly canRunAnotherVersion?: boolean;
	readonly canCompareResults?: boolean;
	readonly id: string;
	readonly type: ThreadItem['type'] | 'turnError' | 'advisor' | 'hook' | 'skillLoad' | 'voiceTranscript' | 'queuedMessage' | 'historyRedo';
	readonly content?: readonly ChatContentPart[];
	/** Resources whose bytes are supplied by the conversation's resource reader. */
	readonly resources?: readonly {
		readonly uri: string;
		readonly name: string;
		readonly kind: 'image' | 'audio' | 'video' | 'document' | 'html';
		readonly mimeType?: string;
		readonly frameOrigin?: string;
	}[];
	readonly markdown?: { readonly supportHtml: boolean; };
	readonly attachmentSource?: { readonly sessionId: string; readonly threadId: string; readonly itemId: string; readonly kind: 'item' | 'toolResult'; };
	readonly hookPart?: IChatHookPart;
	readonly toolInvocation?: IChatToolInvocation;
	readonly text: string;
	/** Exact Core-accepted context body, independent of any current composer draft. */
	readonly contextText?: string;
	readonly contextSourceUrl?: string;
	readonly contextEntries?: readonly { readonly id: string; readonly label: string; readonly text: string; }[];
	readonly conversationLink?: { readonly label: string; readonly sessionId: string; readonly threadId: string; };
	readonly transient: boolean;
	readonly isError?: boolean;
	readonly label?: string;
	readonly detail?: string;
	readonly errorCode?: TurnError['code'];
	readonly action?: ChatTurnErrorAction;
}

export interface ChatStreamingResponseUpdate {
	readonly previousText: string;
	readonly item: IChatListItem;
}

/** Footer commands receive an untyped row argument from the command service. */
export function getCompletedChatResponseSource(value: unknown): ChatResponseFeedbackTarget | undefined {
	if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'agentMessage'
		|| !('transient' in value) || value.transient !== false || ('isError' in value && value.isError)
		|| !('feedbackSource' in value) || !isChatResponseFeedbackTarget(value.feedbackSource)) return undefined;
	return value.feedbackSource;
}

/** Projects an existing transient text append independently of the rest of its turn. */
export function chatStreamingResponseUpdate(previous: ThreadTranscriptEntry | undefined, next: ThreadTranscriptEntry): ChatStreamingResponseUpdate | undefined {
	if (previous?.type !== 'item' || next.type !== 'item' || previous.entryId !== next.entryId || previous.turnId !== next.turnId
		|| !previous.transient || !next.transient || previous.item.type !== 'agentMessage' || next.item.type !== 'agentMessage'
		|| previous.item.itemId !== next.item.itemId || !/\S/u.test(previous.item.text) || next.item.text.length <= previous.item.text.length
		|| !next.item.text.startsWith(previous.item.text)) return undefined;
	return { previousText: previous.item.text, item: chatTranscriptListItem(next) };
}

/** Delivering messages belong to the running turn once accepted by Core. */
export function chatQueuedMessageListItems(queue: readonly QueuedMessage[]): readonly IChatListItem[] {
	return queue.filter(message => message.status !== 'delivering').map(message => {
		const { sessionId, threadId, commandId, revision } = message;
		return {
			id: `queue:${JSON.stringify([sessionId, threadId, commandId])}`,
			type: 'queuedMessage',
			queueTarget: { sessionId, threadId, commandId, expectedRevision: revision },
			text: message.text || localize('chat.queue.contextOnly', 'Message with attached context'),
			label: message.status === 'paused' ? localize('chat.queue.paused', 'Paused')
				: message.status === 'rejected' ? localize('chat.queue.rejected', 'Failed') : localize('chat.queue.pending', 'Queued'),
			detail: message.error ?? (message.contextCount ? localize('chat.queue.contextCount', '{0} attached inputs', message.contextCount) : undefined),
			isError: message.status === 'rejected',
			transient: false,
		};
	});
}

/** Projects the canonical durable plan owned by a Turn. */
export function chatPlanListItem(turn: Turn): IChatListItem | undefined {
	if (!turn.plan) return undefined;
	return chatPlanUpdateListItem(turn.turnId, turn.plan);
}

function chatPlanUpdateListItem(turnId: string, plan: PlanUpdate): IChatListItem {
	const steps = plan.steps.map((step) => {
		switch (step.status) {
			case 'completed': return `- [x] ${step.step}`;
			case 'inProgress': return `- [ ] **${localize('chat.plan.inProgress', 'In progress:')}** ${step.step}`;
			case 'pending': return `- [ ] ${step.step}`;
		}
	});
	return {
		id: `turn-plan:${turnId}`,
		type: 'plan',
		text: [plan.explanation, ...steps].filter((value): value is string => Boolean(value)).join('\n\n'),
		transient: false,
	};
}

/** Associates backend tool evidence within a Turn while preserving transcript order. */
export function chatTranscriptListItems(
	entries: readonly ThreadTranscriptEntry[],
	latestTurnId?: string,
	turns: readonly Turn[] = [],
	source?: { readonly sessionId: string; readonly threadId: string; readonly commandTerminals?: boolean; },
	forkHistory?: { readonly archived: boolean; readonly hasOlderTurns?: boolean; },
	changeSets: readonly TurnChangeSetSummary[] = [],
): readonly IChatListItem[] {
	const completedTurns = new Map(turns.filter(turn => turn.status === 'completed').map(turn => [turn.turnId, turn]));
	const turnChanges = new Map<string, TurnChangeSetSummary['statistics']>();
	for (const { turnId, captureState, statistics } of changeSets) {
		if (captureState !== 'sealed' || !statistics.files || !completedTurns.has(turnId)) continue;
		const previous = turnChanges.get(turnId);
		turnChanges.set(turnId, previous ? {
			files: previous.files + statistics.files,
			additions: previous.additions + statistics.additions,
			deletions: previous.deletions + statistics.deletions,
		} : statistics);
	}
	const skillsByTurn = new Map<string, LoadedTurnSkill[]>();
	for (const entry of entries) {
		if (entry.type !== 'skillLoad' || !completedTurns.has(entry.turnId)) continue;
		const skills = skillsByTurn.get(entry.turnId);
		if (skills) skills.push(entry.skill);
		else skillsByTurn.set(entry.turnId, [entry.skill]);
	}
	const finalReplies = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type === 'item' && entry.item.type === 'agentMessage' && !entry.transient && (turnChanges.has(entry.turnId) || skillsByTurn.has(entry.turnId))) {
			finalReplies.set(entry.turnId, entry.entryId);
		}
	}
	const editableRequests = new Map(turns
		.filter(turn => !turn.kind || turn.kind === 'coding' || turn.kind === 'review')
		.map(turn => [turn.turnId, turn.items.find(item => item.type === 'userMessage')?.itemId]));
	const firstRequestTurn = forkHistory?.hasOlderTurns ? undefined : turns.find(turn => editableRequests.get(turn.turnId))?.turnId;
	// Call IDs are provider-owned and can be reused in another Turn. Keep presentation identity scoped.
	const key = (turnId: string, toolCallId: string) => JSON.stringify([turnId, toolCallId]);
	const toolCalls = new Map(entries.flatMap(entry => entry.type === 'item' && entry.item.type === 'toolCall' ? [[key(entry.turnId, entry.item.toolCallId), entry] as const] : []));
	const toolResults = new Map(entries.flatMap(entry => entry.type === 'item' && entry.item.type === 'toolResult' ? [[key(entry.turnId, entry.item.toolCallId), entry.item] as const] : []));
	const outputs = new Map<string, Extract<ThreadTranscriptEntry, { readonly type: 'toolOutput'; }>[]>();
	for (const entry of entries) {
		if (entry.type !== 'toolOutput') continue;
		const identity = key(entry.turnId, entry.toolCallId);
		const output = outputs.get(identity) ?? [];
		output.push(entry);
		outputs.set(identity, output);
	}
	const stoppedTurns = new Set(turns.filter(turn => turn.status === 'failed' || turn.status === 'interrupted' || turn.status === 'completed').map(turn => turn.turnId));
	for (const entry of entries) if (entry.type === 'turnError') stoppedTurns.add(entry.turnId);
	const startedCalls = new Set(turns.flatMap(turn => (turn.startedToolCallIds ?? []).map(callId => key(turn.turnId, callId))));
	// Parallel calls can be in different states. Only the interaction's exact Item is waiting.
	const pendingInteractions = new Map(turns.flatMap(turn => {
		const pending = turn.pendingInteraction;
		if (!pending?.itemId) return [];
		const waitingStatus = {
			approval: 'waitingForApproval', permissions: 'waitingForUserInput',
			toolResultReview: 'waitingForApproval',
			userInput: 'waitingForUserInput', dynamicTool: 'waitingForCapability',
		};
		return turn.status === waitingStatus[pending.kind] ? [[turn.turnId, pending] as const] : [];
	}));
	const calls = new Map(entries.flatMap(entry => entry.type === 'item' && entry.item.type === 'toolCall' && entry.item.name === 'advisor' ? [[key(entry.turnId, entry.item.toolCallId), entry] as const] : []));
	const results = new Set(entries.flatMap(entry => entry.type === 'item' && entry.item.type === 'toolResult' ? [key(entry.turnId, entry.item.toolCallId)] : []));
	return entries.flatMap<IChatListItem>(entry => {
		if (entry.type === 'toolOutput') {
			const call = toolCalls.get(key(entry.turnId, entry.toolCallId));
			if (call?.item.type === 'toolCall' && call.item.name !== 'advisor') return [];
		}
		if (entry.type === 'item' && entry.item.type === 'toolCall' && entry.item.name !== 'advisor') {
			const call = entry.item;
			const identity = key(entry.turnId, call.toolCallId);
			const result = toolResults.get(identity);
			const output = outputs.get(identity) ?? [];
			const pending = pendingInteractions.get(entry.turnId);
			return [{
				id: entry.entryId, type: 'toolCall' as const,
				text: [call.name, call.argumentsJson, ...output.map(value => `${value.stream}: ${value.text}`), result?.text].filter(Boolean).join('\n\n'),
				transient: !result && !stoppedTurns.has(entry.turnId), isError: result?.isError,
				toolInvocation: {
					call, result, output, streaming: entry.transient && !result && !stoppedTurns.has(entry.turnId), stopped: stoppedTurns.has(entry.turnId),
					...(source?.commandTerminals && call.name === 'shell-session' ? { commandTerminalSource: { sessionId: source.sessionId, threadId: source.threadId } } : {}),
					waitingFor: !result && !stoppedTurns.has(entry.turnId) && pending?.itemId === call.itemId ? pending.kind : undefined,
					executionStarted: startedCalls.has(identity),
				},
				...(source && result?.content?.some(part => part.type !== 'text') ? { attachmentSource: { sessionId: source.sessionId, threadId: source.threadId, itemId: result.itemId, kind: 'toolResult' as const } } : {}),
			}];
		}
		if (entry.type === 'item' && entry.item.type === 'toolResult') {
			const call = toolCalls.get(key(entry.turnId, entry.item.toolCallId));
			if (call?.item.type === 'toolCall' && call.item.name !== 'advisor') return [];
		}
		if (entry.type === 'item' && entry.item.type === 'toolCall' && calls.has(key(entry.turnId, entry.item.toolCallId))) {
			if (results.has(key(entry.turnId, entry.item.toolCallId))) return [];
			return [{ id: entry.entryId, type: 'advisor' as const, text: localize('chat.advisor.consulting', 'Consulting the selected model…'), transient: entry.transient, label: localize('advisor.settings.title', 'Advisor') }];
		}
		if (entry.type === 'item' && entry.item.type === 'toolResult' && calls.has(key(entry.turnId, entry.item.toolCallId))) {
			const item = entry.item;
			let value: unknown;
			try { value = JSON.parse(item.text); } catch { /* Core policy/recovery errors are plain text tool results. */ }
			if (typeof value !== 'object' || value === null) return [{ ...chatListItem(item), id: entry.entryId, type: 'advisor' as const, label: localize('advisor.settings.title', 'Advisor') }];
			const result = value as Record<string, unknown>;
			const model = result.model as { provider?: unknown; model?: unknown; } | undefined;
			const modelLabel = typeof model?.provider === 'string' && typeof model.model === 'string' ? `${model.provider}/${model.model}` : localize('advisor.settings.title', 'Advisor');
			const advice = typeof result.advice === 'string' ? result.advice
				: typeof result.message === 'string' ? result.message
					: result.status === 'limitReached' ? localize('chat.advisor.limitReached', 'The advisor call limit for this Turn has been reached.')
						: localize('chat.advisor.noAdvice', 'No advice returned');
			const usage = result.usage as { inputTokens?: number; outputTokens?: number; } | undefined;
			const details = [
				typeof result.question === 'string' ? result.question : undefined,
				typeof result.sourceSequence === 'number' ? localize('chat.advisor.sequence', 'Conversation sequence {0}', result.sourceSequence) : undefined,
				usage ? localize('chat.advisor.tokens', 'Tokens: {0} input · {1} output',
					usage.inputTokens ?? localize('chat.advisor.unknown', 'unknown'),
					usage.outputTokens ?? localize('chat.advisor.unknown', 'unknown')) : undefined,
			].filter(Boolean).join(' · ');
			return [{ id: entry.entryId, type: 'advisor' as const, text: advice, transient: false, isError: item.isError, label: localize('chat.advisor.modelLabel', 'Advisor · {0}', modelLabel), detail: details }];
		}
		let item = chatTranscriptListItem(entry, { actionsEnabled: entry.turnId === latestTurnId });
		const isFinalReply = finalReplies.get(entry.turnId ?? '') === entry.entryId;
		if (isFinalReply && entry.turnId !== undefined) {
			const loadedSkills = skillsByTurn.get(entry.turnId);
			if (loadedSkills) item = { ...item, loadedSkills };
		}
		if (source && entry.type === 'item' && entry.item.type === 'agentMessage' && !entry.transient && completedTurns.has(entry.turnId)) {
			const changes = isFinalReply ? turnChanges.get(entry.turnId) : undefined;
			item = {
				...item,
				feedbackSource: { sessionId: source.sessionId, threadId: source.threadId, turnId: entry.turnId, itemId: entry.item.itemId },
				canGiveModelFeedback: !!completedTurns.get(entry.turnId)?.model,
				canForkAfterResponse: !forkHistory?.archived,
				...(changes ? { turnChanges: changes } : {}),
			};
		}
		if (source && entry.type === 'item' && entry.item.type === 'userMessage' && !entry.transient) {
			if (editableRequests.get(entry.turnId) === entry.item.itemId) {
				item = {
					...item,
					requestSource: { ...source, turnId: entry.turnId, itemId: entry.item.itemId },
					canForkBeforeRequest: !forkHistory?.archived && entry.turnId !== firstRequestTurn,
				};
			}
		}
		return source && entry.type === 'item' && item.content?.some(part => part.type !== 'text')
			? [{ ...item, attachmentSource: { sessionId: source.sessionId, threadId: source.threadId, itemId: entry.item.itemId, kind: entry.item.type === 'toolResult' ? 'toolResult' as const : 'item' as const } }] : [item];
	});
}

/** Maps one backend-assembled transcript entry to Chat presentation. */
export function chatTranscriptListItem(entry: ThreadTranscriptEntry, options: TranscriptListItemOptions = {}): IChatListItem {
	switch (entry.type) {
		case 'voiceTranscript': return { id: entry.entryId, type: 'voiceTranscript', text: entry.transcript.text, transient: false, label: entry.transcript.speaker === 'user' ? localize('chat.voice.transcript.user', 'Your voice transcript') : localize('chat.voice.transcript.assistant', 'Voice reply transcript') };
		case 'skillLoad': return {
			id: entry.entryId, type: 'skillLoad', transient: false,
			label: localize('chat.skills.loadedActivity', 'Loaded Skill · {0}', entry.skill.name),
			text: formatLoadedSkillReason(entry.skill.reason),
		};
		case 'hookRun': return chatHookListItem(entry);
		case 'item': return { ...chatListItem(entry.item, entry.transient), id: entry.entryId };
		case 'turnPlan': return { ...chatPlanUpdateListItem(entry.turnId, entry.plan), id: entry.entryId };
		case 'turnError': {
			const presentation = turnErrorPresentation(entry.turnId, entry.error);
			return {
				id: entry.entryId,
				type: 'turnError',
				text: entry.error.message,
				transient: false,
				isError: true,
				label: presentation.label,
				detail: presentation.detail,
				errorCode: entry.error.code,
				action: options.actionsEnabled === false ? undefined : presentation.action,
			};
		}
		case 'toolOutput': return {
			id: entry.entryId,
			type: 'toolResult',
			text: entry.text,
			transient: true,
			isError: entry.stream === 'stderr',
			label: entry.stream === 'stderr' ? localize('chat.transcript.toolStderr', 'Tool stderr') : localize('chat.transcript.toolStdout', 'Tool stdout'),
		};
	}
}

interface TranscriptListItemOptions {
	readonly actionsEnabled?: boolean;
}

/** Projects one durable Turn failure as a conversation item. */
export function chatTurnErrorListItem(turn: Turn, options: ChatTurnErrorListItemOptions = {}): IChatListItem | undefined {
	if (turn.status !== 'failed') return undefined;
	const error = turn.error ?? undefined;
	const presentation = error ? turnErrorPresentation(turn.turnId, error) : undefined;
	return {
		id: `turn-error:${turn.turnId}`,
		type: 'turnError',
		text: error?.message ?? localize('chat.turnError.failed', 'Turn failed'),
		transient: false,
		isError: true,
		label: presentation?.label,
		detail: presentation?.detail,
		errorCode: error?.code,
		action: options.actionsEnabled === false || turn.kind !== undefined && turn.kind !== 'coding' && turn.kind !== 'review' ? undefined : presentation?.action,
	};
}

function turnErrorPresentation(turnId: string, error: TurnError): { readonly label: string; readonly detail: string; readonly action?: ChatTurnErrorAction; } {
	switch (error.code) {
		case 'policyCircuitBreaker':
			return {
				label: localize('chat.policyCircuitBreaker.label', 'Automatic review stopped this turn'),
				detail: localize('chat.policyCircuitBreaker.detail', 'Repeated actions were rejected. Review the reason before requesting a safer approach.'),
			};
		case 'connectionFailed':
		case 'providerUnavailable':
		case 'providerHttp':
		case 'modelInvocationFailed':
			return retryPresentation(turnId, localize('chat.turnError.model.label', 'Model error'), localize('chat.turnError.model.detail', 'The model request may have failed temporarily.'));
		case 'contextOverflow':
			return {
				label: localize('chat.turnError.context.label', 'Context limit'),
				detail: localize('chat.turnError.context.detail', 'Automatic context recovery was exhausted. Start a new chat or send a smaller request.'),
				action: { type: 'startNewChat', label: localize('chat.turnError.startNewChat', 'Start new chat') },
			};
		case 'modelConfiguration':
		case 'providerCredentials':
		case 'providerAuth':
			return {
				label: localize('chat.turnError.auth.label', 'Authentication'),
				detail: localize('chat.turnError.auth.detail', 'Choose a model with working credentials before sending another message.'),
				action: { type: 'chooseModel', label: localize('chat.turnError.chooseModel', 'Choose another model') },
			};
		case 'invalidRequest':
			return revisePresentation(localize('chat.turnError.request.label', 'Invalid request'), localize('chat.turnError.request.detail', 'Revise the request or choose a different model.'));
		case 'invalidResponse':
			return retryPresentation(turnId, localize('chat.turnError.response.label', 'Invalid response'), localize('chat.turnError.response.detail', 'The model returned a response Ash could not use.'));
		case 'completionPersistenceFailed':
			return retryPresentation(turnId, localize('chat.turnError.save.label', 'Save failed'), localize('chat.turnError.save.detail', 'The Turn completion could not be saved. Review the conversation before retrying.'));
		case 'interactionDeadlineElapsed':
			return retryPresentation(turnId, localize('chat.turnError.expired.label', 'Interaction expired'), localize('chat.turnError.expired.detail', 'The requested interaction expired before it received a response.'));
		case 'toolRepetition':
			return revisePresentation(localize('chat.turnError.repetition.label', 'Repeated tool failure'), localize('chat.turnError.repetition.detail', 'The same tool and arguments failed five times. Ask Ash to use a different approach or explain the blocker.'));
		case 'rateLimited':
		case 'usageLimited':
			return {
				label: localize('chat.turnError.usage.label', 'Usage limit'),
				detail: localize('chat.turnError.usage.detail', "The model provider's usage limit was reached. Choose another model or try again later."),
				action: { type: 'chooseModel', label: localize('chat.turnError.chooseModel', 'Choose another model') },
			};
		case 'worktreeCaptureFailed':
			return retryPresentation(turnId, localize('chat.turnError.capture.label', 'Worktree capture failed'), localize('chat.turnError.capture.detail', 'The Turn could not create its immutable worktree baseline, so write tools were not allowed.'));
	}
}

function retryPresentation(turnId: string, label: string, detail: string): { readonly label: string; readonly detail: string; readonly action: ChatTurnErrorAction; } {
	return { label, detail, action: { type: 'retry', label: localize('chat.turnError.retry', 'Try again'), turnId } };
}

function revisePresentation(label: string, detail: string): { readonly label: string; readonly detail: string; readonly action: ChatTurnErrorAction; } {
	return { label, detail, action: { type: 'revise', label: localize('chat.turnError.revise', 'Change approach') } };
}

/** Maps a Chat Thread item without interpreting untrusted content. */
export function chatListItem(item: ThreadItem, transient = false): IChatListItem {
	switch (item.type) {
		case 'userMessage':
		case 'agentMessage':
		case 'reasoning':
		case 'plan':
			return {
				id: item.itemId,
				type: item.type,
				text: item.text,
				transient,
			};
		case 'userContext':
			return {
				id: item.itemId,
				type: item.type,
				text: item.name,
				contextText: item.content,
				contextSourceUrl: item.sourceUrl ?? undefined,
				transient,
			};
		case 'userImage': return { id: item.itemId, type: item.type, text: localize('chat.media.image', 'Image'), transient, content: [{ type: 'imageUrl', url: item.url, detail: 'auto' }] };
		case 'userImageAttachment': return { id: item.itemId, type: item.type, text: localize('chat.media.image', 'Image'), transient, content: [{ type: 'imageAttachment', attachment: item.attachment, detail: 'auto' }] };
		case 'userAudioAttachment':
			return {
				id: item.itemId,
				type: item.type,
				text: localize('chat.media.audioDuration', 'Audio ({0} seconds)', Math.ceil(item.attachment.durationMs / 1000)),
				content: [{ type: 'audioAttachment', attachment: item.attachment }],
				transient,
			};
		case 'toolCall':
			return {
				id: item.itemId,
				type: item.type,
				text: `${item.name}\n${item.argumentsJson}`,
				transient,
			};
		case 'toolResult':
			return {
				id: item.itemId,
				type: item.type,
				text: item.text,
				transient,
				isError: item.isError,
				content: item.content ?? undefined,
			};
	}
}

/** Describes the trigger using the same vocabulary in activity and reply details. */
export function formatLoadedSkillReason(reason: LoadedTurnSkill['reason']): string {
	return reason === 'explicit'
		? localize('chat.skills.explicit', 'Manually selected')
		: localize('chat.skills.automatic', 'Automatically selected');
}

/** Converts one Hook outcome for both Chat presentations. */
export function chatHookListItem(entry: Extract<ThreadTranscriptEntry, { readonly type: 'hookRun'; }>): IChatListItem {
	const run = entry.run;
	const reason = run.status.type === 'denied' || run.status.type === 'cancelled' ? run.status.reason : run.status.type === 'failed' ? run.status.message : '';
	return {
		id: entry.entryId,
		type: 'hook',
		text: reason,
		transient: run.status.type === 'running',
		isError: run.status.type === 'denied' || run.status.type === 'failed',
		hookPart: { kind: 'hook', run },
	};
}

import { createUuid } from '../../../base/common/uuid.js';
import { canceled } from '../../../base/common/errors.js';
import { createAppServerResourceApi, readAppServerResource } from './appServerApi.js';
import { Event } from '../../../base/common/event.js';
import type { AgentSession, AgentExecutionNode, SessionResult, SessionThreadResult } from '../common/agentService.js';
import { AppServerRemoteError } from '../common/appServerError.js';
import { AgentThreadHistoryConflictError } from '../common/agentService.js';
import type {
	AgentResponse as AgentResponseDto,
	Thread as ThreadDto,
	ThreadItem as ThreadItemDto,
	ThreadTranscriptEntry as ThreadTranscriptEntryDto,
	ThreadTranscriptSnapshot as ThreadTranscriptSnapshotDto,
	ThreadTranscriptUpdateEnvelope as ThreadTranscriptUpdateEnvelopeDto,
	ThreadUpdateEnvelope as ThreadUpdateEnvelopeDto
} from '../../../../../.build/protocol/typescript/index.js';
import type {
	AgentResponse,
	ChatContentPart,
	Thread,
	ThreadItem,
	ThreadTranscriptEntry,
	ThreadTranscriptSnapshot,
	ThreadTranscriptUpdateEnvelope,
	ThreadUpdate,
	ThreadUpdateEnvelope
} from '../common/agentService.js';
import type {
	SessionRequest,
	SessionRequestParams,
	SessionRequestResult,
	SessionResult as SessionResultDto,
	SessionThreadResult as SessionThreadResultDto,
	Session as SessionDto,
	AgentTreeNodeProjection as AgentNodeDto,
	TurnStartResult,
	TurnInterruptResult,
	TurnSteerResult,
	TurnInteractionResolveResult
} from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from './appServerProtocolClient.js';
import { appServerRequest, voidResult } from './appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type {
	IAgentSessionService,
	IAgentThreadService,
	IAgentTurnService,
	SessionMutationParams
} from '../common/agentService.js';

export function createDisconnectedAgentSessionService(unavailable: UnavailableOperation): IAgentSessionService {
	return {
		create: () => unavailable('session.create'),
		listAgents: () => unavailable('session.listAgents'),
		read: () => unavailable('session.read'),
		readCatalog: () => unavailable('session.readCatalog'),
		list: () => unavailable('session.list'),
		subscribeCatalog: () => unavailable('session.subscribeCatalog'),
		unsubscribeCatalog: () => unavailable('session.unsubscribeCatalog'),
		subscribe: () => unavailable('session.subscribe'),
		unsubscribe: () => unavailable('session.unsubscribe'),
		createThread: () => unavailable('session.createThread'),
		archive: () => unavailable('session.archive'),
		stop: () => unavailable('session.stop')
	};
}

export function createDisconnectedAgentThreadService(unavailable: UnavailableOperation): IAgentThreadService {
	return {
		onDidUpdateThread: Event.None,
		onDidUpdateThreadTranscript: Event.None,
		readAttachment: () => unavailable('thread.readAttachment'),
		readToolResource: () => unavailable('thread.readToolResource'),
		readHistoryState: () => unavailable('thread.readHistoryState'),
		moveHistory: () => unavailable('thread.moveHistory'),
		readContext: () => unavailable('thread.readContext'),
		checkpoints: () => unavailable('thread.checkpoints'),
		restoreMessage: () => unavailable('thread.restoreMessage'),
		readTrace: () => unavailable('thread.readTrace'),
		readTraceDiagnostics: () => unavailable('thread.readTraceDiagnostics'),
		readTracePayload: () => unavailable('thread.readTracePayload'),
		readTraceGraph: () => unavailable('thread.readTraceGraph'),
		read: () => unavailable('thread.read'),
		configureAdvisor: () => unavailable('thread.configureAdvisor'),
		subscribe: () => unavailable('thread.subscribe'),
		unsubscribe: () => unavailable('thread.unsubscribe')
	};
}

export function createDisconnectedAgentTurnService(unavailable: UnavailableOperation): IAgentTurnService {
	return {
		enqueue: () => unavailable('queue.enqueue'),
		listQueued: () => unavailable('queue.list'),
		start: () => unavailable('turn.start'),
		compact: () => unavailable('turn.compact'),
		consultAdvisor: () => unavailable('turn.consultAdvisor'),
		steer: () => unavailable('turn.steer'),
		interrupt: () => unavailable('turn.interrupt'),
		resolveInteraction: () => unavailable('turn.resolveInteraction')
	};
}

export function createAppServerAgentSessionService(connection: AppServerProtocolClient): IAgentSessionService {
	return {
		create: (params) => appServerRequest(connection, 'session/create', params).then(toSessionResult),
		listAgents: () => appServerRequest(connection, 'agent/roles/list', {}),
		read: (params) => appServerRequest(connection, 'session/read', params).then(toSessionResult),
		readCatalog: async (params) => {
			const result = await appServerRequest(connection, 'session/catalog/read', params);
			return { session: result.session ? toAgentSession(result.session) : result.session };
		},
		list: () =>
			appServerRequest(connection, 'session/list', {}).then((result) => ({
				sessions: result.sessions.map(toAgentSession)
			})),
		subscribeCatalog: () =>
			appServerRequest(connection, 'session/catalog/subscribe', {}).then((result) => ({
				sessions: result.sessions.map(toAgentSession)
			})),
		unsubscribeCatalog: () => voidResult(appServerRequest(connection, 'session/catalog/unsubscribe', {})),
		subscribe: async (params) => {
			const result = await appServerRequest(connection, 'session/subscribe', params);
			return {
				...toSessionResult(result),
				threadSnapshots: result.threadProjections.map((snapshot) => ({
					thread: toThread(snapshot.thread),
					directory: snapshot.directory ? { ...snapshot.directory } : snapshot.directory,
					transcript: toThreadTranscriptSnapshot(snapshot.transcript),
					updates: snapshot.updates.map(toThreadUpdate)
				}))
			};
		},
		unsubscribe: (params) => voidResult(appServerRequest(connection, 'session/unsubscribe', params)),
		createThread: (params) =>
			appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, { type: 'createThread', title: params.title })
			)
				.then(sessionThreadResult)
				.then((result) => ({ session: toAgentSession(result.session), threadId: result.threadId })),
		archive: (params) =>
			appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'archive' }))
				.then(sessionResult)
				.then(toSessionResult),
		stop: (params) =>
			appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'stop' }))
				.then(sessionResult)
				.then(toSessionResult)
	};
}

export function createAppServerAgentThreadService(connection: AppServerProtocolClient): IAgentThreadService {
	return {
		onDidUpdateThread: Event.any<ThreadUpdateEnvelope>((listener, thisArgs) => connection.onNotification(event => {
			if (event.method === 'session/thread/update') listener.call(thisArgs, toThreadUpdate(event.params));
		})),
		onDidUpdateThreadTranscript: Event.any<ThreadTranscriptUpdateEnvelope>((listener, thisArgs) => connection.onNotification(event => {
			if (event.method === 'session/thread/transcript/update') listener.call(thisArgs, toThreadTranscriptUpdate(event.params));
		})),
		readAttachment: async (source, signal) => {
			if (signal?.aborted) throw canceled();
			const generation = connection.generation;
			const resource = await appServerRequest(connection, 'attachment/resource/open', { ...source });
			const bytes = await readAppServerResource(createAppServerResourceApi(connection), resource, 16 * 1024 * 1024, signal, generation);
			return { bytes, mimeType: resource.mimeType };
		},
		readToolResource: async (source, signal) => {
			if (signal?.aborted) throw canceled();
			const generation = connection.generation;
			const operationId = createUuid();
			const request = appServerRequest(connection, 'tool/resource/open', { ...source, operationId });
			const cancel = (): void => {
				if (connection.generation === generation) void appServerRequest(connection, 'tool/resource/cancel', { sessionId: source.sessionId, threadId: source.threadId, operationId }).catch(() => undefined);
			};
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted) cancel();
			try {
				const resource = await request;
				const bytes = await readAppServerResource(createAppServerResourceApi(connection), resource, 262_144, signal, generation);
				return { bytes, mimeType: resource.mimeType };
			} finally { signal?.removeEventListener('abort', cancel); }
		},
		readHistoryState: async params => {
			try {
				const result = await appServerRequest(connection, 'session/thread/history', params);
				return { sequence: result.sequence, canUndo: result.canUndo, canRedo: result.canRedo };
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'ThreadHistoryConflict') { throw new AgentThreadHistoryConflictError(); }
				throw error;
			}
		},
		moveHistory: async params => {
			try {
				sessionThreadResult(await appServerRequest(connection, 'session/request', sessionRequest({ sessionId: params.sessionId, commandId: params.commandId }, {
					type: 'moveThreadHistory', threadId: params.threadId, expectedSequence: params.expectedSequence, direction: params.direction,
				})));
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'ThreadHistoryConflict') { throw new AgentThreadHistoryConflictError(); }
				throw error;
			}
		},
		readContext: async params => {
			const { context } = await appServerRequest(connection, 'context/read', { scope: { type: 'thread', ...params }, detail: 'usage' });
			return {
				context: {
					estimatedTokens: context.estimatedTokens,
					allocation: context.allocation ? { contextWindow: context.allocation.contextWindow, autoCompactAt: context.allocation.autoCompactAt } : context.allocation,
					model: context.model ? { ...context.model } : context.model,
					latestRequest: context.latestRequest ? { usedTokens: context.latestRequest.usedTokens } : context.latestRequest,
					categories: context.categories.map(category => ({ category: category.category, tokens: category.tokens })),
				}
			};
		},
		checkpoints: async (params) => {
			const result = await appServerRequest(connection, 'session/thread/checkpoints', params);
			return result.checkpoints.map((checkpoint) => ({
				itemId: checkpoint.itemId,
				turnId: checkpoint.turnId,
				sourceThreadId: checkpoint.sourceThreadId,
				files: checkpoint.workspace.type,
				...(checkpoint.workspace.type === 'unavailable'
					? { unavailableReason: checkpoint.workspace.reason }
					: {})
			}));
		},
		restoreMessage: async (params) => {
			const result = sessionThreadResult(
				await appServerRequest(
					connection,
					'session/request',
					sessionRequest(
						{ sessionId: params.sessionId, commandId: params.commandId },
						{
							type: 'restoreMessage',
							threadId: params.threadId,
							itemId: params.itemId,
							boundary: params.boundary,
							title: params.title
						}
					)
				)
			);
			return { sessionId: result.session.sessionId, threadId: result.threadId };
		},
		readTrace: (params) => appServerRequest(connection, 'session/trace/read', params),
		readTraceDiagnostics: (params) => appServerRequest(connection, 'session/trace/diagnostics/read', params),
		readTracePayload: (params) => appServerRequest(connection, 'session/trace/payload/read', params),
		readTraceGraph: (params) => appServerRequest(connection, 'session/trace/graph/read', params),
		read: async (params) => {
			const result = await appServerRequest(connection, 'session/thread/read', params);
			return { thread: toThread(result.thread), directory: result.directory ? { ...result.directory } : result.directory, transcript: toThreadTranscriptSnapshot(result.transcript) };
		},
		configureAdvisor: async (params) => {
			const result = await appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'configureAdvisor',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					selection: params.selection
				})
			);
			if (result.type !== 'advisorConfigured')
				throw new Error(`Expected advisor configuration result, received ${result.type}.`);
			return result.value;
		},
		subscribe: async (params) => {
			const result = await appServerRequest(connection, 'session/thread/subscribe', params);
			return {
				thread: toThread(result.thread),
				directory: result.directory ? { ...result.directory } : result.directory,
				transcript: toThreadTranscriptSnapshot(result.transcript),
				updates: result.updates.map(toThreadUpdate)
			};
		},
		unsubscribe: (params) => voidResult(appServerRequest(connection, 'session/thread/unsubscribe', params))
	};
}

export function createAppServerAgentTurnService(connection: AppServerProtocolClient): IAgentTurnService {
	return {
		enqueue: (params) =>
			appServerRequest(connection, 'queue/enqueue', params).then((result) => ({ status: result.status })),
		listQueued: (params) =>
			appServerRequest(connection, 'queue/list', params).then((result) => ({
				messages: result.messages.map((message) => ({ status: message.status }))
			})),
		start: (params) =>
			appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'startTurn',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					mode: params.mode,
					approvalMode: params.approvalMode,
					model: params.model,
					reasoningEffort: params.reasoningEffort,
					toolMode: params.toolMode,
					input: params.input
				})
			).then(turnStartResult),
		consultAdvisor: (params) =>
			appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'consultAdvisor',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					question: params.question
				})
			).then(turnStartResult),
		compact: (params) =>
			appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'compactContext',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					retentionPrompt: params.retentionPrompt
				})
			).then(turnStartResult),
		steer: (params) =>
			appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'steerTurn',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					turnId: params.turnId,
					input: params.input
				})
			).then(turnSteerResult),
		interrupt: (params) =>
			appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'interruptTurn',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					turnId: params.turnId
				})
			).then(turnInterruptResult),
		resolveInteraction: (params) =>
			appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'resolveInteraction',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					turnId: params.turnId,
					requestId: params.requestId,
					response: toAgentResponse(params.response)
				})
			).then(turnInteractionResolveResult)
	};
}

function sessionRequest(params: SessionMutationParams, request: SessionRequest): SessionRequestParams {
	return { sessionId: params.sessionId, commandId: params.commandId, request };
}

function sessionResult(result: SessionRequestResult): SessionResultDto {
	if (result.type !== 'session') throw new Error(`Expected Session result, received ${result.type}.`);
	return result.value;
}

function sessionThreadResult(result: SessionRequestResult): SessionThreadResultDto {
	if (result.type !== 'thread') throw new Error(`Expected Thread result, received ${result.type}.`);
	return result.value;
}

function turnStartResult(result: SessionRequestResult): TurnStartResult {
	if (result.type !== 'turn') throw new Error(`Expected Turn result, received ${result.type}.`);
	return result.value;
}

function turnInterruptResult(result: SessionRequestResult): TurnInterruptResult {
	if (result.type !== 'turnInterrupt') throw new Error(`Expected Turn interrupt result, received ${result.type}.`);
	return result.value;
}

function turnSteerResult(result: SessionRequestResult): TurnSteerResult {
	if (result.type !== 'turnSteer') throw new Error(`Expected Turn steer result, received ${result.type}.`);
	return result.value;
}

function turnInteractionResolveResult(result: SessionRequestResult): TurnInteractionResolveResult {
	if (result.type !== 'interaction') throw new Error(`Expected interaction result, received ${result.type}.`);
	return result.value;
}

function toThread(thread: ThreadDto): Thread {
	return {
		agentId: thread.agentId,
		origin:
			thread.origin.type === 'message'
				? {
					type: 'message',
					parentThreadId: thread.origin.parentThreadId,
					parentSequence: thread.origin.parentSequence,
					itemId: thread.origin.itemId,
					boundary: thread.origin.boundary
				}
				: { ...thread.origin },
		sessionId: thread.sessionId,
		threadId: thread.threadId,
		title: thread.title,
		status: thread.status,
		sequence: thread.sequence,
		goal: thread.goal ? { ...thread.goal } : thread.goal,
		advisor: thread.advisor,
		usage: {
			modelInvocations: thread.usage.modelInvocations,
			inputTokens: { ...thread.usage.inputTokens },
			outputTokens: { ...thread.usage.outputTokens },
			cachedInputTokens: { ...thread.usage.cachedInputTokens },
			cacheWriteInputTokens: { ...thread.usage.cacheWriteInputTokens },
			reasoningTokens: { ...thread.usage.reasoningTokens }
		},
		turns: thread.turns.map((turn) => ({
			turnId: turn.turnId,
			status: turn.status,
			mode: turn.mode,
			approvalMode: turn.approvalMode,
			model: turn.model ? { ...turn.model } : turn.model,
			reasoningEffort: turn.reasoningEffort,
			plan: turn.plan
				? {
					explanation: turn.plan.explanation,
					steps: turn.plan.steps.map((step) => ({ ...step }))
				}
				: turn.plan,
			usage: {
				modelInvocations: turn.usage.modelInvocations,
				inputTokens: { ...turn.usage.inputTokens },
				outputTokens: { ...turn.usage.outputTokens },
				cachedInputTokens: { ...turn.usage.cachedInputTokens },
				cacheWriteInputTokens: { ...turn.usage.cacheWriteInputTokens },
				reasoningTokens: { ...turn.usage.reasoningTokens }
			},
			items: turn.items.map(toThreadItem),
			error: turn.error ? { ...turn.error } : turn.error
		}))
	};
}

function toThreadUpdate(update: ThreadUpdateEnvelopeDto): ThreadUpdateEnvelope {
	return {
		sessionId: update.sessionId,
		threadId: update.threadId,
		durableSequence: update.durableSequence,
		streamCursor: update.streamCursor ? { ...update.streamCursor } : update.streamCursor,
		update: toThreadUpdateValue(update.update)
	};
}

function toThreadUpdateValue(update: ThreadUpdateEnvelopeDto['update']): ThreadUpdate {
	switch (update.type) {
		case 'committed': {
			const event = update.event;
			if (event.type === 'interactionRequested')
				return { type: 'committed', event: { type: event.type, interaction: { ...event.interaction } } };
			if (event.type === 'turnModeChanged')
				return {
					type: 'committed',
					event: { type: event.type, turnId: event.turnId, fromMode: event.fromMode, mode: event.mode }
				};
			return { type: 'committed', event: { type: event.type } };
		}
		case 'itemStarted':
			return { type: 'itemStarted', item: toThreadItem(update.item) };
		case 'itemDelta':
			return { type: 'itemDelta', itemId: update.itemId, delta: { ...update.delta } };
		case 'toolOutputDelta':
			return {
				type: 'toolOutputDelta',
				turnId: update.turnId,
				toolCallId: update.toolCallId,
				stream: update.stream,
				text: update.text
			};
	}
}

function toThreadTranscriptSnapshot(snapshot: ThreadTranscriptSnapshotDto): ThreadTranscriptSnapshot {
	return {
		sessionId: snapshot.sessionId,
		threadId: snapshot.threadId,
		durableSequence: snapshot.durableSequence,
		revision: snapshot.revision,
		entries: snapshot.entries.map(toThreadTranscriptEntry)
	};
}

function toThreadTranscriptUpdate(update: ThreadTranscriptUpdateEnvelopeDto): ThreadTranscriptUpdateEnvelope {
	return {
		sessionId: update.sessionId,
		threadId: update.threadId,
		durableSequence: update.durableSequence,
		revision: update.revision,
		changes: update.changes.map((change) => {
			switch (change.type) {
				case 'upsert':
					return { type: 'upsert', entry: toThreadTranscriptEntry(change.entry) };
				case 'remove':
					return { type: 'remove', entryIds: [...change.entryIds] };
				case 'clearTransient':
					return { type: 'clearTransient' };
			}
		})
	};
}

function toThreadTranscriptEntry(entry: ThreadTranscriptEntryDto): ThreadTranscriptEntry {
	switch (entry.type) {
		case 'hookRun':
			return {
				type: 'hookRun',
				entryId: entry.entryId,
				turnId: entry.turnId,
				run: { ...entry.run, status: { ...entry.run.status } }
			};
		case 'item':
			return {
				type: 'item',
				entryId: entry.entryId,
				turnId: entry.turnId,
				item: toThreadItem(entry.item),
				transient: entry.transient
			};
		case 'turnPlan':
			return {
				type: 'turnPlan',
				entryId: entry.entryId,
				turnId: entry.turnId,
				plan: { explanation: entry.plan.explanation, steps: entry.plan.steps.map((step) => ({ ...step })) }
			};
		case 'turnError':
			return { type: 'turnError', entryId: entry.entryId, turnId: entry.turnId, error: { ...entry.error } };
		case 'toolOutput':
			return {
				type: 'toolOutput',
				entryId: entry.entryId,
				turnId: entry.turnId,
				toolCallId: entry.toolCallId,
				stream: entry.stream,
				text: entry.text
			};
	}
}

function toThreadItem(item: ThreadItemDto): ThreadItem {
	// Detach tool provenance and result content from transport values before Chat retains them.
	// Reads and notifications share this conversion.
	switch (item.type) {
		case 'toolCall': {
			const binding = item.binding;
			return {
				...item,
				binding: binding ? {
					...binding,
					sourceChain: binding.sourceChain.map(source => ({ ...source })),
					caller: { ...binding.caller },
					activity: binding.activity?.type === 'command' ? { ...binding.activity, arguments: [...binding.activity.arguments] }
						: binding.activity ? { ...binding.activity } : binding.activity,
				} : binding,
			};
		}
		case 'toolResult': return {
			...item,
			content: item.content == null ? item.content : item.content.map((part): ChatContentPart => {
				switch (part.type) {
					case 'artifact': {
						const artifact = part.artifact;
						const data = artifact.data;
						return {
							type: 'artifact', artifact: {
								...artifact, source: { ...artifact.source },
								data: data.type === 'binary' ? { type: 'bytes', bytes: Uint8Array.from(data.bytes) }
									: data.type === 'json' ? { type: 'json', json: normalizeArtifactJson(data.json) } : { ...data },
							},
						};
					}
					case 'imageAttachment': return { ...part, attachment: { ...part.attachment } };
					case 'audioAttachment': return { ...part, attachment: { ...part.attachment } };
					default: return { ...part };
				}
			}),
		};
		default: return { ...item };
	}
}

function toAgentResponse(response: AgentResponse): AgentResponseDto {
	switch (response.type) {
		case 'approval':
			return { type: 'approval', response: { ...response.response } };
		case 'userInput':
			return { type: 'userInput', response: { answers: { ...response.response.answers } } };
		case 'dynamicTool':
			return {
				type: 'dynamicTool',
				response: { ...response.response, content: response.response.content.map((output) => ({ ...output })) }
			};
	}
}

function toSessionResult(result: SessionResultDto): SessionResult {
	return {
		session: toAgentSession(result.session),
		agentTree: { roots: result.agentTree.roots.map(toAgentExecutionNode) }
	};
}

function toAgentSession(session: SessionDto): AgentSession {
	return {
		sessionId: session.sessionId,
		title: session.title,
		status: session.status,
		executionTarget: session.executionTarget ? { ...session.executionTarget } : session.executionTarget,
		model: session.model ? { ...session.model } : session.model,
		manager: { ...session.manager },
		threads: session.threads.map((thread) => ({
			threadId: thread.threadId,
			title: thread.title,
			status: thread.status,
			parentThreadId: thread.parentThreadId,
			forkedFromId: thread.forkedFromId,
			manager: thread.manager ? { ...thread.manager } : thread.manager
		}))
	};
}

function toAgentExecutionNode(node: AgentNodeDto): AgentExecutionNode {
	return {
		threadId: node.threadId,
		threadSequence: node.threadSequence,
		title: node.title,
		parentThreadId: node.parentThreadId,
		forkedFromId: node.forkedFromId,
		executionStatus: node.executionStatus,
		currentTurnId: node.currentTurnId,
		waitingReason: node.waitingReason,
		usage: {
			modelInvocations: node.usage.modelInvocations,
			inputTokens: { ...node.usage.inputTokens },
			outputTokens: { ...node.usage.outputTokens },
			cachedInputTokens: { ...node.usage.cachedInputTokens },
			cacheWriteInputTokens: { ...node.usage.cacheWriteInputTokens },
			reasoningTokens: { ...node.usage.reasoningTokens }
		},
		goal: node.goal ? { ...node.goal } : node.goal,
		role: node.role ? { name: node.role.name, selectionReason: node.role.selectionReason } : node.role,
		result: node.result ? { status: node.result.status, summary: node.result.summary } : node.result,
		joins: node.joins?.map((join) => ({ status: join.status })),
		children: node.children?.map(toAgentExecutionNode)
	};
}


function normalizeArtifactJson(json: string): string {
	JSON.parse(json);
	return json;
}

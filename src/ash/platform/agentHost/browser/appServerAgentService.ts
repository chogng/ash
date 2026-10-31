import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { createSshRemoteWorkspaceUri } from '../../remote/common/remote.js';
import type { IAgentHostResourceService } from '../common/agentHostResourceService.js';
import type { InputItem } from '../../../../../.build/protocol/typescript/index.js';
import type { AgentInput } from '../common/agent.js';
import { Emitter } from '../../../base/common/event.js';
import { getNLSLanguage, localize } from '../../../nls.js';
import type { VoiceStatus } from '../../../../../.build/protocol/typescript/index.js';
import type { IAgentVoiceService } from '../common/agentService.js';
import type { AgentVoiceSource, AgentVoiceSelection, AgentVoiceSessionState, AgentVoiceTaskRequest, AgentVoiceConnectionChoice } from '../common/agent.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { createUuid } from '../../../base/common/uuid.js';
import { canceled } from '../../../base/common/errors.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { createAppServerResourceApi, readAppServerResource } from './appServerApi.js';
import { Event } from '../../../base/common/event.js';
import type { AgentSession, AgentExecutionNode, SessionResult, SessionThreadResult } from '../common/agent.js';
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
	AgentInteractionOffer,
	TurnInteraction,
	AgentResponse,
	AgentMcpAppTool,
	ChatContentPart,
	Thread,
	ThreadItem,
	ThreadTranscriptEntry,
	ThreadTranscriptSnapshot,
	ThreadTranscriptUpdateEnvelope,
	ThreadUpdate,
	ThreadUpdateEnvelope
} from '../common/agent.js';
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
import type { IAgentSessionService, IAgentThreadService, IAgentTurnService } from '../common/agentService.js';
import type { SessionMutationParams } from '../common/agent.js';

export function createDisconnectedAgentSessionService(unavailable: UnavailableOperation): IAgentSessionService {
	return {
		collectDebugLogs: () => unavailable('session.collectDebugLogs'),
		create: () => unavailable('session.create'),
		listAgents: () => unavailable('session.listAgents'),
		readRoleCatalog: () => unavailable('session.readRoleCatalog'),
		read: () => unavailable('session.read'),
		readCatalog: () => unavailable('session.readCatalog'),
		list: () => unavailable('session.list'),
		subscribeCatalog: () => unavailable('session.subscribeCatalog'),
		unsubscribeCatalog: () => unavailable('session.unsubscribeCatalog'),
		subscribe: () => unavailable('session.subscribe'),
		unsubscribe: () => unavailable('session.unsubscribe'),
		createThread: () => unavailable('session.createThread'),
		archive: () => unavailable('session.archive'),
		rename: () => unavailable('session.rename'),
		delete: () => unavailable('session.delete'),
		restore: () => unavailable('session.restore'),
		stop: () => unavailable('session.stop')
	};
}

export function createDisconnectedAgentThreadService(unavailable: UnavailableOperation): IAgentThreadService {
	return {
		fork: () => unavailable('thread.fork'),
		rewrite: () => unavailable('thread.rewrite'),
		rename: () => unavailable('thread.rename'),
		onDidOfferInteraction: Event.None,
		onDidChangeConnection: Event.None,
		onDidUpdateThread: Event.None,
		onDidUpdateThreadTranscript: Event.None,
		readAttachment: () => unavailable('thread.readAttachment'),
		readToolResource: () => unavailable('thread.readToolResource'),
		readAppResource: () => unavailable('thread.readAppResource'),
		listAppTools: () => unavailable('thread.listAppTools'),
		invokeAppTool: () => unavailable('thread.invokeAppTool'),
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
		startReview: () => unavailable('turn.startReview'),
		compact: () => unavailable('turn.compact'),
		consultAdvisor: () => unavailable('turn.consultAdvisor'),
		steer: () => unavailable('turn.steer'),
		interrupt: () => unavailable('turn.interrupt'),
		resolveInteraction: () => unavailable('turn.resolveInteraction')
	};
}

export function createAppServerAgentSessionService(connection: AppServerProtocolClient, sshHost?: string): IAgentSessionService {
	return {
		async collectDebugLogs(params, signal) {
			if (signal?.aborted) throw canceled();
			const generation = connection.generation;
			const result = await appServerRequest(connection, 'session/debugLogs/collect', params);
			const resources = createAppServerResourceApi(connection);
			const pending = new Set(result.files.map(file => file.resource.resourceId));
			const files: { name: string; bytes: Uint8Array; truncated: boolean; }[] = [];
			let failed = false;
			try {
				if (result.files.reduce((bytes, file) => bytes + file.resource.size, 0) > 64 * 1024 * 1024) {
					throw new Error(localize('debugLogs.collectionByteLimit', 'Debug log resources exceed the collection byte limit.'));
				}
				for (const file of result.files) {
					// The resource reader owns release even when verification or cancellation fails.
					pending.delete(file.resource.resourceId);
					const bytes = await readAppServerResource(resources, file.resource, 16 * 1024 * 1024, signal, generation);
					files.push({ name: file.name, bytes, truncated: file.truncated });
				}
				return { files, omittedFiles: result.omittedFiles };
			} catch (error) {
				failed = true;
				throw error;
			} finally {
				if (generation === connection.generation) {
					const cleanup = await Promise.allSettled([...pending].map(resourceId => resources.release({ resourceId })));
					const rejected = cleanup.find(result => result.status === 'rejected');
					if (!failed && rejected?.status === 'rejected') throw rejected.reason;
				}
			}
		},
		async invokeRuntime(providerId, request, signal) {
			throwIfCancelled(signal);
			if (connection.capabilities?.contracts.sessionRuntimes?.version !== 1) {
				if (request.operation === 'probe') { return { type: 'availability', available: false }; }
				throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.runtime.unavailable' }, 'Session runtime Providers are unavailable on this connection.'));
			}
			const operationId = createUuid();
			const generation = connection.generation;
			let retired = false;
			using state = connection.onStateChange(value => {
				if (value !== 'ready') retired = true;
			});
			const isCurrent = (): boolean => !retired && connection.state === 'ready' && connection.generation === generation;
			const assertCurrent = (): void => {
				throwIfCancelled(signal);
				if (!isCurrent()) throw canceled();
			};
			assertCurrent();
			const cancel = (): void => {
				// Runtime operations and cancellation belong to their admitting connection.
				if (isCurrent()) {
					void appServerRequest(connection, 'session/runtime/cancel', { operationId }).catch(() => { });
				}
			};
			signal.addEventListener('abort', cancel, { once: true });
			try {
				const value = await connection.request(APP_SERVER_METHODS['session/runtime/invoke'], { operationId, providerId, request }, { timeoutMs: 600_000 });
				assertCurrent();
				// Transport decoding has validated this closed result; copy only the domain fields.
				switch (value.type) {
					case 'targets': return { type: value.type, targets: value.targets.map(target => ({ ...target })) };
					case 'availability': return { type: value.type, available: value.available };
					case 'released': return { type: value.type };
					case 'target': return { type: value.type, target: { ...value.target } };
				}
			} catch (error) {
				assertCurrent();
				throw error;
			} finally { signal.removeEventListener('abort', cancel); }
		},
		// The SSH carrier already selected this host; the server consumes its own filesystem paths.
		create: (params) => appServerRequest(connection, 'session/create', {
			...params,
			executionTarget: sshHost && params.executionTarget?.type === 'ssh' && params.executionTarget.host === sshHost
				? { type: 'local', root: params.executionTarget.root }
				: params.executionTarget
		}).then(result => toSessionResult(result, sshHost)),
		listAgents: () => appServerRequest(connection, 'agent/roles/list', {}),
		async readRoleCatalog() {
			const catalog = await appServerRequest(connection, 'agent/roles/catalog', {});
			return {
				agents: catalog.agents.map(({ path, ...role }) => {
					let resource: URI | undefined;
					if (path) { resource = sshHost ? createSshRemoteWorkspaceUri(sshHost, path) : URI.file(path); }
					return { ...role, resource };
				}),
				diagnostics: catalog.diagnostics,
			};
		},
		read: (params) => appServerRequest(connection, 'session/read', params).then(result => toSessionResult(result, sshHost)),
		readCatalog: async (params) => {
			const result = await appServerRequest(connection, 'session/catalog/read', params);
			return { session: result.session ? toAgentSession(result.session, sshHost) : result.session };
		},
		list: () =>
			appServerRequest(connection, 'session/list', {}).then((result) => ({
				sessions: result.sessions.map(session => toAgentSession(session, sshHost))
			})),
		subscribeCatalog: () =>
			appServerRequest(connection, 'session/catalog/subscribe', {}).then((result) => ({
				sessions: result.sessions.map(session => toAgentSession(session, sshHost))
			})),
		unsubscribeCatalog: () => voidResult(appServerRequest(connection, 'session/catalog/unsubscribe', {})),
		subscribe: async (params) => {
			const result = await appServerRequest(connection, 'session/subscribe', params);
			return {
				...toSessionResult(result, sshHost),
				threadSnapshots: result.threadProjections.map((snapshot) => {
					const thread = toThread(snapshot.thread);
					return {
						thread,
						directory: toExecutionTarget(snapshot.directory, sshHost),
						transcript: toThreadTranscriptSnapshot(snapshot.transcript, thread),
						updates: snapshot.updates.map(toThreadUpdate)
					};
				})
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
				.then((result) => {
					if (result.session.sessionId !== params.sessionId) throw new Error(localize('chat.operation.wrongIdentity', 'The server returned a different conversation. Refresh before trying again.'));
					return { session: toAgentSession(result.session, sshHost), threadId: result.threadId };
				}),
		rename: async params => {
			const result = sessionResult(await appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'renameSession', title: params.title })));
			if (result.session.sessionId !== params.sessionId) throw new Error(localize('chat.rename.wrongIdentity', 'The server returned a different conversation while renaming. Refresh and try again.'));
			return toSessionResult(result, sshHost);
		},
		delete: async params => {
			const result = await appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'delete' }));
			if (result.type !== 'deleted' || result.value !== params.sessionId) throw new Error(localize('chatSession.delete.wrongIdentity', 'The server returned a different session while deleting. Refresh before trying again.'));
		},
		archive: (params) =>
			appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'archive' }))
				.then(sessionResult)
				.then(result => toSessionResult(result, sshHost)),
		restore: (params) =>
			appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'restore' }))
				.then(sessionResult)
				.then(result => toSessionResult(result, sshHost)),
		stop: (params) =>
			appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'stop' }))
				.then(sessionResult)
				.then(result => toSessionResult(result, sshHost))
	};
}

/** Shares resource verification, cancellation and release for the two source-bound read ports. */
async function readToolResource(connection: AppServerProtocolClient, source: Parameters<IAgentThreadService['readToolResource']>[0], selection: { readonly type: 'linked'; } | { readonly type: 'app'; readonly uri: string; }, signal?: AbortSignal): ReturnType<IAgentThreadService['readToolResource']> {
	if (signal?.aborted) throw canceled();
	const generation = connection.generation;
	const operationId = createUuid();
	const request = selection.type === 'linked'
		? appServerRequest(connection, 'tool/resource/open', { ...source, operationId })
		: appServerRequest(connection, 'tool/app/resource/open', { ...source, uri: selection.uri, operationId });
	let cancellation: Promise<unknown> | undefined;
	const cancel = (): void => {
		if (connection.generation === generation) { cancellation ??= appServerRequest(connection, 'tool/resource/cancel', { sessionId: source.sessionId, threadId: source.threadId, operationId }); void cancellation.catch(() => undefined); }
	};
	signal?.addEventListener('abort', cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		const { appCsp, encoding, resourceMetadata, ...resource } = await request;
		const bytes = await readAppServerResource(createAppServerResourceApi(connection), resource, 262_144, signal, generation);
		return { bytes, mimeType: resource.mimeType, ...(encoding ? { encoding } : {}), ...(resourceMetadata === undefined ? {} : { resourceMetadata }), ...(appCsp ? { appCsp: { connectDomains: [...appCsp.connectDomains], resourceDomains: [...appCsp.resourceDomains], frameDomains: [...appCsp.frameDomains], baseUriDomains: [...appCsp.baseUriDomains] } } : {}) };
	} finally { signal?.removeEventListener('abort', cancel); }
}

export function createAppServerAgentThreadService(connection: AppServerProtocolClient, sshHost?: string, snapshots?: IAgentHostResourceService): IAgentThreadService {
	return {
		fork: async params => {
			const result = sessionThreadResult(await appServerRequest(connection, 'session/request', sessionRequest(params, {
				type: params.target === 'session' ? 'forkSession' : 'forkThread', parentThreadId: params.threadId, title: params.title,
			})));
			if (params.target === 'thread' && result.session.sessionId !== params.sessionId) throw new Error(localize('chat.operation.wrongIdentity', 'The server returned a different conversation. Refresh before trying again.'));
			return { sessionId: result.session.sessionId, threadId: result.threadId };
		},
		rewrite: async (params, signal) => {
			const result = await withHostResourceInput(connection, snapshots, params.input, input => appServerRequest(connection, 'session/request', sessionRequest(params, {
				type: 'rewriteThread', parentThreadId: params.threadId, beforeTurnId: params.beforeTurnId, title: params.title,
				input,
			})), signal);
			if (result.type !== 'rewrite' || result.value.session.sessionId !== params.sessionId) throw new Error(localize('chat.operation.wrongIdentity', 'The server returned a different conversation. Refresh before trying again.'));
			return { sessionId: result.value.session.sessionId, threadId: result.value.threadId };
		},
		rename: async params => {
			const result = sessionResult(await appServerRequest(connection, 'session/request', sessionRequest(params, { type: 'renameThread', threadId: params.threadId, title: params.title, source: params.source })));
			if (result.session.sessionId !== params.sessionId) throw new Error(localize('chat.rename.wrongIdentity', 'The server returned a different conversation while renaming. Refresh and try again.'));
		},
		onDidOfferInteraction: Event.any<AgentInteractionOffer>((listener, thisArgs) => connection.onNotification(event => {
			if (event.method === 'agent/request') listener.call(thisArgs, {
				connectionGeneration: connection.generation,
				sessionId: event.params.sessionId,
				threadId: event.params.threadId,
				turnId: event.params.turnId,
				interaction: toTurnInteraction(event.params.interaction),
			});
		})),
		onDidChangeConnection: Event.any<void>((listener, thisArgs) => connection.onStateChange(() => listener.call(thisArgs))),
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
		listAppTools: async (source, signal) => {
			if (signal?.aborted) throw canceled();
			const generation = connection.generation;
			const result = await appServerRequest(connection, 'tool/app/list', { ...source });
			if (signal?.aborted) throw canceled();
			if (connection.generation !== generation) throw new Error('App catalog belongs to a retired connection');
			// Detach arbitrary SDK schema/metadata JSON at the transport boundary.
			return result.tools.map(value => {
				if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || !value.inputSchema || typeof value.inputSchema !== 'object' || Array.isArray(value.inputSchema)) throw new TypeError('Invalid App tool contract');
				return JSON.parse(JSON.stringify(value)) as AgentMcpAppTool;
			});
		},
		invokeAppTool: async (source, name, argumentsJson, signal) => {
			if (signal?.aborted) throw canceled();
			const generation = connection.generation;
			const operationId = createUuid();
			const request = connection.request(APP_SERVER_METHODS['tool/app/call'], { ...source, remoteName: name, argumentsJson, operationId }, { timeoutMs: 240_000 });
			let cancellation: Promise<unknown> | undefined;
			const cancel = (): void => { if (connection.generation === generation) { cancellation ??= appServerRequest(connection, 'tool/app/cancel', { sessionId: source.sessionId, threadId: source.threadId, operationId }); void cancellation.catch(() => undefined); } };
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted) cancel();
			try {
				const result = await request;
				if (signal?.aborted || connection.generation !== generation) throw canceled();
				const item = toThreadItem(result.item);
				if (item.type !== 'toolResult') throw new TypeError('App invocation did not return a Tool Result');
				return item;
			} catch (error) { cancel(); throw error; }
			finally { signal?.removeEventListener('abort', cancel); }
		},
		readToolResource: (source, signal) => readToolResource(connection, source, { type: 'linked' }, signal),
		readAppResource: (source, uri, signal) => readToolResource(connection, source, { type: 'app', uri }, signal),
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
			const thread = toThread(result.thread);
			return { thread, directory: toExecutionTarget(result.directory, sshHost), transcript: toThreadTranscriptSnapshot(result.transcript, thread), ...(result.history ? { history: { ...result.history } } : {}) };
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
			const thread = toThread(result.thread);
			return {
				thread,
				directory: toExecutionTarget(result.directory, sshHost),
				transcript: toThreadTranscriptSnapshot(result.transcript, thread),
				updates: result.updates.map(toThreadUpdate),
				...(result.history ? { history: { ...result.history } } : {})
			};
		},
		unsubscribe: (params) => voidResult(appServerRequest(connection, 'session/thread/unsubscribe', params))
	};
}

export function createAppServerAgentTurnService(connection: AppServerProtocolClient, snapshots?: IAgentHostResourceService): IAgentTurnService {
	return {
		enqueue: (params, signal) =>
			withHostResourceInput(connection, snapshots, params.input, input => appServerRequest(connection, 'queue/enqueue', { ...params, input }), signal).then((result) => ({ status: result.status })),
		listQueued: (params) =>
			appServerRequest(connection, 'queue/list', params).then((result) => ({
				messages: result.messages.map((message) => ({ status: message.status }))
			})),
		start: (params, signal) =>
			withHostResourceInput(connection, snapshots, params.input, input => appServerRequest(
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
					input
				})
			), signal).then(turnStartResult),
		startReview: (params) => {
			// The protocol's custom target supports an index-only review without
			// misrepresenting it as a review of the entire working tree.
			const target = params.target.type === 'stagedChanges'
				? { type: 'custom' as const, instructions: localize('scm.review.stagedInstructions', 'Review only staged changes in the Git index (git diff --cached). Read the staged file contents from the index when needed. Exclude unstaged and untracked changes, including unstaged edits to partially staged files. Do not modify files or the index.') }
				: params.target;
			return appServerRequest(connection, 'session/request', sessionRequest(params, {
				type: 'startReview', threadId: params.threadId,
				expectedSequence: params.expectedSequence, target,
			})).then(turnStartResult);
		},
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
		steer: (params, signal) =>
			withHostResourceInput(connection, snapshots, params.input, input => appServerRequest(
				connection,
				'session/request',
				sessionRequest(params, {
					type: 'steerTurn',
					threadId: params.threadId,
					expectedSequence: params.expectedSequence,
					turnId: params.turnId,
					input
				})
			), signal).then(turnSteerResult),
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
			kind: turn.kind,
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

/** Strip transport-only approval fields and detach nested request payloads from the wire frame. */
function toTurnInteraction(interaction: import('../../../../../.build/protocol/typescript/index.js').TurnInteraction): TurnInteraction {
	const request = interaction.request;
	return {
		requestId: interaction.requestId,
		itemId: interaction.itemId,
		deadline: interaction.deadline ? { ...interaction.deadline } : interaction.deadline,
		request: request.type === 'approval'
			? { type: 'approval', request: { reason: request.request.reason, allowedDecisions: request.request.allowedDecisions ? [...request.request.allowedDecisions] : undefined, command: request.request.command ? { ...request.request.command, arguments: [...request.request.command.arguments] } : request.request.command, capabilities: request.request.capabilities.map(capability => ({ ...capability })) } }
			: request.type === 'permissions'
				? { type: 'permissions', request: structuredClone(request.request) }
				: request.type === 'userInput'
					? { type: 'userInput', request: { questions: request.request.questions.map(question => ({ ...question, options: question.options?.map(option => ({ ...option })) })) } }
					: { type: 'dynamicTool', call: { ...request.call, arguments: structuredClone(request.call.arguments) } },
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
				return { type: 'committed', event: { type: event.type, interaction: toTurnInteraction(event.interaction) } };
			if (event.type === 'turnModeChanged')
				return {
					type: 'committed',
					event: { type: event.type, turnId: event.turnId, fromMode: event.fromMode, mode: event.mode }
				};
			if (event.type === 'interactionResolved' || event.type === 'interactionCancelled')
				return { type: 'committed', event: { type: event.type, turnId: event.turnId, requestId: event.requestId } };
			if (event.type === 'turnCompleted' || event.type === 'turnFailed' || event.type === 'turnInterrupted')
				return { type: 'committed', event: { type: event.type, turnId: event.turnId } };
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

function toThreadTranscriptSnapshot(snapshot: ThreadTranscriptSnapshotDto, thread: Thread): ThreadTranscriptSnapshot {
	// The index lives only for this conversion and contains domain items from the same
	// durable snapshot. Share immutable text, never mutable Item shells or transport
	// objects. A later streaming revision still owns its independently converted text.
	const turns = snapshot.sessionId === thread.sessionId && snapshot.threadId === thread.threadId && snapshot.durableSequence === thread.sequence
		? new Map(thread.turns.map(turn => [turn.turnId, new Map(turn.items.map(item => [item.itemId, item]))]))
		: undefined;
	return {
		sessionId: snapshot.sessionId,
		threadId: snapshot.threadId,
		durableSequence: snapshot.durableSequence,
		revision: snapshot.revision,
		entries: snapshot.entries.map(entry => {
			const converted = toThreadTranscriptEntry(entry);
			if (converted.type !== 'item' || converted.transient) return converted;
			const canonical = turns?.get(converted.turnId)?.get(converted.item.itemId);
			if (canonical?.type !== converted.item.type || canonical.turnId !== converted.turnId || converted.item.turnId !== converted.turnId) return converted;
			if ('text' in canonical && 'text' in converted.item && canonical.text === converted.item.text) {
				return { ...converted, item: { ...converted.item, text: canonical.text } };
			}
			return converted;
		})
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
		case 'voiceTranscript': return { type: 'voiceTranscript', entryId: entry.entryId, transcript: { itemId: entry.transcript.itemId, voiceSessionId: entry.transcript.voiceSessionId, mediaEpoch: entry.transcript.mediaEpoch, speaker: entry.transcript.speaker, text: entry.transcript.text, startMs: entry.transcript.startMs, endMs: entry.transcript.endMs, afterItemId: entry.transcript.afterItemId } };
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
								mimeType: artifact.mimeType, contentDigest: artifact.contentDigest, truncated: artifact.truncated,
								...(artifact.resourceMetadata === undefined ? {} : { resourceMetadata: artifact.resourceMetadata }), source: { ...artifact.source },
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
		case 'permissions':
			return {
				type: 'permissions', response: {
					duration: response.response.duration,
					directories: response.response.directories.map(entry => ({ path: entry.path, permissions: [...entry.permissions] })),
					networkHosts: [...response.response.networkHosts],
				}
			};
		case 'userInput':
			return { type: 'userInput', response: { answers: { ...response.response.answers } } };
		case 'dynamicTool':
			return {
				type: 'dynamicTool',
				response: { ...response.response, content: response.response.content.map((output) => ({ ...output })) }
			};
	}
}

/** Backend-local paths belong to the selected SSH host in the Desktop domain. */
function toExecutionTarget(target: AgentSession['executionTarget'], sshHost?: string): AgentSession['executionTarget'] {
	return sshHost && target?.type === 'local' ? { type: 'ssh', host: sshHost, root: target.root } : target ? { ...target } : target;
}

function toSessionResult(result: SessionResultDto, sshHost?: string): SessionResult {
	return {
		session: toAgentSession(result.session, sshHost),
		agentTree: { roots: result.agentTree.roots.map(toAgentExecutionNode) }
	};
}

function toAgentSession(session: SessionDto, sshHost?: string): AgentSession {
	return {
		sessionId: session.sessionId,
		title: session.title,
		status: session.status,
		executionTarget: toExecutionTarget(session.executionTarget, sshHost),
		model: session.model ? { ...session.model } : session.model,
		manager: { ...session.manager },
		threads: session.threads.map((thread) => ({
			threadId: thread.threadId,
			title: thread.title,
			createdAtUnixMs: thread.createdAtUnixMs,
			lastActivityAtUnixMs: thread.lastActivityAtUnixMs ?? undefined,
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

/** Media resources remain attached to their original connection and are never restarted implicitly. */
export class AppServerAgentVoiceService extends Disposable implements IAgentVoiceService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly tasks = this._register(new Emitter<AgentVoiceTaskRequest>());
	public readonly onDidRequestTask = this.tasks.event;
	private readonly device = createUuid();
	private resource: string | undefined;
	private source: AgentVoiceSource | undefined;
	private current: AgentVoiceSessionState | undefined;
	private starting: { readonly operationId: string; readonly generation: number; readonly promise: Promise<VoiceStatus>; readonly cancel: () => Promise<void>; } | undefined;
	public get state(): AgentVoiceSessionState | undefined { return this.current; }
	private inputQueue: Promise<void> = Promise.resolve();
	private inputCounter = 0;
	private hold: { readonly id: string; readonly resourceId: string; readonly epoch: number; renew?: ReturnType<typeof setInterval>; } | undefined;
	public get isAvailable(): boolean { return !this.isDisposed && this.client.state === 'ready' && this.client.capabilities?.contracts.voiceConversation?.version === 2; }

	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onNotification(notification => {
			if (notification.method === 'voice/changed') this.accept(notification.params);
			else if (notification.method === 'voice/delegation') {
				const request = notification.params;
				if (request.resourceId === this.resource && request.sessionId === this.source?.sessionId && request.threadId === this.source.threadId && request.mediaEpoch === this.current?.mediaEpoch && this.current.state === 'connected') this.tasks.fire({ resourceId: request.resourceId, sessionId: request.sessionId, threadId: request.threadId, mediaEpoch: request.mediaEpoch, delegationId: request.delegationId, commandId: request.commandId, transcript: request.transcript });
			}
		}));
		this._register(client.onStateChange(state => {
			if (state !== 'ready') { this.clearHold(); this.resource = undefined; this.source = undefined; this.current = undefined; }
			this.changed.fire();
		}));
	}

	public async getOptions(): Promise<readonly AgentVoiceConnectionChoice[]> {
		this.assertAvailable();
		const generation = this.client.generation;
		const result = await this.client.request(APP_SERVER_METHODS['voice/options'], {});
		if (this.isDisposed || generation !== this.client.generation) throw canceled();
		return result.connections.map(connection => ({ connectionId: connection.connectionId, name: connection.name, defaultModel: connection.defaultModel, models: connection.models.map(model => ({ modelId: model.modelId, defaultVoice: model.defaultVoice, voices: [...model.voices] })) }));
	}

	public async start(source: AgentVoiceSource, selection: AgentVoiceSelection, signal?: AbortSignal): Promise<AgentVoiceSessionState> {
		this.assertAvailable();
		if (signal?.aborted) throw canceled();
		if (this.starting || this.current && !['ended', 'failed'].includes(this.current.state)) throw new Error(localize('chat.voice.alreadyActive', 'Stop the current voice conversation first.'));
		const generation = this.client.generation;
		const resourceId = createUuid(); const operationId = createUuid();
		this.resource = resourceId; this.source = { ...source }; this.current = undefined;
		let cancellation: Promise<void> | undefined;
		const cancel = (): Promise<void> => {
			if (this.client.generation !== generation) return Promise.resolve();
			return cancellation ??= this.client.request(APP_SERVER_METHODS['voice/start/cancel'], { operationId }).then(() => undefined, () => undefined);
		};
		const onAbort = () => { void cancel(); };
		signal?.addEventListener('abort', onAbort, { once: true });
		const promise = this.client.request(APP_SERVER_METHODS['voice/start'], {
			resourceId, operationId, deviceId: this.device, sessionId: source.sessionId, threadId: source.threadId, connectionId: selection.connectionId, modelId: selection.modelId ?? null, voice: selection.voice ?? null, locale: getNLSLanguage() || 'en', inputMode: 'openMic', muted: false,
			taskLabels: {
				queued: localize('chat.voice.task.queued', 'Your voice request is queued in Chat.'),
				running: localize('chat.voice.task.running', 'I am working on your request in Chat.'),
				waiting: localize('chat.voice.task.waiting', 'Your request is waiting for your response in Chat.'),
				completed: localize('chat.voice.task.completed', 'Your request in Chat has completed.'),
				failed: localize('chat.voice.task.failed', 'Your request in Chat could not complete.'),
				stopped: localize('chat.voice.task.stopped', 'Your request in Chat has stopped.'),
				rejected: localize('chat.voice.task.rejected', 'The host could not accept this voice request.'),
			}
		});
		const pending = { operationId, generation, promise, cancel }; this.starting = pending;
		if (signal?.aborted) cancel();
		try {
			const status = await promise;
			if (this.isDisposed || generation !== this.client.generation || this.resource !== resourceId) throw canceled();
			this.accept(status);
			if (signal?.aborted) { await this.stop(); throw canceled(); }
			const current = this.state;
			if (current?.state !== 'connected') throw new Error(localize('chat.voice.startFailed', 'Could not start the voice conversation: {0}', current?.error ?? current?.state ?? status.state));
			return current;
		} catch (error) {
			if (signal?.aborted || this.isDisposed || generation !== this.client.generation) throw canceled();
			throw error;
		} finally { signal?.removeEventListener('abort', onAbort); if (this.starting === pending) this.starting = undefined; }
	}

	public async stop(): Promise<void> {
		this.clearHold();
		const generation = this.client.generation;
		const starting = this.starting;
		if (starting && starting.generation === generation) {
			await starting.cancel();
			try { this.accept(await starting.promise); } catch { return; }
		}
		const current = this.current;
		if (!current || current.state === 'ended' || current.state === 'failed' || this.client.state !== 'ready') return;
		const status = await this.client.request(APP_SERVER_METHODS['voice/stop'], { resourceId: current.resourceId, mediaEpoch: current.mediaEpoch, operationId: createUuid() });
		if (generation === this.client.generation) this.accept(status);
	}

	public async interrupt(): Promise<void> {
		this.clearHold();
		const current = this.current;
		if (!current || current.state !== 'connected') return;
		const generation = this.client.generation;
		const status = await this.client.request(APP_SERVER_METHODS['voice/interrupt'], { resourceId: current.resourceId, mediaEpoch: current.mediaEpoch, operationId: createUuid() });
		if (generation === this.client.generation) this.accept(status);
	}

	public async rejectTask(request: AgentVoiceTaskRequest): Promise<void> {
		if (this.current?.resourceId !== request.resourceId || this.current.mediaEpoch !== request.mediaEpoch || this.current.state !== 'connected') return;
		await this.client.request(APP_SERVER_METHODS['voice/delegation/reject'], { resourceId: request.resourceId, mediaEpoch: request.mediaEpoch, delegationId: request.delegationId });
	}

	public setMuted(muted: boolean): Promise<void> { this.clearHold(); return this.input({ type: 'mute', muted }); }
	public setInputMode(mode: AgentVoiceSessionState['inputMode']): Promise<void> { this.clearHold(); return this.input({ type: 'mode', mode }); }
	public async pttDown(id: string): Promise<void> {
		const state = this.current;
		if (!state || state.state !== 'connected' || state.muted || state.inputMode !== 'pushToTalk') return;
		if (this.hold?.id === id) return;
		this.clearHold();
		const hold = { id, resourceId: state.resourceId, epoch: state.mediaEpoch, renew: undefined as ReturnType<typeof setInterval> | undefined };
		this.hold = hold;
		try {
			await this.input({ type: 'hold', id });
			if (this.hold !== hold) return;
			let renewing = false;
			hold.renew = setInterval(() => {
				if (this.hold !== hold || renewing) return;
				renewing = true;
				void this.input({ type: 'renew', id }).then(() => {
					if (this.hold === hold && !this.current?.listening) this.clearHold();
				}, () => { if (this.hold === hold) { this.clearHold(); void this.input({ type: 'release', id }).catch(() => undefined); } }).finally(() => { renewing = false; });
			}, 500);
		} catch (error) { if (this.hold === hold) this.clearHold(); throw error; }
	}
	public pttUp(id: string): Promise<void> {
		if (this.hold?.id === id) this.clearHold();
		return this.input({ type: 'release', id });
	}
	private clearHold(): void { if (this.hold?.renew !== undefined) clearInterval(this.hold.renew); this.hold = undefined; }
	private input(control: { readonly type: 'mute'; readonly muted: boolean; } | { readonly type: 'mode'; readonly mode: AgentVoiceSessionState['inputMode']; } | { readonly type: 'hold' | 'release' | 'renew'; readonly id: string; }): Promise<void> {
		const source = this.current;
		const generation = this.client.generation;
		if (!source || source.state !== 'connected') return Promise.resolve();
		const operation = this.inputQueue.catch(() => undefined).then(async () => {
			const current = this.current;
			if (this.isDisposed || this.client.generation !== generation || current?.resourceId !== source.resourceId || current.mediaEpoch !== source.mediaEpoch || current.state !== 'connected') throw canceled();
			const inputSequence = this.inputCounter = Math.max(this.inputCounter, current.inputSequence) + 1;
			const status = await this.client.request(APP_SERVER_METHODS['voice/input'], { resourceId: source.resourceId, mediaEpoch: source.mediaEpoch, inputSequence, control });
			if (generation === this.client.generation) this.accept(status);
		});
		this.inputQueue = operation;
		return operation;
	}

	protected override disposeCore(): void { void this.stop().catch(() => undefined); super.disposeCore(); }
	private assertAvailable(): void { if (!this.isAvailable) throw new Error(localize('chat.voice.unavailable', 'Voice conversation is unavailable in this host.')); }
	private accept(status: VoiceStatus): void {
		if (this.isDisposed || status.resourceId !== this.resource || status.sessionId !== this.source?.sessionId || status.threadId !== this.source.threadId) return;
		if (this.current && (status.mediaEpoch < this.current.mediaEpoch || status.mediaEpoch === this.current.mediaEpoch && status.sequence <= this.current.sequence)) return;
		if (this.hold && (status.mediaEpoch !== this.hold.epoch || status.state !== 'connected' || status.muted || status.inputMode !== 'pushToTalk')) this.clearHold();
		this.current = { resourceId: status.resourceId, sessionId: status.sessionId, threadId: status.threadId, mediaEpoch: status.mediaEpoch, sequence: status.sequence, state: status.state, inputMode: status.inputMode, muted: status.muted, listening: status.listening, inputSequence: status.inputSequence, usageMilliseconds: status.usageMilliseconds, ...(status.error ? { error: status.error } : {}) };
		this.changed.fire();
	}
}


async function withHostResourceInput<T>(connection: AppServerProtocolClient, snapshots: IAgentHostResourceService | undefined, input: readonly AgentInput[], operation: (input: InputItem[]) => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal) { throwIfCancelled(signal); }
	const converted: InputItem[] = input.map(item => ({ ...item }));
	if (!snapshots || connection.capabilities?.contracts.hostResources?.version !== 1) { return operation(converted); }
	const generation = connection.generation;
	using leases = new DisposableStore();
	for (const [index, item] of input.entries()) {
		if (item.type !== 'context') { continue; }
		if (signal) { throwIfCancelled(signal); }
		const lease = await snapshots.createSnapshot(item.content);
		if (lease) {
			leases.add(lease);
			converted[index] = { type: 'hostResource', name: item.name, resource: lease.object };
		}
		// Own a late lease before observing cancellation, so teardown always releases it.
		if (signal) { throwIfCancelled(signal); }
		if (connection.state !== 'ready' || connection.generation !== generation) { throw canceled(); }
	}
	if (signal) { throwIfCancelled(signal); }
	return await operation(converted);
}

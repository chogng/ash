import { localize } from '../../../nls.js';
import { createUuid } from '../../../base/common/uuid.js';
import type { ProviderConfigDto, ProviderModelsListFailureCodeDto } from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import { sessionRequest, sessionResult, sessionThreadResult, turnInteractionResolveResult, turnInterruptResult, turnStartResult, turnSteerResult } from "../common/sessionApi.js";
import type { CustomModelProvider, IModelApi, ISessionApi, IThreadApi, ITurnApi } from "../common/sessionApi.js";

export function createDisconnectedSessionApi(unavailable: UnavailableOperation): ISessionApi {
	return {
		create: () => unavailable("session.create"),
		listAgents: () => unavailable("session.listAgents"),
		read: () => unavailable("session.read"),
		readCatalog: () => unavailable("session.readCatalog"),
		list: () => unavailable("session.list"),
		subscribeCatalog: () => unavailable("session.subscribeCatalog"),
		unsubscribeCatalog: () => unavailable("session.unsubscribeCatalog"),
		subscribe: () => unavailable("session.subscribe"),
		unsubscribe: () => unavailable("session.unsubscribe"),
		createThread: () => unavailable("session.createThread"),
		forkThread: () => unavailable("session.forkThread"),
		archive: () => unavailable("session.archive"),
		stop: () => unavailable("session.stop"),
	};
}

export function createDisconnectedModelApi(unavailable: UnavailableOperation): IModelApi {
	return {
		readApprovalReviewModel: () => unavailable('model.readApprovalReviewModel'),
		setApprovalReviewModel: () => unavailable('model.setApprovalReviewModel'),
		setModelPreferences: () => unavailable('model.setModelPreferences'),
		listCustomProviders: () => unavailable('model.listCustomProviders'),
		saveCustomProvider: () => unavailable('model.saveCustomProvider'),
		testProviderModel: () => unavailable('model.testProviderModel'),
		listModels: () => unavailable("model.listModels"),
		listProviders: () => unavailable('model.listProviders'),
		listProviderModels: () => unavailable('model.listProviderModels'),
		setProviderApiKey: () => unavailable('model.setProviderApiKey'),
		removeProviderApiKey: () => unavailable('model.removeProviderApiKey'),
		readModel: () => unavailable("model.readModel"),
		readAdvisorDefault: () => unavailable("model.readAdvisorDefault"),
		readConfiguredProviderIds: () => unavailable("model.readConfiguredProviderIds"),
		setAdvisorDefault: () => unavailable("model.setAdvisorDefault"),
		setModel: () => unavailable("model.setModel"),
	};
}

export function createDisconnectedThreadApi(unavailable: UnavailableOperation): IThreadApi {
	return {
		read: () => unavailable("thread.read"),
		configureAdvisor: () => unavailable("thread.configureAdvisor"),
		subscribe: () => unavailable("thread.subscribe"),
		unsubscribe: () => unavailable("thread.unsubscribe"),
		getGoal: () => unavailable("thread.goal.get"),
		setGoal: () => unavailable("thread.goal.set"),
		clearGoal: () => unavailable("thread.goal.clear"),
	};
}

export function createDisconnectedTurnApi(unavailable: UnavailableOperation): ITurnApi {
	return {
		enqueue: () => unavailable("queue.enqueue"),
		listQueued: () => unavailable("queue.list"),
		start: () => unavailable("turn.start"),
		compact: () => unavailable("turn.compact"),
		consultAdvisor: () => unavailable("turn.consultAdvisor"),
		steer: () => unavailable("turn.steer"),
		interrupt: () => unavailable("turn.interrupt"),
		resolveInteraction: () => unavailable("turn.resolveInteraction"),
	};
}

export function createAppServerSessionApi(connection: AppServerProtocolClient): ISessionApi {
	return {
		create: (params) => appServerRequest(connection, "session/create", params),
		listAgents: () => appServerRequest(connection, "agent/roles/list", {}),
		read: (params) => appServerRequest(connection, "session/read", params),
		readCatalog: (params) => appServerRequest(connection, "session/catalog/read", params),
		list: () => appServerRequest(connection, "session/list", {}),
		subscribeCatalog: () => appServerRequest(connection, "session/catalog/subscribe", {}),
		unsubscribeCatalog: () => voidResult(appServerRequest(connection, "session/catalog/unsubscribe", {})),
		subscribe: (params) => appServerRequest(connection, "session/subscribe", params),
		unsubscribe: (params) => voidResult(appServerRequest(connection, "session/unsubscribe", params)),
		createThread: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "createThread", title: params.title })).then(sessionThreadResult),
		forkThread: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "forkThread", parentThreadId: params.parentThreadId, title: params.title })).then(sessionThreadResult),
		archive: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "archive" })).then(sessionResult),
		stop: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "stop" })).then(sessionResult),
	};
}

export function createAppServerModelApi(connection: AppServerProtocolClient): IModelApi {
	return {
		readApprovalReviewModel: async () => {
			const selection = (await appServerRequest(connection, 'config/read', {})).approvalReviewModel;
			return selection.type === 'automatic' ? { type: 'automatic' } : {
				type: 'explicit', model: { ...selection.model },
				...(selection.connection != null ? { connection: selection.connection } : {}),
				...(selection.reasoningEffort != null ? { reasoningEffort: selection.reasoningEffort } : {}),
			};
		},
		setApprovalReviewModel: async selection => {
			const config = await appServerRequest(connection, 'config/read', {});
			await appServerRequest(connection, 'config/update', {
				commandId: createUuid(), expectedRevision: config.revision, approvalReviewModel: selection,
			});
		},
		setModelPreferences: async (model, update) => {
			const snapshot = await appServerRequest(connection, 'config/read', {});
			await appServerRequest(connection, 'model/preferences/update', {
				command_id: createUuid(), expected_revision: snapshot.revision, model,
				...(update.acceleration !== undefined ? { acceleration: update.acceleration } : {}),
				...(update.longContext !== undefined ? { long_context: update.longContext } : {}),
			});
		},
		listCustomProviders: async () => {
			const snapshot = await appServerRequest(connection, 'config/read', {});
			return Object.values(snapshot.connections).filter(config => config.custom && config.connection.startsWith('custom-')).map(config => ({
				id: config.connection,
				name: config.custom!.name,
				baseUrl: config.baseUrl ?? '',
				apiFormat: config.custom!.protocol,
				order: config.custom!.order,
				models: Object.entries(config.modelContext ?? {}).filter((entry): entry is [string, typeof entry[1] & { contextWindow: number }] => entry[1].contextWindow != null).map(([id, context]) => ({ id, contextWindow: context.contextWindow, ...(config.custom?.modelAliases?.[id] ? { upstreamModel: config.custom.modelAliases[id] } : {}) })),
			}));
		},
		saveCustomProvider: async provider => {
			const snapshot = await appServerRequest(connection, 'config/read', {});
			const config = customProviderConfig(provider);
			await appServerRequest(connection, 'provider/configure', {
				commandId: createUuid(),
				expectedRevision: snapshot.revision,
				config: {
					...snapshot.connections[provider.id],
					...config,
					modelContext: Object.fromEntries(Object.entries(config.modelContext ?? {}).filter((entry): entry is [string, typeof entry[1] & { contextWindow: number }] => entry[1].contextWindow != null).map(([id, context]) => [id, {
						...snapshot.connections[provider.id]?.modelContext?.[id],
						...context,
					}])),
					custom: {
						...config.custom!,
						...snapshot.connections[provider.id]?.custom,
						name: provider.name,
						protocol: provider.apiFormat,
						order: provider.order,
						modelAliases: config.custom!.modelAliases,
					},
				},
			});
		},
		testProviderModel: async (provider, model) => {
			const result = await appServerRequest(connection, 'provider/probe', { config: customProviderConfig(provider), apiKey: null, model });
			return result.type === 'failed' ? result : { type: 'passed' };
		},
		listModels: () => appServerRequest(connection, "model/list", {}),
		listProviders: () => appServerRequest(connection, 'provider/list', {}),
		listProviderModels: async provider => {
			const result = await appServerRequest(connection, 'provider/models/list', { connection: provider });
			if (result.type === 'failed') { throw new Error(modelDiscoveryMessage(result.failure.code)); }
			return result.type === 'models' ? result.models.map(entry => ({ ...entry, discovered: entry.discovered ?? undefined })) : [];
		},
		setProviderApiKey: params => appServerRequest(connection, 'provider/apiKey/set', params),
		removeProviderApiKey: async provider => { await appServerRequest(connection, 'provider/apiKey/remove', { connection: provider }); },
		readModel: async () => (await appServerRequest(connection, "config/read", {})).model,
		readAdvisorDefault: async () => (await appServerRequest(connection, "config/read", {})).advisor ?? null,
		readConfiguredProviderIds: async () => Object.keys((await appServerRequest(connection, "config/read", {})).providers),
		setAdvisorDefault: async ({ commandId, advisor }) => {
			const config = await appServerRequest(connection, "config/read", {});
			await appServerRequest(connection, "config/update", { commandId, expectedRevision: config.revision, advisor });
		},
		setModel: async ({ commandId, model }) => {
			const config = await appServerRequest(connection, "config/read", {});
			await appServerRequest(connection, "config/update", {
				commandId,
				expectedRevision: config.revision,
				model,
			});
		},
	};
}

export function createAppServerThreadApi(connection: AppServerProtocolClient): IThreadApi {
	return {
		read: (params) => appServerRequest(connection, "session/thread/read", params),
		configureAdvisor: async (params) => {
			const result = await appServerRequest(connection, "session/request", sessionRequest(params, { type: "configureAdvisor", threadId: params.threadId, expectedSequence: params.expectedSequence, selection: params.selection }));
			if (result.type !== "advisorConfigured") throw new Error(`Expected advisor configuration result, received ${result.type}.`);
			return result.value;
		},
		subscribe: (params) => appServerRequest(connection, "session/thread/subscribe", params),
		unsubscribe: (params) => voidResult(appServerRequest(connection, "session/thread/unsubscribe", params)),
		getGoal: (params) => appServerRequest(connection, "thread/goal/get", params),
		setGoal: (params) => appServerRequest(connection, "thread/goal/set", params),
		clearGoal: (params) => appServerRequest(connection, "thread/goal/clear", params),
	};
}

export function createAppServerTurnApi(connection: AppServerProtocolClient): ITurnApi {
	return {
		enqueue: params => appServerRequest(connection, "queue/enqueue", params),
		listQueued: params => appServerRequest(connection, "queue/list", params),
		start: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "startTurn", threadId: params.threadId, expectedSequence: params.expectedSequence, mode: params.mode, approvalMode: params.approvalMode, model: params.model, reasoningEffort: params.reasoningEffort, toolMode: params.toolMode, input: params.input })).then(turnStartResult),
		consultAdvisor: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "consultAdvisor", threadId: params.threadId, expectedSequence: params.expectedSequence, question: params.question })).then(turnStartResult),
		compact: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "compactContext", threadId: params.threadId, expectedSequence: params.expectedSequence, retentionPrompt: params.retentionPrompt })).then(turnStartResult),
		steer: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "steerTurn", threadId: params.threadId, expectedSequence: params.expectedSequence, turnId: params.turnId, input: params.input })).then(turnSteerResult),
		interrupt: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "interruptTurn", threadId: params.threadId, expectedSequence: params.expectedSequence, turnId: params.turnId })).then(turnInterruptResult),
		resolveInteraction: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "resolveInteraction", threadId: params.threadId, expectedSequence: params.expectedSequence, turnId: params.turnId, requestId: params.requestId, response: params.response })).then(turnInteractionResolveResult),
	};
}

function customProviderConfig(provider: CustomModelProvider): ProviderConfigDto {
	return {
		connection: provider.id,
		provider: provider.id,
		baseUrl: provider.baseUrl,
		custom: { name: provider.name, protocol: provider.apiFormat, order: provider.order, contextWindow: 272_000, model: null, modelAliases: Object.fromEntries(provider.models.filter(model => model.upstreamModel).map(model => [model.id, model.upstreamModel!])) },
		modelContext: Object.fromEntries(provider.models.map(model => [model.id, { contextWindow: model.contextWindow }])),
	};
}

function modelDiscoveryMessage(code: ProviderModelsListFailureCodeDto): string {
	switch (code) {
		case 'authentication': return localize('models.discovery.authentication', 'The endpoint rejected the API key.');
		case 'permission': return localize('models.discovery.permission', 'The API key does not have permission to list models.');
		case 'unsupported': return localize('models.discovery.unsupported', 'This endpoint does not provide a model list. Add model IDs manually.');
		case 'rateLimited': return localize('models.discovery.rateLimited', 'The endpoint rate limit was reached. Try again later.');
		case 'unreachable': return localize('models.discovery.unreachable', 'Could not reach the endpoint. Check the Base URL and connection.');
		case 'providerUnavailable': return localize('models.discovery.providerUnavailable', 'The endpoint is temporarily unavailable.');
		case 'invalidRequest': return localize('models.discovery.invalidRequest', 'The endpoint rejected the model list request. Check the API format and Base URL.');
		case 'invalidResponse': return localize('models.discovery.invalidResponse', 'The endpoint returned an invalid model list.');
		case 'invalidConfiguration': return localize('models.discovery.invalidConfiguration', 'The provider configuration is invalid. Check its fields.');
		case 'cancelled': return localize('models.discovery.cancelled', 'Model discovery was cancelled.');
		case 'unknown': return localize('models.discovery.unknown', 'Could not fetch the model list.');
	}
}

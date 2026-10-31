import type { ModelListResult } from '../../../../../.build/protocol/typescript/index.js';
import type { ModelCatalogEntry } from '../common/agentModels.js';
import { localize } from '../../../nls.js';
import { createUuid } from '../../../base/common/uuid.js';
import type {
	ProviderConfigDto,
	ProviderModelsListFailureCodeDto
} from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from './appServerProtocolClient.js';
import { appServerRequest } from './appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { CustomModelProvider, IAgentModelsService } from '../common/agentModels.js';
import { withSecretStorageErrors } from '../../secrets/browser/appServerSecretStorageStatusService.js';

export function createDisconnectedAgentModelsService(unavailable: UnavailableOperation): IAgentModelsService {
	return {
		readDefaults: () => unavailable('model.readDefaults'),
		configureDefaults: () => unavailable('model.configureDefaults'),
		readApprovalReviewModel: () => unavailable('model.readApprovalReviewModel'),
		setApprovalReviewModel: () => unavailable('model.setApprovalReviewModel'),
		setModelPreferences: () => unavailable('model.setModelPreferences'),
		listCustomProviders: () => unavailable('model.listCustomProviders'),
		saveCustomProvider: () => unavailable('model.saveCustomProvider'),
		removeCustomProvider: () => unavailable('model.removeCustomProvider'),
		testProviderModel: () => unavailable('model.testProviderModel'),
		listModels: () => unavailable('model.listModels'),
		listProviders: () => unavailable('model.listProviders'),
		listProviderModels: () => unavailable('model.listProviderModels'),
		setProviderApiKey: () => unavailable('model.setProviderApiKey'),
		removeProviderApiKey: () => unavailable('model.removeProviderApiKey'),
		readModel: () => unavailable('model.readModel'),
		readAdvisorDefault: () => unavailable('model.readAdvisorDefault'),
		setAdvisorDefault: () => unavailable('model.setAdvisorDefault'),
		setModel: () => unavailable('model.setModel')
	};
}

export function createAppServerAgentModelsService(connection: AppServerProtocolClient): IAgentModelsService {
	return {
		readDefaults: async () => {
			const config = await appServerRequest(connection, 'config/read', {});
			return {
				commitMessageModel: config.commitMessageModel ? { ...config.commitMessageModel } : null,
				commitMessageEnabled: config.commitMessageEnabled,
				codeReviewModel: config.codeReviewModel ? { ...config.codeReviewModel } : null,
				revision: config.revision,
				model: config.model ? { ...config.model } : null,
				reasoningEffort: config.modelReasoningEffort ?? null,
			};
		},
		configureDefaults: async (update, expectedRevision) => {
			await appServerRequest(connection, 'config/update', {
				commandId: createUuid(), expectedRevision,
				...(update.commitMessageEnabled !== undefined ? { commitMessageEnabled: update.commitMessageEnabled } : {}),
				...(update.commitMessageModel !== undefined ? { commitMessageModel: update.commitMessageModel } : {}),
				...(update.codeReviewModel !== undefined ? { codeReviewModel: update.codeReviewModel } : {}),
				...(update.model !== undefined ? { model: update.model } : {}),
				...(update.reasoningEffort !== undefined ? { modelReasoningEffort: update.reasoningEffort } : {}),
			});
		},
		readApprovalReviewModel: async () => {
			const selection = (await appServerRequest(connection, 'config/read', {})).approvalReviewModel;
			return selection.type === 'automatic'
				? { type: 'automatic' }
				: {
					type: 'explicit',
					model: { ...selection.model },
					...(selection.connection != null ? { connection: selection.connection } : {}),
					...(selection.reasoningEffort != null ? { reasoningEffort: selection.reasoningEffort } : {})
				};
		},
		setApprovalReviewModel: async (selection) => {
			const config = await appServerRequest(connection, 'config/read', {});
			await appServerRequest(connection, 'config/update', {
				commandId: createUuid(),
				expectedRevision: config.revision,
				approvalReviewModel: selection
			});
		},
		setModelPreferences: async (model, update) => {
			const snapshot = await appServerRequest(connection, 'config/read', {});
			await appServerRequest(connection, 'model/preferences/update', {
				command_id: createUuid(),
				expected_revision: snapshot.revision,
				model,
				...(update.acceleration !== undefined ? { acceleration: update.acceleration } : {}),
				...(update.longContext !== undefined ? { long_context: update.longContext } : {})
			});
		},
		listCustomProviders: async () => {
			const snapshot = await appServerRequest(connection, 'config/read', {});
			return Object.values(snapshot.connections)
				.filter((config) => config.custom && config.connection.startsWith('custom-'))
				.map((config) => ({
					id: config.connection,
					name: config.custom!.name,
					baseUrl: config.baseUrl ?? '',
					apiFormat: config.custom!.protocol,
					order: config.custom!.order,
					models: Object.entries(config.modelContext ?? {})
						.filter(
							(entry): entry is [string, (typeof entry)[1] & { contextWindow: number; }] =>
								entry[1].contextWindow != null
						)
						.map(([id, context]) => ({
							id,
							contextWindow: context.contextWindow,
							...(config.custom?.modelAliases?.[id]
								? { upstreamModel: config.custom.modelAliases[id] }
								: {})
						}))
				}));
		},
		saveCustomProvider: async (provider) => {
			const snapshot = await appServerRequest(connection, 'config/read', {});
			const config = customProviderConfig(provider);
			await appServerRequest(connection, 'provider/configure', {
				commandId: createUuid(),
				expectedRevision: snapshot.revision,
				config: {
					...snapshot.connections[provider.id],
					...config,
					modelContext: Object.fromEntries(
						Object.entries(config.modelContext ?? {})
							.filter(
								(entry): entry is [string, (typeof entry)[1] & { contextWindow: number; }] =>
									entry[1].contextWindow != null
							)
							.map(([id, context]) => [
								id,
								{
									...snapshot.connections[provider.id]?.modelContext?.[id],
									...context
								}
							])
					),
					custom: {
						...config.custom!,
						...snapshot.connections[provider.id]?.custom,
						name: provider.name,
						protocol: provider.apiFormat,
						order: provider.order,
						modelAliases: config.custom!.modelAliases
					}
				}
			});
		},
		removeCustomProvider: async (provider) => {
			const snapshot = await appServerRequest(connection, 'config/read', {});
			if (!provider.startsWith('custom-') || !snapshot.connections[provider]?.custom) { throw new TypeError(localize('models.provider.removeCustomOnly', 'Only a configured custom provider can be removed.')); }
			await withSecretStorageErrors(appServerRequest(connection, 'provider/remove', { commandId: createUuid(), expectedRevision: snapshot.revision, connection: provider }));
		},
		testProviderModel: async (provider, model) => {
			const result = await appServerRequest(connection, 'provider/probe', {
				config: customProviderConfig(provider),
				apiKey: null,
				model
			});
			return result.type === 'failed' ? result : { type: 'passed' };
		},
		listModels: async () => {
			const result = await withSecretStorageErrors(appServerRequest(connection, 'model/list', {}));
			return {
				models: result.models.map(modelCatalogEntry),
				statuses: Object.freeze((result.catalog_statuses ?? []).map(status => Object.freeze({
					...status, issues: Object.freeze([...status.issues]),
				}))),
				scopes: result.catalog_scopes?.map((scope) => ({ ...scope }))
			};
		},
		listProviders: () => withSecretStorageErrors(appServerRequest(connection, 'provider/list', {})),
		listProviderModels: async (provider) => {
			const result = await appServerRequest(connection, 'provider/models/list', { connection: provider });
			if (result.type === 'failed') {
				throw new Error(modelDiscoveryMessage(result.failure.code));
			}
			return result.type === 'models' ? result.models.map(modelCatalogEntry) : [];
		},
		setProviderApiKey: (params) => withSecretStorageErrors(appServerRequest(connection, 'provider/apiKey/set', params)),
		removeProviderApiKey: async (provider) => {
			await withSecretStorageErrors(appServerRequest(connection, 'provider/apiKey/remove', { connection: provider }));
		},
		readModel: async () => (await appServerRequest(connection, 'config/read', {})).model,
		readAdvisorDefault: async () => (await appServerRequest(connection, 'config/read', {})).advisor ?? null,
		setAdvisorDefault: async ({ commandId, advisor }) => {
			const config = await appServerRequest(connection, 'config/read', {});
			await appServerRequest(connection, 'config/update', {
				commandId,
				expectedRevision: config.revision,
				advisor
			});
		},
		setModel: async ({ commandId, model }) => {
			const config = await appServerRequest(connection, 'config/read', {});
			await appServerRequest(connection, 'config/update', {
				commandId,
				expectedRevision: config.revision,
				model
			});
		}
	};
}

function customProviderConfig(provider: CustomModelProvider): ProviderConfigDto {
	return {
		connection: provider.id,
		provider: provider.id,
		baseUrl: provider.baseUrl,
		custom: {
			name: provider.name,
			protocol: provider.apiFormat,
			order: provider.order,
			contextWindow: 272_000,
			model: null,
			modelAliases: Object.fromEntries(
				provider.models.filter((model) => model.upstreamModel).map((model) => [model.id, model.upstreamModel!])
			)
		},
		modelContext: Object.fromEntries(
			provider.models.map((model) => [model.id, { contextWindow: model.contextWindow }])
		)
	};
}

function modelDiscoveryMessage(code: ProviderModelsListFailureCodeDto): string {
	switch (code) {
		case 'authentication':
			return localize('models.discovery.authentication', 'The endpoint rejected the API key.');
		case 'permission':
			return localize('models.discovery.permission', 'The API key does not have permission to list models.');
		case 'unsupported':
			return localize(
				'models.discovery.unsupported',
				'This endpoint does not provide a model list. Add model IDs manually.'
			);
		case 'rateLimited':
			return localize('models.discovery.rateLimited', 'The endpoint rate limit was reached. Try again later.');
		case 'unreachable':
			return localize(
				'models.discovery.unreachable',
				'Could not reach the endpoint. Check the Base URL and connection.'
			);
		case 'providerUnavailable':
			return localize('models.discovery.providerUnavailable', 'The endpoint is temporarily unavailable.');
		case 'invalidRequest':
			return localize(
				'models.discovery.invalidRequest',
				'The endpoint rejected the model list request. Check the API format and Base URL.'
			);
		case 'invalidResponse':
			return localize('models.discovery.invalidResponse', 'The endpoint returned an invalid model list.');
		case 'invalidConfiguration':
			return localize(
				'models.discovery.invalidConfiguration',
				'The provider configuration is invalid. Check its fields.'
			);
		case 'cancelled':
			return localize('models.discovery.cancelled', 'Model discovery was cancelled.');
		case 'unknown':
			return localize('models.discovery.unknown', 'Could not fetch the model list.');
	}
}

function modelCatalogEntry(entry: ModelListResult['models'][number]): ModelCatalogEntry {
	return Object.freeze({
		model: Object.freeze({ ...entry.model }),
		displayName: entry.display_name,
		capabilities: Object.freeze({ toolCalling: entry.capabilities.tools, agentMode: entry.capabilities.agent_mode ?? 'unknown' }),
		source: entry.source ? Object.freeze({ providerId: entry.source.provider_id, connectionId: entry.source.connection_id, metadata: entry.source.metadata }) : undefined,
		pricing: Object.freeze((entry.pricing ?? []).map(price => Object.freeze({
			currency: price.currency, serviceTier: price.service_tier, region: price.region,
			minInputTokens: price.min_input_tokens, maxInputTokens: price.max_input_tokens,
			input: price.input, output: price.output, cacheRead: price.cache_read, cacheWrite: price.cache_write,
			revision: price.revision, reviewedAt: price.reviewed_at, sourceUrls: Object.freeze([...price.source_urls]),
		}))),
		inputModalities: entry.settings.input_modalities ? Object.freeze([...entry.settings.input_modalities]) : null,
		retirement: entry.retirement ? Object.freeze({ shutdownDate: entry.retirement.shutdown_date }) : undefined,
		description: entry.description,
		defaultContextWindow: entry.default_context_window,
		maximumContextWindow: entry.maximum_context_window,
		accelerationOptions: Object.freeze(entry.acceleration_options.map((option) => Object.freeze({ ...option }))),
		selectedAcceleration: entry.selected_acceleration,
		longContext: entry.long_context,
		...(entry.discovered === true ? { discovered: true } : {}),
		contextWindow: entry.context_window,
		supportedReasoningEfforts: Object.freeze(
			entry.supported_reasoning_efforts.map((option) => Object.freeze({ ...option }))
		),
		...(entry.default_reasoning_effort != null ? { defaultReasoningEffort: entry.default_reasoning_effort } : {})
	});
}

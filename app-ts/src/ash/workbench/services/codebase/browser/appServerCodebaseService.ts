import type { CodebaseStatusResult, ConfigCommandResult, ConfigReadResult, ProviderConfigDto, CodebaseAutomaticContextDto, CodebaseModelsDto } from "../../../../platform/app-server/common/generated/index.js";
import type { ICodebaseApi } from "../../../../platform/codebase/common/codebaseApi.js";
import type { CodebaseConfigurationCommandResult, CodebaseConfigurationSnapshot, CodebaseProviderConfiguration, CodebaseStatus, ICodebaseService, CodebaseAutomaticContext, CodebaseModels } from "../../../../platform/codebase/common/codebaseService.js";

export class AppServerCodebaseService implements ICodebaseService {
	constructor(private readonly api: ICodebaseApi) {}

	async readConfig(): Promise<CodebaseConfigurationSnapshot> { return projectConfiguration(await this.api.readConfig()); }

	async configureProvider(config: CodebaseProviderConfiguration, expectedRevision: number): Promise<CodebaseConfigurationCommandResult> {
		return projectCommandResult(await this.api.configureProvider({ commandId: commandId("provider"), expectedRevision, config: providerConfigurationDto(config) }));
	}

	async configure(models: CodebaseModels | undefined, automaticContext: CodebaseAutomaticContext, expectedRevision: number): Promise<CodebaseConfigurationCommandResult> {
		return projectCommandResult(await this.api.configure({ commandId: commandId("configure"), expectedRevision, models: models ? modelsDto(models) : null, automaticContext: automaticContext as CodebaseAutomaticContextDto }));
	}

	async status(): Promise<CodebaseStatus> { return projectStatus(await this.api.status()); }

}

function projectConfiguration(config: ConfigReadResult): CodebaseConfigurationSnapshot {
	return {
		revision: config.revision,
		generation: config.generation,
		providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, projectProviderConfiguration(provider)])),
		codebase: {
			models: config.codebase.models ? projectModels(config.codebase.models) : config.codebase.models,
			automaticContext: config.codebase.automaticContext,
		},
	};
}

function projectProviderConfiguration(config: ProviderConfigDto): CodebaseProviderConfiguration {
	return { provider: config.provider, baseUrl: config.baseUrl, maxOutputTokens: config.maxOutputTokens, modelContext: config.modelContext ? Object.fromEntries(Object.entries(config.modelContext).map(([model, context]) => [model, { ...context }])) : undefined };
}

function providerConfigurationDto(config: CodebaseProviderConfiguration): ProviderConfigDto {
	return { provider: config.provider, baseUrl: config.baseUrl, maxOutputTokens: config.maxOutputTokens, modelContext: config.modelContext ? Object.fromEntries(Object.entries(config.modelContext).map(([model, context]) => [model, { ...context }])) : undefined };
}

function projectModels(models: CodebaseModelsDto): CodebaseModels {
	return { embeddingModel: { ...models.embeddingModel }, rerankModel: models.rerankModel ? { ...models.rerankModel } : models.rerankModel };
}

function modelsDto(models: CodebaseModels): CodebaseModelsDto {
	return { embeddingModel: { ...models.embeddingModel }, rerankModel: models.rerankModel ? { ...models.rerankModel } : models.rerankModel };
}

function projectCommandResult(result: ConfigCommandResult): CodebaseConfigurationCommandResult {
	return { revision: result.revision, generation: result.generation, disposition: result.disposition };
}

function projectStatus(status: CodebaseStatusResult): CodebaseStatus {
	return { ...status };
}

function commandId(operation: string): string {
	return `desktop-codebase-${operation}-${crypto.randomUUID()}`;
}

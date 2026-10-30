import type { CodebaseStatusResult, ConfigCommandResult, CodebaseModelsDto } from '../../../../../../.build/protocol/typescript/index.js';
import type { ICodebaseApi } from '../../../../platform/codebase/common/codebaseApi.js';
import type { CodebaseConfigurationCommandResult, CodebaseConfigurationSnapshot, CodebaseStatus, ICodebaseService, CodebaseAutomaticContext, CodebaseModels } from '../../../../platform/codebase/common/codebaseService.js';

export class AppServerCodebaseService implements ICodebaseService {
	constructor(private readonly api: ICodebaseApi) { }

	async readConfig(): Promise<CodebaseConfigurationSnapshot> {
		const config = await this.api.readConfig();
		return {
			revision: config.revision,
			generation: config.generation,
			codebase: {
				models: config.codebase.models ? projectModels(config.codebase.models) : config.codebase.models,
				automaticContext: config.codebase.automaticContext,
			},
		};
	}

	async configure(models: CodebaseModels | undefined, automaticContext: CodebaseAutomaticContext, expectedRevision: number): Promise<CodebaseConfigurationCommandResult> {
		return projectCommandResult(await this.api.configure({
			commandId: commandId('configure'),
			expectedRevision,
			models: models ? modelsDto(models) : null,
			automaticContext,
		}));
	}

	async status(): Promise<CodebaseStatus> { return projectStatus(await this.api.status()); }

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
	return { ...status, embedding: { ...status.embedding } };
}

function commandId(operation: string): string {
	return `desktop-codebase-${operation}-${crypto.randomUUID()}`;
}

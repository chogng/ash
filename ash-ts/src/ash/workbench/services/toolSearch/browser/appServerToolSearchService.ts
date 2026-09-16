import type { ModelRef, ToolSearchConfigDto } from "../../../../platform/app-server/common/generated/index.js";
import type { IToolSearchApi } from "../../../../platform/toolSearch/common/toolSearchApi.js";
import type { IToolSearchService, ToolSearchConfiguration, ToolSearchEmbeddingStatus, ToolSearchSettings } from "../../../../platform/toolSearch/common/toolSearchService.js";

export class AppServerToolSearchService implements IToolSearchService {
	constructor(private readonly api: IToolSearchApi) {}

	async readConfig(): Promise<ToolSearchSettings> {
		const config = await this.api.readConfig();
		return toolSearchSettings(config.revision, config.toolSearch);
	}

	async configure(config: ToolSearchConfiguration, expectedRevision: number): Promise<void> {
		await this.api.configure({
			commandId: `desktop-tool-search-configure-${crypto.randomUUID()}`,
			expectedRevision,
			mode: config.mode,
			embeddingModel: config.embeddingModel ?? null,
		});
	}
}

function toolSearchSettings(revision: number, config: ToolSearchConfigDto): ToolSearchSettings {
	return {
		revision,
		mode: config.mode,
		embeddingModel: config.embeddingModel ?? undefined,
		embeddingStatus: embeddingStatus(config.embeddingStatus),
	};
}

function embeddingStatus(status: ToolSearchConfigDto["embeddingStatus"]): ToolSearchEmbeddingStatus {
	switch (status.type) {
		case "disabled": return { type: "disabled" };
		case "ready": return { type: "ready", model: modelRef(status.model) };
		case "unavailable": return {
			type: "unavailable",
			model: status.model ? modelRef(status.model) : undefined,
			reason: status.reason,
		};
	}
}

function modelRef(model: ModelRef): ModelRef {
	return { provider: model.provider, model: model.model };
}

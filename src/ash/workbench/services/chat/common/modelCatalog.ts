import type { ModelRef } from '../../../../platform/agentHost/common/agentModels.js';
export type { ModelReasoningEffort, ModelReasoningEffortOption, ModelAccelerationOption, ModelRetirement, ModelCatalogEntry } from '../../../../platform/agentHost/common/agentModels.js';

export function modelRefIdentity(model: ModelRef): string {
	return `${model.provider}\0${model.model}`;
}

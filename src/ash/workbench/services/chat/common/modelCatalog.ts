import type { ModelRef, ModelPurpose, ModelCatalogEntry } from '../../../../platform/agentHost/common/agentModels.js';
export { ModelPurpose } from '../../../../platform/agentHost/common/agentModels.js';
export type {
	ModelReasoningEffort,
	ModelReasoningEffortOption,
	ModelAccelerationOption,
	ModelRetirement,
	ModelCatalogEntry,
	ModelCatalogStatus,
} from '../../../../platform/agentHost/common/agentModels.js';

export function modelRefIdentity(model: ModelRef): string {
	return `${model.provider}\0${model.model}`;
}

/** Picks only explicit catalog recommendations; callers retain saved selections separately. */
export function modelsRecommendedFor(models: readonly ModelCatalogEntry[], purpose: ModelPurpose): readonly ModelCatalogEntry[] {
	return models.filter(model => model.recommendedFor?.includes(purpose));
}

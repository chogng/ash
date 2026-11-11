import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../services/chat/common/modelCatalog.js';

/** An active host override takes precedence over the conversation preference. */
export function resolveModelReasoningEffort(entry: ModelCatalogEntry, selected: ModelReasoningEffort | undefined): ModelReasoningEffort | undefined {
	return [entry.reasoningEffortOverride, selected, entry.effectiveReasoningEffort, entry.defaultReasoningEffort]
		.find(candidate => entry.supportedReasoningEfforts?.some(option => option.effort === candidate));
}

/** Changing the effort of an Ultra model first releases the host override. */
export async function applyModelReasoningEffort(
	currentOverride: ModelReasoningEffort | undefined,
	selected: string,
	isCurrent: () => boolean,
	disableUltra: () => Promise<unknown>,
	apply: () => Promise<unknown>,
): Promise<void> {
	if (!isCurrent() || currentOverride === selected) return;
	if (currentOverride !== undefined) await disableUltra();
	if (isCurrent()) await apply();
}

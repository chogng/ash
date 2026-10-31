import type { AdvisorConfig } from './chatService.js';
import { modelRefIdentity, type ModelCatalogEntry, type ModelReasoningEffort } from './modelCatalog.js';

export type AdvisorConfigChange =
	| { readonly type: 'selectModel'; readonly model: Pick<ModelCatalogEntry, 'model' | 'supportedReasoningEfforts'>; readonly reasoningEffort?: ModelReasoningEffort | null; }
	| { readonly type: 'inherit'; }
	| { readonly type: 'setEnabled'; readonly enabled: boolean; }
	| { readonly type: 'clear'; };

/** Shared configuration transitions; the Chat service remains the persistence owner. */
export function updateAdvisorConfig(current: AdvisorConfig | null, change: AdvisorConfigChange): AdvisorConfig | null {
	if (change.type === 'clear') { return null; }
	if (change.type === 'inherit') {
		return { model: null, enabled: true, maxCalls: current?.maxCalls ?? 3, maxOutputTokens: current?.maxOutputTokens ?? 2048 };
	}
	if (change.type === 'setEnabled') { return current ? { ...current, enabled: change.enabled } : null; }
	const selected = change.model;
	const sameModel = current?.model && modelRefIdentity(current.model) === modelRefIdentity(selected.model);
	// Budgets belong to the Advisor preference. Reasoning effort must be supported
	// by the next model; retain unknown metadata only for the already saved model.
	const retainedEffort = current?.reasoningEffort && (
		selected.supportedReasoningEfforts?.some(option => option.effort === current.reasoningEffort)
		|| (sameModel && selected.supportedReasoningEfforts === undefined)
	) ? current.reasoningEffort : undefined;
	const reasoningEffort = 'reasoningEffort' in change ? change.reasoningEffort ?? undefined : retainedEffort;
	return {
		model: selected.model,
		enabled: true,
		maxCalls: current?.maxCalls ?? 3,
		maxOutputTokens: current?.maxOutputTokens ?? 2048,
		reasoningEffort,
	};
}

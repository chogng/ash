import type { ModelRef } from './chatService.js';

export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'extraHigh' | 'max';

export interface ModelReasoningEffortOption {
	readonly effort: ModelReasoningEffort;
	readonly description?: string | null;
}

export interface ModelAccelerationOption {
	readonly name: string;
	readonly description: string;
}

export interface ModelCatalogEntry {
	readonly contextWindowOptions: readonly number[];
	readonly model: ModelRef;
	readonly displayName: string;
	readonly description?: string | null;
	readonly discovered?: boolean;
	readonly contextWindow?: number | null;
	readonly defaultContextWindow?: number | null;
	readonly maximumContextWindow?: number | null;
	readonly supportsFast?: boolean;
	readonly acceleration?: ModelAccelerationOption;
	readonly fast?: boolean;
	readonly supportedReasoningEfforts?: readonly ModelReasoningEffortOption[];
	readonly modelReasoningEffort?: ModelReasoningEffort;
}

export function modelRefIdentity(model: ModelRef): string {
	return `${model.provider}\0${model.model}`;
}

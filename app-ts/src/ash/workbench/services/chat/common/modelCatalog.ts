import type { ModelRef } from './chatService.js';

export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'extraHigh' | 'max';

export interface ModelReasoningEffortOption {
	readonly effort: ModelReasoningEffort;
	readonly description?: string | null;
}

export interface ModelAccelerationOption {
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export interface ModelCatalogEntry {
	readonly longContext: boolean | null;
	readonly model: ModelRef;
	readonly displayName: string;
	readonly description?: string | null;
	readonly discovered?: boolean;
	readonly contextWindow?: number | null;
	readonly defaultContextWindow?: number | null;
	readonly maximumContextWindow?: number | null;
	readonly accelerationOptions?: readonly ModelAccelerationOption[];
	readonly selectedAcceleration?: string | null;
	readonly supportedReasoningEfforts?: readonly ModelReasoningEffortOption[];
	readonly defaultReasoningEffort?: ModelReasoningEffort;
}

export function modelRefIdentity(model: ModelRef): string {
	return `${model.provider}\0${model.model}`;
}

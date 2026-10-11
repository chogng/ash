import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export enum ExtensionRecommendationReason { Workspace = 'workspace' }

export interface ExtensionRecommendation {
	readonly extensionId: string;
	readonly reason: { readonly reasonId: ExtensionRecommendationReason; readonly reasonText: string; };
}

export interface ExtensionRecommendationsSnapshot {
	readonly recommendations: readonly ExtensionRecommendation[];
	readonly resources: readonly URI[];
	readonly diagnostics: readonly string[];
}

export interface IExtensionRecommendationsService {
	readonly onDidChangeRecommendations: Event<void>;
	getWorkspaceRecommendations(): Promise<ExtensionRecommendationsSnapshot>;
	refresh(): void;
}

export const IExtensionRecommendationsService = createServiceIdentifier<IExtensionRecommendationsService>('extensionRecommendationsService');

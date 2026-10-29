import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export enum RecommendationSource {
	FILE = 1,
	WORKSPACE = 2,
	EXE = 3,
}

export interface IExtensionRecommendations {
	readonly source: RecommendationSource;
	readonly extensions: readonly string[];
	readonly name: string;
	readonly searchValue?: string;
	readonly languageId?: string;
	/** The owning editor/workspace context can retire an in-flight suggestion. */
	readonly signal?: AbortSignal;
}

export enum RecommendationsNotificationResult {
	Ignored = 'ignored',
	Cancelled = 'cancelled',
	TooMany = 'toomany',
	Accepted = 'reacted',
}

/** Optional, contextual suggestions; installation continues through the normal package review. */
export interface IExtensionRecommendationNotificationService {
	readonly ignoredRecommendations: readonly string[];
	hasToIgnoreRecommendationNotifications(): boolean;
	promptImportantExtensionsInstallNotification(
		recommendations: IExtensionRecommendations,
	): Promise<RecommendationsNotificationResult>;
	promptWorkspaceRecommendations(recommendations: readonly string[], signal?: AbortSignal): Promise<void>;
	resetIgnoredRecommendations(): void;
}

export const IExtensionRecommendationNotificationService =
	createServiceIdentifier<IExtensionRecommendationNotificationService>('extensionRecommendationNotificationService');

import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IExtensionRecommendations } from '../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import type { ExtensionUiTarget } from '../../../../platform/extensionManagement/common/extensionManagementService.js';

export enum ExtensionRecommendationReason { Workspace = 'workspace', Executable = 'executable', File = 'file', Application = 'application', WorkspaceConfig = 'workspaceConfig' }

export interface ExtensionRecommendation {
	readonly extensionId: string;
	readonly reason: { readonly reasonId: ExtensionRecommendationReason; readonly reasonText: string; };
	/** The package manifest's declared product windows; never inferred from its capabilities. */
	readonly uiTargets?: readonly ExtensionUiTarget[];
	/** Discovery context shared by the Recommended view and optional install notification. */
	readonly context?: Omit<IExtensionRecommendations, 'extensions'>;
}

export interface ExtensionRecommendationsSnapshot {
	readonly recommendations: readonly ExtensionRecommendation[];
	readonly resources: readonly URI[];
	readonly diagnostics: readonly string[];
}

export interface IExtensionRecommendationsService {
	readonly target: ExtensionUiTarget;
	readonly onDidChangeRecommendations: Event<void>;
	getWorkspaceRecommendations(): Promise<ExtensionRecommendationsSnapshot>;
	getRecommendations(): Promise<ExtensionRecommendationsSnapshot>;
	/** Records an explicit request for an optional editor, including when another editor is used as fallback. */
	recommendForResource(resource: URI): void;
	refresh(): void;
}

export const IExtensionRecommendationsService = createServiceIdentifier<IExtensionRecommendationsService>('extensionRecommendationsService');

/** Registry-qualified package IDs and declarative editor IDs share one recommendation identity. */
export function extensionRecommendationKey(id: string): string { return id.toLowerCase().replace(/@[^@]+$/u, ''); }

export interface IExtensionIgnoredRecommendationsService {
	readonly onDidChangeIgnoredRecommendations: Event<void>;
	readonly onDidChangeGlobalIgnoredRecommendation: Event<{ readonly extensionId: string; readonly isRecommended: boolean; }>;
	readonly ignoredRecommendations: readonly string[];
	readonly globalIgnoredRecommendations: readonly string[];
	toggleGlobalIgnoredRecommendation(extensionId: string, ignore: boolean): void;
}

export const IExtensionIgnoredRecommendationsService = createServiceIdentifier<IExtensionIgnoredRecommendationsService>('IExtensionIgnoredRecommendationsService');

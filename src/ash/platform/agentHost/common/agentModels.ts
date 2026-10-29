import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface ModelRef {
	readonly provider: string;
	readonly model: string;
}

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

/** Confirmed announcement for the selected connection; an absent date still means retiring. */
export interface ModelRetirement {
	/** Exact date-only YYYY-MM-DD value, displayed without time-zone conversion. */
	readonly shutdownDate?: string | null;
}

export interface ModelCatalogEntry {
	/** Unknown modalities preserve existing attachment behavior. */
	readonly inputModalities?: readonly ('text' | 'image' | 'audio')[] | null;
	readonly longContext: boolean | null;
	readonly model: ModelRef;
	readonly displayName: string;
	readonly description?: string | null;
	readonly discovered?: boolean;
	readonly retirement?: ModelRetirement;
	readonly contextWindow?: number | null;
	readonly defaultContextWindow?: number | null;
	readonly maximumContextWindow?: number | null;
	readonly accelerationOptions?: readonly ModelAccelerationOption[];
	readonly selectedAcceleration?: string | null;
	readonly supportedReasoningEfforts?: readonly ModelReasoningEffortOption[];
	readonly defaultReasoningEffort?: ModelReasoningEffort;
}

export interface AdvisorConfig {
	readonly model: ModelRef;
	readonly enabled: boolean;
	readonly reasoningEffort?: ModelReasoningEffort | null;
	readonly maxCalls: number;
	readonly maxOutputTokens: number;
}

export type AdvisorSelection =
	| { readonly type: 'default' }
	| { readonly type: 'off' }
	| { readonly type: 'model'; readonly config: AdvisorConfig };

export interface ModelProviderCredentialStatus {
	readonly connection: string;
	readonly access: 'apiKey' | 'subscription' | 'local' | 'enterprise' | 'unknown';
	readonly active: boolean;
	readonly configured: boolean;
	readonly ready: boolean;
	readonly provider: string;
	readonly displayName: string;
	readonly apiKeyPolicy: 'unsupported' | 'optional' | 'required';
	readonly apiKeyConfigured: boolean;
}

export interface AgentModelCatalog {
	readonly models: readonly ModelCatalogEntry[];
	readonly scopes?: readonly { readonly connection: string; readonly identity: string | null }[];
}

export interface AgentModelProviders {
	readonly providers: readonly ModelProviderCredentialStatus[];
}

export type ModelProviderApiFormat = 'responses' | 'chatCompletions' | 'anthropicMessages';

/** User-owned connection declarations; credentials remain in the secret store. */
export interface CustomModelProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly apiFormat: ModelProviderApiFormat;
	readonly order: number;
	readonly models: readonly {
		readonly id: string;
		readonly contextWindow: number;
		readonly upstreamModel?: string;
	}[];
}

export type ModelProviderTestResult =
	{ readonly type: 'passed' } | { readonly type: 'failed'; readonly message: string };

export interface ModelPreferencesUpdate {
	readonly acceleration?: string | null;
	readonly longContext?: boolean;
}

/** Review selection does not change the model or effort used by the Agent. */
export type ApprovalReviewModelSelection =
	| { readonly type: 'automatic' }
	| {
			readonly type: 'explicit';
			readonly model: { readonly provider: string; readonly model: string };
			readonly connection?: string;
			readonly reasoningEffort?: ModelReasoningEffort;
	  };

/** Backend execution defaults. Null means no configured model, not an executable automatic selection. */
export interface AgentModelDefaults {
	readonly revision: number;
	readonly model: ModelRef | null;
	readonly reasoningEffort: ModelReasoningEffort | null;
}

export interface AgentModelDefaultsUpdate {
	readonly model?: ModelRef | null;
	readonly reasoningEffort?: ModelReasoningEffort | null;
}

export interface IAgentModelsService {
	readDefaults(): Promise<AgentModelDefaults>;
	configureDefaults(update: AgentModelDefaultsUpdate, expectedRevision: number): Promise<void>;
	readApprovalReviewModel(): Promise<ApprovalReviewModelSelection>;
	setApprovalReviewModel(selection: ApprovalReviewModelSelection): Promise<void>;
	setModelPreferences(model: ModelRef, update: ModelPreferencesUpdate): Promise<void>;
	readAdvisorDefault(): Promise<AdvisorConfig | null>;
	setAdvisorDefault(params: { readonly commandId: string; readonly advisor: AdvisorConfig | null }): Promise<void>;
	listCustomProviders(): Promise<readonly CustomModelProvider[]>;
	saveCustomProvider(provider: CustomModelProvider): Promise<void>;
	testProviderModel(provider: CustomModelProvider, model: string): Promise<ModelProviderTestResult>;
	listModels(): Promise<AgentModelCatalog>;
	listProviders(): Promise<AgentModelProviders>;
	listProviderModels(connection: string): Promise<readonly ModelCatalogEntry[]>;
	setProviderApiKey(params: {
		readonly connection: string;
		readonly apiKey: string;
	}): Promise<{ readonly connection: string; readonly apiKeyConfigured: boolean }>;
	removeProviderApiKey(connection: string): Promise<void>;
	readModel(): Promise<ModelRef | null>;
	setModel(params: { readonly commandId: string; readonly model: ModelRef }): Promise<void>;
}

export const IAgentModelsService = createServiceIdentifier<IAgentModelsService>('agentModelsService');

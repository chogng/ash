import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface ModelRef {
	readonly provider: string;
	readonly model: string;
}

/** Curated picker uses, independent of model capabilities and connection access. */
export enum ModelPurpose {
	Advisor = 'advisor',
	Review = 'review',
	Commit = 'commit',
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

/** Unknown evidence is preserved across adapters and is never treated as a negative declaration. */
export type ModelCapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export interface ModelCatalogSource {
	readonly providerId: string;
	readonly connectionId: string;
	readonly metadata: 'providerLive' | 'userConfigured' | 'builtinCurated' | 'providerSeed' | 'persistedObservation' | 'unknown';
}

/** Exact decimal currency amounts per million tokens for one published API rate rule. */
export interface ModelTokenPricing {
	readonly currency: string;
	readonly serviceTier: string;
	readonly region: string;
	readonly minInputTokens: number;
	readonly maxInputTokens: number | null;
	readonly input: string | null;
	readonly output: string | null;
	readonly cacheRead: string | null;
	readonly cacheWrite: string | null;
	readonly revision: string;
	readonly reviewedAt: string;
	readonly sourceUrls: readonly string[];
}

export interface ModelCatalogEntry {
	readonly recommendedFor?: readonly ModelPurpose[];
	readonly capabilities?: { readonly toolCalling: ModelCapabilitySupport; readonly agentMode: ModelCapabilitySupport; };
	readonly source?: ModelCatalogSource;
	readonly pricing?: readonly ModelTokenPricing[];
	/** Unknown modalities preserve existing attachment behavior. */
	readonly inputModalities?: readonly ('text' | 'image' | 'audio')[] | null;
	readonly longContext: boolean | null;
	readonly model: ModelRef;
	readonly displayName: string;
	readonly description?: string | null;
	readonly discovered?: boolean;
	readonly retirement?: ModelRetirement;
	readonly contextWindow?: number | null;
	/** Usable input capacity after output and safety reservations, independent of compaction. */
	readonly usableContextWindow?: number | null;
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
	| { readonly type: 'default'; }
	| { readonly type: 'off'; }
	| { readonly type: 'model'; readonly config: AdvisorConfig; };

export interface ModelProviderCredentialStatus {
	readonly catalog?: ModelCatalogStatus;
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

/** Discovery evidence for one connection; it does not certify model invocation readiness. */
export interface ModelCatalogStatus {
	readonly provider: string;
	readonly connection: string;
	readonly freshness: 'fresh' | 'staleUsable' | 'expired' | 'staticOnly';
	readonly issues: readonly ('refreshFailed' | 'discoveryUnsupported' | 'authenticationRequired' | 'staleCatalog' | 'unknownCapability' | 'unlistedModel')[];
}

export interface AgentModelCatalog {
	readonly models: readonly ModelCatalogEntry[];
	readonly statuses?: readonly ModelCatalogStatus[];
	readonly scopes?: readonly { readonly connection: string; readonly identity: string | null; }[];
}

export interface AgentModelProviders { readonly providers: readonly ModelProviderCredentialStatus[]; }

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
	{ readonly type: 'passed'; } | { readonly type: 'failed'; readonly message: string; };

export interface ModelPreferencesUpdate {
	readonly acceleration?: string | null;
	readonly longContext?: boolean;
}

/** Review selection does not change the model or effort used by the Agent. */
export type ApprovalReviewModelSelection =
	| { readonly type: 'automatic'; }
	| {
		readonly type: 'explicit';
		readonly model: { readonly provider: string; readonly model: string; };
		readonly connection?: string;
		readonly reasoningEffort?: ModelReasoningEffort;
	};

/** Backend execution defaults. Null means no configured model, not an executable automatic selection. */
export interface AgentModelDefaults {
	/** Null inherits the model of the Turn that produced the changes. */
	readonly commitMessageModel: ModelRef | null;
	readonly commitMessageEnabled: boolean;
	/** Null follows the reviewing Thread's current model. */
	readonly codeReviewModel: ModelRef | null;
	readonly revision: number;
	readonly model: ModelRef | null;
	readonly reasoningEffort: ModelReasoningEffort | null;
}

export interface AgentModelDefaultsUpdate {
	readonly commitMessageModel?: ModelRef | null;
	readonly commitMessageEnabled?: boolean;
	readonly codeReviewModel?: ModelRef | null;
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
	setAdvisorDefault(params: { readonly commandId: string; readonly advisor: AdvisorConfig | null; }): Promise<void>;
	listCustomProviders(): Promise<readonly CustomModelProvider[]>;
	saveCustomProvider(provider: CustomModelProvider): Promise<void>;
	removeCustomProvider(connection: string): Promise<void>;
	testProviderModel(provider: CustomModelProvider, model: string): Promise<ModelProviderTestResult>;
	listModels(): Promise<AgentModelCatalog>;
	listProviders(): Promise<AgentModelProviders>;
	listProviderModels(connection: string): Promise<readonly ModelCatalogEntry[]>;
	setProviderApiKey(params: {
		readonly connection: string;
		readonly apiKey: string;
	}): Promise<{ readonly connection: string; readonly apiKeyConfigured: boolean; }>;
	removeProviderApiKey(connection: string): Promise<void>;
	readModel(): Promise<ModelRef | null>;
	setModel(params: { readonly commandId: string; readonly model: ModelRef; }): Promise<void>;
}

export const IAgentModelsService = createServiceIdentifier<IAgentModelsService>('agentModelsService');

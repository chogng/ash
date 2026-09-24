import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export interface CodebaseModelReference {
	readonly provider: string;
	readonly model: string;
}

export interface CodebaseProviderConfiguration {
	readonly provider: string;
	readonly baseUrl?: string | null;
	readonly maxOutputTokens?: number | null;
	readonly modelContext?: Readonly<Record<string, { readonly contextWindow: number; readonly autoCompactTokenLimit?: number | null }>>;
}

export interface CodebaseModels {
	readonly embeddingModel: CodebaseModelReference;
	readonly rerankModel?: CodebaseModelReference | null;
}

export type CodebaseAutomaticContext = "off" | "firstInvocation";

/** Stable Settings identity for the aggregate semantic-code-search policy. */
export const CodebaseSettingId = "codebase";

export interface CodebaseConfigurationSnapshot {
	readonly revision: number;
	readonly generation: number;
	readonly providers: Readonly<Record<string, CodebaseProviderConfiguration>>;
	readonly codebase: {
		readonly models?: CodebaseModels | null;
		readonly automaticContext: CodebaseAutomaticContext;
	};
}

export interface CodebaseConfigurationCommandResult {
	readonly revision: number;
	readonly generation: number;
	readonly disposition: "updated" | "replayed";
}

export interface CodebaseStatus {
	readonly state: "empty" | "indexing" | "ready" | "stale" | "failed";
	readonly rootId: string;
	readonly generation: number;
	readonly indexedFileCount: number;
	readonly indexedChunkCount: number;
	readonly indexedSourceBytes: number;
	readonly skippedFileCount: number;
	readonly truncatedFileCount: number;
	readonly fileLimitHit: boolean;
	readonly sourceBytesLimitHit: boolean;
}

/** Frontend-owned semantic codebase configuration contract for the active Workspace. */
export interface ICodebaseService {
	readConfig(): Promise<CodebaseConfigurationSnapshot>;
	configureProvider(config: CodebaseProviderConfiguration, expectedRevision: number): Promise<CodebaseConfigurationCommandResult>;
	configure(models: CodebaseModels | undefined, automaticContext: CodebaseAutomaticContext, expectedRevision: number): Promise<CodebaseConfigurationCommandResult>;
	status(): Promise<CodebaseStatus>;
}

export const ICodebaseService = createServiceIdentifier<ICodebaseService>("codebaseService");

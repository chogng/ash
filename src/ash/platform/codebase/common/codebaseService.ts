import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { ModelRef } from "../../agentHost/common/agentModels.js";

export interface CodebaseModels {
	readonly embeddingModel: ModelRef;
	readonly rerankModel?: ModelRef | null;
}

export type CodebaseAutomaticContext = "off" | "firstInvocation";

/** Stable Settings identity for the aggregate semantic-code-search policy. */
export const CodebaseSettingId = "codebase";

export interface CodebaseConfigurationSnapshot {
	readonly revision: number;
	readonly generation: number;
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

/** Runtime binding and vector publication are independent of the source index. */
export type CodebaseEmbeddingStatus =
	| { readonly type: "disabled"; }
	| { readonly type: "unavailable"; }
	| {
		readonly type: "active";
		readonly state: "idle" | "indexing" | "ready" | "stale" | "cancelled" | "failed";
		readonly targetGeneration: number;
		readonly publishedGeneration: number | null;
		readonly totalChunkCount: number;
		readonly processedChunkCount: number;
		readonly reusedEmbeddingCount: number;
		readonly embeddedChunkCount: number;
		readonly lastErrorCode: string | null;
	};

export interface CodebaseStatus {
	/** Source scanning and publication only; embedding failures do not change this state. */
	readonly sourceState: "empty" | "indexing" | "ready" | "stale" | "failed";
	readonly embedding: CodebaseEmbeddingStatus;
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

/** Client contract for backend-owned Codebase policy and the active directory's index status.
 * Provider connections and credentials are managed by their configuration and model owners.
 */
export interface ICodebaseService {
	readConfig(): Promise<CodebaseConfigurationSnapshot>;
	configure(models: CodebaseModels | undefined, automaticContext: CodebaseAutomaticContext, expectedRevision: number): Promise<CodebaseConfigurationCommandResult>;
	status(): Promise<CodebaseStatus>;
}

export const ICodebaseService = createServiceIdentifier<ICodebaseService>("codebaseService");

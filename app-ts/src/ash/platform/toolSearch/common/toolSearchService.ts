import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export interface ToolSearchModelReference {
	readonly provider: string;
	readonly model: string;
}

export type ToolSearchEmbeddingStatus =
	| { readonly type: "disabled" }
	| { readonly type: "ready"; readonly model: ToolSearchModelReference }
	| { readonly type: "unavailable"; readonly model?: ToolSearchModelReference; readonly reason: string };

export interface ToolSearchSettings {
	readonly revision: number;
	readonly mode: "lexical" | "hybridEmbedding";
	readonly embeddingModel?: ToolSearchModelReference;
	readonly embeddingStatus: ToolSearchEmbeddingStatus;
}

export interface ToolSearchConfiguration {
	readonly mode: "lexical" | "hybridEmbedding";
	readonly embeddingModel?: ToolSearchModelReference;
}

/** Stable Settings identity for the aggregate Tool Search policy. */
export const ToolSearchSettingId = "toolSearch.configuration";

/** Frontend-owned configuration and readiness view for deferred Agent-tool retrieval. */
export interface IToolSearchService {
	readConfig(): Promise<ToolSearchSettings>;
	configure(config: ToolSearchConfiguration, expectedRevision: number): Promise<void>;
}

export const IToolSearchService = createServiceIdentifier<IToolSearchService>("toolSearchService");

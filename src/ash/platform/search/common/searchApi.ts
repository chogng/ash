import type { ContentSearchCancelParams, ContentSearchReadParams, ContentSearchReadResult, ContentSearchStartParams, ContentSearchStartResult } from "../../../../../.build/protocol/typescript/index.js";

export interface IContentSearchApi {
	start(params: ContentSearchStartParams): Promise<ContentSearchStartResult>;
	read(params: ContentSearchReadParams): Promise<ContentSearchReadResult>;
	cancel(params: ContentSearchCancelParams): Promise<void>;
}

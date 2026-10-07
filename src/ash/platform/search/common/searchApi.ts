import type { ContentSearchCancelParams, ContentSearchReadParams, ContentSearchReadResult, ContentSearchStartParams, ContentSearchStartResult } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";

export interface IContentSearchApi {
	start(params: ContentSearchStartParams): Promise<ContentSearchStartResult>;
	read(params: ContentSearchReadParams): Promise<ContentSearchReadResult>;
	cancel(params: ContentSearchCancelParams): Promise<void>;
}

import type { ContentSearchCancelParams, ContentSearchReadParams, ContentSearchReadResult, ContentSearchStartParams, ContentSearchStartResult } from "../../app-server/common/generated/index.js";

export interface IContentSearchApi {
	start(params: ContentSearchStartParams): Promise<ContentSearchStartResult>;
	read(params: ContentSearchReadParams): Promise<ContentSearchReadResult>;
	cancel(params: ContentSearchCancelParams): Promise<void>;
}

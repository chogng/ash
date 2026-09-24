import type { ContentSearchReadResult, ContentSearchStartResult } from "../../app-server/common/generated/index.js";
import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import type { IContentSearchApi } from "../common/searchApi.js";

export function createContentSearchApi(): IContentSearchApi {
	return {
		start: (params) => invoke<ContentSearchStartResult>("ash:content-search:start", params),
		read: (params) => invoke<ContentSearchReadResult>("ash:content-search:read", params),
		cancel: (params) => invoke<void>("ash:content-search:cancel", params),
	};
}

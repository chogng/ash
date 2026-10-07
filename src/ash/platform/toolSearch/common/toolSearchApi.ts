import type { ConfigCommandResult, ConfigReadResult, ToolSearchConfigureParams } from "../../app-server/common/generated/index.js";

/** Transport-only Tool Search operations. Product consumers use IToolSearchService. */
export interface IToolSearchApi {
	readConfig(): Promise<ConfigReadResult>;
	configure(params: ToolSearchConfigureParams): Promise<ConfigCommandResult>;
}

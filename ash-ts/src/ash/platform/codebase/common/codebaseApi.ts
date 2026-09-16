import type { CodebaseStatusResult, ConfigCommandResult, ConfigReadResult, ProviderConfigureParams, CodebaseConfigureParams } from "../../app-server/common/generated/index.js";

/** Transport-only semantic codebase operations. Product consumers use ICodebaseService. */
export interface ICodebaseApi {
	readConfig(): Promise<ConfigReadResult>;
	configureProvider(params: ProviderConfigureParams): Promise<ConfigCommandResult>;
	configure(params: CodebaseConfigureParams): Promise<ConfigCommandResult>;
	status(): Promise<CodebaseStatusResult>;
}

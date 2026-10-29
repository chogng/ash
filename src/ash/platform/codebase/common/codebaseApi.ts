import type {
	CodebaseStatusResult,
	ConfigCommandResult,
	ConfigReadResult,
	CodebaseConfigureParams,
} from '../../../../../.build/protocol/typescript/index.js';

/** Transport-only semantic codebase operations. Product consumers use ICodebaseService. */
export interface ICodebaseApi {
	readConfig(): Promise<Pick<ConfigReadResult, 'revision' | 'generation' | 'codebase'>>;
	configure(params: CodebaseConfigureParams): Promise<ConfigCommandResult>;
	status(): Promise<CodebaseStatusResult>;
}

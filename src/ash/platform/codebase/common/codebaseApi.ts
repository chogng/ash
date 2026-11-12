import type { CodebaseStatusResult, ConfigCommandResult, ConfigReadResult, CodebaseConfigureParams } from '../../../../../.build/protocol/typescript/index.js';
import type { Event } from '../../../base/common/event.js';

/** Transport-only semantic codebase operations. Product consumers use ICodebaseService. */
export interface ICodebaseApi {
	readonly onDidChangeConfig: Event<void>;
	readConfig(): Promise<Pick<ConfigReadResult, 'revision' | 'generation' | 'codebase'>>;
	configure(params: CodebaseConfigureParams): Promise<ConfigCommandResult>;
	status(): Promise<CodebaseStatusResult>;
}

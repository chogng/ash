import type { LogLevel } from '../../../../platform/log/common/log.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const IWorkbenchEnvironmentService = createServiceIdentifier<IWorkbenchEnvironmentService>('workbenchEnvironmentService');

/** The host supplies a separate origin for each webview, with {{uuid}} as its identity. */
export interface IWorkbenchEnvironmentService {
	readonly isBuilt: boolean;
	readonly webviewExternalEndpoint: string;
	readonly argvResource: URI;
	/** The host opened this window to receive an existing terminal process. */
	readonly expectsTerminalTransfer?: boolean;
	readonly logLevel?: string;
	/** Initial host recorder level; persisted values are reread before each new window starts. */
	readonly initialLogLevel?: LogLevel;
	readonly extensionLogLevel?: readonly (readonly [string, string])[];
}

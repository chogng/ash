import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const IWorkbenchEnvironmentService = createServiceIdentifier<IWorkbenchEnvironmentService>('workbenchEnvironmentService');

/** The host supplies a separate origin for each webview, with {{uuid}} as its identity. */
export interface IWorkbenchEnvironmentService {
	readonly webviewExternalEndpoint: string;
}

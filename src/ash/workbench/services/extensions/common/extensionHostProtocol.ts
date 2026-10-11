import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { getNLSLanguage } from '../../../../nls.js';
import type { ExtensionHostInitialization, IExtensionHostApi, JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';

/** Collects a snapshot from the existing window owners, without retaining a second fact store. */
export function createExtensionHostInitialization(workspace: IWorkspaceContextService, configuration: IConfigurationService): ExtensionHostInitialization {
	const current = workspace.getWorkspace();
	return Object.freeze({
		language: getNLSLanguage(),
		workspaceFolders: Object.freeze(current.folders.map(folder => Object.freeze({ uri: folder.uri.toString(), name: folder.name, index: folder.index }))),
		workspaceName: current.name ?? null,
		workspaceFile: current.configuration?.toString() ?? null,
		configurationValues: configuration.getValue<Readonly<Record<string, unknown>>>() ?? {},
		configurationData: configuration.getConfigurationData(),
	});
}

export type BrowserExtensionHostRequest =
	| { readonly id: number; readonly type: 'activate'; readonly entryPoint: string; readonly language: string; readonly extensionId: string; readonly configuration: JsonValue; readonly initialization: JsonValue; }
	| { readonly id: number; readonly type: 'invoke'; readonly request: Parameters<IExtensionHostApi['invoke']>[0]; }
	| { readonly id: number; readonly type: 'deactivate'; }
	| { readonly id: number; readonly type: 'cancel'; readonly invocationId: number; }
	| { readonly id: number; readonly type: 'commandResult'; readonly success: true; readonly result: JsonValue; }
	| { readonly id: number; readonly type: 'commandResult'; readonly success: false; readonly error: string; };

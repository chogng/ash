import type { ICallService } from '../../call/common/callService.js';
import type { IMemoriesService } from '../../memories/common/memoriesService.js';
import type { IMemoryDiagnosticsService } from '../../memory/common/memoryDiagnosticsService.js';
import type { IAppServerApi, IResourceApi, IServerEventApi } from "../../app-server/common/appServerApi.js";
import type { IExtensionApi } from "../../extensions/common/extensionApi.js";
import type { IFileApi } from "../../files/common/fileApi.js";
import type { IDiffApi } from "../../diff/common/diffApi.js";
import type { ISyntaxApi } from "../../syntax/common/syntaxApi.js";
import type { IGitApi } from "../../git/common/gitApi.js";
import type { IContentSearchApi } from "../../search/common/searchApi.js";
import type { IModelApi, ISessionApi, IThreadApi, ITurnApi } from "../../sessions/common/sessionApi.js";
import type { ISkillService } from "../../skills/common/skillService.js";
import type { ILanguageServerService } from "../../language/common/languageServerService.js";
import type { ITerminalProcessService } from "../../terminal/common/terminalProcessService.js";
import type { ITypstApi } from "../../typst/common/typstApi.js";
import type { IDocumentCollaborationApi } from "../../collaboration/common/documentCollaborationApi.js";
import type { ICodebaseApi } from "../../codebase/common/codebaseApi.js";
import type { IConnectorApi } from "../../connectors/common/connectorApi.js";
import type { IToolSearchApi } from "../../toolSearch/common/toolSearchApi.js";
import type { ILanguageApi } from "../../language/common/languageApi.js";
import type { IPluginApi } from "../../plugins/common/pluginApi.js";
import type { IDebugAdapterProcessService } from "../../debug/common/debugAdapterProcessService.js";
import type { IExtensionHostApi } from "../../extensionHost/common/extensionHostApi.js";
import type { ICodebaseSymbolsApi } from "../../codebaseSymbols/common/codebaseSymbolsApi.js";
import type { IRemoteAgentApi } from "../../remote/common/remoteAgentApi.js";
import type { IRemoteConnectionService } from "../../remote/common/remoteConnectionService.js";
import type { IRemoteTunnelService } from "../../remote/common/remoteTunnelService.js";
import type { IMarketplaceApi } from "../../marketplace/common/marketplaceApi.js";
import type { IDirPermissionsApi } from "../../dirPermissions/common/dirPermissionsApi.js";
import type { IAccountApi } from "../../accounts/common/accountApi.js";
import type { ITurnChangesApi } from "../../turnChanges/common/turnChangesApi.js";
import type { IAutomationService } from '../../automation/common/automationService.js';

/** Optional product capabilities contributed by a statically selected host bundle. */
export interface RendererHostCapabilities {
	readonly debugAdapter?: IDebugAdapterProcessService;
}

/** Merges product capabilities while rejecting two contributions that claim the same slot. */
export function mergeRendererHostCapabilities(capabilities: readonly RendererHostCapabilities[]): RendererHostCapabilities {
	const merged: Record<string, unknown> = {};
	for (const capability of capabilities) {
		for (const [name, value] of Object.entries(capability)) {
			if (value === undefined) continue;
			if (Object.hasOwn(merged, name)) throw new Error(`Renderer host capability '${name}' was contributed more than once`);
			merged[name] = value;
		}
	}
	return merged;
}

/** Transport-neutral capability set supplied by a renderer host at startup. */
export interface IRendererHost extends RendererHostCapabilities {
	readonly calls?: ICallService;
	readonly automation?: IAutomationService;
	readonly memoryDiagnostics?: IMemoryDiagnosticsService;
	readonly memories?: IMemoriesService;
	readonly appServer: IAppServerApi;
	readonly accounts: IAccountApi;
	readonly remote?: IRemoteAgentApi;
	/** Optional because web hosts cannot restart into a host-owned SSH connection. */
	readonly remoteConnections?: IRemoteConnectionService;
	/** Optional because web and disconnected hosts cannot own an SSH process. */
	readonly remoteTunnels?: IRemoteTunnelService;
	readonly session: ISessionApi;
	readonly model: IModelApi;
	readonly thread: IThreadApi;
	readonly turn: ITurnApi;
	readonly turnChanges: ITurnChangesApi;
	readonly skills: ISkillService;
	readonly languageServers: ILanguageServerService;
	readonly typst: ITypstApi;
	readonly documentCollaboration: IDocumentCollaborationApi;
	readonly resource: IResourceApi;
	readonly extensions: IExtensionApi;
	readonly extensionHost: IExtensionHostApi;
	readonly fs: IFileApi;
	readonly diff: IDiffApi;
	readonly syntax: ISyntaxApi;
	readonly language: ILanguageApi;
	readonly git: IGitApi;
	readonly contentSearch: IContentSearchApi;
	readonly terminal: ITerminalProcessService;
	readonly events: IServerEventApi;
	readonly codebase: ICodebaseApi;
	readonly codebaseSymbols: ICodebaseSymbolsApi;
	readonly connectors: IConnectorApi;
	readonly plugins: IPluginApi;
	readonly marketplace: IMarketplaceApi;
	readonly toolSearch: IToolSearchApi;
	readonly dirPermissions: IDirPermissionsApi;
}

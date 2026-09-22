import { createDisconnectedLanguageServerService } from "../../language/browser/languageServerService.js";
import { createDisconnectedAppServerApi, createDisconnectedResourceApi, createDisconnectedServerEventApi } from "./appServerApi.js";
import { createDisconnectedFileApi } from "../../files/browser/fileApi.js";
import { createDisconnectedExtensionApi } from "../../extensions/browser/extensionApi.js";
import { createDisconnectedDiffApi } from "../../diff/browser/diffApi.js";
import { createDisconnectedSyntaxApi } from "../../syntax/browser/syntaxApi.js";
import { createDisconnectedGitApi } from "../../git/browser/gitApi.js";
import type { IRendererHost } from "../../renderer/common/rendererHost.js";
import { unavailableOperation, WebAppServerUnavailableError } from "../../renderer/browser/disconnectedHost.js";
import { createDisconnectedContentSearchApi } from "../../search/browser/searchApi.js";
import { createDisconnectedModelApi, createDisconnectedSessionApi, createDisconnectedThreadApi, createDisconnectedTurnApi } from "../../sessions/browser/sessionApi.js";
import { createDisconnectedSkillApi } from "../../skills/browser/skillApi.js";
import { DisconnectedTerminalProcessService } from "../../terminal/browser/disconnectedTerminalProcessService.js";
import { createDisconnectedTypstApi } from "../../typst/browser/typstApi.js";
import { createDisconnectedDocumentCollaborationApi } from "../../collaboration/browser/documentCollaborationApi.js";
import { createDisconnectedCodebaseApi } from "../../codebase/browser/codebaseApi.js";
import { createDisconnectedCodebaseSymbolsApi } from "../../codebaseSymbols/browser/codebaseSymbolsApi.js";
import { createDisconnectedConnectorApi } from "../../connectors/browser/connectorApi.js";
import { createDisconnectedToolSearchApi } from "../../toolSearch/browser/toolSearchApi.js";
import { createDisconnectedLanguageApi } from "../../language/browser/languageApi.js";
import { createDisconnectedPluginApi } from "../../plugins/browser/pluginApi.js";
import { createDisconnectedExtensionHostApi } from "../../extensionHost/browser/extensionHostApi.js";
import { createDisconnectedMarketplaceApi } from "../../marketplace/browser/marketplaceApi.js";
import { createDisconnectedDirPermissionsApi } from "../../dirPermissions/browser/dirPermissionsApi.js";
import { createDisconnectedAccountApi } from "../../accounts/browser/accountApi.js";
import { createDisconnectedTurnChangesApi } from "../../turnChanges/browser/turnChangesApi.js";

export { WebAppServerUnavailableError };

/** Composes the explicit disconnected capability set for standalone Web pages. */
export function createDisconnectedRendererApi(): IRendererHost {
	const appServer = createDisconnectedAppServerApi(unavailableOperation);
	return {
		appServer,
		accounts: createDisconnectedAccountApi(unavailableOperation),
		session: createDisconnectedSessionApi(unavailableOperation),
		model: createDisconnectedModelApi(unavailableOperation),
		thread: createDisconnectedThreadApi(unavailableOperation),
		turn: createDisconnectedTurnApi(unavailableOperation),
		turnChanges: createDisconnectedTurnChangesApi(unavailableOperation),
		skills: createDisconnectedSkillApi(unavailableOperation),
		typst: createDisconnectedTypstApi(unavailableOperation),
		documentCollaboration: createDisconnectedDocumentCollaborationApi(unavailableOperation),
		resource: createDisconnectedResourceApi(unavailableOperation),
		extensions: createDisconnectedExtensionApi(unavailableOperation),
		extensionHost: createDisconnectedExtensionHostApi(unavailableOperation),
		fs: createDisconnectedFileApi(unavailableOperation),
		diff: createDisconnectedDiffApi(unavailableOperation),
		syntax: createDisconnectedSyntaxApi(unavailableOperation),
		language: createDisconnectedLanguageApi(unavailableOperation),
		languageServers: createDisconnectedLanguageServerService(unavailableOperation),
		git: createDisconnectedGitApi(unavailableOperation),
		contentSearch: createDisconnectedContentSearchApi(unavailableOperation),
		terminal: new DisconnectedTerminalProcessService(unavailableOperation, appServer),
		events: createDisconnectedServerEventApi(),
		codebase: createDisconnectedCodebaseApi(unavailableOperation),
		codebaseSymbols: createDisconnectedCodebaseSymbolsApi(unavailableOperation),
		connectors: createDisconnectedConnectorApi(unavailableOperation),
		plugins: createDisconnectedPluginApi(unavailableOperation),
		marketplace: createDisconnectedMarketplaceApi(unavailableOperation),
		toolSearch: createDisconnectedToolSearchApi(unavailableOperation),
		dirPermissions: createDisconnectedDirPermissionsApi(unavailableOperation),
	};
}

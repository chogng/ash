import { createDisconnectedInstructionService } from '../../instructions/browser/appServerInstructionService.js';
import { createDisconnectedFileSearchApi } from '../../search/browser/fileSearchApi.js';
import { createDisconnectedNetworkDiagnosticsApi } from '../../networkDiagnostics/browser/networkDiagnosticsApi.js';
import { createDisconnectedIssueReporterService } from '../../issue/browser/appServerIssueReporterService.js';
import { createDisconnectedGitHubService } from '../../github/browser/appServerGitHubService.js';
import { createDisconnectedHooksApi } from '../../hooks/browser/hooksApi.js';
import { Event } from '../../../base/common/event.js';
import { createDisconnectedLanguageServerService } from "../../language/browser/languageServerService.js";
import { createDisconnectedAppServerApi, createDisconnectedResourceApi, createDisconnectedServerEventApi } from "./appServerApi.js";
import { createDisconnectedFileApi } from "../../files/browser/fileApi.js";
import { createBrowserExtensionApi } from "../../extensions/browser/extensionApi.js";
import { createDisconnectedDiffApi } from "../../diff/browser/diffApi.js";
import { createDisconnectedSyntaxApi } from "../../syntax/browser/syntaxApi.js";
import { createDisconnectedGitApi } from "../../git/browser/gitApi.js";
import type { IRendererHost } from "../../renderer/common/rendererHost.js";
import { unavailableOperation, WebAppServerUnavailableError } from "../../renderer/browser/disconnectedHost.js";
import { createDisconnectedContentSearchApi, createDisconnectedContentSearchConfigurationApi } from "../../search/browser/searchApi.js";
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
import { createDisconnectedAgentCapabilitiesApi } from '../../agentCapabilities/browser/agentCapabilitiesApi.js';
import { createDisconnectedTraceSettingsApi } from '../../trace/browser/traceSettingsApi.js';
import { createDisconnectedAccountApi } from "../../accounts/browser/accountApi.js";
import { createDisconnectedTurnChangesApi } from "../../turnChanges/browser/turnChangesApi.js";
import { createDisconnectedTeamApi } from '../../teams/browser/teamApi.js';

export { WebAppServerUnavailableError };

/** Composes the explicit disconnected capability set for standalone Web pages. */
export function createDisconnectedRendererApi(): IRendererHost {
	const appServer = createDisconnectedAppServerApi(unavailableOperation);
	return {
		hasAppServer: false,
		appServer,
		accounts: createDisconnectedAccountApi(unavailableOperation),
		session: createDisconnectedSessionApi(unavailableOperation),
		teams: createDisconnectedTeamApi(unavailableOperation),
		model: createDisconnectedModelApi(unavailableOperation),
		thread: createDisconnectedThreadApi(unavailableOperation),
		turn: createDisconnectedTurnApi(unavailableOperation),
		turnChanges: createDisconnectedTurnChangesApi(unavailableOperation),
		skills: createDisconnectedSkillApi(unavailableOperation),
		instructions: createDisconnectedInstructionService(unavailableOperation),
		typst: createDisconnectedTypstApi(unavailableOperation),
		documentCollaboration: createDisconnectedDocumentCollaborationApi(unavailableOperation),
		resource: createDisconnectedResourceApi(unavailableOperation),
		extensions: createBrowserExtensionApi(),
		extensionHost: createDisconnectedExtensionHostApi(unavailableOperation),
		fs: createDisconnectedFileApi(unavailableOperation),
		diff: createDisconnectedDiffApi(unavailableOperation),
		syntax: createDisconnectedSyntaxApi(unavailableOperation),
		language: createDisconnectedLanguageApi(unavailableOperation),
		languageServers: createDisconnectedLanguageServerService(unavailableOperation),
		git: createDisconnectedGitApi(unavailableOperation),
		fileSearch: createDisconnectedFileSearchApi(unavailableOperation),
		contentSearch: createDisconnectedContentSearchApi(unavailableOperation),
		contentSearchConfiguration: createDisconnectedContentSearchConfigurationApi(unavailableOperation),
		terminal: new DisconnectedTerminalProcessService(unavailableOperation, appServer),
		assets: {
			getCatalog: () => unavailableOperation("asset/catalog"),
			updateEntry: () => unavailableOperation("asset/catalog/update"),
			createCollection: () => unavailableOperation("asset/collection/create"),
			deleteCollection: () => unavailableOperation("asset/collection/delete"),
			importImage: () => unavailableOperation("asset/import"),
			getVersion: () => unavailableOperation("asset/version"),
			readVersion: () => unavailableOperation("asset/read"),
		},
		testing: { onDidUpdate: Event.None, onDidDisconnect: Event.None, discover: unavailableOperation, run: unavailableOperation, prepareDebug: unavailableOperation, read: unavailableOperation, cancel: unavailableOperation, release: unavailableOperation },
		events: createDisconnectedServerEventApi(),
		codebase: createDisconnectedCodebaseApi(unavailableOperation),
		codebaseSymbols: createDisconnectedCodebaseSymbolsApi(unavailableOperation),
		connectors: createDisconnectedConnectorApi(unavailableOperation),
		plugins: createDisconnectedPluginApi(unavailableOperation),
		marketplace: createDisconnectedMarketplaceApi(unavailableOperation),
		toolSearch: createDisconnectedToolSearchApi(unavailableOperation),
		dirPermissions: createDisconnectedDirPermissionsApi(unavailableOperation),
		networkDiagnostics: createDisconnectedNetworkDiagnosticsApi(unavailableOperation),
		issueReporter: createDisconnectedIssueReporterService(unavailableOperation),
		github: createDisconnectedGitHubService(),
		agentCapabilities: createDisconnectedAgentCapabilitiesApi(unavailableOperation),
		traceSettings: createDisconnectedTraceSettingsApi(unavailableOperation),
		hooks: createDisconnectedHooksApi(unavailableOperation),
	};
}

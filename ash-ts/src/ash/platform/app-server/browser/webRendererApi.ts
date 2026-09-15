import { AppServerMemoriesService } from '../../memories/browser/appServerMemoriesService.js';
import { AppServerMemoryDiagnosticsService } from '../../memory/browser/appServerMemoryDiagnosticsService.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createAppServerAppServerApi, createAppServerResourceApi, createAppServerServerEventApi } from "./appServerApi.js";
import { type AppServerTransport } from "../common/appServerTransport.js";
import { AppServerProtocolClient, type AppServerProtocolClientOptions, type AppServerConnectionMetadata } from "./appServerProtocolClient.js";
import { createAppServerFileApi } from "../../files/browser/fileApi.js";
import { createAppServerExtensionApi } from "../../extensions/browser/extensionApi.js";
import { createAppServerDiffApi } from "../../diff/browser/diffApi.js";
import { createAppServerSyntaxApi } from "../../syntax/browser/syntaxApi.js";
import { createAppServerGitApi } from "../../git/browser/gitApi.js";
import { mergeRendererHostCapabilities, type IRendererHost, type RendererHostCapabilities } from "../../renderer/common/rendererHost.js";
import { createAppServerContentSearchApi } from "../../search/browser/searchApi.js";
import { createAppServerModelApi, createAppServerSessionApi, createAppServerThreadApi, createAppServerTurnApi } from "../../sessions/browser/sessionApi.js";
import { createAppServerSkillApi } from "../../skills/browser/skillApi.js";
import { AppServerTerminalProcessService } from "../../terminal/browser/appServerTerminalProcessService.js";
import { createAppServerTypstApi } from "../../typst/browser/typstApi.js";
import { createAppServerDocumentCollaborationApi } from "../../collaboration/browser/documentCollaborationApi.js";
import { createAppServerCodebaseApi } from "../../codebase/browser/codebaseApi.js";
import { createAppServerCodebaseSymbolsApi } from "../../codebaseSymbols/browser/codebaseSymbolsApi.js";
import { createAppServerConnectorApi, type BrowserConnectorHostServices } from "../../connectors/browser/connectorApi.js";
import { createAppServerToolSearchApi } from "../../toolSearch/browser/toolSearchApi.js";
import { createAppServerLanguageApi } from "../../language/browser/languageApi.js";
import { createAppServerPluginApi } from "../../plugins/browser/pluginApi.js";
import { createAppServerExtensionHostApi } from "../../extensionHost/browser/extensionHostApi.js";
import { createAppServerMarketplaceApi } from "../../marketplace/browser/marketplaceApi.js";
import { createAppServerDirPermissionsApi } from "../../dirPermissions/browser/dirPermissionsApi.js";
import { createAppServerAccountApi } from "../../accounts/browser/accountApi.js";
import { createAppServerTurnChangesApi } from "../../turnChanges/browser/turnChangesApi.js";
import { AppServerAutomationService } from '../../automation/browser/appServerAutomationService.js';

export type RendererCapabilityContribution = (connection: AppServerProtocolClient, appServer: IRendererHost["appServer"]) => RendererHostCapabilities;

export interface ConnectedWebRendererApi {
	readonly api: IRendererHost;
	readonly metadata: AppServerConnectionMetadata;
	dispose(): void;
}

/** Connects a browser Renderer host through its transport. */
export async function connectWebRendererApi(transport: AppServerTransport, connectorHostServices: BrowserConnectorHostServices, options: AppServerProtocolClientOptions = {}, contributions: readonly RendererCapabilityContribution[] = []): Promise<ConnectedWebRendererApi> {
	const connection = new AppServerProtocolClient(transport, options);
	try {
		const metadata = await connection.connect();
		let disposed = false;
		let reconnecting = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let releaseWait: (() => void) | undefined;
		const reconnect = connection.onStateChange(state => {
			if (state !== 'crashed' || disposed || reconnecting) { return; }
			reconnecting = true;
			void (async () => {
				const deadline = Date.now() + 5 * 60_000;
				let delay = 500;
				try {
					while (!disposed && connection.state === 'crashed' && Date.now() < deadline) {
						await new Promise<void>(resolve => { releaseWait = resolve; retryTimer = setTimeout(resolve, delay); });
						releaseWait = undefined;
						if (disposed || connection.state !== 'crashed') { return; }
						try { await connection.connect(); return; }
						catch { delay = Math.min(delay * 2, 10_000); }
					}
				} finally { reconnecting = false; }
			})();
		});
		const instanceId = generateUuid();
		const memoryDiagnostics = connection.capabilities?.contracts.memoryDiagnostics?.version === 1 ? new AppServerMemoryDiagnosticsService(connection, 'browser', async () => [{ instanceId, processId: null, role: 'renderer', phase: 'unknown', metrics: [{ kind: 'domNodes', value: document.getElementsByTagName('*').length, unavailable: null }, { kind: 'javaScriptHeapBytes', value: null, unavailable: 'unsupported' }, { kind: 'residentBytes', value: null, unavailable: 'unsupported' }] }]) : undefined;
		const memories = connection.capabilities?.memories ? new AppServerMemoriesService(connection) : undefined;
		const automation = connection.capabilities?.contracts.automation?.version === 1 ? new AppServerAutomationService(connection) : undefined;
		return {
			api: { ...createRendererHost(connection, connectorHostServices, contributions), automation, memoryDiagnostics, memories },
			metadata,
			dispose: () => { disposed = true; reconnect.dispose(); clearTimeout(retryTimer); releaseWait?.(); memories?.dispose(); memoryDiagnostics?.dispose(); automation?.dispose(); connection.dispose(); },
		};
	} catch (error) {
		connection.dispose();
		throw error;
	}
}

export function createRendererHost(connection: AppServerProtocolClient, connectorHostServices: BrowserConnectorHostServices, contributions: readonly RendererCapabilityContribution[]): IRendererHost {
	const appServer = createAppServerAppServerApi(connection);
	const resource = createAppServerResourceApi(connection);
	const capabilities = mergeRendererHostCapabilities(contributions.map(contribution => contribution(connection, appServer)));
	return {
		appServer,
		accounts: createAppServerAccountApi(connection, connectorHostServices),
		session: createAppServerSessionApi(connection),
		model: createAppServerModelApi(connection),
		thread: createAppServerThreadApi(connection),
		turn: createAppServerTurnApi(connection),
		turnChanges: createAppServerTurnChangesApi(connection),
		skills: createAppServerSkillApi(connection),
		typst: createAppServerTypstApi(connection),
		documentCollaboration: createAppServerDocumentCollaborationApi(connection),
		resource,
		extensions: createAppServerExtensionApi(connection, resource),
		extensionHost: createAppServerExtensionHostApi(connection),
		fs: createAppServerFileApi(connection),
		diff: createAppServerDiffApi(connection),
		syntax: createAppServerSyntaxApi(connection),
		language: createAppServerLanguageApi(connection),
		git: createAppServerGitApi(connection),
		contentSearch: createAppServerContentSearchApi(connection),
		terminal: new AppServerTerminalProcessService(connection, appServer),
		...capabilities,
		events: createAppServerServerEventApi(connection),
		codebase: createAppServerCodebaseApi(connection),
		codebaseSymbols: createAppServerCodebaseSymbolsApi(connection),
		connectors: createAppServerConnectorApi(connection, connectorHostServices),
		plugins: createAppServerPluginApi(connection),
		marketplace: createAppServerMarketplaceApi(connection),
		toolSearch: createAppServerToolSearchApi(connection),
		dirPermissions: createAppServerDirPermissionsApi(connection),
	};
}

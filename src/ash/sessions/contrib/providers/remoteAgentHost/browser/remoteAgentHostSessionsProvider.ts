import { DisposableMap, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IAgentModelsService } from '../../../../../platform/models/common/agentModels.js';
import { IAgentSessionService, IAgentTurnService, IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import type { IFileSystemDirectory } from '../../../../../platform/files/common/fileApi.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAgentHostFileSystemService } from '../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { IDevContainerAgentHostService } from '../../../../common/devContainerAgentHostService.js';
import { sessionWorkspaceUri } from '../../../../common/sessionWorkspace.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IArtifactCatalogService } from '../../../../services/artifactCatalog/common/artifactCatalogService.js';
import { AppServerSessionsProvider, type AppServerSessionsProviderHost } from '../../agentHost/browser/appServerSessionsProvider.js';

interface IRemoteSessionsProviderHost extends AppServerSessionsProviderHost {
	readonly root: URI;
	readonly directory: IFileSystemDirectory;
}

/** Publishes one host's Sessions and mounts their directories on that same connection. */
export class RemoteAgentHostSessionsProvider extends AppServerSessionsProvider {
	readonly ownsSessionFileSystem = true;
	private readonly mounts = this._register(new DisposableMap<string, IDisposable>());

	constructor(
		private readonly remoteHost: IRemoteSessionsProviderHost,
		@IAppServerApi appServer: IAppServerApi,
		@IAgentSessionService sessionApi: IAgentSessionService,
		@IAgentModelsService modelApi: IAgentModelsService,
		@IAgentTurnService turnApi: IAgentTurnService,
		@IAgentConnection private readonly hostApi: IAgentConnection,
		@IInstantiationService instantiation: IInstantiationService,
		@IDevContainerAgentHostService containers: IDevContainerAgentHostService,
		@IAgentHostFileSystemService private readonly files: IAgentHostFileSystemService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@IArtifactCatalogService artifactCatalog: IArtifactCatalogService,
	) {
		super(remoteHost, appServer, sessionApi, modelApi, turnApi, hostApi, instantiation, containers, artifactCatalog);
		this._register(management.onDidChange(() => this.synchronizeDirectories()));
		this.synchronizeDirectories();
	}

	private synchronizeDirectories(): void {
		const directories = new Map<string, IFileSystemDirectory>();
		const root = this.remoteHost.root;
		directories.set(root.toString(), this.remoteHost.directory);
		for (const session of this.management.sessions) {
			if (session.providerId !== this.id) continue;
			for (const workspace of [session.workspace, ...session.chats.map(chat => chat.workspace)]) {
				if (!workspace) continue;
				const uri = sessionWorkspaceUri(workspace);
				if (!directories.has(uri.toString())) directories.set(uri.toString(), {
					uri, target: { type: 'session', sessionId: session.backendSessionId ?? session.sessionId, path: workspace.root },
				});
			}
		}
		const desired = new Map([...directories.values()].map(directory => [JSON.stringify([directory.uri.toString(), directory.target]), directory]));
		for (const [key] of this.mounts) {
			if (!desired.has(key)) this.mounts.deleteAndDispose(key);
		}
		for (const [key, directory] of desired) {
			if (this.mounts.has(key)) continue;
			this.mounts.set(key, this.files.registerAuthority(directory.uri.authority, {
				api: this.hostApi.fs, resourceApi: this.hostApi.resource,
				directories: () => [directory],
			}));
		}
	}
}

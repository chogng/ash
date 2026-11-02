import { agentHostConnectionAddress, type IAgentHostConnectionInfo } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { isSSHAgentHost } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { DisposableMap, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IAgentModelsService } from '../../../../../platform/agentHost/common/agentModels.js';
import { IAgentSessionService, IAgentTurnService } from '../../../../../platform/agentHost/common/agentService.js';
import type { IFileSystemDirectory } from '../../../../../platform/files/common/fileApi.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import { IAgentHostFileSystemService } from '../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { IDevContainerAgentHostService } from '../../../../common/devContainerAgentHostService.js';
import { sessionWorkspaceUri } from '../../../../common/sessionWorkspace.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
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
		@IRendererHostService private readonly hostApi: IRendererHost,
		@IInstantiationService instantiation: IInstantiationService,
		@IDevContainerAgentHostService containers: IDevContainerAgentHostService,
		@IAgentHostFileSystemService private readonly files: IAgentHostFileSystemService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
	) {
		super(remoteHost, appServer, sessionApi, modelApi, turnApi, hostApi, instantiation, containers);
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
				onDidChange: listener => {
					const subscription = this.hostApi.events.subscribe(event => {
						if (event.method === 'fs/changed') listener(event.params);
					});
					return toDisposable(() => subscription.dispose());
				},
			}));
		}
	}
}

/** Stable Sessions namespace shared by every domain presented for this host. */
export function remoteAgentHostProviderId(info: IAgentHostConnectionInfo): string {
	const connection = info.remoteConnection!;
	return isSSHAgentHost(connection) ? `ssh-agent-host:${JSON.stringify([connection.host, connection.workspace])}` : `${connection.type}-agent-host:${connection.type === 'tunnel' ? info.directory!.uri.authority : agentHostConnectionAddress(connection)}`;
}

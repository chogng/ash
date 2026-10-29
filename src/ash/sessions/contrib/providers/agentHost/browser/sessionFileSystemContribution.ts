import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import { Schemas } from '../../../../../base/common/network.js';
import type { IFileSystemDirectory } from '../../../../../platform/files/common/fileApi.js';
import { IAgentHostFileSystemService } from '../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { sessionWorkspaceUri } from '../../../../common/sessionWorkspace.js';
import { buildAgentHostSessionWorkspace } from '../../../../common/agentHostSessionWorkspace.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';

/** Adds discovered Session worktrees to their existing connection's filesystem namespace. */
export class SessionFileSystemContribution extends Disposable {
	private readonly mounts = this._register(new DisposableMap<string, IDisposable>());
	constructor(
		private readonly defaultProviderId: string,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@IAgentHostFileSystemService private readonly files: IAgentHostFileSystemService,
	) {
		super();
		this._register(sessions.onDidChange(() => this.update()));
		this._register(providers.onDidChangeProviders(() => this.update()));
		this.update();
	}
	private update(): void {
		const desired = new Map<string, { sessionId: string; directory: IFileSystemDirectory }>();
		const roots = new Set<string>();
		for (const session of this.sessions.sessions) {
			if (!session.providerId || session.providerId === this.defaultProviderId || !this.providers.getProvider(session.providerId)) continue;
			const provider = this.providers.getProvider(session.providerId)!;
			const environment = provider.currentWorkspace();
			const environmentRoot =
				environment.type === 'ssh' || environment.type === 'local' || environment.type === 'provider' ? sessionWorkspaceUri(buildAgentHostSessionWorkspace(environment)!) : undefined;
			for (const workspace of [session.workspace, ...session.chats.map(chat => chat.workspace)]) {
				if (!workspace) continue;
				const uri = sessionWorkspaceUri(workspace);
				if (uri.scheme !== Schemas.ashRemote) continue;
				// The connection contribution already owns this exact environment root.
				if (environmentRoot && extUri.isEqual(environmentRoot, uri)) continue;
				const rootKey = extUri.getComparisonKey(uri);
				if (roots.has(rootKey)) continue;
				roots.add(rootKey);
				const key = JSON.stringify([session.providerId, session.backendSessionId, rootKey]);
				desired.set(key, {
					sessionId: session.sessionId,
					directory: {
						uri,
						target: { type: 'session', sessionId: session.backendSessionId!, path: workspace.root },
					},
				});
			}
		}
		for (const key of this.mounts.keys()) if (!desired.has(key)) this.mounts.deleteAndDispose(key);
		for (const [key, value] of desired) {
			if (this.mounts.has(key)) continue;
			const scope = this.scopes.getScope(value.sessionId);
			const host = scope.services.host;
			const registration = this.files.registerAuthority(value.directory.uri.authority, {
				api: host.fs,
				resourceApi: host.resource,
				directories: () => [value.directory],
				onDidChange: listener => {
					const subscription = host.events.subscribe(event => {
						if (event.method === 'fs/changed') listener(event.params);
					});
					return toDisposable(() => subscription.dispose());
				},
			});
			this.mounts.set(key, registration);
		}
	}
}

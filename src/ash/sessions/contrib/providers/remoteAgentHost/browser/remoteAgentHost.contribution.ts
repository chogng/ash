import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { IAgentHostConnectionsService, type IAgentHostConnectionInfo } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { agentHostConnectionAddress } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { isSSHAgentHost } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { RemoteAgentHostSessionsProvider } from './remoteAgentHostSessionsProvider.js';
import { createAgentHostSessionScope } from '../../agentHost/browser/agentHostSessionScope.js';
import { WSLAgentHostContribution } from './wslAgentHost.contribution.js';
import { TunnelAgentHostContribution } from './tunnelAgentHost.contribution.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { SSHAgentHostContribution } from './sshAgentHost.contribution.js';

// The Desktop entrypoint admits this window-owned scope after the base Sessions services restore.
registerWorkbenchContribution(SSHAgentHostContribution.ID, WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(SSHAgentHostContribution));

/** One owner projects every additional runtime host into Sessions, independent of its carrier kind. */
export class RemoteAgentHostContribution extends Disposable {
	public static readonly ID = 'sessions.contrib.remoteAgentHostContribution';
	private readonly scopes = new Map<string, DisposableStore>();
	private readonly scopeLifetimes = this._register(new DisposableStore());
	constructor(
		@IRendererHostService private readonly renderer: IRendererHost,
		@IAgentHostConnectionsService private readonly hosts: IAgentHostConnectionsService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		if (!renderer.agentHosts) return;
		this._register(toDisposable(() => this.scopes.clear()));
		this._register(hosts.onDidChangeConnections(() => this.synchronizeScopes()));
		this.synchronizeScopes();
	}

	private synchronizeScopes(): void {
		if (this.isDisposed) return;
		const hosts = this.hosts.connections.filter(info => !info.isAmbient && info.connection && info.remoteConnection);
		const desired = new Set(hosts.map(info => info.authority));
		for (const [authority, resources] of this.scopes) {
			if (desired.has(authority)) continue;
			this.scopes.delete(authority);
			this.scopeLifetimes.delete(resources);
			resources.dispose();
		}
		for (const info of hosts) {
			if (this.scopes.has(info.authority)) continue;
			const resources = this.scopeLifetimes.add(new DisposableStore());
			this.scopes.set(info.authority, resources);
			try { this.registerScope(info, resources); }
			catch (error) {
				this.scopes.delete(info.authority);
				this.scopeLifetimes.delete(resources);
				resources.dispose();
				this.renderer.agentHosts!.disconnect(info.id);
				if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
			}
		}
	}

	private registerScope(info: IAgentHostConnectionInfo, resources: DisposableStore): void {
		const connection = info.remoteConnection!;
		const api = info.connection!;
		resources.add(toDisposable(() => this.renderer.agentHosts?.disconnect(info.id)));
		const root = info.directory!.uri;
		// This contribution is the scope owner. Its providers borrow only this connection's domains.
		const services = createAgentHostSessionScope(this.instantiation, api, resources);
		const provider = resources.add(services.createInstance(RemoteAgentHostSessionsProvider, {
			id: isSSHAgentHost(connection) ? `ssh-agent-host:${JSON.stringify([connection.host, connection.workspace])}` : `${connection.type}-agent-host:${connection.type === 'tunnel' ? root.authority : agentHostConnectionAddress(connection)}`, label: connection.name,
			root, directory: info.directory!,
			workspace: () => isSSHAgentHost(connection) ? { type: 'ssh', host: connection.host, root: connection.workspace } : { type: 'remote', authority: root.authority, root: connection.workspace },
			selectWorkspace: async () => undefined,
		}));
		resources.add(this.providers.registerProvider(provider));
	}
}

for (const contribution of [RemoteAgentHostContribution, WSLAgentHostContribution, TunnelAgentHostContribution]) {
	registerWorkbenchContribution(contribution.ID, WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance<Disposable>(contribution));
}

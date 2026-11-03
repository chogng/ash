import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Action } from '../../../../../base/common/actions.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostConnectionsService, type IAgentHostConnectionInfo } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { isSSHAgentHost } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { RemoteAgentHostSessionsProvider, remoteAgentHostProviderId } from './remoteAgentHostSessionsProvider.js';
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
		@IRemoteAgentHostService private readonly remoteHosts: IRemoteAgentHostService,
		@IAgentHostConnectionsService private readonly hosts: IAgentHostConnectionsService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		if (!remoteHosts.isAvailable) return;
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
				this.remoteHosts.disconnect(info.id);
				if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
			}
		}
	}

	private registerScope(info: IAgentHostConnectionInfo, resources: DisposableStore): void {
		const connection = info.remoteConnection!;
		const api = info.connection!;
		resources.add(toDisposable(() => this.remoteHosts.disconnect(info.id)));
		const root = info.directory!.uri;
		// This contribution is the scope owner. Its providers borrow only this connection's domains.
		const services = createAgentHostSessionScope(this.instantiation, api, resources);
		const provider = resources.add(services.createInstance(RemoteAgentHostSessionsProvider, {
			id: remoteAgentHostProviderId(info), label: connection.name,
			root, directory: info.directory!,
			workspace: () => isSSHAgentHost(connection) ? { type: 'ssh', host: connection.host, root: connection.workspace } : { type: 'remote', authority: root.authority, root: connection.workspace },
			selectWorkspace: async () => undefined,
		}));
		resources.add(this.providers.registerProvider(provider));
		void this.checkWindowsSandbox(info, resources);
	}

	private async checkWindowsSandbox(info: IAgentHostConnectionInfo, resources: DisposableStore): Promise<void> {
		const capabilities = info.connection!.agentCapabilities;
		if (!capabilities.isAvailable) return;
		const read = async () => {
			const snapshot = await capabilities.read();
			const network = snapshot.sandboxPolicy?.network;
			return snapshot.sandboxDiagnostics.filter(diagnostic => diagnostic.network === network);
		};
		const diagnostics = await read().catch(() => undefined);
		if (resources.isDisposed || !diagnostics
			|| diagnostics.some(diagnostic => diagnostic.readiness.type === 'ready')
			|| !diagnostics.some(diagnostic => diagnostic.backend === 'mxc' && diagnostic.readiness.type === 'unsupported')
			|| !diagnostics.some(diagnostic => diagnostic.backend === 'windows' && diagnostic.readiness.type === 'unavailable')) return;

		const warning = localize('sessions.remoteSandbox.required', 'The Windows account sandbox on {0} needs administrator setup before Agent commands can run.', info.name);
		const pending = resources.add(new DisposableStore());
		const instructions = pending.add(new Action('sessions.remoteSandbox.instructions', localize('sessions.remoteSandbox.instructions', 'Setup Instructions'), '', true, () =>
			this.instantiation.invokeFunction(accessor => accessor.get(IDialogService)).info(
				warning,
				localize('sessions.remoteSandbox.steps', 'On the Windows host, open PowerShell as administrator under the same Windows account used by this connection. In the Ash Remote package’s bin folder, review the service installation plan and install the service. Then review and apply the account setup plan. Return here and select Refresh Status.')
				+ '\n\n$service = .\\ash-windows-sandbox-service.exe plan install | ConvertFrom-Json'
				+ '\n$service'
				+ '\n.\\ash-windows-sandbox-service.exe install --approve $service.sha256'
				+ '\n$accounts = .\\ash-windows-sandbox.exe plan setup --slots 1 | ConvertFrom-Json'
				+ '\n$accounts'
				+ '\n.\\ash-windows-sandbox.exe setup --slots 1 --approve $accounts.sha256',
			)));
		const refresh = pending.add(new Action('sessions.remoteSandbox.refresh', localize('sessions.remoteSandbox.refresh', 'Refresh Status'), '', true, async () => {
			if (pending.isDisposed || !refresh.enabled) return;
			refresh.enabled = false;
			const updated = await read().catch(() => undefined);
			if (pending.isDisposed) return;
			if (updated?.some(diagnostic => diagnostic.readiness.type === 'ready')) {
				notification.close();
				this.notifications.info(localize('sessions.remoteSandbox.ready', 'The command sandbox on {0} is ready.', info.name));
			} else {
				refresh.enabled = true;
				notification.updateMessage(updated?.length
					? localize('sessions.remoteSandbox.pending', 'The command sandbox on {0} is still unavailable. Finish setup on the Windows host and refresh again.', info.name)
					: localize('sessions.remoteSandbox.readFailed', 'Could not check the command sandbox on {0}. Check the connection and refresh again.', info.name));
			}
		}));
		const notification = this.notifications.notify({
			severity: Severity.Warning,
			message: warning,
			sticky: true,
			actions: { primary: [instructions, refresh] },
		});
		pending.add(toDisposable(() => notification.close()));
		pending.add(notification.onDidClose(() => {
			if (resources.delete(pending)) pending.dispose();
		}));
	}
}

for (const contribution of [RemoteAgentHostContribution, WSLAgentHostContribution, TunnelAgentHostContribution]) {
	registerWorkbenchContribution(contribution.ID, WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance<Disposable>(contribution));
}

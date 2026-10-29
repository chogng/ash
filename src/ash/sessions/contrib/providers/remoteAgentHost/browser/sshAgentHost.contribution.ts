import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IAgentHostConnectionsService, type IAgentHostConnectionInfo } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IRemoteConnectionService, type RemoteConnectionDefinition } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { IAgentHostFileSystemService } from '../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import { Menus } from '../../../../browser/menus.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { AppServerSessionsProvider } from '../../agentHost/browser/appServerSessionsProvider.js';
import { createAgentHostSessionScope } from '../../agentHost/browser/agentHostSessionScope.js';

const manageHostsCommand = 'sessions.action.manageAgentHosts';

/** Admits runtime endpoints into this window's provider and file projections. */
export class SSHAgentHostContribution extends Disposable {
	static readonly ID = 'sessions.contrib.sshAgentHostContribution';
	private readonly scopes = new Map<string, DisposableStore>();
	private readonly scopeLifetimes = this._register(new DisposableStore());
	private readonly pendingConnections = this._register(new DisposableStore());
	private readonly pickers = this._register(new DisposableStore());

	constructor(
		@IRendererHostService private readonly renderer: IRendererHost,
		@IAgentHostConnectionsService private readonly hosts: IAgentHostConnectionsService,
		@IAgentHostFileSystemService private readonly files: IAgentHostFileSystemService,
		@IRemoteConnectionService private readonly connections: IRemoteConnectionService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		if (!renderer.agentHosts) { return; }
		this._register(toDisposable(() => this.scopes.clear()));
		this._register(this.hosts.onDidChangeConnections(() => this.synchronizeScopes()));
		this.synchronizeScopes();
		this._register(CommandsRegistry.register(manageHostsCommand, async () => {
			try { await this.showHosts(); }
			catch (error) { if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error)); }
		}));
		const command = { id: manageHostsCommand, title: localize2({ bundle: 'ash.workbench', key: 'agentHosts.manage' }, 'Agents: Manage Connected Hosts') };
		this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command }));
		this._register(MenusRegistry.appendMenuItem(Menus.SidebarSessionsHeader, { command, group: 'navigation', order: 90 }));
	}

	private async showHosts(): Promise<void> {
		const add: IQuickPickItem = { label: localize({ bundle: 'ash.workbench', key: 'agentHosts.add' }, 'Connect a Saved SSH Host…') };
		const items = this.hosts.connections.filter(info => !info.isAmbient && info.remoteConnection).map(info => ({ label: info.name, description: info.remoteConnection!.host, detail: info.remoteConnection!.workspace, info }));
		const selected = await this.pick<IQuickPickItem & { readonly info?: IAgentHostConnectionInfo; }>(
			[add, ...items],
			localize({ bundle: 'ash.workbench', key: 'agentHosts.select' }, 'Connect a host, or select a connected host to disconnect'),
		);
		if (!selected || this.isDisposed) { return; }
		if (selected.info) {
			this.renderer.agentHosts!.disconnect(selected.info.id);
			return;
		}
		const available = await this.connections.list();
		if (this.isDisposed) { return; }
		const target = await this.pick(
			available.map(connection => ({ label: connection.name, description: connection.host, detail: connection.workspace, connection })),
			localize({ bundle: 'ash.workbench', key: 'agentHosts.target' }, 'Select a saved SSH host to connect in this Agents window'),
		);
		if (target && !this.isDisposed) { await this.connect(target.connection); }
	}

	private pick<T extends IQuickPickItem>(items: readonly T[], placeholder: string): Promise<T | undefined> {
		this.assertNotDisposed();
		const resources = new DisposableStore();
		this.pickers.add(resources);
		const picker = resources.add(this.quickInput.createQuickPick<T>());
		picker.items = items;
		picker.placeholder = picker.ariaLabel = placeholder;
		return new Promise(resolve => {
			let settled = false;
			const finish = (selected?: T): void => {
				if (settled) { return; }
				settled = true;
				this.pickers.delete(resources);
				resources.dispose();
				resolve(selected);
			};
			resources.add(toDisposable(() => finish()));
			resources.add(picker.onDidAccept(() => finish(picker.selectedItems[0])));
			resources.add(picker.onDidHide(() => finish()));
			picker.show();
		});
	}

	private async connect(connection: RemoteConnectionDefinition): Promise<void> {
		const resources = this.pendingConnections.add(new DisposableStore());
		const controller = new AbortController();
		resources.add(toDisposable(() => controller.abort()));
		try {
			await this.renderer.agentHosts!.connect(connection, controller.signal);
			if (this.isDisposed) throw canceled();
		} finally { this.pendingConnections.delete(resources); resources.dispose(); }
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
		const root = createSshRemoteWorkspaceUri(connection.host, connection.workspace);
		resources.add(this.files.registerAuthority(root.authority, {
			api: api.fs,
			resourceApi: api.resource,
			directories: () => [{ uri: root, target: { type: 'environment', dirId: `agent-host:${info.id}` } }],
			onDidChange: listener => {
				const subscription = api.events.subscribe(event => {
					if (event.method === 'fs/changed') { listener(event.params); }
				});
				return toDisposable(() => subscription.dispose());
			},
		}));
		// This contribution is the scope owner. Its providers borrow only this connection's domains.
		const services = createAgentHostSessionScope(this.instantiation, api, resources);
		const provider = resources.add(services.createInstance(AppServerSessionsProvider, {
			id: `ssh-agent-host:${hostKey(connection)}`, label: connection.name,
			workspace: () => ({ type: 'ssh', host: connection.host, root: connection.workspace }),
			selectWorkspace: async () => undefined,
		}));
		resources.add(this.providers.registerProvider(provider));
	}
}

function hostKey(connection: RemoteConnectionDefinition): string {
	return JSON.stringify([connection.host, connection.workspace]);
}

import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IAppServerApi, IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IAgentSessionService, IAgentTurnService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentModelsService } from '../../../../../platform/agentHost/common/agentModels.js';
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

const manageHostsCommand = 'sessions.action.manageAgentHosts';

interface HostScope {
	readonly connection: RemoteConnectionDefinition;
	readonly resources: DisposableStore;
	readonly ready: Promise<AppServerSessionsProvider>;
}

/** Owns independent backend service scopes in this Agents window. */
export class SSHAgentHostContribution extends Disposable {
	static readonly ID = 'sessions.contrib.sshAgentHostContribution';
	private readonly hosts = new Map<string, HostScope>();
	private readonly pickers = this._register(new DisposableStore());

	constructor(
		@IRendererHostService private readonly renderer: IRendererHost,
		@IAgentHostFileSystemService private readonly files: IAgentHostFileSystemService,
		@IRemoteConnectionService private readonly connections: IRemoteConnectionService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		if (!renderer.agentHosts) { return; }
		this._register(toDisposable(() => {
			for (const scope of this.hosts.values()) { scope.resources.dispose(); }
			this.hosts.clear();
		}));
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
		const items = [...this.hosts.values()].map(scope => ({ label: scope.connection.name, description: scope.connection.host, detail: scope.connection.workspace, scope }));
		const selected = await this.pick<IQuickPickItem & { readonly scope?: HostScope; }>(
			[add, ...items],
			localize({ bundle: 'ash.workbench', key: 'agentHosts.select' }, 'Connect a host, or select a connected host to disconnect'),
		);
		if (!selected || this.isDisposed) { return; }
		if (selected.scope) {
			const scope = selected.scope;
			const key = hostKey(scope.connection);
			if (this.hosts.get(key) === scope) { this.hosts.delete(key); scope.resources.dispose(); }
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

	private connect(connection: RemoteConnectionDefinition): Promise<AppServerSessionsProvider> {
		const key = hostKey(connection);
		const existing = this.hosts.get(key);
		if (existing) { return existing.ready; }
		const resources = new DisposableStore();
		const controller = new AbortController();
		resources.add(toDisposable(() => controller.abort()));
		const ready = Promise.resolve().then(async () => {
			const host = await this.renderer.agentHosts!.connect(connection, controller.signal);
			if (this.isDisposed || controller.signal.aborted) { host.dispose(); throw canceled(); }
			resources.add(host);
			const root = createSshRemoteWorkspaceUri(connection.host, connection.workspace);
			resources.add(this.files.registerAuthority(root.authority, {
				api: host.api.fs,
				resourceApi: host.api.resource,
				directories: () => [{ uri: root, target: { type: 'environment', dirId: `agent-host:${host.id}` } }],
				onDidChange: listener => {
					const subscription = host.api.events.subscribe(event => {
						if (event.method === 'fs/changed') { listener(event.params); }
					});
					return toDisposable(() => subscription.dispose());
				},
			}));
			// This contribution is the scope owner. Its providers borrow only this connection's domains.
			const services = resources.add(this.instantiation.createChild());
			services.registerInstance(IRendererHostService, host.api);
			services.registerInstance(IAppServerApi, host.api.appServer);
			services.registerInstance(IServerEventApi, host.api.events);
			services.registerInstance(IAgentSessionService, host.api.session);
			services.registerInstance(IAgentModelsService, host.api.model);
			services.registerInstance(IAgentTurnService, host.api.turn);
			const provider = resources.add(services.createInstance(AppServerSessionsProvider, {
				id: `ssh-agent-host:${key}`, label: connection.name,
				workspace: () => ({ type: 'ssh', host: connection.host, root: connection.workspace }),
				selectWorkspace: async () => undefined,
			}));
			resources.add(this.providers.registerProvider(provider));
			return provider;
		});
		const scope: HostScope = { connection, resources, ready };
		this.hosts.set(key, scope);
		void ready.catch(() => {
			if (this.hosts.get(key) === scope) { this.hosts.delete(key); resources.dispose(); }
		});
		return ready;
	}
}

function hostKey(connection: RemoteConnectionDefinition): string {
	return JSON.stringify([connection.host, connection.workspace]);
}

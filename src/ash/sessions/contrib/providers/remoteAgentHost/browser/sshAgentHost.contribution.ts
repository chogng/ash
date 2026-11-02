import { isSSHAgentHost } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IAgentHostConnectionsService, type IAgentHostConnectionInfo } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IRemoteConnectionService, type RemoteConnectionDefinition } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { Menus } from '../../../../browser/menus.js';

const manageHostsCommand = 'sessions.action.manageAgentHosts';

/** Connects saved SSH targets and manages this window's connected hosts. */
export class SSHAgentHostContribution extends Disposable {
	static readonly ID = 'sessions.contrib.sshAgentHostContribution';
	private readonly pendingConnections = this._register(new DisposableStore());
	private readonly pickers = this._register(new DisposableStore());

	constructor(
		@IRemoteAgentHostService private readonly remoteHosts: IRemoteAgentHostService,
		@IAgentHostConnectionsService private readonly hosts: IAgentHostConnectionsService,
		@IRemoteConnectionService private readonly connections: IRemoteConnectionService,
		@ICommandService private readonly commands: ICommandService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		if (!remoteHosts.isAvailable) { return; }
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
		const items = this.hosts.connections.filter(info => !info.isAmbient && info.remoteConnection).map(info => ({ label: info.name, description: isSSHAgentHost(info.remoteConnection!) ? info.remoteConnection!.host : info.remoteConnection!.type === 'wsl' ? info.remoteConnection!.distro : info.remoteConnection!.endpoint, detail: info.remoteConnection!.workspace, info }));
		const selected = await this.pick<IQuickPickItem & { readonly info?: IAgentHostConnectionInfo; readonly command?: string; }>(
			[add, { label: localize('sessions.hosts.connectWSL', 'Agents: Connect to WSL…'), command: 'sessions.action.connectWSLAgentHost' }, { label: localize('sessions.hosts.connectTunnel', 'Agents: Connect to Ash Tunnel…'), command: 'sessions.action.connectTunnelAgentHost' }, ...items],
			localize({ bundle: 'ash.workbench', key: 'agentHosts.select' }, 'Connect a host, or select a connected host to disconnect'),
		);
		if (!selected || this.isDisposed) { return; }
		if (selected.command) { await this.commands.executeCommand(selected.command); return; }
		if (selected.info) {
			this.remoteHosts.disconnect(selected.info.id);
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
			await this.remoteHosts.connect(connection, controller.signal);
			if (this.isDisposed) throw canceled();
		} finally { this.pendingConnections.delete(resources); resources.dispose(); }
	}

}

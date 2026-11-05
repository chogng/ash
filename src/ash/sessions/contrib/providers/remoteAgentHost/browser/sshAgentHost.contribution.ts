import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { isSSHAgentHost } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { agentHostConnectionAddress, IAgentHostConnectionsService, type IAgentHostConnectionInfo } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { RemotesWidget } from './remotesWidget.js';
import { canonicalRemoteConnectionDefinition, IRemoteConnectionService, type RemoteConnectionDefinition } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { Menus } from '../../../../browser/menus.js';

function hostStatus(state: IAgentHostConnectionInfo['state']): string {
	switch (state) {
		case 'ready': return localize({ bundle: 'ash.workbench', key: 'agentHosts.status.connected' }, 'Connected');
		case 'starting':
		case 'initializing': return localize({ bundle: 'ash.workbench', key: 'agentHosts.status.connecting' }, 'Connecting');
		case 'restarting': return localize({ bundle: 'ash.workbench', key: 'agentHosts.status.reconnecting' }, 'Reconnecting');
		case 'stopping': return localize({ bundle: 'ash.workbench', key: 'agentHosts.status.disconnecting' }, 'Disconnecting');
		case 'stopped':
		case 'crashed': return localize({ bundle: 'ash.workbench', key: 'agentHosts.status.disconnected' }, 'Disconnected');
	}
}

function canReconnect(info: IAgentHostConnectionInfo): boolean {
	return !!info.connection && (info.state === 'stopped' || info.state === 'crashed');
}

const manageHostsCommand = 'sessions.action.manageAgentHosts';

/** Connects saved SSH targets and manages this window's connected hosts. */
export class SSHAgentHostContribution extends Disposable {
	static readonly ID = 'sessions.contrib.sshAgentHostContribution';
	private readonly pendingConnections = this._register(new DisposableStore());
	private readonly newEnvironment = this._register(new MutableDisposable<Dialog>());
	private readonly manager = this._register(new MutableDisposable<RemotesWidget>());

	constructor(
		@IRemoteAgentHostService private readonly remoteHosts: IRemoteAgentHostService,
		@IAgentHostConnectionsService private readonly hosts: IAgentHostConnectionsService,
		@IRemoteConnectionService private readonly connections: IRemoteConnectionService,
		@ILayoutService private readonly layout: ILayoutService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		if (!remoteHosts.isAvailable) { return; }
		this._register(CommandsRegistry.register(manageHostsCommand, async () => {
			try { await this.showHosts(); }
			catch (error) { if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error)); }
		}));
		this._register(CommandsRegistry.register('sessions.action.newRemoteEnvironment', (_accessor, transport) => {
			if (transport !== undefined && transport !== 'ssh' && transport !== 'tunnel') return false;
			return this.addEnvironment(transport);
		}));
		const command = { id: manageHostsCommand, title: localize2({ bundle: 'ash.workbench', key: 'agentHosts.manage' }, 'Agents: Manage Connected Hosts') };
		this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command }));
		this._register(MenusRegistry.appendMenuItem(Menus.SessionsViewFilter, { command, group: '2_manage' }));
	}

	private async addEnvironment(transport?: 'ssh' | 'tunnel'): Promise<boolean> {
		if (this.newEnvironment.value || (transport === 'ssh' && !this.connections.available)) return false;
		const cancel = localize('sessions.environment.cancel', 'Cancel');
		const transports = this.connections.available ? [
			localize('sessions.environment.ssh', 'SSH'),
			localize('sessions.environment.tunnel', 'Ash Tunnel'),
		] : [localize('sessions.environment.tunnel', 'Ash Tunnel')];
		const dialogStyles = { buttonStyles: defaultButtonStyles, checkboxStyles: defaultCheckboxStyles, inputBoxStyles: defaultInputBoxStyles, dialogStyles: defaultDialogStyles };
		try {
			if (transport === undefined) {
				const choose = new Dialog(this.layout.activeContainer, localize('sessions.environment.newEnvironment', 'New Environment'), [...transports, cancel], {
					...dialogStyles,
					cancelId: transports.length,
					detail: localize('sessions.environment.transportHelp', 'Save an SSH connection or connect using an authenticated Ash Tunnel URL.'),
				});
				this.newEnvironment.value = choose;
				const choice = await choose.show();
				if (this.isDisposed || choice.button === transports.length) return false;
				this.newEnvironment.clear();
				transport = transports.length === 1 || choice.button === 1 ? 'tunnel' : 'ssh';
			}
			if (transport === 'tunnel') {
				return !!await this.commands.executeCommand<string>('sessions.action.connectTunnelAgentHost');
			}
			if (!this.connections.available) return false;
			const ssh = new Dialog(this.layout.activeContainer, localize('sessions.environment.newSSH', 'New SSH Connection'), [localize('sessions.environment.save', 'Save'), cancel], {
				...dialogStyles, cancelId: 1,
				inputs: [
					{ placeholder: localize('sessions.environment.connectionName', 'Connection name') },
					{ placeholder: localize('sessions.environment.sshHost', 'OpenSSH host alias') },
					{ placeholder: localize('sessions.environment.workspacePath', 'Absolute workspace path') },
				],
			});
			this.newEnvironment.value = ssh;
			const result = await ssh.show();
			if (this.isDisposed || result.button !== 0 || !result.values) return false;
			const [name, host, workspace] = result.values;
			await this.connections.save(canonicalRemoteConnectionDefinition({ name: name!, host: host!, workspace: workspace! }));
			return !this.isDisposed;
		} finally {
			this.newEnvironment.clear();
		}
	}

	private async showHosts(): Promise<void> {
		if (this.manager.value) return;
		let saved: readonly RemoteConnectionDefinition[] = [];
		const reportError = (error: unknown): void => {
			if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
		};
		const manager = new RemotesWidget(this.layout.activeContainer, () => {
			const connected = this.hosts.connections.flatMap(info => {
				const target = info.remoteConnection;
				if (info.isAmbient || !target) return [];
				const address = isSSHAgentHost(target) ? target.host : target.type === 'wsl' ? target.distro : target.endpoint;
				return [{
					id: agentHostConnectionAddress(target), name: info.name, address: `${address} · ${target.workspace}`,
					status: hostStatus(info.state),
					actions: [
						...(canReconnect(info) ? [{
							id: 'reconnect', label: localize('sessions.remotes.reconnect', 'Reconnect'),
							run: () => this.remoteHosts.reconnect(info.id),
						}] : []),
						{
							id: 'disconnect', label: localize('sessions.remotes.disconnect', 'Disconnect'),
							run: () => this.remoteHosts.disconnect(info.id),
						},
					],
				}];
			});
			return [...connected, ...saved.filter(target => !connected.some(row => row.id === agentHostConnectionAddress(target))).map(target => ({
				id: agentHostConnectionAddress(target), name: target.name, address: `${target.host} · ${target.workspace}`, status: hostStatus('stopped'),
				actions: [{ id: 'connect', label: localize('sessions.remotes.connect', 'Connect'), run: () => this.connect(target) }],
			}))];
		}, this.hosts.onDidChangeConnections, reportError);
		this.manager.value = manager;
		try {
			const closed = manager.show();
			void this.connections.list().then(targets => { saved = targets; }, reportError).finally(() => manager.finishLoading());
			await closed;
		} finally {
			if (this.manager.value === manager) this.manager.clear();
		}
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

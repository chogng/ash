import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { saveTunnelEndpoint, tunnelEnvironmentLabel } from '../../../../common/savedTunnelEnvironments.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { tunnelEndpoint } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';

/** Connects Ash's authenticated loopback URL after the user establishes its SSH forward. */
export class TunnelAgentHostContribution extends Disposable {
	private readonly pending = this._register(new DisposableStore());
	constructor(
		@IRemoteAgentHostService private readonly remoteHosts: IRemoteAgentHostService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		if (!remoteHosts.isAvailable) return;
		const id = 'sessions.action.connectTunnelAgentHost';
		this._register(CommandsRegistry.register(id, (_accessor, endpoint) => {
			if (endpoint !== undefined && typeof endpoint !== 'string') return;
			return this.connect(endpoint === undefined ? undefined : tunnelEndpoint(endpoint).href);
		}));
		const command = { id, title: localize2('sessions.hosts.connectTunnel', 'Agents: Connect to Ash Tunnel…') };
		this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command }));
	}

	private async connect(expectedEndpoint?: string): Promise<string | undefined> {
		const resources = this.pending.add(new DisposableStore());
		const cancellation = new CancellationTokenSource();
		resources.add(toDisposable(() => cancellation.dispose(true)));
		const controller = new AbortController();
		resources.add(toDisposable(() => controller.abort()));
		try {
			let link = await this.quickInput.input({
				title: expectedEndpoint
					? localize('sessions.hosts.tunnelReauthenticate', 'Paste the authenticated Ash Tunnel URL for {0}', tunnelEnvironmentLabel(expectedEndpoint))
					: localize('sessions.hosts.tunnelLink', 'Paste the authenticated Ash Tunnel URL after starting its SSH forward'),
				password: true,
				validateInput: async value => {
					try {
						const { endpoint } = parseTunnelLink(value);
						if (expectedEndpoint && endpoint !== expectedEndpoint) {
							return localize('sessions.hosts.tunnelEndpointMismatch', 'Use an authenticated URL for {0}.', tunnelEnvironmentLabel(expectedEndpoint));
						}
						return undefined;
					}
					catch { return localize('sessions.hosts.tunnelLinkInvalid', 'Use the authenticated URL from Ash Tunnel connection instructions.'); }
				},
			}, cancellation.token);
			if (!link || resources.isDisposed) return;
			const { endpoint, ticket } = parseTunnelLink(link);
			link = undefined;
			if (expectedEndpoint && endpoint !== expectedEndpoint) return;
			const host = await this.remoteHosts.connect({ type: 'tunnel', name: tunnelEnvironmentLabel(endpoint), endpoint, workspace: '/' }, controller.signal, ticket);
			if (resources.isDisposed) return;
			await saveTunnelEndpoint(this.storage, endpoint);
			return host.directory.uri.authority;
		} catch (error) {
			if (!this.isDisposed && !controller.signal.aborted && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
		} finally { this.pending.delete(resources); resources.dispose(); }
	}
}

function parseTunnelLink(value: string): { endpoint: string; ticket: string; } {
	const link = new URL(value);
	const parameters = new URLSearchParams(link.hash.slice(1));
	const endpoint = tunnelEndpoint(parameters.get('ash-endpoint') ?? `${link.origin}/`).href;
	const ticket = parameters.get('ash-ticket');
	if (!ticket || !/^[a-f0-9]{64}$/.test(ticket)) throw new TypeError('Missing Ash Tunnel ticket');
	return { endpoint, ticket };
}

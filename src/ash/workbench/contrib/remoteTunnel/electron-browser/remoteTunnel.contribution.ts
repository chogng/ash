import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextKeyService, RawContextKey, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IRemoteTunnelService, INACTIVE_TUNNEL_MODE, type ConnectionInfo } from '../../../../platform/remoteTunnel/common/remoteTunnel.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerWorkbenchContribution, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';

export const RemoteTunnelCommandIds = {
	turnOn: 'workbench.remoteTunnel.actions.turnOn',
	turnOff: 'workbench.remoteTunnel.actions.turnOff',
	manage: 'workbench.remoteTunnel.actions.manage',
	copyToClipboard: 'workbench.remoteTunnel.actions.copyToClipboard',
} as const;
const REMOTE_TUNNEL_CONNECTION_STATE_KEY = 'remoteTunnelConnection';
const REMOTE_TUNNEL_CONNECTION_STATE = new RawContextKey<'connected' | 'connecting' | 'disconnected'>(REMOTE_TUNNEL_CONNECTION_STATE_KEY, 'disconnected');

class RemoteTunnelWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	private readonly connection: IContextKey<'connected' | 'connecting' | 'disconnected'>;
	private revision = 0;
	constructor(@IRemoteTunnelService private readonly tunnels: IRemoteTunnelService, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		this.connection = REMOTE_TUNNEL_CONNECTION_STATE.bindTo(contextKeys);
		this._register(toDisposable(() => this.connection.reset()));
		this._register(tunnels.onDidChangeTunnelStatus(value => {
			this.revision++;
			this.connection.set(value.type === 'uninitialized' ? 'disconnected' : value.type);
		}));
	}

	public async onWorkspaceRestored(): Promise<void> {
		const revision = this.revision;
		const value = await this.tunnels.initialize(INACTIVE_TUNNEL_MODE);
		if (!this.isDisposed && revision === this.revision) { this.connection.set(value.type === 'uninitialized' ? 'disconnected' : value.type); }
	}
}
registerWorkbenchContribution('workbench.contrib.remoteTunnel', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(RemoteTunnelWorkbenchContribution));

registerAction2(class extends Action2 {
	constructor() {
		super({ id: RemoteTunnelCommandIds.turnOn, title: localize2({ bundle: 'ash.workbench', key: 'remoteTunnel.turnOn' }, 'Remote Tunnels: Turn On Remote Tunnel Access'), f1: true });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const dialogs = accessor.get(IDialogService);
		const tunnels = accessor.get(IRemoteTunnelService);
		const clipboard = accessor.get(IClipboardService);
		const relay = await accessor.get(IQuickInputService).input({
			title: localize({ bundle: 'ash.workbench', key: 'remoteTunnel.relayTitle' }, 'SSH relay for this local workspace'),
			placeHolder: localize({ bundle: 'ash.workbench', key: 'remoteTunnel.relayPlaceholder' }, 'OpenSSH host alias, for example ash-relay'),
			validateInput: async value => /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,251}[a-zA-Z0-9])?$/.test(value.trim()) ? undefined : localize({ bundle: 'ash.workbench', key: 'remoteTunnel.invalidRelay' }, 'Enter an OpenSSH host alias using letters, numbers, dots, underscores or hyphens.'),
		});
		if (relay === undefined) { return; }
		try {
			status(localize({ bundle: 'ash.workbench', key: 'remoteTunnel.starting' }, 'Starting remote tunnel access.'));
			const value = await tunnels.startTunnel({ active: true, asService: false, session: { providerId: 'ssh', sessionId: relay.trim(), accountLabel: relay.trim() } });
			if (value.type === 'connected') {
				await showConnection(value.info, dialogs, clipboard);
			} else if (value.type === 'disconnected' && (await tunnels.getMode()).active) {
				await dialogs.error(localize({ bundle: 'ash.workbench', key: 'remoteTunnel.failed' }, 'Could not start remote tunnel access. Check your SSH alias, key authentication and relay forwarding permissions.'));
			}
		} catch {
			await dialogs.error(localize({ bundle: 'ash.workbench', key: 'remoteTunnel.unavailable' }, 'Remote tunnel access requires one local folder and an available Ash backend.'));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: RemoteTunnelCommandIds.turnOff, title: localize2({ bundle: 'ash.workbench', key: 'remoteTunnel.turnOff' }, 'Remote Tunnels: Turn Off Remote Tunnel Access'), f1: true });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IRemoteTunnelService).stopTunnel();
		status(localize({ bundle: 'ash.workbench', key: 'remoteTunnel.stopped' }, 'Remote tunnel access is off.'));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: RemoteTunnelCommandIds.manage, title: localize2({ bundle: 'ash.workbench', key: 'remoteTunnel.manage' }, 'Remote Tunnels: Show Remote Tunnel Access'), f1: true });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const dialogs = accessor.get(IDialogService);
		const clipboard = accessor.get(IClipboardService);
		const value = await accessor.get(IRemoteTunnelService).getTunnelStatus();
		if (value.type === 'connected') { await showConnection(value.info, dialogs, clipboard); return; }
		await dialogs.info(value.type === 'connecting'
			? localize({ bundle: 'ash.workbench', key: 'remoteTunnel.starting' }, 'Starting remote tunnel access.')
			: localize({ bundle: 'ash.workbench', key: 'remoteTunnel.stopped' }, 'Remote tunnel access is off.'));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: RemoteTunnelCommandIds.copyToClipboard, title: localize2({ bundle: 'ash.workbench', key: 'remoteTunnel.copy' }, 'Remote Tunnels: Copy Connection Instructions'), f1: true });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const clipboard = accessor.get(IClipboardService);
		const value = await accessor.get(IRemoteTunnelService).getTunnelStatus();
		if (value.type !== 'connected') { return; }
		await clipboard.writeText(connectionInstructions(value.info));
		status(localize({ bundle: 'ash.workbench', key: 'remoteTunnel.copied' }, 'Remote tunnel connection instructions copied.'));
	}
});

function connectionInstructions(info: ConnectionInfo): string {
	if (!info.link || !info.domain || !info.tunnelId) { throw new Error('Missing SSH connection details'); }
	const port = new URL(info.link).port;
	// The original local port preserves the Web listener's exact Host and Origin.
	const command = `ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:127.0.0.1:${info.tunnelId} ${info.domain}`;
	return localize({ bundle: 'ash.workbench', key: 'remoteTunnel.instructions' }, 'On the other device, run:\n{0}\n\nThen open:\n{1}\n\nUse the same SSH relay alias on both devices. This address has a single-use ticket. Turn on access again to issue a new ticket. Access ends when Ash quits or you turn it off.', command, info.link);
}

async function showConnection(info: ConnectionInfo, dialogs: IDialogService, clipboard: IClipboardService): Promise<void> {
	await dialogs.prompt({
		severity: DialogSeverity.Info,
		title: localize({ bundle: 'ash.workbench', key: 'remoteTunnel.connected' }, 'Remote tunnel access is on'),
		message: info.tunnelName,
		detail: connectionInstructions(info),
		buttons: [{ label: localize({ bundle: 'ash.workbench', key: 'remoteTunnel.copyButton' }, 'Copy Connection Instructions'), run: () => clipboard.writeText(connectionInstructions(info)) }],
		cancelButton: localize({ bundle: 'ash.workbench', key: 'remoteTunnel.close' }, 'Close'),
	});
}

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { LogLevel } from '../../log/common/log.js';
import { localize } from '../../../nls.js';
import { INACTIVE_TUNNEL_MODE, TunnelStates, type ActiveTunnelMode, type IRemoteTunnelService, type TunnelMode, type TunnelStatus } from '../common/remoteTunnel.js';
import { ITunnelProcessCoordinator } from './tunnelProcessCoordinator.js';

/** Standard status facade above the sole application helper coordinator. */
export class RemoteTunnelService extends Disposable implements IRemoteTunnelService {
	declare public readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<TunnelStatus>());
	private readonly modeChanged = this._register(new Emitter<TunnelMode>());
	public readonly onDidChangeTunnelStatus = this.changed.event;
	public readonly onDidChangeMode = this.modeChanged.event;
	public readonly onDidTokenFailed = Event.None;
	private mode: TunnelMode = INACTIVE_TUNNEL_MODE;
	private status: TunnelStatus = TunnelStates.uninitialized;
	private workspaceRoot: string | undefined;

	constructor(@ITunnelProcessCoordinator private readonly coordinator: ITunnelProcessCoordinator) {
		super();
		this._register(coordinator.onDidChangeStatus(status => {
			if (status.connectionState === 'connecting') {
				this.setStatus(TunnelStates.connecting());
			} else if (status.connectionState === 'disconnected') {
				this.setStatus(TunnelStates.disconnected());
			}
		}));
		this._register(coordinator.onDidMachineStatus(event => {
			if (event.status.type === 'connected' && this.mode.active) {
				this.setStatus(TunnelStates.connected(event.status, false));
			}
		}));
	}

	public async getTunnelStatus(): Promise<TunnelStatus> { return this.status; }
	public async getMode(): Promise<TunnelMode> { return this.mode; }
	public async getTunnelName(): Promise<string | undefined> { return this.mode.active ? this.coordinator.getIntendedTunnelName() : undefined; }

	public async initialize(mode: TunnelMode): Promise<TunnelStatus> {
		this.assertNotDisposed();
		// A newly opened window observes existing hosting; its default inactive
		// initialization must not turn off another window's application lease.
		if (this.status.type !== 'uninitialized') { return this.status; }
		if (mode.active) { return this.startTunnel(mode); }
		this.setStatus(TunnelStates.disconnected());
		return this.status;
	}

	public async startTunnel(mode: ActiveTunnelMode): Promise<TunnelStatus> {
		this.assertNotDisposed();
		const validated = validateMode(mode);
		if (!validated.active || !this.workspaceRoot) { throw new Error(localize({ bundle: 'ash.workbench', key: 'remoteTunnel.localWorkspace' }, 'Open a local folder before enabling remote tunnel access.')); }
		this.mode = validated;
		this.modeChanged.fire(this.mode);
		await this.coordinator.setRemoteAccess(validated, LogLevel.Info, this.workspaceRoot);
		return this.status;
	}

	public async stopTunnel(): Promise<void> {
		this.assertNotDisposed();
		this.mode = INACTIVE_TUNNEL_MODE;
		this.modeChanged.fire(this.mode);
		await this.coordinator.setRemoteAccess(this.mode, LogLevel.Info);
	}

	/** Main supplies the authenticated window's folder; renderer data cannot select a root. */
	public createChannel(getWorkspaceRoot: (context: string) => string | undefined): IServerChannel<string> {
		return {
			call: async <T>(context: string, command: string, argument?: unknown): Promise<T> => {
				const root = getWorkspaceRoot(context);
				if (command === 'startTunnel' || command === 'initialize') {
					const mode = validateMode(argument);
					if (command === 'startTunnel' && !mode.active) { throw new TypeError('Expected active tunnel mode'); }
					if (mode.active) {
						if (!root) { throw new Error(localize({ bundle: 'ash.workbench', key: 'remoteTunnel.localWorkspace' }, 'Open a local folder before enabling remote tunnel access.')); }
						this.workspaceRoot = root;
					}
					return await (command === 'initialize' ? this.initialize(mode) : this.startTunnel(mode as ActiveTunnelMode)) as T;
				}
				if (argument !== undefined) { throw new TypeError('Tunnel operation takes no arguments'); }
				switch (command) {
					case 'getTunnelStatus': return await this.getTunnelStatus() as T;
					case 'getMode': return await this.getMode() as T;
					case 'getTunnelName': return await this.getTunnelName() as T;
					case 'stopTunnel': await this.stopTunnel(); return undefined as T;
					default: throw new Error('Unknown remote tunnel operation');
				}
			},
			listen: <T>(context: string, event: string, argument?: unknown): Event<T> => {
				getWorkspaceRoot(context);
				if (argument !== undefined) { throw new TypeError('Tunnel event takes no arguments'); }
				switch (event) {
					case 'onDidChangeTunnelStatus': return this.onDidChangeTunnelStatus as Event<T>;
					case 'onDidChangeMode': return this.onDidChangeMode as Event<T>;
					case 'onDidTokenFailed': return this.onDidTokenFailed as Event<T>;
					default: throw new Error('Unknown remote tunnel event');
				}
			},
		};
	}

	private setStatus(status: TunnelStatus): void {
		this.status = status;
		this.coordinator.setRemoteAccessStatus(status);
		this.changed.fire(status);
	}
}

function validateMode(value: unknown): TunnelMode {
	if (!isRecord(value)) { throw new TypeError('Invalid tunnel mode'); }
	if (value.active === false && Object.keys(value).length === 1) { return INACTIVE_TUNNEL_MODE; }
	if (value.active !== true || value.asService !== false || Object.keys(value).length !== 3 || !isRecord(value.session)) { throw new TypeError('Unsupported tunnel mode'); }
	const session = value.session;
	if (session.providerId !== 'ssh' || typeof session.sessionId !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,251}[a-zA-Z0-9])?$/.test(session.sessionId)
		|| typeof session.accountLabel !== 'string' || session.accountLabel.length > 253 || !session.accountLabel || Object.keys(session).length !== 3) {
		throw new TypeError('Invalid SSH relay session');
	}
	return { active: true, asService: false, session: { providerId: 'ssh', sessionId: session.sessionId.toLowerCase(), accountLabel: session.accountLabel } };
}

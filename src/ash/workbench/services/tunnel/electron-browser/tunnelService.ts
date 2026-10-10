import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IAddressProvider } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { TunnelPrivacyId, type ITunnelService, type RemoteTunnel } from '../../../../platform/tunnel/common/tunnel.js';
import { localize } from '../../../../nls.js';

interface Forward {
	readonly id: string;
	readonly localPort: number;
	readonly remoteHost: '127.0.0.1';
	readonly remotePort: number;
	readonly state: 'open' | 'recovering' | 'failed';
}

type ForwardChange = { readonly kind: 'upsert'; readonly tunnel: Forward; } | { readonly kind: 'removed'; readonly id: string; };

/** Owns Desktop tunnel leases above the authenticated Main channel. */
export class TunnelService extends Disposable implements ITunnelService {
	declare public readonly _serviceBrand: undefined;
	private readonly opened = this._register(new Emitter<RemoteTunnel>());
	private readonly closed = this._register(new Emitter<{ host: string; port: number; }>());
	private readonly forwards = new Map<string, Forward>();
	private readonly references = new Map<string, number>();
	private revision = 0;
	private readonly channel: IChannel;
	private readonly pendingOpens = new Map<number, Promise<Forward>>();
	public readonly onTunnelOpened = this.opened.event;
	public readonly onTunnelClosed = this.closed.event;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		super();
		this.channel = mainProcessService.getChannel('remotePortForwarding');
		this._register(this.channel.listen<unknown>('ash:remote:tunnel:changed')(value => this.acceptChange(validateChange(value))));
		this._register(toDisposable(() => {
			this.forwards.clear();
			this.references.clear();
			this.pendingOpens.clear();
		}));
	}

	public get tunnels(): Promise<readonly RemoteTunnel[]> {
		return this.readTunnels();
	}

	public async openTunnel(_addressProvider: IAddressProvider | undefined, remoteHost: string | undefined, remotePort: number, localHost?: string, localPort?: number, elevateIfNeeded?: boolean, privacy?: string, protocol?: string): Promise<RemoteTunnel | string | undefined> {
		this.assertNotDisposed();
		if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
			throw new TypeError(localize('tunnel.invalidPort', 'Remote port must be an integer from 1 to 65535.'));
		}
		const supportedPrivacy = privacy === undefined || privacy === TunnelPrivacyId.Private || privacy === TunnelPrivacyId.ConstantPrivate;
		if (!isLoopback(remoteHost) || !isLoopback(localHost) || localPort !== undefined || elevateIfNeeded || !supportedPrivacy || protocol !== undefined) {
			return localize('tunnel.unsupportedOptions', 'SSH forwarding supports private loopback ports with an automatically assigned local port.');
		}
		// The provider is already bound to the authenticated SSH window. A resolver's
		// address provider cannot replace that host or choose a second connection.
		let forward = [...this.forwards.values()].find(candidate => candidate.remotePort === remotePort);
		if (!forward) {
			let pending = this.pendingOpens.get(remotePort);
			if (!pending) {
				pending = this.channel.call<unknown>('ash:remote:tunnel:open', { remotePort }).then(validateForward);
				this.pendingOpens.set(remotePort, pending);
			}
			try {
				forward = await pending;
			} finally {
				if (this.pendingOpens.get(remotePort) === pending) {
					this.pendingOpens.delete(remotePort);
				}
			}
		}
		if (this.isDisposed) {
			await this.channel.call<void>('ash:remote:tunnel:close', { id: forward.id });
			return undefined;
		}
		this.forwards.set(forward.id, forward);
		this.references.set(forward.id, (this.references.get(forward.id) ?? 0) + 1);
		return this.createTunnel(forward, true);
	}

	public async closeTunnel(remoteHost: string, remotePort: number): Promise<void> {
		this.assertNotDisposed();
		if (!isLoopback(remoteHost)) {
			return;
		}
		await this.readTunnels();
		const forward = [...this.forwards.values()].find(candidate => candidate.remotePort === remotePort);
		if (forward) {
			await this.channel.call<void>('ash:remote:tunnel:close', { id: forward.id });
		}
	}

	private async readTunnels(): Promise<readonly RemoteTunnel[]> {
		this.assertNotDisposed();
		while (true) {
			const revision = this.revision;
			const value = await this.channel.call<unknown>('ash:remote:tunnel:list');
			if (!Array.isArray(value)) {
				throw new TypeError('Invalid Remote tunnel list');
			}
			const snapshot = value.map(validateForward);
			this.assertNotDisposed();
			// Main's notifications can overtake a list reply. Read again rather than
			// resurrect a closed forward or replace a newer recovery state.
			if (revision !== this.revision) {
				continue;
			}
			this.forwards.clear();
			for (const forward of snapshot) {
				this.forwards.set(forward.id, forward);
			}
			for (const id of this.references.keys()) {
				if (!this.forwards.has(id)) {
					this.references.delete(id);
				}
			}
			return snapshot.map(forward => this.createTunnel(forward, false));
		}
	}

	private acceptChange(change: ForwardChange): void {
		if (this.isDisposed) {
			return;
		}
		this.revision++;
		if (change.kind === 'upsert') {
			this.forwards.set(change.tunnel.id, change.tunnel);
			this.opened.fire(this.createTunnel(change.tunnel, false));
			return;
		}
		const forward = this.forwards.get(change.id);
		this.forwards.delete(change.id);
		this.references.delete(change.id);
		if (forward && ![...this.forwards.values()].some(candidate => candidate.remoteHost === forward.remoteHost && candidate.remotePort === forward.remotePort)) {
			this.closed.fire({ host: forward.remoteHost, port: forward.remotePort });
		}
	}

	private createTunnel(forward: Forward, retained: boolean): RemoteTunnel {
		let released = false;
		return Object.freeze({
			tunnelRemoteHost: forward.remoteHost,
			tunnelRemotePort: forward.remotePort,
			tunnelLocalPort: forward.localPort,
			localAddress: `${forward.remoteHost}:${forward.localPort}`,
			privacy: TunnelPrivacyId.ConstantPrivate,
			state: forward.state,
			dispose: async (): Promise<void> => {
				if (released || this.isDisposed || !this.forwards.has(forward.id)) {
					return;
				}
				released = true;
				if (retained) {
					const remaining = (this.references.get(forward.id) ?? 1) - 1;
					if (remaining > 0) {
						this.references.set(forward.id, remaining);
						return;
					}
					this.references.delete(forward.id);
				}
				try {
					await this.channel.call<void>('ash:remote:tunnel:close', { id: forward.id });
				} catch (error) {
					released = false;
					if (retained && this.forwards.has(forward.id)) {
						this.references.set(forward.id, (this.references.get(forward.id) ?? 0) + 1);
					}
					throw error;
				}
			},
		});
	}
}

function isLoopback(host: string | undefined): boolean {
	return host === undefined || host === 'localhost' || host === '127.0.0.1';
}

function validateForward(value: unknown): Forward {
	if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > 512 || /[\0\r\n]/.test(value.id)
		|| value.remoteHost !== '127.0.0.1' || !isPort(value.remotePort) || !isPort(value.localPort)
		|| (value.state !== 'open' && value.state !== 'recovering' && value.state !== 'failed')) {
		throw new TypeError('Invalid Remote tunnel reply');
	}
	return { id: value.id, remoteHost: value.remoteHost, remotePort: value.remotePort, localPort: value.localPort, state: value.state };
}

function validateChange(value: unknown): ForwardChange {
	if (!isRecord(value)) {
		throw new TypeError('Invalid Remote tunnel change');
	}
	if (value.kind === 'upsert') {
		return { kind: 'upsert', tunnel: validateForward(value.tunnel) };
	}
	if (value.kind === 'removed' && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 512 && !/[\0\r\n]/.test(value.id)) {
		return { kind: 'removed', id: value.id };
	}
	throw new TypeError('Invalid Remote tunnel change');
}

function isPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65535;
}

import { spawn } from 'node:child_process';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationError, getErrorMessage } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { boundedPositiveInteger, nonEmptyString, record } from '../../ipc/electron-main/ipcValidation.js';
import { getWorkspaceRemoteAuthority, type IAnyWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { createSshRemoteAuthority } from '../common/remote.js';

/** Window-facing description of a Rust-owned SSH forward. */
export interface SshPortForward {
	readonly id: string;
	readonly localPort: number;
	readonly remoteHost: '127.0.0.1';
	readonly remotePort: number;
	readonly state: 'open' | 'recovering' | 'failed';
}

export interface SshPortForwardOpenRequest {
	readonly remotePort: number;
}

export type SshPortForwardChange =
	| { readonly kind: 'upsert'; readonly tunnel: SshPortForward; }
	| { readonly kind: 'removed'; readonly id: string; };

const MAX_STATUS_LENGTH = 16_384;

function spawnForwardHost(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) {
	return spawn(executable, args, { env: environment, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
}

interface SshPortForwardingServiceOptions {
	readonly getWorkspace: () => IAnyWorkspaceIdentifier;
	readonly forwardExecutable: () => string;
	readonly sshExecutable: string;
	readonly localEnvironment: NodeJS.ProcessEnv;
	readonly spawnProcess?: typeof spawnForwardHost;
}

interface Forward {
	readonly ready: DeferredPromise<SshPortForward>;
	readonly closed: DeferredPromise<void>;
	readonly endLease: () => void;
	tunnel?: SshPortForward;
}

/** Owns window leases and projects Rust tunnel events for the existing Ports IPC. */
export class SshPortForwardingService extends Disposable {
	private readonly changes = this._register(new Emitter<SshPortForwardChange>());
	private readonly forwards = new Map<string, Forward>();
	private nextId = 1;

	constructor(private readonly options: SshPortForwardingServiceOptions) {
		super();
		this._register(toDisposable(() => { void this.closeAll(); }));
	}

	async list(): Promise<readonly SshPortForward[]> {
		return [...this.forwards.values()].flatMap(forward => forward.tunnel ? [forward.tunnel] : []);
	}

	async open(request: SshPortForwardOpenRequest): Promise<SshPortForward> {
		this.assertNotDisposed();
		const remotePort = boundedPositiveInteger(request.remotePort, 'remotePort', 65535);
		const authority = getWorkspaceRemoteAuthority(this.options.getWorkspace());
		if (!authority?.startsWith('ssh+')) {
			throw new Error('Remote tunnels require an SSH Remote Workspace');
		}
		const { host } = createSshRemoteAuthority(authority.slice(4));
		const id = `remote-tunnel-${this.nextId++}`;
		const child = (this.options.spawnProcess ?? spawnForwardHost)(
			this.options.forwardExecutable(), ['forward', host, String(remotePort), this.options.sshExecutable], this.options.localEnvironment,
		);
		const forward: Forward = {
			ready: new DeferredPromise(),
			closed: new DeferredPromise(),
			endLease: () => {
				if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end();
			},
		};
		this.forwards.set(id, forward);

		const publish = (localPort: number, state: SshPortForward['state']) => {
			const tunnel: SshPortForward = Object.freeze({ id, localPort, remoteHost: '127.0.0.1', remotePort, state });
			forward.tunnel = tunnel;
			if (state === 'open') {
				void forward.ready.complete(tunnel);
			}
			this.changes.fire({ kind: 'upsert', tunnel });
		};
		const fail = (message: string) => {
			if (this.forwards.get(id) !== forward || forward.ready.isRejected || forward.tunnel?.state === 'failed') return;
			if (forward.tunnel) {
				publish(forward.tunnel.localPort, 'failed');
				console.error(message);
			} else {
				void forward.ready.error(new Error(message));
			}
			forward.endLease();
		};

		child.stdin.on('error', error => fail(error.message));
		child.on('error', error => fail(error.message));
		child.once('close', () => {
			void forward.closed.complete(undefined);
			fail('SSH tunnel host exited');
			if (!forward.tunnel && this.forwards.get(id) === forward) {
				this.forwards.delete(id);
			}
		});
		child.stdout.on('error', error => fail(error.message));
		child.stdout.setEncoding('utf8');
		let buffer = '';
		child.stdout.on('data', (chunk: string) => {
			if (this.forwards.get(id) !== forward || forward.ready.isRejected || forward.tunnel?.state === 'failed') return;
			buffer += chunk;
			try {
				let newline: number;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					if (newline > MAX_STATUS_LENGTH) throw new Error('SSH tunnel status is too long');
					const value: unknown = JSON.parse(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					const { kind } = record(value, ['kind'], ['localPort', 'message']);
					if (kind === 'ready') {
						const localPort = boundedPositiveInteger(record(value, ['kind', 'localPort']).localPort, 'localPort', 65535);
						if (forward.tunnel && forward.tunnel.localPort !== localPort) {
							throw new Error('SSH tunnel recovery changed the local port');
						}
						publish(localPort, 'open');
					} else if (kind === 'recovering' && forward.tunnel) {
						record(value, ['kind']);
						if (forward.tunnel.state !== 'recovering') publish(forward.tunnel.localPort, 'recovering');
					} else if (kind === 'failed') {
						fail(nonEmptyString(record(value, ['kind', 'message']).message, 'message'));
						return;
					} else {
						throw new Error('Invalid SSH tunnel status');
					}
					if (this.forwards.get(id) !== forward) return;
				}
				if (buffer.length > MAX_STATUS_LENGTH) throw new Error('SSH tunnel status is too long');
			} catch (error) {
				fail(getErrorMessage(error));
			}
		});
		return forward.ready.p;
	}

	async close(id: string): Promise<void> {
		const forward = this.forwards.get(id);
		if (!forward) return;
		this.forwards.delete(id);
		void forward.ready.error(new CancellationError('SSH tunnel startup was cancelled'));
		forward.endLease();
		await forward.closed.p;
		if (forward.tunnel && !this.isDisposed) {
			this.changes.fire({ kind: 'removed', id });
		}
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.forwards.keys()].map(id => this.close(id)));
	}

	onDidChange(listener: (change: SshPortForwardChange) => void): IDisposable {
		return this.changes.event(listener);
	}
}

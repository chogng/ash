import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService, type LogLevel } from '../../log/common/log.js';
import type { TunnelMode, TunnelStatus } from '../common/remoteTunnel.js';
import { INACTIVE_TUNNEL_MODE } from '../common/remoteTunnel.js';
import { parseTunnelMachineStatus, type TunnelMachineStatus } from './tunnelMachineStatus.js';

export type TunnelProcessMode = 'none' | 'remoteAccess' | 'service';
export type TunnelProcessConnectionState = 'disconnected' | 'connecting' | 'connected';
export interface ITunnelProcessOutput { readonly mode: TunnelProcessMode; readonly message: string; readonly isError: boolean; }
export interface ITunnelProcessMachineStatus { readonly mode: TunnelProcessMode; readonly status: TunnelMachineStatus; cancel(): void; }
export interface ITunnelProcessStatus {
	readonly mode: TunnelProcessMode;
	readonly tunnelName: string | undefined;
	readonly tunnelId?: string;
	readonly connectionState: TunnelProcessConnectionState;
	readonly serviceInstallFailed: boolean;
}
export const ITunnelProcessCoordinator = createDecorator<ITunnelProcessCoordinator>('tunnelProcessCoordinator');
export interface ITunnelProcessCoordinator {
	readonly _serviceBrand: undefined;
	readonly onDidChangeStatus: Event<ITunnelProcessStatus>;
	readonly onDidOutput: Event<ITunnelProcessOutput>;
	readonly onDidMachineStatus: Event<ITunnelProcessMachineStatus>;
	getStatus(): ITunnelProcessStatus;
	getIntendedTunnelName(): string;
	setRemoteAccess(mode: TunnelMode, logLevel: LogLevel, workspaceRoot?: string): Promise<void>;
	restart(): Promise<void>;
	setRemoteAccessStatus(status: TunnelStatus): void;
}

interface HostOptions {
	readonly executable: string;
	readonly backendExecutable: string;
	readonly sshExecutable: string;
	readonly assets: string;
	readonly environment: NodeJS.ProcessEnv;
}
interface Run {
	readonly child: ChildProcessWithoutNullStreams;
	readonly ready: Promise<void>;
	readonly closed: Promise<void>;
	stop(): Promise<void>;
}

/** Owns one helper process across windows; Rust owns SSH and the shared Web lease. */
export class TunnelProcessCoordinator extends Disposable implements ITunnelProcessCoordinator {
	declare public readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<ITunnelProcessStatus>());
	private readonly output = this._register(new Emitter<ITunnelProcessOutput>());
	private readonly machine = this._register(new Emitter<ITunnelProcessMachineStatus>());
	public readonly onDidChangeStatus = this.changed.event;
	public readonly onDidOutput = this.output.event;
	public readonly onDidMachineStatus = this.machine.event;
	private status: ITunnelProcessStatus = { mode: 'none', tunnelName: undefined, connectionState: 'disconnected', serviceInstallFailed: false };
	private mode: TunnelMode = INACTIVE_TUNNEL_MODE;
	private workspaceRoot: string | undefined;
	private generation = 0;
	private run: Run | undefined;
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly options: HostOptions, @ILogService private readonly logService: ILogService) {
		super();
		this._register(toDisposable(() => {
			this.generation++;
			// EOF reaches Rust even if Main is exiting; killing the helper first would
			// prevent its lease and SSH cleanup from running.
			void this.run?.stop();
		}));
	}

	public getStatus(): ITunnelProcessStatus { return this.status; }
	public getIntendedTunnelName(): string { return this.mode.active ? this.mode.session.sessionId : ''; }
	public restart(): Promise<void> { return this.setRemoteAccess(this.mode, 'information', this.workspaceRoot); }

	public setRemoteAccess(mode: TunnelMode, _logLevel: LogLevel, workspaceRoot?: string): Promise<void> {
		this.assertNotDisposed();
		const generation = ++this.generation;
		this.mode = mode;
		this.workspaceRoot = workspaceRoot;
		const stopped = this.run?.stop();
		const operation = this.queue.then(async () => {
			await stopped;
			if (this.isDisposed || generation !== this.generation) { return; }
			this.run = undefined;
			if (!mode.active) {
				this.update({ mode: 'none', tunnelName: undefined, connectionState: 'disconnected', serviceInstallFailed: false });
				return;
			}
			if (!workspaceRoot || mode.asService) { throw new Error('Unsupported inbound hosting mode'); }
			this.update({ mode: 'remoteAccess', tunnelName: mode.session.sessionId, connectionState: 'connecting', serviceInstallFailed: false });
			const run = this.launch(mode.session.sessionId, workspaceRoot, generation);
			this.run = run;
			this.output.fire({ mode: 'remoteAccess', message: 'Inbound helper started', isError: false });
			try {
				await run.ready;
			} catch {
				await run.stop();
				if (generation === this.generation && !this.isDisposed) {
					this.logService.warn('remoteTunnel', 'Inbound hosting failed');
					this.update({ ...this.status, connectionState: 'disconnected' });
				}
			}
		});
		this.queue = operation.catch(() => undefined);
		return operation;
	}

	public setRemoteAccessStatus(status: TunnelStatus): void {
		if (status.type === 'connected') {
			this.update({ ...this.status, connectionState: 'connected', tunnelId: status.info.tunnelId });
		}
	}

	private launch(relay: string, workspaceRoot: string, generation: number): Run {
		const child = spawn(this.options.executable, ['--relay', relay, '--ssh', this.options.sshExecutable, '--backend', this.options.backendExecutable, '--assets', this.options.assets], {
			env: { ...this.options.environment, ASH_WORKSPACE_ROOT: workspaceRoot },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
		let resolveClosed!: () => void;
		const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
		let stopping: Promise<void> | undefined;
		let buffer = '';
		let published = false;
		const timer = setTimeout(() => { rejectReady(new Error('Inbound hosting timed out')); void run.stop(); }, 45_000);
		const run: Run = {
			child, ready, closed,
			stop: (): Promise<void> => {
				if (!stopping) {
					rejectReady(new Error('Inbound hosting stopped'));
					clearTimeout(timer);
					child.stdin.end();
					stopping = new Promise<void>(resolve => {
						const kill = setTimeout(() => child.kill(), 5_000);
						void closed.then(() => { clearTimeout(kill); resolve(); });
					});
				}
				return stopping;
			},
		};
		child.stdin.on('error', () => undefined);
		child.on('error', () => rejectReady(new Error('Inbound hosting could not start')));
		child.once('close', () => {
			clearTimeout(timer);
			rejectReady(new Error('Inbound hosting exited'));
			resolveClosed();
			if (generation === this.generation && !this.isDisposed) {
				this.update({ ...this.status, connectionState: 'disconnected' });
			}
		});
		// Never forward raw launcher output: it contains a bearer ticket. Drain
		// diagnostics without retaining them or exposing them to renderer logs.
		child.stderr.resume();
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (generation !== this.generation || this.isDisposed || stopping) { return; }
			buffer += chunk;
			if (buffer.length > 16_384) { rejectReady(new Error('Invalid hosting output')); void run.stop(); return; }
			const newline = buffer.indexOf('\n');
			if (newline < 0) { return; }
			const status = parseTunnelMachineStatus(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (published || !status || status.type !== 'connected' || buffer.length !== 0) {
				rejectReady(new Error('Invalid hosting output')); void run.stop(); return;
			}
			published = true;
			clearTimeout(timer);
			this.machine.fire({ mode: 'remoteAccess', status, cancel: () => { void run.stop(); } });
			resolveReady();
		});
		return run;
	}

	private update(status: ITunnelProcessStatus): void {
		this.status = status;
		this.changed.fire(status);
	}
}

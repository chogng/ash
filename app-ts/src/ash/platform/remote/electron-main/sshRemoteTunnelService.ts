import { createConnection, createServer } from "node:net";
import { type ChildProcess, spawn } from "node:child_process";
import { throwIfCancelled } from "../../../base/common/cancellation.js";
import { CancellationError, getErrorMessage } from "../../../base/common/errors.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { IAnyWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import { isRemoteWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import { getRemoteAuthority } from "../common/remote.js";
import { type IRemoteTunnelService, type RemoteTunnel, type RemoteTunnelChange, type RemoteTunnelOpenRequest } from "../common/remoteTunnelService.js";

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
const STARTUP_POLL_INTERVAL_MS = 10;
const STARTUP_STABILITY_MS = 50;
const LISTENER_PROBE_TIMEOUT_MS = 250;
const DEFAULT_RECOVERY_WINDOW_MS = 30_000;
const DEFAULT_INITIAL_RECOVERY_DELAY_MS = 250;
const DEFAULT_MAX_RECOVERY_DELAY_MS = 2_000;
const REMOTE_LOOPBACK_HOST = "127.0.0.1" as const;

export interface SpawnSshTunnelOptions {
	readonly environment: NodeJS.ProcessEnv;
}

export type SpawnSshTunnel = (executable: string, args: readonly string[], options: SpawnSshTunnelOptions) => ChildProcess;

/** Whether the selected loopback port currently accepts TCP connections. */
export type LoopbackListenerReadiness = "pending" | "ready";

/** Probes the local listener created by OpenSSH without sending application bytes. */
export type ProbeLoopbackListener = (localPort: number, signal?: AbortSignal) => Promise<LoopbackListenerReadiness>;

/** Bounded retry timing owned by the Electron Main Tunnel coordinator. */
export interface SshRemoteTunnelRecoveryPolicy {
	readonly windowMs: number;
	readonly initialDelayMs: number;
	readonly maxDelayMs: number;
}

export interface SshRemoteTunnelServiceOptions {
	readonly getWorkspace: () => IAnyWorkspaceIdentifier;
	readonly sshExecutable: string;
	readonly localEnvironment: NodeJS.ProcessEnv;
	readonly spawnProcess?: SpawnSshTunnel;
	readonly reserveLocalPort?: () => Promise<number>;
	readonly probeLoopbackListener?: ProbeLoopbackListener;
	readonly startupTimeoutMs?: number;
	readonly recoveryPolicy?: SshRemoteTunnelRecoveryPolicy;
	readonly now?: () => number;
	readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface TunnelRecord {
	tunnel: RemoteTunnel;
	readonly host: string;
	readonly cancellation: AbortController;
	child?: ChildProcess;
	candidateChild?: ChildProcess;
	recovery?: Promise<void>;
}

/** Owns SSH local forwards for one Remote window and never exposes the child to Renderer code. */
export class SshRemoteTunnelService extends Disposable implements IRemoteTunnelService {
	private readonly changes = this._register(new Emitter<RemoteTunnelChange>());
	private readonly tunnels = new Map<string, TunnelRecord>();
	private readonly cancellation = new AbortController();
	private readonly spawnProcess: SpawnSshTunnel;
	private readonly reserveLocalPort: () => Promise<number>;
	private readonly probeLoopbackListener: ProbeLoopbackListener;
	private readonly recoveryPolicy: SshRemoteTunnelRecoveryPolicy;
	private readonly now: () => number;
	private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	private readonly startupTimeoutMs: number;
	private nextId = 1;

	constructor(readonly options: SshRemoteTunnelServiceOptions) {
		super();
		if (options.sshExecutable.trim().length === 0 || hasControlCharacter(options.sshExecutable)) {
			throw new Error("SSH executable must be non-empty and contain no control characters");
		}
		this.spawnProcess = options.spawnProcess ?? defaultSpawn;
		this.reserveLocalPort = options.reserveLocalPort ?? reserveLoopbackPort;
		this.probeLoopbackListener = options.probeLoopbackListener ?? probeLoopbackListener;
		this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.startupTimeoutMs) || this.startupTimeoutMs <= 0) {
			throw new Error("startupTimeoutMs must be a positive safe integer");
		}
		this.recoveryPolicy = options.recoveryPolicy ?? {
			windowMs: DEFAULT_RECOVERY_WINDOW_MS,
			initialDelayMs: DEFAULT_INITIAL_RECOVERY_DELAY_MS,
			maxDelayMs: DEFAULT_MAX_RECOVERY_DELAY_MS,
		};
		validateRecoveryPolicy(this.recoveryPolicy);
		this.now = options.now ?? Date.now;
		this.wait = options.wait ?? wait;
		this._register(toDisposable(() => {
			this.cancellation.abort();
			for (const record of this.tunnels.values()) {
				record.cancellation.abort();
				record.child?.kill();
				record.candidateChild?.kill();
			}
			this.tunnels.clear();
		}));
	}

	list(): Promise<readonly RemoteTunnel[]> {
		return Promise.resolve([...this.tunnels.values()].map(record => record.tunnel));
	}

	async open(request: RemoteTunnelOpenRequest): Promise<RemoteTunnel> {
		validatePort(request.remotePort, "remotePort");
		const authority = this.remoteAuthority();
		const localPort = await this.reserveLocalPort();
		validatePort(localPort, "localPort");
		if (this.isDisposed) throw new Error("Remote tunnel service was disposed during startup");
		const child = this.spawnTunnel(authority.host, localPort, request.remotePort);
		try {
			await waitForStartup(child, localPort, this.startupTimeoutMs, this.probeLoopbackListener, this.wait, this.now, this.cancellation.signal);
		} catch (error) {
			await stopChild(child);
			throw error instanceof Error ? error : new Error("SSH tunnel failed to start");
		}
		if (this.isDisposed) {
			await stopChild(child);
			throw new Error("Remote tunnel service was disposed during startup");
		}

		const record: TunnelRecord = {
			tunnel: Object.freeze({
				id: `remote-tunnel-${this.nextId++}`,
				localPort,
				remoteHost: REMOTE_LOOPBACK_HOST,
				remotePort: request.remotePort,
				state: "open",
			}),
			host: authority.host,
			cancellation: new AbortController(),
			child,
		};
		this.tunnels.set(record.tunnel.id, record);
		this.bindChild(record, child);
		if (child.exitCode !== null) {
			this.tunnels.delete(record.tunnel.id);
			throw new Error(`SSH tunnel exited before it became ready: ${child.exitCode}`);
		}
		this.changes.fire({ kind: "upsert", tunnel: record.tunnel });
		return record.tunnel;
	}

	async close(id: string): Promise<void> {
		const record = this.tunnels.get(id);
		if (!record) return;
		this.tunnels.delete(id);
		record.cancellation.abort();
		const children = new Set([record.child, record.candidateChild].filter((child): child is ChildProcess => child !== undefined));
		record.child = undefined;
		record.candidateChild = undefined;
		await Promise.all([...children].map(stopChild));
		await record.recovery;
		this.changes.fire({ kind: "removed", id });
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.tunnels.keys()].map(id => this.close(id)));
	}

	onDidChange(listener: (change: RemoteTunnelChange) => void): IDisposable {
		return this.changes.event(listener);
	}

	private remoteAuthority(): { readonly host: string } {
		const workspace = this.options.getWorkspace();
		if (!isRemoteWorkspaceIdentifier(workspace)) {
			throw new Error("Remote tunnels require an SSH Remote Workspace");
		}
		const authority = getRemoteAuthority(workspace.uri);
		if (!authority || authority.type !== "ssh") {
			throw new Error("Remote tunnels require an SSH Remote authority");
		}
		return authority;
	}

	private spawnTunnel(host: string, localPort: number, remotePort: number): ChildProcess {
		return this.spawnProcess(
			this.options.sshExecutable,
			sshTunnelArguments(host, localPort, remotePort),
			{ environment: this.options.localEnvironment },
		);
	}

	private bindChild(record: TunnelRecord, child: ChildProcess): void {
		child.once("exit", (code, signal) => {
			this.beginRecovery(record, child, `SSH process exited (${code ?? "signal"} ${signal ?? ""})`.trim());
		});
		child.once("error", error => {
			this.beginRecovery(record, child, `SSH process failed: ${error.message}`);
		});
	}

	private beginRecovery(record: TunnelRecord, child: ChildProcess, failure: string): void {
		if (!this.isCurrent(record) || record.child !== child || record.recovery) return;
		record.child = undefined;
		record.candidateChild = child;
		this.publish(record, "recovering");
		const recovery = this.recover(record, failure);
		record.recovery = recovery;
		void recovery.then(() => {
			if (record.recovery === recovery) record.recovery = undefined;
		});
	}

	private async recover(record: TunnelRecord, initialFailure: string): Promise<void> {
		const started = this.now();
		let attempts = 0;
		let lastFailure = initialFailure;
		try {
			if (record.candidateChild) await stopChild(record.candidateChild);
			record.candidateChild = undefined;
			while (this.isCurrent(record)) {
				const elapsed = Math.max(0, this.now() - started);
				const delay = recoveryDelayWithinWindow(this.recoveryPolicy, elapsed, attempts);
				if (delay === undefined) {
					this.failRecovery(record, attempts, lastFailure);
					return;
				}
				attempts += 1;
				await this.wait(delay, record.cancellation.signal);
				if (!this.isCurrent(record)) return;
				let child: ChildProcess | undefined;
				try {
					child = this.spawnTunnel(record.host, record.tunnel.localPort, record.tunnel.remotePort);
					record.candidateChild = child;
					await waitForStartup(child, record.tunnel.localPort, this.startupTimeoutMs, this.probeLoopbackListener, this.wait, this.now, record.cancellation.signal);
					if (!this.isCurrent(record)) {
						await stopChild(child);
						return;
					}
					record.candidateChild = undefined;
					record.child = child;
					this.bindChild(record, child);
					this.publish(record, "open");
					return;
				} catch (error) {
					lastFailure = getErrorMessage(error);
					if (child) await stopChild(child);
					if (record.candidateChild === child) record.candidateChild = undefined;
				}
			}
		} catch (error) {
			if (this.isCurrent(record)) this.failRecovery(record, attempts, getErrorMessage(error));
		}
	}

	private failRecovery(record: TunnelRecord, attempts: number, failure: string): void {
		if (!this.isCurrent(record)) return;
		record.child = undefined;
		record.candidateChild = undefined;
		this.publish(record, "failed");
		console.error(`SSH tunnel ${record.tunnel.id} did not recover within ${this.recoveryPolicy.windowMs}ms after ${attempts} attempts: ${failure}`);
	}

	private publish(record: TunnelRecord, state: RemoteTunnel["state"]): void {
		if (!this.isCurrent(record)) return;
		record.tunnel = Object.freeze({ ...record.tunnel, state });
		this.changes.fire({ kind: "upsert", tunnel: record.tunnel });
	}

	private isCurrent(record: TunnelRecord): boolean {
		return !this.isDisposed && !record.cancellation.signal.aborted && this.tunnels.get(record.tunnel.id) === record;
	}
}

/** Builds the direct OpenSSH arguments for one fixed loopback forward. */
export function sshTunnelArguments(host: string, localPort: number, remotePort: number): readonly string[] {
	if (host.trim().length === 0 || hasControlCharacter(host)) throw new Error("SSH host must be non-empty and contain no control characters");
	validatePort(localPort, "localPort");
	validatePort(remotePort, "remotePort");
	return [
		"-N",
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		`ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECONDS}`,
		"-L",
		`127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
		host,
	];
}

function defaultSpawn(executable: string, args: readonly string[], options: SpawnSshTunnelOptions): ChildProcess {
	return spawn(executable, [...args], { env: { ...options.environment }, shell: false, stdio: "ignore" });
}

async function reserveLoopbackPort(): Promise<number> {
	const server = createServer();
	return new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: REMOTE_LOOPBACK_HOST, port: 0 }, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a local loopback port"));
				return;
			}
			server.close(error => error ? reject(error) : resolve(address.port));
		});
	});
}

async function probeLoopbackListener(localPort: number, signal?: AbortSignal): Promise<LoopbackListenerReadiness> {
	if (signal) throwIfCancelled(signal, "SSH tunnel startup was cancelled");
	return new Promise<LoopbackListenerReadiness>((resolve, reject) => {
		const socket = createConnection({ host: REMOTE_LOOPBACK_HOST, port: localPort });
		let settled = false;
		const finish = (result: LoopbackListenerReadiness): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			socket.destroy();
			resolve(result);
		};
		const abort = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			reject(new CancellationError("SSH tunnel startup was cancelled", signal?.reason));
		};
		const timeout = setTimeout(() => finish("pending"), LISTENER_PROBE_TIMEOUT_MS);
		timeout.unref();
		socket.once("connect", () => finish("ready"));
		socket.once("error", () => finish("pending"));
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function waitForStartup(child: ChildProcess, localPort: number, timeoutMs: number, probe: ProbeLoopbackListener, wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>, now: () => number, signal?: AbortSignal): Promise<void> {
	if (child.exitCode !== null) throw new Error(`SSH tunnel exited before startup: ${child.exitCode}`);
	let settled = false;
	let failure: Error | undefined;
	const startedAt = now();
	let waitedMs = 0;
	let listenerObserved = false;
	const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
		if (settled) return;
		failure = new Error(`SSH tunnel exited before startup (${code ?? "signal"} ${signal ?? ""})`.trim());
	};
	const error = (value: Error): void => {
		if (settled) return;
		failure = value;
	};
	child.once("exit", exit);
	child.once("error", error);
	try {
		while (true) {
			throwIfStartupFailed(child, failure, signal);
			const readiness = await probe(localPort, signal);
			throwIfStartupFailed(child, failure, signal);
			if (readiness === "ready" && listenerObserved) return;

			const intervalMs = readiness === "ready" ? STARTUP_STABILITY_MS : STARTUP_POLL_INTERVAL_MS;
			const elapsedMs = Math.max(waitedMs, Math.max(0, now() - startedAt));
			const remainingMs = timeoutMs - elapsedMs;
			if (remainingMs <= 0) throw new Error(`SSH tunnel did not listen on 127.0.0.1:${localPort} within ${timeoutMs}ms`);
			listenerObserved = readiness === "ready";
			const delayMs = Math.min(intervalMs, remainingMs);
			await wait(delayMs, signal);
			waitedMs += delayMs;
		}
	} finally {
		settled = true;
		child.removeListener("exit", exit);
		child.removeListener("error", error);
	}
}

function throwIfStartupFailed(child: ChildProcess, failure: Error | undefined, signal?: AbortSignal): void {
	if (failure) throw failure;
	if (child.exitCode !== null) throw new Error(`SSH tunnel exited before startup: ${child.exitCode}`);
	if (signal) throwIfCancelled(signal, "SSH tunnel startup was cancelled");
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	await new Promise<void>(resolve => {
		const done = (): void => {
			child.removeListener("exit", done);
			child.removeListener("close", done);
			child.removeListener("error", done);
			resolve();
		};
		child.once("exit", done);
		child.once("close", done);
		child.once("error", done);
		child.kill();
	});
}

function validatePort(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer from 1 to 65535`);
}

function validateRecoveryPolicy(policy: SshRemoteTunnelRecoveryPolicy): void {
	validatePositiveSafeInteger(policy.windowMs, "recoveryPolicy.windowMs");
	validatePositiveSafeInteger(policy.initialDelayMs, "recoveryPolicy.initialDelayMs");
	validatePositiveSafeInteger(policy.maxDelayMs, "recoveryPolicy.maxDelayMs");
	if (policy.maxDelayMs < policy.initialDelayMs) {
		throw new Error("recoveryPolicy.maxDelayMs must be greater than or equal to initialDelayMs");
	}
}

function validatePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

function recoveryDelayWithinWindow(policy: SshRemoteTunnelRecoveryPolicy, elapsed: number, attempt: number): number | undefined {
	const remaining = policy.windowMs - elapsed;
	const delay = Math.min(policy.initialDelayMs * (2 ** Math.min(attempt, 31)), policy.maxDelayMs);
	return delay <= remaining ? delay : undefined;
}

function hasControlCharacter(value: string): boolean {
	return /[\0\r\n]/u.test(value);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise(resolve => {
		const done = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timeout = setTimeout(done, milliseconds);
		timeout.unref();
		signal?.addEventListener("abort", done, { once: true });
	});
}

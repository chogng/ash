import type { ITerminalAutoReply, TerminalProcessSignal } from '../common/terminal.js';
import { APP_SERVER_METHODS, type TerminalAttachResult, type TerminalReconnectLease } from "../../../../../.build/protocol/typescript/index.js";
import { timeout } from "../../../base/common/async.js";
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Disposable, toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { Emitter } from '../../../base/common/event.js';
import { AppServerRemoteError } from "../../agentHost/common/appServerError.js";
import type { AppServerConnectionState } from "../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import type {
	ITerminalProcessCloseOptions, ITerminalProcessCreateOptions, ITerminalProcessCreation,
	ITerminalProcessInfo,
	ITerminalProcessInvalidationEvent,
	ITerminalReconnectLease,
	ITerminalProcessProfile, ITerminalProcessReadOptions, ITerminalProcessReadResult,
	ITerminalProcessResizeOptions, ITerminalProcessService, ITerminalProcessWriteOptions,
	TerminalProcessConnectionState, ITerminalResolvedProfile, TerminalProcessProfileSelection,
} from "../common/terminal.js";
import { decodeTerminalProcessReadResult, decodeTerminalProcessReady, encodeTerminalProcessInput, profileSelection } from "./appServerTerminalProcessService.js";

const MAX_RECONNECT_GRACE_PERIOD_MILLIS = 5 * 60 * 1_000;
const INITIAL_RECONNECT_DELAY_MILLIS = 50;
const MAX_RECONNECT_DELAY_MILLIS = 1_000;

export interface ReconnectableTerminalProcessServiceOptions {
	/** Protocol readiness precedes restoring this connection's directory grants. */
	readonly whenDirectoriesReady?: () => Promise<void>;
	/** Stable window owner, independent of the replaceable business connection. */
	readonly lifetimeToken?: () => Promise<string>;
	readonly now?: () => number;
	readonly wait?: (milliseconds: number) => Promise<void>;
	readonly reportError?: (message: string, error: unknown) => void;
}

interface TerminalRecord {
	readonly terminalId: string;
	readonly dirId: string | undefined;
	reconnectToken: string;
	reconnectGracePeriodMillis: number;
	rows: number;
	cols: number;
	generation: number;
	recoveryDeadline?: number;
	recovery?: { readonly generation: number; readonly promise: Promise<void>; };
	closing: boolean;
	closure?: { pending?: Promise<void>; };
}

/** Retains PTY leases across connection and backend replacement while the execution host remains alive. */
export class ReconnectableTerminalProcessService extends Disposable implements ITerminalProcessService {
	private readonly now: () => number;
	private readonly wait: (milliseconds: number) => Promise<void>;
	private readonly reportError: (message: string, error: unknown) => void;
	private readonly whenDirectoriesReady: (() => Promise<void>) | undefined;
	private readonly terminals = new Map<string, TerminalRecord>();
	private readonly handedOff = new Set<string>();
	private readonly invalidated = this._register(new Emitter<ITerminalProcessInvalidationEvent>());
	readonly onDidInvalidateProcess = this.invalidated.event;
	private previousState: AppServerConnectionState;
	private replacementRevision = 0;

	constructor(private readonly supervisor: AppServerProtocolClient, private readonly options: ReconnectableTerminalProcessServiceOptions = {}) {
		super();
		this.now = options.now ?? (() => performance.now());
		this.wait = options.wait ?? timeout;
		this.reportError = options.reportError ?? defaultReportError;
		this.whenDirectoriesReady = options.whenDirectoriesReady;
		this.previousState = this.supervisor.state;
		this._register(this.supervisor.onStateChange(state => this.acceptConnectionState(state)));
		this._register(toDisposable(() => {
			this.terminals.clear();
			this.handedOff.clear();
		}));
	}

	get operatingSystem() { return this.supervisor.operatingSystem; }

	async listProfiles(dirId?: string): Promise<readonly ITerminalProcessProfile[]> {
		if (this.whenDirectoriesReady) await this.waitForDirectories();
		const result = await this.supervisor.request(APP_SERVER_METHODS["terminal/profile/list"], { dirId });
		return result.profiles;
	}

	async resolveProfile(profile: TerminalProcessProfileSelection, dirId?: string): Promise<ITerminalResolvedProfile> {
		if (this.whenDirectoriesReady) await this.waitForDirectories();
		return this.supervisor.request(APP_SERVER_METHODS['terminal/profile/resolve'], { dirId, profile: profileSelection(profile) });
	}

	async getEnvironment(names?: readonly string[], dirId?: string): Promise<Readonly<Record<string, string>>> {
		if (this.whenDirectoriesReady) await this.waitForDirectories();
		const result = await this.supervisor.request(APP_SERVER_METHODS["terminal/environment/read"], { names: names && [...names], dirId });
		return result.values;
	}

	getConnectionState(): Promise<TerminalProcessConnectionState> {
		return Promise.resolve(this.supervisor.state);
	}

	onConnectionState(listener: (state: TerminalProcessConnectionState) => void): IDisposable {
		return this.supervisor.onStateChange(listener);
	}

	async create(params: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation> {
		if (this.isDisposed) throw new CancellationError();
		const generation = this.supervisor.generation;
		const replacementRevision = this.replacementRevision;
		if (this.whenDirectoriesReady) await this.waitForDirectories();
		const lifetimeToken = this.options.lifetimeToken ? await this.options.lifetimeToken() : undefined;
		if (this.isDisposed || replacementRevision !== this.replacementRevision || generation !== this.supervisor.generation) throw new CancellationError();
		const execution = params.execution?.type === 'process' ? { ...params.execution, args: typeof params.execution.args === 'string' ? params.execution.args : [...params.execution.args] } : params.execution;
		const result = await this.supervisor.request(APP_SERVER_METHODS["terminal/create"], {
			...params,
			autoReplies: params.autoReplies && [...params.autoReplies],
			profile: profileSelection(params.profile),
			execution,
			lifecycle: { type: "reconnectable" },
			lifetimeToken,
		});
		if (this.isDisposed || replacementRevision !== this.replacementRevision || generation !== this.supervisor.generation || this.supervisor.state !== 'ready') {
			// A reply already delivered by the protocol may outlive its owner. Only
			// the original connection can release that process; a new host must never
			// receive a close for an identity issued by the retired connection.
			if (result.terminalId && generation === this.supervisor.generation && this.supervisor.state === 'ready') {
				await this.supervisor.request(APP_SERVER_METHODS['terminal/close'], { ...workspaceFolder(params.dirId), terminalId: result.terminalId }).catch(() => { });
			}
			throw new CancellationError();
		}
		let lease: TerminalReconnectLease;
		try {
			lease = requireReconnectLease(result.reconnect);
		} catch (error) {
			if (result.terminalId) {
				await this.supervisor.request(APP_SERVER_METHODS["terminal/close"], { ...workspaceFolder(params.dirId), terminalId: result.terminalId }).catch(() => { });
			}
			throw error;
		}
		if (!result.terminalId || this.terminals.has(result.terminalId)) {
			throw new Error("Remote App Server returned an invalid or duplicate terminal identity");
		}
		this.terminals.set(result.terminalId, {
			terminalId: result.terminalId,
			dirId: params.dirId,
			reconnectToken: lease.reconnectToken,
			reconnectGracePeriodMillis: lease.reconnectGracePeriodMillis,
			rows: params.rows,
			cols: params.cols,
			generation: this.supervisor.generation,
			closing: false,
		});
		return {
			ready: decodeTerminalProcessReady(result.ready),
			terminalId: result.terminalId,
			profile: result.profile,
			connectionPersistence: "reconnectable",
		};
	}

	async write(params: ITerminalProcessWriteOptions): Promise<void> {
		const record = await this.ensureAttached(params.terminalId);
		this.assertAttached(record);
		const { data, ...identity } = params;
		if (typeof data === 'string') {
			await this.supervisor.request(APP_SERVER_METHODS['terminal/write'], { ...identity, data });
		} else {
			await this.supervisor.request(APP_SERVER_METHODS['terminal/writeBinary'], { ...identity, dataBase64: encodeTerminalProcessInput(data) });
		}
	}

	async getReconnectLease(terminalId: string): Promise<ITerminalReconnectLease | undefined> {
		if (!this.terminals.has(terminalId) || this.terminals.get(terminalId)!.closing) return undefined;
		try {
			const record = await this.ensureAttached(terminalId);
			this.assertAttached(record);
			return { terminalId, ...workspaceFolder(record.dirId), reconnectToken: record.reconnectToken, reconnectGracePeriodMillis: record.reconnectGracePeriodMillis };
		} catch (error) {
			// Replacement or expiry can retire the record while attachment is pending.
			// A reload must omit that process instead of requesting a stale credential.
			if (!this.terminals.has(terminalId) || this.terminals.get(terminalId)!.closing) return undefined;
			throw error;
		}
	}

	async detach(terminalId: string): Promise<ITerminalReconnectLease> {
		const record = await this.ensureAttached(terminalId);
		this.assertAttached(record);
		// Block every source operation before dispatch. A failed detach restores the
		// record, while a successful one retires it before exposing the credential.
		record.closing = true;
		let detached = false;
		try {
			const result = await this.supervisor.request(APP_SERVER_METHODS['terminal/detach'], { terminalId, ...workspaceFolder(record.dirId) });
			detached = true;
			this.assertAttached(record, true);
			const lease = requireReconnectLease(result);
			this.terminals.delete(terminalId);
			this.handedOff.add(terminalId);
			return { terminalId, ...workspaceFolder(record.dirId), ...lease };
		} catch (error) {
			if (this.terminals.get(terminalId) === record) {
				if (detached) this.terminals.delete(terminalId);
				else record.closing = false;
			}
			throw error;
		}
	}

	async attach(lease: ITerminalReconnectLease, dimensions: { readonly rows: number; readonly cols: number; }, profile: ITerminalProcessProfile): Promise<ITerminalProcessCreation> {
		if (this.isDisposed) throw new CancellationError();
		if (this.terminals.has(lease.terminalId)) throw new Error('Terminal is already attached');
		this.handedOff.delete(lease.terminalId);
		const record: TerminalRecord = {
			terminalId: lease.terminalId, dirId: lease.dirId,
			reconnectToken: lease.reconnectToken, reconnectGracePeriodMillis: lease.reconnectGracePeriodMillis,
			rows: dimensions.rows, cols: dimensions.cols, generation: -1, closing: false,
		};
		this.terminals.set(record.terminalId, record);
		try {
			await this.ensureAttached(record.terminalId);
			const info = await this.getProcessInfo({ terminalId: record.terminalId, ...workspaceFolder(record.dirId) });
			this.assertAttached(record);
			return { terminalId: record.terminalId, ready: info.ready, profile, connectionPersistence: 'reconnectable' };
		} catch (error) {
			// Once attached, the old lease is consumed. A failed information query
			// must retain the rotated credential for recovery, rollback or close.
			if (record.generation < 0 && this.terminals.get(record.terminalId) === record) this.terminals.delete(record.terminalId);
			throw error;
		}
	}

	async resize(params: ITerminalProcessResizeOptions): Promise<void> {
		const record = this.requireTerminal(params.terminalId);
		record.rows = params.rows;
		record.cols = params.cols;
		await this.ensureAttached(record.terminalId);
		this.assertAttached(record);
		await this.supervisor.request(APP_SERVER_METHODS["terminal/resize"], params);
	}

	async sendSignal(params: ITerminalProcessCloseOptions & { readonly signal: TerminalProcessSignal; }): Promise<void> {
		const record = await this.ensureAttached(params.terminalId);
		this.assertAttached(record);
		await this.supervisor.request(APP_SERVER_METHODS['terminal/sendSignal'], params);
	}

	async setAutoReplies(params: ITerminalProcessCloseOptions & { readonly rules: readonly ITerminalAutoReply[]; }): Promise<void> {
		const record = await this.ensureAttached(params.terminalId);
		this.assertAttached(record);
		await this.supervisor.request(APP_SERVER_METHODS['terminal/setAutoReplies'], { ...params, rules: [...params.rules] });
	}

	async read(params: ITerminalProcessReadOptions): Promise<ITerminalProcessReadResult> {
		const record = await this.ensureAttached(params.terminalId);
		this.assertAttached(record);
		const result = await this.supervisor.request(APP_SERVER_METHODS["terminal/read"], params);
		this.assertAttached(record);
		return decodeTerminalProcessReadResult(result);
	}

	async getProcessInfo(params: ITerminalProcessCloseOptions): Promise<ITerminalProcessInfo> {
		const record = await this.ensureAttached(params.terminalId);
		this.assertAttached(record);
		const result = await this.supervisor.request(APP_SERVER_METHODS['terminal/processInfo'], params);
		this.assertAttached(record);
		return { ...result, ready: decodeTerminalProcessReady(result.ready), cwd: result.cwd ?? undefined };
	}

	async close(params: ITerminalProcessCloseOptions): Promise<void> {
		if (this.handedOff.delete(params.terminalId)) {
			this.terminals.delete(params.terminalId);
			return;
		}
		const record = this.terminals.get(params.terminalId);
		// A cleared record belongs to a retired owner or has already been closed.
		// Its identity cannot authorize a close on the current execution host.
		if (!record) return;
		record.closing = true;
		const closure = record.closure ??= {};
		// Retain the credential until the host acknowledges close. A UI pane can
		// disappear while its business transport is down; recovery must finish it.
		if (this.supervisor.state !== 'ready') return;
		if (closure.pending) return closure.pending;
		const operation = (async () => {
			try {
				await this.ensureAttached(record.terminalId, true);
				this.assertAttached(record, true);
				await this.supervisor.request(APP_SERVER_METHODS['terminal/close'], params);
			} catch (error) {
				if (this.terminals.get(record.terminalId) !== record) return;
				if (!(error instanceof AppServerRemoteError) || error.errorName !== 'TerminalNotFound') throw error;
			}
			if (this.terminals.get(record.terminalId) === record) this.terminals.delete(record.terminalId);
		})();
		closure.pending = operation;
		try { await operation; }
		finally { if (closure.pending === operation) closure.pending = undefined; }
	}

	/** Renderer disposal releases its clients without terminating the handed-off processes. */
	prepareForReload(): void {
		for (const record of this.terminals.values()) this.handedOff.add(record.terminalId);
	}

	/** Drops leases before an intentional runtime replacement changes broker identity. */
	prepareForServerReplacement(): void {
		this.replacementRevision++;
		const records = [...this.terminals.values()];
		this.terminals.clear();
		for (const record of records) {
			record.closing = true;
			this.invalidated.fire({ terminalId: record.terminalId, reason: 'replacement' });
		}
		if (this.supervisor.state !== "ready") return;
		for (const record of records) {
			void this.supervisor.request(APP_SERVER_METHODS["terminal/close"], { ...workspaceFolder(record.dirId), terminalId: record.terminalId }).catch(() => {
				// The old connection is about to stop; its broker expires any unclosed lease.
			});
		}
	}

	private acceptConnectionState(state: AppServerConnectionState): void {
		const previous = this.previousState;
		this.previousState = state;
		if (previous === "ready" && state !== "ready") {
			const now = this.now();
			for (const record of this.terminals.values()) {
				if (!record.closing && record.recoveryDeadline === undefined) {
					record.recoveryDeadline = record.reconnectGracePeriodMillis === 0 ? Infinity : now + record.reconnectGracePeriodMillis;
				}
			}
		}
		if (state !== "ready") return;
		for (const record of this.terminals.values()) {
			if (record.closure) {
				void this.close({ terminalId: record.terminalId, ...workspaceFolder(record.dirId) }).catch(error => this.reportError('Failed to complete terminal close after recovery', error));
				continue;
			}
			if (record.generation === this.supervisor.generation || record.closing) continue;
			void this.ensureAttached(record.terminalId).catch(error => {
				if (!(error instanceof RecoverySupersededError) && !isCancellationError(error)) {
					this.reportError(`Failed to recover Remote terminal ${record.terminalId}`, error);
				}
			});
		}
	}

	private async ensureAttached(terminalId: string, allowClosing = false): Promise<TerminalRecord> {
		const record = this.requireTerminal(terminalId);
		if (this.isDisposed || (record.closing && !allowClosing)) throw new CancellationError();
		const generation = this.supervisor.generation;
		if (record.generation === generation) return record;
		if (this.supervisor.state !== "ready") {
			return Promise.reject(new Error(`Remote terminal is waiting for App Server recovery: ${this.supervisor.state}`));
		}
		if (record.recovery?.generation === generation) {
			await record.recovery.promise;
			return record;
		}
		const promise = this.recover(record, generation);
		record.recovery = { generation, promise };
		try {
			await promise;
		} finally {
			if (record.recovery?.promise === promise) record.recovery = undefined;
		}
		return record;
	}

	private async recover(record: TerminalRecord, generation: number): Promise<void> {
		const deadline = record.recoveryDeadline ?? (record.reconnectGracePeriodMillis === 0 ? Infinity : this.now() + record.reconnectGracePeriodMillis);
		record.recoveryDeadline = deadline;
		let delay = INITIAL_RECONNECT_DELAY_MILLIS;
		let lastError: unknown;
		while (!this.isDisposed && this.terminals.get(record.terminalId) === record) {
			if (this.supervisor.state !== "ready" || this.supervisor.generation !== generation) {
				throw new RecoverySupersededError();
			}
			try {
				if (this.whenDirectoriesReady) await this.waitForDirectories();
				const lifetimeToken = this.options.lifetimeToken ? await this.options.lifetimeToken() : undefined;
				if (this.terminals.get(record.terminalId) !== record || this.supervisor.generation !== generation) throw new CancellationError();
				const attached = await this.supervisor.request(APP_SERVER_METHODS["terminal/attach"], {
					...workspaceFolder(record.dirId),
					terminalId: record.terminalId,
					reconnectToken: record.reconnectToken,
					lifetimeToken,
					rows: record.rows,
					cols: record.cols,
				});
				this.acceptAttachment(record, generation, attached);
				return;
			} catch (error) {
				if (isCancellationError(error)) throw error;
				lastError = error;
				// An authoritative rejection ends recovery; transport loss and Busy
				// can still resolve when the old backend releases its connection.
				if (error instanceof AppServerRemoteError && (error.errorName === 'TerminalNotFound' || error.errorName === 'TerminalAttachRejected')) break;
			}
			if (this.supervisor.state !== "ready" || this.supervisor.generation !== generation) {
				throw new RecoverySupersededError();
			}
			const remaining = deadline - this.now();
			if (remaining <= 0) break;
			await this.wait(Math.min(delay, remaining));
			delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MILLIS);
		}
		if (this.terminals.get(record.terminalId) === record) {
			this.terminals.delete(record.terminalId);
			this.invalidated.fire({ terminalId: record.terminalId, reason: 'expiry' });
		}
		throw new Error(Number.isFinite(deadline) ? "Remote terminal reconnect lease expired before attachment" : "Remote terminal is no longer available for attachment", { cause: lastError });
	}

	private async waitForDirectories(): Promise<void> {
		const generation = this.supervisor.generation;
		await this.whenDirectoriesReady!();
		if (this.isDisposed || generation !== this.supervisor.generation || this.supervisor.state !== 'ready') throw new CancellationError();
	}

	private acceptAttachment(record: TerminalRecord, generation: number, attached: TerminalAttachResult): void {
		if (attached.terminalId !== record.terminalId) {
			throw new Error("Remote terminal attachment returned a different terminal identity");
		}
		const lease = requireReconnectLease(attached.reconnect);
		if (this.supervisor.state !== "ready" || this.supervisor.generation !== generation) {
			throw new RecoverySupersededError();
		}
		if (this.isDisposed || this.terminals.get(record.terminalId) !== record) {
			// A retired owner can still receive a successful attach. Release only on
			// the same connection, without publishing the rotated credential.
			void this.supervisor.request(APP_SERVER_METHODS['terminal/close'], { ...workspaceFolder(record.dirId), terminalId: record.terminalId }).catch(() => { });
			throw new CancellationError();
		}
		record.reconnectToken = lease.reconnectToken;
		record.reconnectGracePeriodMillis = lease.reconnectGracePeriodMillis;
		record.generation = generation;
		record.recoveryDeadline = undefined;
	}

	private assertAttached(record: TerminalRecord, allowClosing = false): void {
		// Every caller resumes in its own microtask after recovery. A close or
		// replacement can retire the record before that caller dispatches its RPC.
		if (this.isDisposed || this.terminals.get(record.terminalId) !== record || (record.closing && !allowClosing) || this.supervisor.state !== 'ready' || record.generation !== this.supervisor.generation) {
			throw new CancellationError();
		}
	}

	private requireTerminal(terminalId: string): TerminalRecord {
		const record = this.terminals.get(terminalId);
		if (!record) throw new Error("Remote terminal is no longer recoverable");
		return record;
	}
}

function workspaceFolder(dirId: string | undefined): { readonly dirId?: string; } {
	return dirId === undefined ? {} : { dirId };
}

function requireReconnectLease(value: TerminalReconnectLease | null): TerminalReconnectLease {
	if (!value || !/^[0-9a-f]{64}$/.test(value.reconnectToken) || !Number.isSafeInteger(value.reconnectGracePeriodMillis) || value.reconnectGracePeriodMillis < 0 || value.reconnectGracePeriodMillis > MAX_RECONNECT_GRACE_PERIOD_MILLIS) {
		throw new Error("Remote App Server returned an invalid terminal reconnect lease");
	}
	return value;
}

class RecoverySupersededError extends Error { }

function defaultReportError(message: string, error: unknown): void {
	console.error(message, error);
}

import { APP_SERVER_METHODS, type TerminalAttachResult, type TerminalReconnectLease } from "../../../../../.build/protocol/typescript/index.js";
import { timeout } from "../../../base/common/async.js";
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Disposable, toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import type { AppServerConnectionState } from "../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import type {
	ITerminalProcessCloseOptions, ITerminalProcessCreateOptions, ITerminalProcessCreation,
	ITerminalProcessInfo,
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
}

/** Keeps Remote PTY leases in the renderer; only a new connection to the same backend can reattach them. */
export class ReconnectableTerminalProcessService extends Disposable implements ITerminalProcessService {
	private readonly now: () => number;
	private readonly wait: (milliseconds: number) => Promise<void>;
	private readonly reportError: (message: string, error: unknown) => void;
	private readonly terminals = new Map<string, TerminalRecord>();
	private readonly handedOff = new Set<string>();
	private previousState: AppServerConnectionState;
	private replacementRevision = 0;

	constructor(private readonly supervisor: AppServerProtocolClient, options: ReconnectableTerminalProcessServiceOptions = {}) {
		super();
		this.now = options.now ?? (() => performance.now());
		this.wait = options.wait ?? timeout;
		this.reportError = options.reportError ?? defaultReportError;
		this.previousState = this.supervisor.state;
		this._register(this.supervisor.onStateChange(state => this.acceptConnectionState(state)));
		this._register(toDisposable(() => {
			this.terminals.clear();
			this.handedOff.clear();
		}));
	}

	get operatingSystem() { return this.supervisor.operatingSystem; }

	async listProfiles(dirId?: string): Promise<readonly ITerminalProcessProfile[]> {
		const result = await this.supervisor.request(APP_SERVER_METHODS["terminal/profile/list"], { dirId });
		return result.profiles;
	}

	async resolveProfile(profile: TerminalProcessProfileSelection, dirId?: string): Promise<ITerminalResolvedProfile> {
		return this.supervisor.request(APP_SERVER_METHODS['terminal/profile/resolve'], { dirId, profile: profileSelection(profile) });
	}

	async getEnvironment(names?: readonly string[], dirId?: string): Promise<Readonly<Record<string, string>>> {
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
		const execution = params.execution?.type === 'process' ? { ...params.execution, args: typeof params.execution.args === 'string' ? params.execution.args : [...params.execution.args] } : params.execution;
		const result = await this.supervisor.request(APP_SERVER_METHODS["terminal/create"], {
			...params,
			profile: profileSelection(params.profile),
			execution,
			lifecycle: { type: "reconnectable" },
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

	async getReconnectLease(terminalId: string): Promise<ITerminalReconnectLease> {
		const record = await this.ensureAttached(terminalId);
		this.assertAttached(record);
		return { terminalId, ...workspaceFolder(record.dirId), reconnectToken: record.reconnectToken, reconnectGracePeriodMillis: record.reconnectGracePeriodMillis };
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
			if (this.terminals.get(record.terminalId) === record) this.terminals.delete(record.terminalId);
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

	async sendSignal(params: ITerminalProcessCloseOptions & { readonly signal: 'interrupt'; }): Promise<void> {
		const record = await this.ensureAttached(params.terminalId);
		this.assertAttached(record);
		await this.supervisor.request(APP_SERVER_METHODS['terminal/sendSignal'], params);
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
		try {
			if (this.supervisor.state === "ready") {
				await this.ensureAttached(record.terminalId, true);
				this.assertAttached(record, true);
				await this.supervisor.request(APP_SERVER_METHODS["terminal/close"], params);
			}
		} finally {
			if (this.terminals.get(record.terminalId) === record) this.terminals.delete(record.terminalId);
		}
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
		for (const record of records) record.closing = true;
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
					record.recoveryDeadline = now + record.reconnectGracePeriodMillis;
				}
			}
		}
		if (state !== "ready") return;
		for (const record of this.terminals.values()) {
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
		const deadline = record.recoveryDeadline ?? this.now() + record.reconnectGracePeriodMillis;
		record.recoveryDeadline = deadline;
		let delay = INITIAL_RECONNECT_DELAY_MILLIS;
		let lastError: unknown;
		while (!this.isDisposed && this.terminals.get(record.terminalId) === record) {
			if (this.supervisor.state !== "ready" || this.supervisor.generation !== generation) {
				throw new RecoverySupersededError();
			}
			try {
				const attached = await this.supervisor.request(APP_SERVER_METHODS["terminal/attach"], {
					...workspaceFolder(record.dirId),
					terminalId: record.terminalId,
					reconnectToken: record.reconnectToken,
					rows: record.rows,
					cols: record.cols,
				});
				this.acceptAttachment(record, generation, attached);
				return;
			} catch (error) {
				if (isCancellationError(error)) throw error;
				lastError = error;
			}
			if (this.supervisor.state !== "ready" || this.supervisor.generation !== generation) {
				throw new RecoverySupersededError();
			}
			const remaining = deadline - this.now();
			if (remaining <= 0) break;
			await this.wait(Math.min(delay, remaining));
			delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MILLIS);
		}
		if (this.terminals.get(record.terminalId) === record) this.terminals.delete(record.terminalId);
		throw new Error("Remote terminal reconnect lease expired before attachment", { cause: lastError });
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
	if (!value || !/^[0-9a-f]{64}$/.test(value.reconnectToken) || !Number.isSafeInteger(value.reconnectGracePeriodMillis) || value.reconnectGracePeriodMillis <= 0 || value.reconnectGracePeriodMillis > MAX_RECONNECT_GRACE_PERIOD_MILLIS) {
		throw new Error("Remote App Server returned an invalid terminal reconnect lease");
	}
	return value;
}

class RecoverySupersededError extends Error { }

function defaultReportError(message: string, error: unknown): void {
	console.error(message, error);
}

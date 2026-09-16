import { APP_SERVER_METHODS, type TerminalAttachResult, type TerminalCloseParams, type TerminalCreateParams, type TerminalReadParams, type TerminalReadResult, type TerminalReconnectLease, type TerminalResizeParams, type TerminalWriteParams } from "../../app-server/common/generated/index.js";
import { timeout } from "../../../base/common/async.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { AppServerConnectionState } from "../../app-server/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import type { ITerminalProcessCreation } from "../common/terminalProcessService.js";

const MAX_RECONNECT_GRACE_PERIOD_MILLIS = 5 * 60 * 1_000;
const INITIAL_RECONNECT_DELAY_MILLIS = 50;
const MAX_RECONNECT_DELAY_MILLIS = 1_000;

export interface ReconnectableTerminalProcessServiceOptions {
	readonly supervisor: Pick<AppServerProtocolClient, "request" | "state" | "generation" | "onStateChange">;
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
	recovery?: { readonly generation: number; readonly promise: Promise<void> };
	closing: boolean;
}

/** Keeps Remote PTY bearer leases in the renderer and reattaches them after App Server replacement. */
export class ReconnectableTerminalProcessService extends Disposable {
	private readonly supervisor: Pick<AppServerProtocolClient, "request" | "state" | "generation" | "onStateChange">;
	private readonly now: () => number;
	private readonly wait: (milliseconds: number) => Promise<void>;
	private readonly reportError: (message: string, error: unknown) => void;
	private readonly terminals = new Map<string, TerminalRecord>();
	private previousState: AppServerConnectionState;

	constructor(options: ReconnectableTerminalProcessServiceOptions) {
		super();
		this.supervisor = options.supervisor;
		this.now = options.now ?? (() => performance.now());
		this.wait = options.wait ?? timeout;
		this.reportError = options.reportError ?? defaultReportError;
		this.previousState = this.supervisor.state;
		this._register(this.supervisor.onStateChange(state => this.acceptConnectionState(state)));
		this._register(toDisposable(() => {
			this.terminals.clear();
		}));
	}

	async create(params: TerminalCreateParams): Promise<ITerminalProcessCreation> {
		const result = await this.supervisor.request(APP_SERVER_METHODS["terminal/create"], {
			...params,
			lifecycle: { type: "reconnectable" },
		});
		let lease: TerminalReconnectLease;
		try {
			lease = requireReconnectLease(result.reconnect);
		} catch (error) {
			if (result.terminalId) {
				await this.supervisor.request(APP_SERVER_METHODS["terminal/close"], { ...workspaceFolder(params.dirId), terminalId: result.terminalId }).catch(() => {});
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
			terminalId: result.terminalId,
			profile: result.profile,
			connectionPersistence: "reconnectable",
		};
	}

	async write(params: TerminalWriteParams): Promise<void> {
		await this.ensureAttached(params.terminalId);
		await this.supervisor.request(APP_SERVER_METHODS["terminal/write"], params);
	}

	async resize(params: TerminalResizeParams): Promise<void> {
		const record = this.requireTerminal(params.terminalId);
		record.rows = params.rows;
		record.cols = params.cols;
		await this.ensureAttached(record.terminalId);
		await this.supervisor.request(APP_SERVER_METHODS["terminal/resize"], params);
	}

	async read(params: TerminalReadParams): Promise<TerminalReadResult> {
		await this.ensureAttached(params.terminalId);
		return this.supervisor.request(APP_SERVER_METHODS["terminal/read"], params);
	}

	async close(params: TerminalCloseParams): Promise<void> {
		const record = this.terminals.get(params.terminalId);
		if (!record) {
			await this.supervisor.request(APP_SERVER_METHODS["terminal/close"], params);
			return;
		}
		record.closing = true;
		try {
			if (this.supervisor.state === "ready") {
				await this.ensureAttached(record.terminalId, true);
				await this.supervisor.request(APP_SERVER_METHODS["terminal/close"], params);
			}
		} finally {
			if (this.terminals.get(record.terminalId) === record) this.terminals.delete(record.terminalId);
		}
	}

	/** Drops leases before an intentional runtime replacement changes broker identity. */
	prepareForServerReplacement(): void {
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
				if (!(error instanceof RecoverySupersededError)) {
					this.reportError(`Failed to recover Remote terminal ${record.terminalId}`, error);
				}
			});
		}
	}

	private ensureAttached(terminalId: string, allowClosing = false): Promise<void> {
		const record = this.requireTerminal(terminalId);
		if (record.closing && !allowClosing) return Promise.reject(new Error("Remote terminal is closing"));
		const generation = this.supervisor.generation;
		if (record.generation === generation) return Promise.resolve();
		if (this.supervisor.state !== "ready") {
			return Promise.reject(new Error(`Remote terminal is waiting for App Server recovery: ${this.supervisor.state}`));
		}
		if (record.recovery?.generation === generation) return record.recovery.promise;
		const promise = this.recover(record, generation);
		record.recovery = { generation, promise };
		return promise.finally(() => {
			if (record.recovery?.promise === promise) record.recovery = undefined;
		});
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
		record.reconnectToken = lease.reconnectToken;
		record.reconnectGracePeriodMillis = lease.reconnectGracePeriodMillis;
		record.generation = generation;
		record.recoveryDeadline = undefined;
	}

	private requireTerminal(terminalId: string): TerminalRecord {
		const record = this.terminals.get(terminalId);
		if (!record) throw new Error("Remote terminal is no longer recoverable");
		return record;
	}
}

function workspaceFolder(dirId: string | undefined): { readonly dirId?: string } {
	return dirId === undefined ? {} : { dirId };
}

function requireReconnectLease(value: TerminalReconnectLease | null): TerminalReconnectLease {
	if (!value || !/^[0-9a-f]{64}$/.test(value.reconnectToken) || !Number.isSafeInteger(value.reconnectGracePeriodMillis) || value.reconnectGracePeriodMillis <= 0 || value.reconnectGracePeriodMillis > MAX_RECONNECT_GRACE_PERIOD_MILLIS) {
		throw new Error("Remote App Server returned an invalid terminal reconnect lease");
	}
	return value;
}

class RecoverySupersededError extends Error {}

function defaultReportError(message: string, error: unknown): void {
	console.error(message, error);
}

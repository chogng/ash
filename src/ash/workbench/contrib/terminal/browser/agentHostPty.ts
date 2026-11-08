import type { IAgentCommandTerminal, ITerminalAutoReply } from '../../../../platform/terminal/common/terminal.js';
import { TaskQueue, timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import type { ITerminalProcessOwnership } from '../../../services/terminal/common/terminal.js';
import { CancellationError, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalProcessService, type IProcessDataEvent, type ITerminalProcessCreation } from '../../../../platform/terminal/common/terminal.js';
import { BasePty } from '../common/basePty.js';
import { TerminalProcessManager } from './terminalProcessManager.js';
import { localize } from '../../../../nls.js';
import { ProcessPropertyType, type IProcessPropertyMap } from '../../../../platform/terminal/common/terminal.js';

/** Displays an Agent-owned PTY. Disposing this view detaches without terminating the process. */
export class AgentCommandPty extends BasePty {
	readonly ownsProcess = false;
	private readonly inputMode = this._register(new Emitter<void>());
	readonly onDidChangeInputMode = this.inputMode.event;
	private readonly mutations = new TaskQueue();
	private readonly decoder = new TextDecoder();
	private cursor = 0;
	private controlsInput = false;
	private stopped = false;
	private closing: Promise<void> | undefined;

	constructor(id: number, private readonly command: IAgentCommandTerminal, private cols: number, private rows: number) {
		super(id, false);
	}

	get input(): ((data: string) => Promise<void>) | undefined {
		return this.controlsInput ? data => this.write(new TextEncoder().encode(data)) : undefined;
	}

	processBinary(data: string): Promise<void> {
		return this.write(Uint8Array.from(data, value => value.charCodeAt(0)));
	}

	private write(bytes: Uint8Array): Promise<void> {
		return this.mutations.schedule(async () => {
			if (!this.controlsInput || this.stopped) throw new CancellationError();
			// Keep a large paste in order across the transport's bounded input messages.
			for (let offset = 0; offset < bytes.length && !this.stopped; offset += 65_536) {
				await this.command.write(bytes.subarray(offset, offset + 65_536));
			}
		});
	}

	takeInput(): Promise<void> {
		return this.mutations.schedule(async () => {
			if (this.stopped) throw new CancellationError();
			if (this.controlsInput) return;
			await this.command.takeInput();
			this.controlsInput = true;
			if (!this.stopped) {
				this.inputMode.fire();
				await this.command.resize(this.rows, this.cols);
			}
		});
	}

	resize(cols: number, rows: number): Promise<void> {
		this.cols = cols;
		this.rows = rows;
		return this.mutations.schedule(async () => {
			if (this.controlsInput && !this.stopped) await this.command.resize(rows, cols);
		});
	}

	async start(): Promise<void> {
		try {
			if (!this.stopped && await this.read()) void this.poll();
		} catch (error) {
			void this.shutdown();
			throw error;
		}
	}

	private async poll(): Promise<void> {
		try {
			while (!this.stopped) {
				await timeout(100);
				if (this.stopped || !await this.read()) return;
			}
		} catch (error) {
			if (this.stopped) return;
			if (!isCancellationError(error)) this.handleData(`\r\n${localize('terminal.agentCommand.disconnected', 'The Agent terminal connection ended.')}\r\n`);
			void this.shutdown();
			this.handleExit(undefined);
		}
	}

	private async read(): Promise<boolean> {
		const output = await this.command.read(this.cursor);
		if (this.stopped) return false;
		this.cursor = output.nextCursor;
		if (output.gap) {
			this.decoder.decode();
			this.handleData(`${localize('terminal.agentCommand.outputGap', 'Earlier terminal output was truncated.')}\r\n`);
		}
		const text = this.decoder.decode(output.bytes, { stream: !output.exited });
		if (text) this.handleData(text);
		if (output.exited) {
			void this.shutdown();
			this.handleExit(output.exitCode);
		}
		return !output.exited;
	}

	shutdown(): Promise<void> {
		this.stopped = true;
		return this.closing ??= this.mutations.schedule(async () => {
			if (this.controlsInput) {
				this.controlsInput = false;
				this.inputMode.fire();
			}
			await this.command.detach().catch(error => {
				if (!isCancellationError(error)) onUnexpectedError(error);
			});
		});
	}

	protected override disposeCore(): void {
		void this.shutdown();
		super.disposeCore();
	}
}

/** A client for one Rust-owned process; output and input keep their original commit/ACK mechanism. */
export class AgentHostPty extends BasePty<IProcessDataEvent> {
	private readonly manager: TerminalProcessManager;
	private closeTask: Promise<void> | undefined;
	private readySent = false;

	constructor(
		id: number,
		readonly creation: ITerminalProcessCreation,
		private readonly dirId: string | undefined,
		private readonly released: () => void,
		private readonly ownership: ITerminalProcessOwnership | undefined,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(id, creation.connectionPersistence === 'reconnectable');
		this.manager = this._register(instantiation.createInstance(TerminalProcessManager, { terminalId: creation.terminalId, ...(dirId === undefined ? {} : { dirId }) }));
		this._register(this.manager.onProcessData(event => this.handleData(event)));
		this._register(this.manager.onProcessExit(code => this.handleExit(code)));
	}

	get cwdDetection() { return this.manager.cwdDetection; }
	get promptTypeDetection() { return this.manager.promptTypeDetection; }
	get cwd() { return this.manager.cwd; }
	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		this.assertCanWrite();
		if (this.isDisposed || this.closeTask) throw new CancellationError();
		if (property === ProcessPropertyType.Title) return this.creation.profile.title as IProcessPropertyMap[T];
		const info = await this.processes.getProcessInfo({
			terminalId: this.creation.terminalId,
			...(this.dirId === undefined ? {} : { dirId: this.dirId })
		});
		this.assertCanWrite();
		if (this.isDisposed || this.closeTask) throw new CancellationError();
		// Failure to inspect a process must not silently authorize killing it.
		return (info.hasChildProcesses ?? true) as IProcessPropertyMap[T];
	}
	async getCwd(): Promise<string> {
		this.assertNotDisposed();
		this.assertCanWrite();
		if (this.closeTask) {
			throw new CancellationError();
		}
		const info = await this.processes.getProcessInfo({
			terminalId: this.creation.terminalId,
			...(this.dirId === undefined ? {} : { dirId: this.dirId }),
		});
		if (this.isDisposed || this.closeTask) {
			throw new CancellationError();
		}
		// A result from the retired host cannot supply cwd for a new Split request.
		this.assertCanWrite();
		if (info.cwd === undefined) throw new Error(localize('terminal.process.cwdUnavailable', 'The terminal working directory is unavailable.'));
		return info.cwd;
	}
	get shellIntegration() { return this.manager.shellIntegration; }
	get onProcessError() { return this.manager.onProcessError; }
	get onDidChangeCommandStatus() { return this.manager.onDidChangeCommandStatus; }
	get onDidChangeMetadata() { return this.manager.onDidChangeMetadata; }
	get onPtyReconnect() { return this.manager.onPtyReconnect; }

	protected assertCanWrite(): void { }

	start(reconnecting = false): Promise<void> {
		try { this.assertCanWrite(); } catch (error) { return Promise.reject(error); }
		if (this.closeTask || this.isDisposed) return Promise.reject(new CancellationError());
		if (!this.readySent) { this.readySent = true; this.handleReady(this.creation.ready); }
		return this.manager.start(reconnecting);
	}

	async input(data: string): Promise<void> { this.assertCanWrite(); return this.manager.write(data); }
	async setAutoReplies(rules: readonly ITerminalAutoReply[]): Promise<void> { this.assertCanWrite(); return this.manager.setAutoReplies(rules); }
	async sendSignal(signal: string): Promise<void> { this.assertCanWrite(); return this.manager.sendSignal(signal); }
	async processBinary(data: string): Promise<void> { this.assertCanWrite(); return this.manager.processBinary(data); }
	async resize(cols: number, rows: number): Promise<void> { this.assertCanWrite(); return this.manager.setDimensions(cols, rows); }
	stop(): void { this.manager.stop(); }
	serializeState() { return this.manager.serializeState(); }
	restoreState(state: { readonly sequence: number; readonly pendingUtf8: readonly number[]; }): void { this.manager.restoreState(state); }
	shutdown(_immediate: boolean): void { void this.close().catch(onUnexpectedError); }

	close(): Promise<void> {
		if (this.closeTask) return this.closeTask;
		this.stop();
		this.closeTask = Promise.resolve().then(() => {
			if (this.ownership?.canTerminate === false) return;
			return this.processes.close({ terminalId: this.creation.terminalId, ...(this.dirId === undefined ? {} : { dirId: this.dirId }) });
		}).finally(() => {
			this.dispose();
		});
		return this.closeTask;
	}

	protected override disposeCore(): void {
		// Remove the local registration immediately, even if host release is still
		// pending. A retired PTY must not keep its instance reachable through the backend.
		this.released();
		// Explicit close() retains the failing promise; IDisposable has no asynchronous result channel.
		void this.close().catch(() => { });
		super.disposeCore();
	}
}

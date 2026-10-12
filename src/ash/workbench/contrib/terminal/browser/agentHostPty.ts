import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalProcessService, type IProcessDataEvent, type ITerminalProcessCreation } from '../../../../platform/terminal/common/terminal.js';
import { BasePty } from '../common/basePty.js';
import { TerminalProcessManager } from './terminalProcessManager.js';

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
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(id, creation.connectionPersistence === 'reconnectable');
		this.manager = this._register(instantiation.createInstance(TerminalProcessManager, { terminalId: creation.terminalId, ...(dirId === undefined ? {} : { dirId }) }));
		this._register(this.manager.onProcessData(event => this.handleData(event)));
		this._register(this.manager.onProcessExit(code => this.handleExit(code)));
	}

	get cwd() { return this.manager.cwd; }
	get shellIntegration() { return this.manager.shellIntegration; }
	get onProcessError() { return this.manager.onProcessError; }
	get onDidChangeCommandStatus() { return this.manager.onDidChangeCommandStatus; }
	get onDidChangeMetadata() { return this.manager.onDidChangeMetadata; }
	get onOutputGap() { return this.manager.onOutputGap; }
	get onPtyReconnect() { return this.manager.onPtyReconnect; }

	start(reconnecting = false): Promise<void> {
		if (this.closeTask || this.isDisposed) return Promise.reject(new CancellationError());
		if (!this.readySent) { this.readySent = true; this.handleReady(this.creation.ready); }
		return this.manager.start(reconnecting);
	}

	input(data: string): Promise<void> { return this.manager.write(data); }
	processBinary(data: string): Promise<void> { return this.manager.processBinary(data); }
	resize(cols: number, rows: number): Promise<void> { return this.manager.setDimensions(cols, rows); }
	stop(): void { this.manager.stop(); }
	shutdown(_immediate: boolean): void { void this.close().catch(onUnexpectedError); }

	close(): Promise<void> {
		if (this.closeTask) return this.closeTask;
		this.stop();
		this.closeTask = Promise.resolve().then(() => this.processes.close({ terminalId: this.creation.terminalId, ...(this.dirId === undefined ? {} : { dirId: this.dirId }) })).finally(() => {
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

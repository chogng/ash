import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationError, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import {
	ITerminalProcessService,
	ProcessPropertyType,
	type IShellLaunchConfig,
	type ITerminalChildProcess,
	type IProcessDataEvent,
	type ITerminalProcessReady,
	type ITerminalProcessCreateOptions,
	type TerminalProcessConnectionPersistence,
	type TerminalProcessConnectionState,
} from '../../../../platform/terminal/common/terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalCommandStatusEvent, ITerminalContribution, ITerminalDimensions, ITerminalInstance, ITerminalProfile, TerminalInstanceState } from './terminal.js';
import { TerminalExtensionsRegistry } from './terminalExtensions.js';
import { TerminalProcessManager } from './terminalProcessManager.js';
import { XtermTerminal } from './xterm/xtermTerminal.js';
import { localize } from '../../../../nls.js';

export interface CustomTerminalProcessOptions {
	readonly create: NonNullable<IShellLaunchConfig['customPtyImplementation']>;
	readonly instanceNumber: number;
	dimensions: ITerminalDimensions;
	readonly onTitleChanged: () => void;
}

export class TerminalInstance extends Disposable implements ITerminalInstance {
	private readonly pendingOutput: IProcessDataEvent[] = [];
	private readonly pendingScreenData: Uint8Array[] = [];
	private pendingScreenBytes = 0;
	private screenDataTruncated = false;
	private readonly shellLifetime = this._register(new MutableDisposable<DisposableStore>());
	private shellProcessManager: TerminalProcessManager | undefined;
	private screen: XtermTerminal | undefined;
	private screenInitialization: Promise<XtermTerminal | undefined> | undefined;
	private readonly contributions = this._register(new DisposableMap<string, ITerminalContribution>());
	private pendingExit: { readonly code: number | undefined; } | undefined;
	private readonly customLifetime = this._register(new MutableDisposable<DisposableStore>());
	private customProcess: ITerminalChildProcess | undefined;
	private readonly onClosed: () => void;
	private readonly _onDidWriteData = this._register(new Emitter<IProcessDataEvent>({
		onDidAddFirstListener: () => queueMicrotask(() => {
			while (!this.isDisposed && this._onDidWriteData.hasListeners() && this.pendingOutput.length > 0) {
				this._onDidWriteData.fire(this.pendingOutput.shift()!);
			}
		}),
	}));
	private readonly _onDidChangeCommandStatus = this._register(new Emitter<ITerminalCommandStatusEvent>());
	private readonly _onDidExit = this._register(new Emitter<number | undefined>({
		onDidAddFirstListener: () => queueMicrotask(() => {
			if (!this.isDisposed && this._onDidExit.hasListeners() && this.pendingExit) {
				const { code } = this.pendingExit;
				this.pendingExit = undefined;
				this._onDidExit.fire(code);
			}
		}),
	}));
	private readonly _onDidChangeState = this._register(new Emitter<TerminalInstanceState>());
	private _state: TerminalInstanceState = "running";
	private _exitCode: number | undefined;
	private closed = false;
	private closeTask: Promise<void> | undefined;
	private processCloseTask: Promise<void> | undefined;
	private relaunchTask: Promise<void> | undefined;
	private serverTerminalId: string;
	private _profile: ITerminalProfile;
	private _title: string;
	private pollGeneration = 0;

	readonly onDidWriteData: Event<IProcessDataEvent> = this._onDidWriteData.event;
	readonly onDidChangeCommandStatus: Event<ITerminalCommandStatusEvent> = this._onDidChangeCommandStatus.event;
	readonly onDidExit: Event<number | undefined> = this._onDidExit.event;
	readonly onDidChangeState: Event<TerminalInstanceState> = this._onDidChangeState.event;

	constructor(
		readonly id: string,
		private readonly instanceNumber: number,
		readonly dirId: string,
		private readonly processWorkspaceFolderId: string | undefined,
		serverTerminalId: string,
		private processReady: ITerminalProcessReady,
		title: string,
		profile: ITerminalProfile,
		private connectionPersistence: TerminalProcessConnectionPersistence,
		private _customTitle: string | undefined,
		private readonly getConnectionState: () => TerminalProcessConnectionState,
		onClosed: () => void,
		private readonly onTitleChanged: () => void,
		private custom: CustomTerminalProcessOptions | undefined,
		private launch: Pick<ITerminalProcessCreateOptions, 'env' | 'cwd' | 'execution'> | undefined,
		private initialText: IShellLaunchConfig['initialText'],
		private waitOnExit: IShellLaunchConfig['waitOnExit'],
		private dimensions: ITerminalDimensions,
		@ITerminalProcessService private readonly processService: ITerminalProcessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.serverTerminalId = serverTerminalId;
		this._profile = profile;
		this._title = title;
		this.onClosed = onClosed;
		this.writeInitialText();
		// Creation listeners may send input before output polling starts. The ready
		// process already exists, so its input owner must exist before publication too.
		if (!custom) this.createShellProcessManager();
	}

	protected override disposeCore(): void {
		void this.close();
		this.pendingOutput.length = 0;
		this.pendingScreenData.length = 0;
		this.pendingScreenBytes = 0;
		this.pendingExit = undefined;
		// UI contributions must stop observing focus before removal of their screen's DOM.
		this.contributions.clearAndDisposeAll();
		// Completed Tasks retain instance metadata. Do not keep a disposed screen
		// or a readiness promise that resolved to its potentially large buffer.
		this.screen = undefined;
		this.screenInitialization = undefined;
		this.onClosed();
		super.disposeCore();
	}

	get state(): TerminalInstanceState {
		return this._state;
	}

	public get isReadOnly(): boolean {
		return this.custom !== undefined && this.customProcess?.input === undefined;
	}

	get exitCode(): number | undefined {
		return this._exitCode;
	}

	public get processId(): number {
		return this.processReady.pid;
	}

	public get initialCwd(): string {
		return this.processReady.cwd;
	}

	get profile(): ITerminalProfile {
		return this._profile;
	}

	get title(): string {
		return this._title;
	}

	public get customTitle(): string | undefined { return this._customTitle; }

	setTitle(title: string): void {
		this._title = title;
	}

	public prepareCustomProcess(): void {
		if (this.custom) {
			this.createCustomProcess(this.custom);
		}
	}

	start(): void {
		if (this.closed || this.isDisposed) {
			return;
		}
		if (this.customProcess) {
			const process = this.customProcess;
			void process.start().catch(() => {
				if (this.customProcess === process && !this.closed) {
					this.setState('error');
				}
			});
			return;
		}
		// The connection may change while create or relaunch awaits its PTY.
		// Query the window owner now instead of retaining a pre-request snapshot.
		if (this.getConnectionState() !== 'ready') {
			this.loseConnection();
			return;
		}
		const generation = ++this.pollGeneration;
		void this.poll(generation);
	}

	private createCustomProcess(custom: CustomTerminalProcessOptions): void {
		const process = custom.create(custom.instanceNumber, custom.dimensions.cols, custom.dimensions.rows);
		this.customProcess = process;
		const lifetime = new DisposableStore();
		this.customLifetime.value = lifetime;
		lifetime.add(process);
		lifetime.add(process.onProcessData(data => {
			const event: IProcessDataEvent = { data: VSBuffer.fromString(data).buffer, trackCommit: false };
			this.writeScreenData(event.data);
			// The PTY can write inside open(), before the view owns its xterm widget.
			if (!this._onDidWriteData.hasListeners() || this.pendingOutput.length > 0) {
				this.pendingOutput.push(event);
			} else {
				this._onDidWriteData.fire(event);
			}
		}));
		lifetime.add(process.onProcessReady(ready => { this.processReady = ready; }));
		lifetime.add(process.onDidChangeProperty(property => {
			if (property.type === ProcessPropertyType.Title) {
				this._title = property.value;
				custom.onTitleChanged();
			}
		}));
		lifetime.add(process.onProcessExit(code => this.handleProcessExit(code)));
	}

	public get xterm(): XtermTerminal | undefined { return this.screen; }
	public get xtermReadyPromise(): Promise<XtermTerminal | undefined> { return this.screenInitialization ?? Promise.resolve(undefined); }
	public getContribution<T extends ITerminalContribution>(id: string): T | null {
		return this.contributions.get(id) as T | undefined ?? null;
	}

	public attachToElement(container: HTMLElement): void {
		this.assertNotDisposed();
		if (this.screen) {
			container.append(this.screen.element);
			return;
		}
		const screen = this._register(this.instantiationService.createInstance(XtermTerminal, container, this));
		this.screen = screen;
		if (this.screenDataTruncated) {
			screen.write(`\r\n${localize('terminal.outputTruncated', '[terminal output truncated]')}\r\n`);
		}
		for (const data of this.pendingScreenData) { screen.write(data); }
		this.pendingScreenData.length = 0;
		this.pendingScreenBytes = 0;
		this.screenDataTruncated = false;
		for (const { id, ctor } of TerminalExtensionsRegistry.getTerminalContributions()) {
			this.contributions.set(id, this.instantiationService.createInstance(ctor, { instance: this }));
		}
		this.screenInitialization = screen.initialize().then(() => {
			if (this.isDisposed || screen.isDisposed) { return undefined; }
			// Raw keys and terminal replies must bypass sendText's Enter normalization.
			const input = screen.raw.onData(data => {
				if (!this.isReadOnly && !this.closed && this._state === 'running') {
					if (this.customProcess) this.customProcess.input?.(data);
					else void this.shellProcessManager!.write(data).catch(onUnexpectedError);
				}
			});
			this._register(toDisposable(() => input.dispose()));
			const completedInput = screen.raw.onKey(({ domEvent }) => {
				// Workbench shortcuts remain available after exit. Parser replies use
				// onData, so they cannot accidentally close a waiting task terminal.
				// xterm prevents Enter's default before firing onKey. Workbench
				// commands stop propagation in the document's capture listener.
				if (this._state === 'exited' && this.waitOnExit && !domEvent.altKey && !domEvent.ctrlKey && !domEvent.metaKey) {
					void this.close().catch(onUnexpectedError);
				}
			});
			this._register(toDisposable(() => completedInput.dispose()));
			const binary = screen.raw.onBinary(data => { void this.processBinary(data).catch(onUnexpectedError); });
			this._register(toDisposable(() => binary.dispose()));
			for (const [, contribution] of this.contributions) { contribution.xtermReady?.(screen); }
			return screen;
		});
		// Loading can start in a background instance without a View awaiting it.
		void this.screenInitialization.catch(error => {
			if (!isCancellationError(error) && !this.closed) { this.setState('error'); }
		});
	}

	public detachFromElement(): void {
		this.screen?.setVisible(false);
		this.screen?.element.remove();
	}

	public async sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void> {
		if (this.isReadOnly || this.closed || this._state !== 'running') { throw new CancellationError(); }
		if (bracketedPasteMode && this.screen) {
			const screen = await this.xtermReadyPromise;
			if (!this.closed && !this.isDisposed && screen?.raw.modes.bracketedPasteMode) { text = `\x1b[200~${text}\x1b[201~`; }
		}
		text = text.replace(/\r?\n/g, '\r');
		if (shouldExecute && !text.endsWith('\r')) { text += '\r'; }
		if (this.customProcess?.input) {
			this.customProcess.input(text);
			return;
		}
		if (this.isReadOnly || this.closed || this._state !== 'running' || !this.shellProcessManager) {
			throw new CancellationError();
		}
		await this.shellProcessManager.write(text);
	}

	public processBinary(data: string): Promise<void> {
		if (this.isReadOnly || this.closed || this._state !== 'running' || !this.shellProcessManager) {
			return Promise.reject(new CancellationError());
		}
		return this.shellProcessManager.processBinary(data);
	}

	resize(dimensions: ITerminalDimensions): void {
		this.dimensions = dimensions;
		if (this.custom) {
			this.custom.dimensions = dimensions;
			if (!this.closed && this._state === 'running') this.customProcess?.resize?.(dimensions.cols, dimensions.rows);
			return;
		}
		if (!this.closed && this._state === 'running') {
			void this.shellProcessManager?.setDimensions(dimensions.cols, dimensions.rows).catch(onUnexpectedError);
		}
	}

	public clearBuffer(): void {
		this.pendingOutput.length = 0;
		this.pendingScreenData.length = 0;
		this.pendingScreenBytes = 0;
		this.screenDataTruncated = false;
		this.screen?.clearBuffer();
	}

	private writeScreenData(data: Uint8Array): void {
		if (this.screen) {
			this.screen.write(data);
			return;
		}
		if (data.byteLength === 0) { return; }
		// Process observers can drain output before a view exists. Bound that retained
		// display history independently of observers and the backend's own output ring.
		const limit = 1024 * 1024;
		if (data.byteLength > limit) {
			data = data.slice(-limit);
			this.screenDataTruncated = true;
		}
		this.pendingScreenData.push(data);
		this.pendingScreenBytes += data.byteLength;
		while (this.pendingScreenBytes > limit || this.pendingScreenData.length > 4096) {
			this.pendingScreenBytes -= this.pendingScreenData.shift()!.byteLength;
			this.screenDataTruncated = true;
		}
	}

	private writeInitialText(): void {
		if (this.initialText !== undefined) {
			const text = typeof this.initialText === 'string' ? `${this.initialText}\r\n` : this.initialText.text + (this.initialText.trailingNewLine ? '\r\n' : '');
			this.writeScreenData(VSBuffer.fromString(text).buffer);
		}
	}

	private handleProcessData(event: IProcessDataEvent): void {
		const screen = this.screen;
		if (screen && event.trackCommit) {
			event.writePromise = new Promise((resolve, reject) => {
				screen.write(event.data, resolve);
				// A retained hidden screen parses immediately; a terminal with no screen
				// queues display bytes without making task completion wait for a view.
				void screen.initialize().catch(reject);
			});
		} else {
			this.writeScreenData(event.data);
		}
		this._onDidWriteData.fire(event);
	}

	private handleProcessExit(code: number | undefined): void {
		this._exitCode = code;
		this.setState('exited');
		const message = code === undefined
			? localize('terminal.processExitedUnknown', '[process exited with unknown code]')
			: localize('terminal.processExited', '[process exited with code {0}]', code);
		this.writeScreenData(VSBuffer.fromString(`\r\n${message}\r\n`).buffer);
		try {
			const waitMessage = typeof this.waitOnExit === 'function' && code !== undefined ? this.waitOnExit(code) : typeof this.waitOnExit === 'string' ? this.waitOnExit : undefined;
			if (waitMessage) this.writeScreenData(VSBuffer.fromString(`${waitMessage}\r\n`).buffer);
		} catch (error) {
			// A caller's display callback must not prevent exit delivery or cleanup.
			onUnexpectedError(error);
		}
		if (this._onDidExit.hasListeners()) {
			this._onDidExit.fire(code);
		} else {
			this.pendingExit = { code };
		}
	}

	public reuseTerminal(shell: IShellLaunchConfig): Promise<void> {
		if (this.closed || this.isDisposed) return Promise.reject(new CancellationError());
		if (this.relaunchTask) return Promise.reject(new CancellationError());
		this.relaunchTask = this.performRelaunch(this.dimensions, shell).finally(() => { this.relaunchTask = undefined; });
		return this.relaunchTask;
	}

	public close(): Promise<void> {
		if (this.closeTask) {
			return this.closeTask;
		}
		this.closed = true;
		this.pollGeneration += 1;
		this.shellProcessManager?.stop();
		this.closeTask = this.releaseProcess().finally(() => this.dispose());
		// IDisposable starts release without an async error channel. close() retains
		// the original promise, so explicit callers can await and observe failures.
		void this.closeTask.catch(() => { });
		return this.closeTask;
	}

	private async releaseProcess(): Promise<void> {
		const relaunch = this.relaunchTask;
		try {
			await this.closeProcess();
		} finally {
			// A replacement returned after closure is released by its creation owner.
			// Waiting here ensures close() covers that PTY as well as the old one.
			await relaunch?.catch(error => {
				if (!isCancellationError(error)) {
					throw error;
				}
			});
		}
	}

	private closeProcess(): Promise<void> {
		if (this.custom) {
			const process = this.customProcess;
			return this.processCloseTask ??= Promise.resolve().then(() => process?.shutdown(true));
		}
		return this.processCloseTask ??= this.processService.close({
			...processWorkspaceFolder(this.processWorkspaceFolderId),
			terminalId: this.serverTerminalId,
		});
	}

	loseConnection(): void {
		if (this.custom) {
			return;
		}
		if (this.closed || this._state === "exited" || this._state === "disconnected") return;
		this.pollGeneration += 1;
		this.shellProcessManager?.stop();
		if (this.connectionPersistence === "reconnectable") {
			if (this._state !== "reconnecting") {
				this.setState("reconnecting");
				this.handleProcessData({ data: VSBuffer.fromString(`\r\n${localize('terminal.reconnecting', '[terminal reconnecting]')}\r\n`).buffer, trackCommit: false });
			}
			return;
		}
		this.setState("disconnected");
		this.handleProcessData({ data: VSBuffer.fromString(`\r\n${localize('terminal.connectionLost', '[terminal connection lost; process was not preserved]')}\r\n`).buffer, trackCommit: false });
	}

	restoreConnection(): void {
		if (this.closed || this._state !== "reconnecting") return;
		const generation = ++this.pollGeneration;
		void this.poll(generation, "reconnecting");
	}

	public relaunch(dimensions: ITerminalDimensions): Promise<void> {
		if (this.relaunchTask) {
			return this.relaunchTask;
		}
		if (this.closed || this._state === 'running' || this._state === 'reconnecting') {
			return Promise.resolve();
		}
		this.relaunchTask = this.performRelaunch(dimensions).finally(() => {
			this.relaunchTask = undefined;
		});
		return this.relaunchTask;
	}

	private async performRelaunch(dimensions: ITerminalDimensions, replacement?: IShellLaunchConfig): Promise<void> {
		this.dimensions = dimensions;
		if (replacement) {
			// Old reads must stop before release yields; the retained screen belongs to the new process next.
			this.pollGeneration++;
			this.shellProcessManager?.stop();
			try { await this.closeProcess(); }
			catch (error) { this.setState('error'); throw error; }
		} else {
			await this.closeProcess().catch(() => { });
		}
		if (this.closed) {
			throw new CancellationError();
		}
		try {
			if (replacement) {
				this.shellLifetime.clear();
				this.customLifetime.clear();
				this.shellProcessManager = undefined;
				this.customProcess = undefined;
				this.pendingExit = undefined;
				this.custom = replacement.customPtyImplementation ? {
					create: replacement.customPtyImplementation, instanceNumber: this.instanceNumber,
					dimensions, onTitleChanged: this.onTitleChanged,
				} : undefined;
				this.launch = Object.freeze({
					...(replacement.env === undefined ? {} : { env: Object.freeze({ ...replacement.env }) }),
					...(replacement.cwd === undefined ? {} : { cwd: replacement.cwd }),
					...(replacement.execution === undefined ? {} : { execution: replacement.execution.type === 'process' ? Object.freeze({ ...replacement.execution, args: Object.freeze([...replacement.execution.args]) }) : Object.freeze({ ...replacement.execution }) }),
				});
				this._customTitle = replacement.name;
				this.initialText = replacement.initialText;
				this.waitOnExit = replacement.waitOnExit;
				this._title = replacement.name ?? this._profile.title;
				this.onTitleChanged();
			}
			this.writeInitialText();
			if (this.custom) {
				this.customLifetime.clear();
				this.customProcess = undefined;
				this.processCloseTask = undefined;
				this._exitCode = undefined;
				this.processReady = { pid: -1, cwd: replacement?.cwd ?? this.processReady.cwd };
				this.custom.dimensions = dimensions;
				this.createCustomProcess(this.custom);
				this.setState('running');
				if (!replacement?.deferStart) this.start();
				return;
			}
			const created = await this.processService.create({
				...processWorkspaceFolder(this.processWorkspaceFolderId),
				...this.launch,
				rows: dimensions.rows,
				cols: dimensions.cols,
				profile: replacement ? { type: 'default' } : { type: 'profile', profileId: this._profile.profileId },
			});
			if (this.closed) {
				await this.processService.close({ ...processWorkspaceFolder(this.processWorkspaceFolderId), terminalId: created.terminalId });
				throw new CancellationError();
			}
			this.serverTerminalId = created.terminalId;
			this.processReady = created.ready;
			this.connectionPersistence = created.connectionPersistence;
			this.processCloseTask = undefined;
			this._profile = created.profile;
			this.shellLifetime.clear();
			this.createShellProcessManager();
			this._exitCode = undefined;
			if (!replacement) this.handleProcessData({ data: VSBuffer.fromString(`\r\n${localize('terminal.relaunched', '[terminal relaunched]')}\r\n`).buffer, trackCommit: false });
			this.setState("running");
			if (!replacement?.deferStart) this.start();
		} catch (error) {
			this.setState("error");
			throw error;
		}
	}

	private createShellProcessManager(): void {
		const lifetime = new DisposableStore();
		this.shellLifetime.value = lifetime;
		const manager = this.instantiationService.createInstance(TerminalProcessManager, {
			...processWorkspaceFolder(this.processWorkspaceFolderId),
			terminalId: this.serverTerminalId,
		});
		this.shellProcessManager = lifetime.add(manager);
		lifetime.add(manager.onProcessError(() => this.setState('error')));
		lifetime.add(manager.onProcessData(event => this.handleProcessData(event)));
		lifetime.add(manager.onDidChangeCommandStatus(event => this._onDidChangeCommandStatus.fire(event)));
		lifetime.add(manager.onOutputGap(() => {
			this.handleProcessData({ data: VSBuffer.fromString(`\r\n${localize('terminal.outputTruncated', '[terminal output truncated]')}\r\n`).buffer, trackCommit: false });
		}));
		lifetime.add(manager.onPtyReconnect(() => {
			this.handleProcessData({ data: VSBuffer.fromString(`\r\n${localize('terminal.reconnected', '[terminal reconnected]')}\r\n`).buffer, trackCommit: false });
			this.setState("running");
		}));
		lifetime.add(manager.onProcessExit(code => this.handleProcessExit(code)));
	}

	private async poll(generation: number, initialState: "running" | "reconnecting" = "running"): Promise<void> {
		try {
			await this.shellProcessManager!.start(initialState === "reconnecting");
		} catch (error) {
			if (!isCancellationError(error) && !this.closed && generation === this.pollGeneration) {
				if (this._state === "reconnecting") {
					this.handleProcessData({ data: VSBuffer.fromString(`\r\n${localize('terminal.recoveryFailed', '[terminal recovery failed; relaunch required]')}\r\n`).buffer, trackCommit: false });
				}
				this.setState("error");
			}
		}
	}

	private setState(state: TerminalInstanceState): void {
		if (this._state === state || this.closed) return;
		this._state = state;
		if (state === 'error') {
			this.shellProcessManager?.stop();
			this.writeScreenData(VSBuffer.fromString(`\r\n${localize('terminal.operationFailed', '[terminal operation failed]')}\r\n`).buffer);
		}
		this._onDidChangeState.fire(state);
	}
}

function processWorkspaceFolder(dirId: string | undefined): { readonly dirId?: string; } {
	return dirId === undefined ? {} : { dirId };
}

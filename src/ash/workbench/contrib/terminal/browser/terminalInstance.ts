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
	type TerminalProcessConnectionPersistence,
	type TerminalProcessConnectionState,
} from '../../../../platform/terminal/common/terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalCommandStatusEvent, ITerminalContribution, ITerminalDimensions, ITerminalInstance, ITerminalProfile, TerminalInstanceState } from './terminal.js';
import { TerminalExtensionsRegistry } from './terminalExtensions.js';
import { TerminalProcessManager } from './terminalProcessManager.js';
import { XtermTerminal } from './xterm/xtermTerminal.js';

export interface CustomTerminalProcessOptions {
	readonly create: NonNullable<IShellLaunchConfig['customPtyImplementation']>;
	readonly instanceNumber: number;
	dimensions: ITerminalDimensions;
	readonly onTitleChanged: () => void;
}

export class TerminalInstance extends Disposable implements ITerminalInstance {
	private readonly pendingOutput: IProcessDataEvent[] = [];
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
		readonly dirId: string,
		private readonly processWorkspaceFolderId: string | undefined,
		serverTerminalId: string,
		private processReady: ITerminalProcessReady,
		title: string,
		profile: ITerminalProfile,
		private readonly connectionPersistence: TerminalProcessConnectionPersistence,
		readonly customTitle: string | undefined,
		private readonly getConnectionState: () => TerminalProcessConnectionState,
		onClosed: () => void,
		private readonly custom: CustomTerminalProcessOptions | undefined,
		@ITerminalProcessService private readonly processService: ITerminalProcessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.serverTerminalId = serverTerminalId;
		this._profile = profile;
		this._title = title;
		this.onClosed = onClosed;
		// Creation listeners may send input before output polling starts. The ready
		// process already exists, so its input owner must exist before publication too.
		if (!custom) this.createShellProcessManager();
	}

	protected override disposeCore(): void {
		void this.close();
		this.pendingOutput.length = 0;
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
		return this.custom !== undefined;
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
		lifetime.add(process.onProcessExit(code => {
			this._exitCode = code;
			this.setState('exited');
			if (this._onDidExit.hasListeners()) {
				this._onDidExit.fire(code);
			} else {
				this.pendingExit = { code };
			}
		}));
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
		for (const { id, ctor } of TerminalExtensionsRegistry.getTerminalContributions()) {
			this.contributions.set(id, this.instantiationService.createInstance(ctor, { instance: this }));
		}
		this.screenInitialization = screen.initialize().then(() => {
			if (this.isDisposed || screen.isDisposed) { return undefined; }
			// Raw keys and terminal replies must bypass sendText's Enter normalization.
			const input = screen.raw.onData(data => {
				if (!this.isReadOnly && !this.closed && this._state === 'running') {
					void this.shellProcessManager!.write(data).catch(onUnexpectedError);
				}
			});
			this._register(toDisposable(() => input.dispose()));
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
		if (this.custom) {
			this.custom.dimensions = dimensions;
			return;
		}
		if (!this.closed && this._state === 'running') {
			void this.shellProcessManager?.setDimensions(dimensions.cols, dimensions.rows).catch(onUnexpectedError);
		}
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
		if (this.isReadOnly) {
			return;
		}
		if (this.closed || this._state === "exited" || this._state === "disconnected") return;
		this.pollGeneration += 1;
		this.shellProcessManager?.stop();
		if (this.connectionPersistence === "reconnectable") {
			if (this._state !== "reconnecting") {
				this.setState("reconnecting");
				this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal reconnecting]\r\n").buffer, trackCommit: false });
			}
			return;
		}
		this.setState("disconnected");
		this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal connection lost; process was not preserved]\r\n").buffer, trackCommit: false });
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

	private async performRelaunch(dimensions: ITerminalDimensions): Promise<void> {
		await this.closeProcess().catch(() => { });
		if (this.closed) {
			throw new CancellationError();
		}
		try {
			if (this.custom) {
				this.customLifetime.clear();
				this.customProcess = undefined;
				this.processCloseTask = undefined;
				this._exitCode = undefined;
				this.custom.dimensions = dimensions;
				this.createCustomProcess(this.custom);
				this.setState('running');
				this.start();
				return;
			}
			const created = await this.processService.create({
				...processWorkspaceFolder(this.processWorkspaceFolderId),
				rows: dimensions.rows,
				cols: dimensions.cols,
				profile: {
					type: "profile",
					profileId: this._profile.profileId,
				},
			});
			if (this.closed) {
				await this.processService.close({ ...processWorkspaceFolder(this.processWorkspaceFolderId), terminalId: created.terminalId });
				throw new CancellationError();
			}
			this.serverTerminalId = created.terminalId;
			this.processReady = created.ready;
			this.processCloseTask = undefined;
			this._profile = created.profile;
			this.shellLifetime.clear();
			this.createShellProcessManager();
			this._exitCode = undefined;
			this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal relaunched]\r\n").buffer, trackCommit: false });
			this.setState("running");
			this.start();
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
		lifetime.add(manager.onProcessData(event => this._onDidWriteData.fire(event)));
		lifetime.add(manager.onDidChangeCommandStatus(event => this._onDidChangeCommandStatus.fire(event)));
		lifetime.add(manager.onOutputGap(() => {
			this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal output truncated]\r\n").buffer, trackCommit: false });
		}));
		lifetime.add(manager.onPtyReconnect(() => {
			this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal reconnected]\r\n").buffer, trackCommit: false });
			this.setState("running");
		}));
		lifetime.add(manager.onProcessExit(code => {
			this._exitCode = code;
			this.setState("exited");
			this._onDidExit.fire(code);
		}));
	}

	private async poll(generation: number, initialState: "running" | "reconnecting" = "running"): Promise<void> {
		try {
			await this.shellProcessManager!.start(initialState === "reconnecting");
		} catch (error) {
			if (!isCancellationError(error) && !this.closed && generation === this.pollGeneration) {
				if (this._state === "reconnecting") {
					this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal recovery failed; relaunch required]\r\n").buffer, trackCommit: false });
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
		}
		this._onDidChangeState.fire(state);
	}
}

function processWorkspaceFolder(dirId: string | undefined): { readonly dirId?: string; } {
	return dirId === undefined ? {} : { dirId };
}

import { TerminalEscapeSequences } from './terminalEscapeSequences.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getTerminalUri } from './terminalUri.js';
import { URI } from '../../../../base/common/uri.js';
import type { ITerminalSerializedState } from '../../../services/terminal/common/terminal.js';
import { CancellationError, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import {
	TerminalLocation,
	ProcessPropertyType,
	type IProcessPropertyMap,
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
import type { AgentHostPty } from './agentHostPty.js';
import type { AgentHostTerminalService } from './agentHostTerminalService.js';
import { XtermTerminal } from './xterm/xtermTerminal.js';
import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { TerminalStatusList } from './terminalStatusList.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCapabilityStore, TerminalCapabilityStoreMultiplexer } from '../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { TerminalRecorder } from '../../../../platform/terminal/common/terminalRecorder.js';
import { NaiveCwdDetectionCapability } from '../../../../platform/terminal/common/capabilities/naiveCwdDetectionCapability.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalProcessService, GeneralShellType, PosixShellType } from '../../../../platform/terminal/common/terminal.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { escapeNonWindowsPath } from '../../../../platform/terminal/common/terminalEnvironment.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { containsDragType, DataTransfers } from '../../../../base/browser/dnd.js';
import { UriList } from '../../../../base/common/dataTransfer.js';
import { getPathForFile, LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import { DraggedEditorIdentifier } from '../../../browser/parts/editor/editorTabDragAndDrop.js';

export interface CustomTerminalProcessOptions {
	readonly create: NonNullable<IShellLaunchConfig['customPtyImplementation']>;
	readonly instanceNumber: number;
	dimensions: ITerminalDimensions;
	readonly onTitleChanged: () => void;
}

export class TerminalInstance extends Disposable implements ITerminalInstance {
	private readonly processCapabilities = this._register(new TerminalCapabilityStore());
	readonly capabilities = this._register(new TerminalCapabilityStoreMultiplexer());
	readonly resource: URI;
	private hostTarget: TerminalLocation | undefined = TerminalLocation.Panel;
	private readonly targetChanged = this._register(new Emitter<TerminalLocation | undefined>());
	readonly onDidChangeTarget = this.targetChanged.event;
	get target(): TerminalLocation | undefined { return this.hostTarget; }
	set target(value: TerminalLocation | undefined) {
		if (this.hostTarget === value) return;
		this.hostTarget = value;
		this.targetChanged.fire(value);
		this.onTitleChanged();
	}
	readonly statusList = this._register(new TerminalStatusList());
	private readonly pendingOutput: IProcessDataEvent[] = [];
	private screenRecorder: TerminalRecorder | undefined;
	private readonly shellLifetime = this._register(new MutableDisposable<DisposableStore>());
	private shellProcessManager: AgentHostPty | undefined;
	private screen: XtermTerminal | undefined;
	private screenInitialization: Promise<XtermTerminal | undefined> | undefined;
	private readonly contributions = this._register(new DisposableMap<string, ITerminalContribution>());
	private pendingExit: { readonly code: number | undefined; } | undefined;
	private readonly customLifetime = this._register(new MutableDisposable<DisposableStore>());
	private customProcess: ITerminalChildProcess | undefined;
	private readonly onClosed: (() => void) | undefined;
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
	private frozen = false;
	private closeTask: Promise<void> | undefined;
	private processCloseTask: Promise<void> | undefined;
	private relaunchTask: Promise<void> | undefined;
	private _profile: ITerminalProfile;
	private customIcon: ThemeIcon | undefined;
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
		child: AgentHostPty | undefined,
		private processReady: ITerminalProcessReady,
		title: string,
		profile: ITerminalProfile,
		private connectionPersistence: TerminalProcessConnectionPersistence,
		private _customTitle: string | undefined,
		private readonly getConnectionState: () => TerminalProcessConnectionState,
		onClosed: () => void,
		private readonly onTitleChanged: () => void,
		private custom: CustomTerminalProcessOptions | undefined,
		private launch: Pick<ITerminalProcessCreateOptions, 'env' | 'strictEnv' | 'cwd' | 'execution' | 'profile'> | undefined,
		private initialText: IShellLaunchConfig['initialText'],
		private waitOnExit: IShellLaunchConfig['waitOnExit'],
		private dimensions: ITerminalDimensions,
		private readonly backend: AgentHostTerminalService,
		private restored: ITerminalSerializedState | undefined,
		private _revivalLaunch: ITerminalSerializedState['launch'] = undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPathService private readonly paths: IPathService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
	) {
		super();
		this.shellProcessManager = child;
		try {
			this._register(this.capabilities.add(this.processCapabilities));
			this.screenRecorder = this.createScreenRecorder();

			this._profile = profile;
			this._title = title;
			this.resource = restored ? URI.parse(restored.resource) : getTerminalUri(generateUuid(), instanceNumber, title);
			if (restored) {
				this.hostTarget = restored.target;
				child?.restoreState(restored);
			}
			this.writeInitialText();
			// Creation listeners may send input before output polling starts. The ready
			// process already exists, so its input owner must exist before publication too.
			if (!custom) this.createShellProcessManager();
			// Restored screens must exist even when the panel is hidden. Otherwise new
			// process output would enter the startup recorder ahead of the saved VT buffer.
			if (restored && typeof document !== 'undefined') this.attachToElement(document.createElement('div'));
			this.onClosed = onClosed;
		} catch (error) {
			// A screen/contribution constructor can fail after acquiring disposable
			// resources. Membership has not been published, so no close callback runs.
			this.dispose();
			throw error;
		}
	}

	protected override disposeCore(): void {
		void this.close();
		this.pendingOutput.length = 0;
		this.screenRecorder = undefined;
		this.pendingExit = undefined;
		// UI contributions must stop observing focus before removal of their screen's DOM.
		this.contributions.clearAndDisposeAll();
		// Completed Tasks retain instance metadata. Do not keep a disposed screen
		// or a readiness promise that resolved to its potentially large buffer.
		this.screen = undefined;
		this.screenInitialization = undefined;
		this.onClosed?.();
		super.disposeCore();
	}

	get revivalLaunch(): ITerminalSerializedState['launch'] { return this._revivalLaunch; }

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

	/** A fresh view of the immutable launch snapshot; split callers cannot mutate relaunch data. */
	public get shellLaunchConfig(): Readonly<IShellLaunchConfig> {
		const profile = this.launch?.profile;
		return Object.freeze({
			name: this.title,
			executable: profile?.type === 'custom' ? profile.path : undefined,
			args: profile?.type === 'custom' ? profile.args : undefined,
			env: this.launch?.env,
			strictEnv: this.launch?.strictEnv,
			cwd: this.launch?.cwd,
			icon: this.profile.icon,
			color: this.profile.color,
			customPtyImplementation: this.custom?.create,
		});
	}

	public get instanceId(): number { return this.instanceNumber; }

	public get cwd(): string | undefined { return this.shellProcessManager?.cwd; }
	public get shellIntegration() { return this.shellProcessManager?.shellIntegration; }
	public get shellType() { return this.processReady.shellType; }

	public get initialCwd(): string {
		return this.processReady.cwd;
	}

	get profile(): ITerminalProfile {
		return this.customIcon ? Object.freeze({ ...this._profile, icon: this.customIcon }) : this._profile;
	}

	get title(): string {
		return this._title;
	}

	public get customTitle(): string | undefined { return this._customTitle; }

	setTitle(title: string): void {
		this._title = title;
	}

	async rename(title?: string): Promise<void> {
		if (this.closed || this.isDisposed) return;
		this._customTitle = title || undefined;
		this.onTitleChanged();
	}

	async changeIcon(icon?: ThemeIcon): Promise<ThemeIcon | undefined> {
		if (this.closed || this.isDisposed) return undefined;
		this.customIcon = icon;
		this.onTitleChanged();
		return this.profile.icon;
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
		if (this.frozen && this.screen) {
			this.frozen = false;
			this.screen.raw.options.disableStdin = this.isReadOnly;
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
			if (this.closed || this.isDisposed) return;
			const event: IProcessDataEvent = typeof data === 'string' ? { data, trackCommit: false } : data;
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
		const editorDrag = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();
		const acceptsDrop = (event: DragEvent): boolean => !this.isReadOnly && this.state === 'running'
			&& (editorDrag.hasData(DraggedEditorIdentifier.prototype) || containsDragType(event, 'text/uri-list') || containsDragType(event, DataTransfers.FILES));
		this._register(addDisposableListener(screen.element, 'dragover', event => {
			if (!acceptsDrop(event)) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		}));
		this._register(addDisposableListener(screen.element, 'drop', event => {
			if (!acceptsDrop(event) || !event.dataTransfer) return;
			event.preventDefault();
			event.stopPropagation();
			// Read the transfer during the event. Browser File contents are never uploaded
			// or interpreted as a path on the execution host.
			const dragged = editorDrag.getData(DraggedEditorIdentifier.prototype)?.[0]?.input.resource;
			const uri = UriList.parse(event.dataTransfer.getData('text/uri-list'))[0];
			const file = event.dataTransfer.files[0];
			const localPath = file && getPathForFile(file);
			try {
				const resource = dragged ?? (uri ? URI.parse(uri, true) : localPath ? URI.file(localPath) : undefined);
				if (!resource) throw new Error(localize('terminal.path.dropUnavailable', 'This dropped file has no path on the terminal execution host.'));
				void this.sendPath(resource, false).then(() => screen.focus(), onUnexpectedError);
			} catch (error) { onUnexpectedError(error); }
		}));
		this._register(this.capabilities.add(screen.capabilities));
		const recorder = this.screenRecorder!;
		const replay = recorder.generateReplayEventSync();
		const truncated = recorder.isTruncated;
		this.screenRecorder = undefined;
		for (const { id, ctor } of TerminalExtensionsRegistry.getTerminalContributions()) {
			this.contributions.set(id, this.instantiationService.createInstance(ctor, { instance: this }));
		}
		const restored = this.restored;
		this.screenInitialization = screen.initialize(restored).then(async () => {
			if (this.isDisposed || screen.isDisposed) { return undefined; }
			if (truncated) screen.raw.write(`\r\n${localize('terminal.outputTruncated', '[terminal output truncated]')}\r\n`);
			for (const entry of restored ? [] : replay.events) {
				if (entry.cols > 0 && entry.rows > 0) screen.raw.resize(entry.cols, entry.rows);
				await new Promise<void>(resolve => screen.raw.write(entry.data, resolve));
				if (entry.shellIntegration) screen.handleShellIntegration(entry.shellIntegration);
				if (this.isDisposed || screen.isDisposed) return undefined;
			}
			if (!restored) screen.raw.resize(this.dimensions.cols, this.dimensions.rows);
			this.restored = undefined;
			// Raw keys and terminal replies must bypass sendText's Enter normalization.
			const input = screen.raw.onData(data => {
				if (!this.isReadOnly && !this.closed && this._state === 'running') {
					void this.sendRawInput(data).catch(onUnexpectedError);
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
			const contributionsReady = (): void => {
				for (const [, contribution] of this.contributions) { contribution.xtermReady?.(screen); }
			};
			// Recovery needs the parsed buffer before its view is revealed. Features
			// that bind the textarea become ready only after the renderer opens there.
			if (screen.raw.element) contributionsReady();
			else this._register(Event.once(screen.onDidOpen)(contributionsReady));
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
			if (!this.closed && !this.isDisposed && screen?.raw.modes.bracketedPasteMode) { text = `${TerminalEscapeSequences.BracketedPasteStart}${text}${TerminalEscapeSequences.BracketedPasteEnd}`; }
		}
		text = text.replace(/\r?\n/g, '\r');
		if (shouldExecute && !text.endsWith('\r')) { text += '\r'; }
		await this.sendRawInput(text);
	}

	public async sendPath(originalPath: string | URI, shouldExecute: boolean): Promise<void> {
		const process = this.shellProcessManager;
		const generation = this.pollGeneration;
		let retired = false;
		using stateListener = this.onDidChangeState(() => { retired = true; });
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === this.dirId);
		if (!process || !folder || this.isReadOnly || this.closed || this._state !== 'running') throw new CancellationError();
		const shell = this.processReady.shellType;
		if (shell !== PosixShellType.Bash && shell !== PosixShellType.Zsh && shell !== GeneralShellType.PowerShell
			|| shell !== GeneralShellType.PowerShell && this.processes.operatingSystem === OperatingSystem.Windows) {
			throw new Error(localize('terminal.path.unsupportedShell', 'This terminal does not have a supported, confirmed shell for sending paths.'));
		}
		let path: string | undefined;
		if (typeof originalPath === 'string') {
			path = originalPath;
		} else {
			if (originalPath.query || originalPath.fragment || originalPath.scheme !== folder.uri.scheme || getRemoteAuthority(originalPath) !== getRemoteAuthority(folder.uri)) {
				throw new Error(localize('terminal.path.wrongHost', 'The resource does not belong to this terminal execution host.'));
			}
			path = await this.paths.getHostPath(originalPath);
		}
		const rules = await this.paths.getPath(folder.uri);
		if (!path || !rules?.isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error(localize('terminal.path.invalid', 'Only absolute host paths without control characters can be sent to the terminal.'));
		// URI conversion can yield; never insert into a relaunched process or a replaced root.
		if (retired || this.shellProcessManager !== process || this.pollGeneration !== generation
			|| this.workspace.getWorkspace().folders.find(candidate => candidate.id === this.dirId)?.uri.toString() !== folder.uri.toString()) throw new CancellationError();
		const quoted = escapeNonWindowsPath(path, shell);
		await this.sendText(shell === GeneralShellType.PowerShell && shouldExecute ? `& ${quoted}` : quoted, shouldExecute);
	}

	private async sendRawInput(data: string): Promise<void> {
		const process: ITerminalChildProcess | undefined = this.customProcess ?? this.shellProcessManager;
		if (this.isReadOnly || this.closed || this._state !== 'running' || !process?.input) {
			throw new CancellationError();
		}
		await process.input(data);
	}

	public async sendSignal(signal: string): Promise<void> {
		const process: ITerminalChildProcess | undefined = this.customProcess ?? this.shellProcessManager;
		if (this.isReadOnly || this.closed || this._state !== 'running' || !process?.sendSignal) throw new CancellationError();
		await process.sendSignal(signal);
	}

	public processBinary(data: string): Promise<void> {
		const process: ITerminalChildProcess | undefined = this.customProcess ?? this.shellProcessManager;
		if (this.isReadOnly || this.closed || this._state !== 'running' || !process?.processBinary) {
			return Promise.reject(new CancellationError());
		}
		return process.processBinary(data);
	}

	resize(dimensions: ITerminalDimensions): void {
		this.dimensions = dimensions;
		this.screenRecorder?.handleResize(dimensions.cols, dimensions.rows);
		if (this.custom) {
			this.custom.dimensions = dimensions;
			if (!this.closed && this._state === 'running') {
				void Promise.resolve(this.customProcess?.resize?.(dimensions.cols, dimensions.rows)).catch(onUnexpectedError);
			}
			return;
		}
		if (!this.closed && this._state === 'running') {
			void this.shellProcessManager?.resize(dimensions.cols, dimensions.rows).catch(onUnexpectedError);
		}
	}

	public clearBuffer(): void {
		this.pendingOutput.length = 0;
		this.screenRecorder = this.screen ? undefined : this.createScreenRecorder();
		this.screen?.clearBuffer();
	}

	private writeScreenData(data: string): void {
		if (this.screen) {
			void this.screenInitialization?.then(screen => screen?.write(data)).catch(onUnexpectedError);
			return;
		}
		this.screenRecorder?.handleData(data);
	}

	private createScreenRecorder(): TerminalRecorder {
		return new TerminalRecorder(this.dimensions.cols, this.dimensions.rows, { maxBytes: 1024 * 1024, maxChunks: 4096 });
	}

	private writeInitialText(): void {
		if (this.initialText !== undefined) {
			const text = typeof this.initialText === 'string' ? `${this.initialText}\r\n` : this.initialText.text + (this.initialText.trailingNewLine ? '\r\n' : '');
			this.writeScreenData(text);
		}
	}

	private handleProcessData(event: IProcessDataEvent): void {
		if (this.closed || this.isDisposed) return;
		const screen = this.screen;
		const generation = this.pollGeneration;
		if (screen && event.trackCommit) {
			event.writePromise = new Promise((resolve, reject) => {
				void this.screenInitialization!.then(ready => {
					if (!ready || this.closed || this.isDisposed) throw new CancellationError();
					ready.write(event.data, () => {
						if (event.shellIntegration && generation === this.pollGeneration) ready.handleShellIntegration(event.shellIntegration);
						resolve();
					});
				}).catch(reject);
			});
		} else if (!screen) {
			this.screenRecorder?.handleData(event.data, event.shellIntegration);
		} else {
			this.writeScreenData(event.data);
		}
		if (event.data || !event.shellIntegration) this._onDidWriteData.fire(event);
	}

	private handleProcessExit(code: number | undefined): void {
		this._exitCode = code;
		this.setState('exited');
		const message = code === undefined
			? localize('terminal.processExitedUnknown', '[process exited with unknown code]')
			: localize('terminal.processExited', '[process exited with code {0}]', code);
		this.writeScreenData(`\r\n${message}\r\n`);
		try {
			const waitMessage = typeof this.waitOnExit === 'function' && code !== undefined ? this.waitOnExit(code) : typeof this.waitOnExit === 'string' ? this.waitOnExit : undefined;
			if (waitMessage) this.writeScreenData(`${waitMessage}\r\n`);
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
		// Release can wait on the old PTY. Capture caller-owned launch data before
		// yielding so later task preparation cannot change this replacement.
		const replacement = {
			...shell,
			executable: typeof shell.executable === 'string' ? shell.executable : shell.executable && Object.freeze([...shell.executable]),
			args: shell.args && (typeof shell.args === 'string' ? shell.args : Object.freeze([...shell.args])),
			env: shell.env && Object.freeze({ ...shell.env }),
			execution: shell.execution?.type === 'process' ? Object.freeze({ ...shell.execution, args: (typeof shell.execution.args === 'string' ? shell.execution.args : Object.freeze([...shell.execution.args])) }) : shell.execution,
		};
		this.relaunchTask = this.performRelaunch(this.dimensions, replacement).finally(() => { this.relaunchTask = undefined; });
		return this.relaunchTask;
	}

	async serializeState(): Promise<ITerminalSerializedState> {
		const child = this.shellProcessManager;
		if (!child || this.closed || this.relaunchTask || this.connectionPersistence !== 'reconnectable') throw new Error(localize('terminal.reload.unsupported', 'This terminal cannot preserve its process across a window reload.'));
		const checkpoint = await child.serializeState();
		if (!this.screen && typeof document !== 'undefined') this.attachToElement(document.createElement('div'));
		const screen = await this.xtermReadyPromise;
		if (!screen) throw new Error(localize('terminal.reload.screenUnavailable', 'The terminal screen is unavailable for recovery.'));
		this.frozen = true;
		screen.raw.options.disableStdin = true;
		const vt = await screen.getRangeAsVT();
		const cwd = child.cwd ?? await child.getCwd().catch(() => this.initialCwd);
		if (this.closed) throw new CancellationError();
		return {
			instanceId: this.instanceId, resource: this.resource.toString(), dirId: this.dirId, processDirId: this.processWorkspaceFolderId,
			process: child.creation, title: this.title, customTitle: this.customTitle, target: this.target ?? TerminalLocation.Panel,
			cols: screen.raw.cols, rows: screen.raw.rows, ...checkpoint, vt, cwd,
			launch: this.launch?.execution ? undefined : this._revivalLaunch,
		};
	}

	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		if (property === ProcessPropertyType.Title) return this.title as IProcessPropertyMap[T];
		if (this._state === 'exited' || this.closed) return false as IProcessPropertyMap[T];
		return this.shellProcessManager ? this.shellProcessManager.refreshProperty(property) : true as IProcessPropertyMap[T];
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
		return this.processCloseTask ??= this.shellProcessManager!.close();
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
				this.handleProcessData({ data: `\r\n${localize('terminal.reconnecting', '[terminal reconnecting]')}\r\n`, trackCommit: false });
			}
			return;
		}
		this.setState("disconnected");
		this.handleProcessData({ data: `\r\n${localize('terminal.connectionLost', '[terminal connection lost; process was not preserved]')}\r\n`, trackCommit: false });
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
				// Reuse supplies resolved execution data, without an admitted revival intent.
				this._revivalLaunch = undefined;
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
					profile: replacement.executable ? Object.freeze({
						type: 'custom' as const, name: replacement.name ?? this._profile.title,
						path: Object.freeze(typeof replacement.executable === 'string' ? [replacement.executable] : [...replacement.executable]),
						args: typeof replacement.args === 'string' ? replacement.args : Object.freeze([...(replacement.args ?? [])]),
					}) : { type: 'default' as const },
					...(replacement.env === undefined ? {} : { env: Object.freeze({ ...replacement.env }) }),
					...(replacement.strictEnv === undefined ? {} : { strictEnv: replacement.strictEnv }),
					...(replacement.cwd === undefined ? {} : { cwd: replacement.cwd }),
					...(replacement.execution === undefined ? {} : { execution: replacement.execution.type === 'process' ? Object.freeze({ ...replacement.execution, args: (typeof replacement.execution.args === 'string' ? replacement.execution.args : Object.freeze([...replacement.execution.args])) }) : Object.freeze({ ...replacement.execution }) }),
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
			const child = await this.backend.createProcess({
				...processWorkspaceFolder(this.processWorkspaceFolderId),
				...this.launch,
				rows: dimensions.rows,
				cols: dimensions.cols,
				profile: this.launch?.profile ?? { type: 'profile', profileId: this._profile.profileId },
			}, this.instanceNumber);
			const created = child.creation;
			if (this.closed) {
				await child.close();
				throw new CancellationError();
			}

			this.processReady = created.ready;
			this.connectionPersistence = created.connectionPersistence;
			this.processCloseTask = undefined;
			this._profile = { ...created.profile, icon: replacement?.icon ?? this._profile.icon, color: replacement?.color ?? this._profile.color };
			this.shellLifetime.clear();
			this.shellProcessManager = child;
			this.createShellProcessManager();
			this._exitCode = undefined;
			if (!replacement) this.handleProcessData({ data: `\r\n${localize('terminal.relaunched', '[terminal relaunched]')}\r\n`, trackCommit: false });
			this.setState("running");
			if (!replacement?.deferStart) this.start();
		} catch (error) {
			this.setState("error");
			throw error;
		}
	}

	private createShellProcessManager(): void {
		this.statusList.remove('process-error');
		const lifetime = new DisposableStore();
		this.shellLifetime.value = lifetime;
		const manager = this.shellProcessManager!;
		const cwdQuery = lifetime.add(new NaiveCwdDetectionCapability(manager));
		this.processCapabilities.add(TerminalCapability.NaiveCwdDetection, cwdQuery);
		lifetime.add(toDisposable(() => {
			if (this.processCapabilities.get(TerminalCapability.NaiveCwdDetection) === cwdQuery) this.processCapabilities.remove(TerminalCapability.NaiveCwdDetection);
		}));
		// The backend owns the child. This instance holds a release lease, not a second disposable owner.
		lifetime.add(toDisposable(() => { void manager.close().catch(() => { }); }));
		lifetime.add(manager.onProcessReady(ready => { this.processReady = ready; }));
		lifetime.add(manager.onProcessError(error => {
			this.statusList.add({
				id: 'process-error', severity: Severity.Error,
				tooltip: localize('terminal.status.processError', 'Terminal process failed: {0}', error instanceof Error ? error.message : String(error)),
			});
			this.setState('error');
		}));
		lifetime.add(manager.onProcessData(event => this.handleProcessData(event)));
		lifetime.add(manager.onDidChangeCommandStatus(event => this._onDidChangeCommandStatus.fire(event)));
		lifetime.add(manager.onDidChangeMetadata(() => this.refreshCapabilities()));
		lifetime.add(manager.onOutputGap(() => {
			this.handleProcessData({ data: `\r\n${localize('terminal.outputTruncated', '[terminal output truncated]')}\r\n`, trackCommit: false });
		}));
		lifetime.add(manager.onPtyReconnect(() => {
			this.handleProcessData({ data: `\r\n${localize('terminal.reconnected', '[terminal reconnected]')}\r\n`, trackCommit: false });
			this.setState("running");
		}));
		lifetime.add(manager.onProcessExit(code => this.handleProcessExit(code)));
		this.refreshCapabilities();
	}

	private refreshCapabilities(): void {
		const integration = this.shellIntegration;
		for (const id of this.processCapabilities.items) {
			if (id === TerminalCapability.CwdDetection && !integration?.cwdDetection) {
				this.processCapabilities.remove(id);
			}
		}
		const prompt = this.shellProcessManager?.promptTypeDetection;
		if (integration?.promptType !== undefined && prompt && this.capabilities.get(TerminalCapability.PromptTypeDetection) !== prompt) {
			this.processCapabilities.add(TerminalCapability.PromptTypeDetection, prompt);
		} else if (integration?.promptType === undefined) {
			this.processCapabilities.remove(TerminalCapability.PromptTypeDetection);
		}
		const cwd = this.shellProcessManager?.cwdDetection;
		if (integration?.cwdDetection && cwd && this.capabilities.get(TerminalCapability.CwdDetection) !== cwd) {
			this.processCapabilities.add(TerminalCapability.CwdDetection, cwd);
		}

	}

	private async poll(generation: number, initialState: "running" | "reconnecting" = "running"): Promise<void> {
		try {
			await this.shellProcessManager!.start(initialState === "reconnecting");
		} catch (error) {
			if (!isCancellationError(error) && !this.closed && generation === this.pollGeneration) {
				if (this._state === "reconnecting") {
					this.handleProcessData({ data: `\r\n${localize('terminal.recoveryFailed', '[terminal recovery failed; relaunch required]')}\r\n`, trackCommit: false });
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
			this.writeScreenData(`\r\n${localize('terminal.operationFailed', '[terminal operation failed]')}\r\n`);
		}
		this._onDidChangeState.fire(state);
	}
}

function processWorkspaceFolder(dirId: string | undefined): { readonly dirId?: string; } {
	return dirId === undefined ? {} : { dirId };
}

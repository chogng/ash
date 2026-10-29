import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { getTerminalAutoReplyRules } from '../common/terminalConfiguration.js';
import { MergedEnvironmentVariableCollection } from '../../../../platform/terminal/common/environmentVariableCollection.js';
import { serializeEnvironmentVariableCollections } from '../../../../platform/terminal/common/environmentVariableShared.js';
import type { ITerminalAutoReply } from '../../../../platform/terminal/common/terminal.js';
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
	type TerminalShellIntegrationEvent,
} from '../../../../platform/terminal/common/terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ITerminalCommandStatusEvent, ITerminalContribution, ITerminalDimensions, ITerminalInstance, ITerminalProfile, TerminalInstanceState } from './terminal.js';
import { TerminalExtensionsRegistry } from './terminalExtensions.js';
import type { AgentHostPty } from './agentHostPty.js';
import type { AgentHostTerminalService } from './agentHostTerminalService.js';
import { XtermTerminal } from './xterm/xtermTerminal.js';
import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { TerminalStatus, TerminalStatusList } from './terminalStatusList.js';
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
import { TerminalContextKeys } from '../common/terminalContextKey.js';

export interface CustomTerminalProcessOptions {
	readonly create: NonNullable<IShellLaunchConfig['customPtyImplementation']>;
	readonly instanceNumber: number;
	dimensions: ITerminalDimensions;
	readonly onTitleChanged: () => void;
}

export class TerminalInstance extends Disposable implements ITerminalInstance {
	private environmentVariableCollection: MergedEnvironmentVariableCollection | undefined;
	private readonly processCapabilities = this._register(new TerminalCapabilityStore());
	readonly capabilities = this._register(new TerminalCapabilityStoreMultiplexer());
	readonly resource: URI;
	private hostTarget: TerminalLocation | undefined = TerminalLocation.Panel;
	private readonly targetChanged = this._register(new Emitter<TerminalLocation | undefined>());
	readonly onDidChangeTarget = this.targetChanged.event;
	get target(): TerminalLocation | undefined {
		return this.hostTarget;
	}
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
	private readonly startupReset = this._register(new MutableDisposable<DisposableStore>());
	private readonly contributions = this._register(new DisposableMap<string, ITerminalContribution>());
	private pendingExit: { readonly code: number | undefined } | undefined;
	private readonly customLifetime = this._register(new MutableDisposable<DisposableStore>());
	private customProcess: ITerminalChildProcess | undefined;
	private readonly onClosed: (() => void) | undefined;
	private readonly _onDidWriteData = this._register(
		new Emitter<IProcessDataEvent>({
			onDidAddFirstListener: () =>
				queueMicrotask(() => {
					while (!this.isDisposed && this._onDidWriteData.hasListeners() && this.pendingOutput.length > 0) {
						this._onDidWriteData.fire(this.pendingOutput.shift()!);
					}
				}),
		}),
	);
	private readonly _onDidChangeCommandStatus = this._register(new Emitter<ITerminalCommandStatusEvent>());
	private readonly _onDidExit = this._register(
		new Emitter<number | undefined>({
			onDidAddFirstListener: () =>
				queueMicrotask(() => {
					if (!this.isDisposed && this._onDidExit.hasListeners() && this.pendingExit) {
						const { code } = this.pendingExit;
						this.pendingExit = undefined;
						this._onDidExit.fire(code);
					}
				}),
		}),
	);
	private readonly _onDidChangeState = this._register(new Emitter<TerminalInstanceState>());
	private _state: TerminalInstanceState = 'running';
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
		private launch:
			| (Pick<ITerminalProcessCreateOptions, 'env' | 'strictEnv' | 'cwd' | 'execution' | 'profile'> &
					Pick<IShellLaunchConfig, 'type' | 'executable' | 'args' | 'environmentVariableCollections' | 'environmentVariableCollectionsPersistable'>)
			| undefined,
		private initialText: IShellLaunchConfig['initialText'],
		private waitOnExit: IShellLaunchConfig['waitOnExit'],
		private dimensions: ITerminalDimensions,
		private readonly backend: AgentHostTerminalService,
		private restored: ITerminalSerializedState | undefined,
		private _revivalLaunch: ITerminalSerializedState['launch'] = undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPathService private readonly paths: IPathService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super();
		if (launch) {
			const { environmentVariableCollections, environmentVariableCollectionsPersistable, ...processLaunch } = launch;
			this.launch = processLaunch;
			this.captureEnvironmentVariableCollections(
				environmentVariableCollections ?? restored?.environmentVariableCollections,
				environmentVariableCollectionsPersistable ?? restored?.environmentVariableCollections !== undefined,
			);
		}
		this.shellProcessManager = child;
		try {
			this._register(this.capabilities.add(this.processCapabilities));
			this.screenRecorder = this.createScreenRecorder();

			this._profile = profile;
			this._title = title;
			this.resource = restored ? URI.parse(restored.resource) : getTerminalUri(generateUuid(), instanceNumber, title);
			if (restored) {
				// Keep the PTY at its saved grid while singleton panes are regrouped.
				// Intermediate resizes would queue repaints for a grid we no longer show.
				this.frozen = true;
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

	get revivalLaunch(): ITerminalSerializedState['launch'] {
		return this._revivalLaunch;
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

	get extEnvironmentVariableCollection(): MergedEnvironmentVariableCollection | undefined {
		return this.environmentVariableCollection;
	}

	private environmentVariableCollectionsPersistable = false;

	private captureEnvironmentVariableCollections(value: IShellLaunchConfig['environmentVariableCollections'], persistable = false): void {
		this.environmentVariableCollectionsPersistable = value?.length === 0 || persistable;
		this.environmentVariableCollection =
			value &&
			new MergedEnvironmentVariableCollection(
				new Map(
					value.map(([extension, map, descriptions]) => [
						extension,
						{
							map: new Map(map),
							descriptionMap: new Map(descriptions ?? []),
						},
					]),
				),
				this.processes.operatingSystem !== OperatingSystem.Windows,
			);
	}

	/** A fresh view of the immutable launch snapshot; split callers cannot mutate relaunch data. */
	public get shellLaunchConfig(): Readonly<IShellLaunchConfig> {
		const profile = this.launch?.profile;
		return Object.freeze({
			name: this.title,
			environmentVariableCollections: this.environmentVariableCollection && serializeEnvironmentVariableCollections(this.environmentVariableCollection.collections),
			environmentVariableCollectionsPersistable: this.environmentVariableCollectionsPersistable,
			executable: this.processReady.launch?.executable ?? this.launch?.executable ?? (profile?.type === 'custom' ? profile.path : undefined),
			args: this.launch?.args ?? (profile?.type === 'custom' ? profile.args : undefined),
			env: this.launch?.env,
			strictEnv: this.launch?.strictEnv,
			cwd: this.launch?.cwd,
			icon: this.profile.icon,
			color: this.profile.color,
			customPtyImplementation: this.custom?.create,
		});
	}

	public get instanceId(): number {
		return this.instanceNumber;
	}

	public get cwd(): string | undefined {
		return this.shellProcessManager?.cwd;
	}
	public get shellIntegration() {
		return this.shellProcessManager?.shellIntegration;
	}
	public get shellType() {
		return this.processReady.shellType;
	}
	/** Actual argv is display-only; split/relaunch must use the original profile arguments. */
	public get injectedArgs() {
		return this.processReady.launch?.args;
	}

	public get initialCwd(): string {
		return this.processReady.cwd;
	}

	get profile(): ITerminalProfile {
		return this.customIcon ? Object.freeze({ ...this._profile, icon: this.customIcon }) : this._profile;
	}

	get title(): string {
		return this._title;
	}

	public get customTitle(): string | undefined {
		return this._customTitle;
	}

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
		const resumeDimensions = this.frozen ? this.dimensions : undefined;
		if (this.frozen) {
			this.frozen = false;
			if (this.screen) this.screen.raw.options.disableStdin = this.isReadOnly;
		}
		if (this.customProcess) {
			const process = this.customProcess;
			void process.start().catch(error => {
				if (this.customProcess === process && !this.closed) {
					this.handleProcessError(error);
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
		void this.poll(generation, 'running', resumeDimensions);
	}

	private createCustomProcess(custom: CustomTerminalProcessOptions): void {
		const process = custom.create(custom.instanceNumber, custom.dimensions.cols, custom.dimensions.rows);
		this.customProcess = process;
		const lifetime = new DisposableStore();
		this.customLifetime.value = lifetime;
		lifetime.add(process);
		lifetime.add(
			process.onProcessData(data => {
				if (this.closed || this.isDisposed) return;
				const event: IProcessDataEvent = typeof data === 'string' ? { data, trackCommit: false } : data;
				this.writeScreenData(event.data);
				// The PTY can write inside open(), before the view owns its xterm widget.
				if (!this._onDidWriteData.hasListeners() || this.pendingOutput.length > 0) {
					this.pendingOutput.push(event);
				} else {
					this._onDidWriteData.fire(event);
				}
			}),
		);
		lifetime.add(
			process.onProcessReady(ready => {
				this.processReady = ready;
			}),
		);
		lifetime.add(
			process.onDidChangeProperty(property => {
				if (property.type === ProcessPropertyType.Title) {
					this._title = property.value;
					custom.onTitleChanged();
				}
			}),
		);
		lifetime.add(process.onProcessExit(code => this.handleProcessExit(code)));
	}

	public get xterm(): XtermTerminal | undefined {
		return this.screen;
	}
	public get xtermReadyPromise(): Promise<XtermTerminal | undefined> {
		return this.screenInitialization ?? Promise.resolve(undefined);
	}
	public getContribution<T extends ITerminalContribution>(id: string): T | null {
		return (this.contributions.get(id) as T | undefined) ?? null;
	}

	public attachToElement(container: HTMLElement): void {
		this.assertNotDisposed();
		if (this.screen) {
			container.append(this.screen.element);
			return;
		}
		const screen = this._register(this.instantiationService.createInstance(XtermTerminal, container, this));
		this.screen = screen;
		this._register(
			screen.onDidOpen(() => {
				// ConPTY repaints in viewport coordinates after a resize. Configure its
				// blank-row expansion and cursor-line reflow even without shell integration;
				// otherwise a wrapped prompt's repaint can overwrite retained output.
				const windowsPty = !this.custom && this.processes.operatingSystem === OperatingSystem.Windows;
				screen.raw.options.windowsPty = windowsPty ? { backend: 'conpty' } : undefined;
				screen.raw.options.reflowCursorLine = windowsPty;
			}),
		);
		// Establish the instance scope before any contribution creates a nested
		// scope. Keyboard routing must not depend on contribution registration order.
		const scope = this._register(this.contextKeys.createScoped(screen.element));
		const screenServices = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, scope])));
		const focused = TerminalContextKeys.focus.bindTo(scope);
		const alternate = TerminalContextKeys.altBufferActive.bindTo(scope);
		const editorDrag = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();
		const acceptsDrop = (event: DragEvent): boolean =>
			!this.isReadOnly &&
			this.state === 'running' &&
			(editorDrag.hasData(DraggedEditorIdentifier.prototype) || containsDragType(event, 'text/uri-list') || containsDragType(event, DataTransfers.FILES));
		this._register(
			addDisposableListener(screen.element, 'dragover', event => {
				if (!acceptsDrop(event)) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
			}),
		);
		this._register(
			addDisposableListener(screen.element, 'drop', event => {
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
				} catch (error) {
					onUnexpectedError(error);
				}
			}),
		);
		this._register(this.capabilities.add(screen.capabilities));
		this._register(screen.shellIntegration.onDidChangeSeenSequences(() => this.refreshCapabilities()));
		const promptInputListener = this._register(new MutableDisposable());
		this._register(
			this.capabilities.onDidAddCommandDetectionCapability(capability => {
				promptInputListener.value = capability.promptInputModel.onDidChangeInput(() => this.refreshCapabilities());
				this.refreshCapabilities();
			}),
		);
		this._register(
			this.capabilities.onDidRemoveCommandDetectionCapability(() => {
				promptInputListener.clear();
				this.refreshCapabilities();
			}),
		);
		const recorder = this.screenRecorder!;
		const replay = recorder.generateReplayEventSync();
		this.screenRecorder = undefined;
		for (const { id, ctor } of TerminalExtensionsRegistry.getTerminalContributions()) {
			this.contributions.set(id, screenServices.createInstance(ctor, { instance: this }));
		}
		const restored = this.restored;
		this.screenInitialization = screen.initialize(restored).then(async () => {
			if (this.isDisposed || screen.isDisposed) {
				return undefined;
			}
			if (restored && this.processes.operatingSystem === OperatingSystem.Windows && restored.process.terminalId !== this.shellProcessManager?.creation.terminalId) {
				// A new ConPTY owns viewport coordinates starting at row one. Move
				// the saved screen into scrollback before its first absolute repaint.
				screen.raw.write('\r\n'.repeat(screen.raw.rows));
				this.preserveRevivedHistory(screen);
			}
			for (const entry of restored ? [] : replay.events) {
				if (entry.cols > 0 && entry.rows > 0) screen.raw.resize(entry.cols, entry.rows);
				await new Promise<void>(resolve => screen.write(entry.data, resolve));
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
				this.startupReset.clear();
				// Workbench shortcuts remain available after exit. Parser replies use
				// onData, so they cannot accidentally close a waiting task terminal.
				// xterm prevents Enter's default before firing onKey. Workbench
				// commands stop propagation in the document's capture listener.
				if (this._state === 'exited' && this.waitOnExit && !domEvent.altKey && !domEvent.ctrlKey && !domEvent.metaKey) {
					void this.close().catch(onUnexpectedError);
				}
			});
			this._register(toDisposable(() => completedInput.dispose()));
			const binary = screen.raw.onBinary(data => {
				void this.processBinary(data).catch(onUnexpectedError);
			});
			this._register(toDisposable(() => binary.dispose()));
			const contributionsReady = (): void => {
				const textarea = screen.raw.textarea!;
				// Opening or restoring a screen may have already applied its focus request.
				focused.set(textarea === screen.element.ownerDocument.activeElement);
				this._register(addDisposableListener(screen.element, 'focusin', event => focused.set(event.target === textarea)));
				this._register(addDisposableListener(screen.element, 'focusout', event => focused.set(event.relatedTarget === textarea)));
				alternate.set(screen.raw.buffer.active.type === 'alternate');
				const bufferChanged = screen.raw.buffer.onBufferChange(buffer => alternate.set(buffer.type === 'alternate'));
				this._register(toDisposable(() => bufferChanged.dispose()));
				for (const [, contribution] of this.contributions) {
					contribution.xtermReady?.(screen);
				}
			};
			// Recovery needs the parsed buffer before its view is revealed. Features
			// that bind the textarea become ready only after the renderer opens there.
			if (screen.raw.element) contributionsReady();
			else this._register(Event.once(screen.onDidOpen)(contributionsReady));
			return screen;
		});
		// Loading can start in a background instance without a View awaiting it.
		void this.screenInitialization.catch(error => {
			if (!isCancellationError(error) && !this.closed) {
				this.handleProcessError(error);
			}
		});
	}

	public detachFromElement(): void {
		this.screen?.setVisible(false);
		this.screen?.element.remove();
	}

	public async sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void> {
		if (this.isReadOnly || this.closed || this._state !== 'running') {
			throw new CancellationError();
		}
		this.startupReset.clear();
		if (bracketedPasteMode && this.screen) {
			const screen = await this.xtermReadyPromise;
			if (!this.closed && !this.isDisposed && screen?.raw.modes.bracketedPasteMode) {
				text = `${TerminalEscapeSequences.BracketedPasteStart}${text}${TerminalEscapeSequences.BracketedPasteEnd}`;
			}
		}
		text = text.replace(/\r?\n/g, '\r');
		if (shouldExecute && !text.endsWith('\r')) {
			text += '\r';
		}
		await this.sendRawInput(text);
	}

	public async sendPath(originalPath: string | URI, shouldExecute: boolean): Promise<void> {
		const process = this.shellProcessManager;
		const generation = this.pollGeneration;
		let retired = false;
		using stateListener = this.onDidChangeState(() => {
			retired = true;
		});
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === this.dirId);
		if (!process || !folder || this.isReadOnly || this.closed || this._state !== 'running') throw new CancellationError();
		const shell = this.processReady.shellType;
		if (
			(shell !== PosixShellType.Bash && shell !== PosixShellType.Zsh && shell !== GeneralShellType.PowerShell) ||
			(shell !== GeneralShellType.PowerShell && this.processes.operatingSystem === OperatingSystem.Windows)
		) {
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
		if (!path || !rules?.isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))
			throw new Error(localize('terminal.path.invalid', 'Only absolute host paths without control characters can be sent to the terminal.'));
		// URI conversion can yield; never insert into a relaunched process or a replaced root.
		if (
			retired ||
			this.shellProcessManager !== process ||
			this.pollGeneration !== generation ||
			this.workspace
				.getWorkspace()
				.folders.find(candidate => candidate.id === this.dirId)
				?.uri.toString() !== folder.uri.toString()
		)
			throw new CancellationError();
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

	public async setAutoReplies(rules: readonly ITerminalAutoReply[]): Promise<void> {
		if (this.custom || this.closed || this._state !== 'running' || !this.shellProcessManager) return;
		await this.shellProcessManager.setAutoReplies(rules);
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
		if (!this.closed && !this.frozen && this._state === 'running') {
			void this.shellProcessManager?.resize(dimensions.cols, dimensions.rows).catch(onUnexpectedError);
		}
	}

	public clearBuffer(): void {
		this.startupReset.clear();
		this.pendingOutput.length = 0;
		this.screenRecorder = this.screen ? undefined : this.createScreenRecorder();
		this.screen?.clearBuffer();
	}

	private preserveRevivedHistory(screen: XtermTerminal): void {
		const handlers = new DisposableStore();
		this.startupReset.value = handlers;
		// ConPTY paints its new viewport after the shell's prompt boundaries.
		// Preserve only saved scrollback during that initial paint; cursor moves
		// and ordinary viewport erases must retain their normal console semantics.
		const erase = screen.raw.parser.registerCsiHandler({ final: 'J' }, parameters => {
			return parameters[0] === 3;
		});
		handlers.add(toDisposable(() => erase.dispose()));
		const cursor = screen.raw.parser.registerCsiHandler({ prefix: '?', final: 'h' }, parameters => {
			if (parameters.includes(25)) this.startupReset.clear();
			return false;
		});
		handlers.add(toDisposable(() => cursor.dispose()));
	}

	private writeScreenData(data: string, shellIntegration?: TerminalShellIntegrationEvent): void {
		if (this.screen) {
			void this.screenInitialization
				?.then(screen => {
					if (!screen) return;
					screen.write(data, () => {
						if (shellIntegration && !screen.isDisposed) screen.handleShellIntegration(shellIntegration);
					});
				})
				.catch(onUnexpectedError);
			return;
		}
		this.screenRecorder?.handleData(data, shellIntegration);
	}

	private createScreenRecorder(): TerminalRecorder {
		return new TerminalRecorder(this.dimensions.cols, this.dimensions.rows, {
			maxBytes: 1024 * 1024,
			maxChunks: 4096,
		});
	}

	private writeInitialText(): void {
		let text = this.initialText === undefined ? '' : typeof this.initialText === 'string' ? `${this.initialText}\r\n` : this.initialText.text + (this.initialText.trailingNewLine ? '\r\n' : '');
		if (this.launch?.type === 'Task') {
			// These are screen boundaries for the launched task, never bytes parsed
			// from its output or entries in the backend's Shell command history.
			this.writeScreenData('', {
				type: 'processReady',
				isWindowsPty: !this.custom && this.processes.operatingSystem === OperatingSystem.Windows,
			});
			if (text.startsWith('\r\n')) {
				this.writeScreenData('\r\n');
				text = text.slice(2);
			}
			this.writeScreenData('', { type: 'commandStart' });
			this.writeScreenData(text);
			this.writeScreenData('', {
				type: 'commandExecuted',
				commandId: generateUuid(),
				command: undefined,
				isTrusted: false,
				cwd: this.launch.cwd,
				timestampMillis: Date.now(),
			});
		} else if (text) {
			this.writeScreenData(text);
		}
	}

	private handleProcessData(event: IProcessDataEvent): void {
		if (this.closed || this.isDisposed) return;
		const screen = this.screen;
		const generation = this.pollGeneration;
		// Task presentation already begins before its echo. A native readiness
		// frame must not reset that marker after the command has been displayed.
		const shellIntegration = this.launch?.type === 'Task' && event.shellIntegration?.type === 'processReady' ? undefined : event.shellIntegration;
		if (screen && event.trackCommit) {
			event.writePromise = new Promise((resolve, reject) => {
				void this.screenInitialization!.then(ready => {
					if (!ready || this.closed || this.isDisposed) throw new CancellationError();
					ready.write(event.data, () => {
						if (shellIntegration && generation === this.pollGeneration) ready.handleShellIntegration(shellIntegration);
						resolve();
					});
				}).catch(reject);
			});
		} else if (!screen) {
			this.screenRecorder?.handleData(event.data, shellIntegration);
		} else {
			this.writeScreenData(event.data);
		}
		if (event.data || !event.shellIntegration) this._onDidWriteData.fire(event);
	}

	private handleProcessExit(code: number | undefined): void {
		if (this.launch?.type === 'Task') {
			this.writeScreenData('', { type: 'commandFinished', exitCode: code, durationMillis: undefined });
		}
		this._exitCode = code;
		this.setState('exited');
		if (code !== undefined && code !== 0) {
			const message = localize('terminated.exitCodeOnly', 'The terminal process terminated with exit code: {0}.', code);
			this.writeScreenData(`\r\n${message}\r\n`);
		}
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
			execution:
				shell.execution?.type === 'process'
					? Object.freeze({
							...shell.execution,
							args: typeof shell.execution.args === 'string' ? shell.execution.args : Object.freeze([...shell.execution.args]),
						})
					: shell.execution,
		};
		this.relaunchTask = this.performRelaunch(this.dimensions, replacement).finally(() => {
			this.relaunchTask = undefined;
		});
		return this.relaunchTask;
	}

	async serializeState(): Promise<ITerminalSerializedState> {
		const child = this.shellProcessManager;
		if (!child || this.closed || this.relaunchTask || this.connectionPersistence !== 'reconnectable')
			throw new Error(localize('terminal.reload.unsupported', 'This terminal cannot preserve its process across a window reload.'));
		const checkpoint = await child.serializeState();
		if (!this.screen && typeof document !== 'undefined') this.attachToElement(document.createElement('div'));
		const screen = await this.xtermReadyPromise;
		if (!screen) throw new Error(localize('terminal.reload.screenUnavailable', 'The terminal screen is unavailable for recovery.'));
		this.frozen = true;
		screen.raw.options.disableStdin = true;
		const vt = await screen.getRangeAsVT();
		const cwd = child.cwd ?? (await child.getCwd().catch(() => this.initialCwd));
		if (this.closed) throw new CancellationError();
		return {
			instanceId: this.instanceId,
			resource: this.resource.toString(),
			dirId: this.dirId,
			processDirId: this.processWorkspaceFolderId,
			environmentVariableCollections:
				this.environmentVariableCollectionsPersistable && this.environmentVariableCollection
					? serializeEnvironmentVariableCollections(this.environmentVariableCollection.collections)
					: undefined,
			process: child.creation,
			title: this.title,
			customTitle: this.customTitle,
			target: this.target ?? TerminalLocation.Panel,
			cols: screen.raw.cols,
			rows: screen.raw.rows,
			...checkpoint,
			vt,
			cwd,
			launch: this.launch?.execution ? undefined : this._revivalLaunch,
		};
	}

	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		if (property === ProcessPropertyType.Title) return this.title as IProcessPropertyMap[T];
		if (this._state === 'exited' || this.closed) return false as IProcessPropertyMap[T];
		return this.shellProcessManager ? this.shellProcessManager.refreshProperty(property) : (true as IProcessPropertyMap[T]);
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
		void this.closeTask.catch(() => {});
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
			return (this.processCloseTask ??= Promise.resolve().then(() => process?.shutdown(true)));
		}
		return (this.processCloseTask ??= this.shellProcessManager!.close());
	}

	loseConnection(): void {
		if (this.custom) {
			return;
		}
		// Errors require an explicit relaunch. Later host transitions must not
		// resume failed operations or repeatedly append recovery failures.
		if (this.closed || this._state === 'exited' || this._state === 'disconnected' || this._state === 'error') return;
		this.pollGeneration += 1;
		this.shellProcessManager?.stop();
		if (this.connectionPersistence === 'reconnectable') {
			this.setState('reconnecting');
			return;
		}
		this.setState('disconnected');
	}

	restoreConnection(): void {
		if (this.closed || this._state !== 'reconnecting') return;
		const generation = ++this.pollGeneration;
		void this.poll(generation, 'reconnecting');
	}

	public relaunch(dimensions: ITerminalDimensions, replacement?: IShellLaunchConfig): Promise<void> {
		if (this.relaunchTask) {
			return this.relaunchTask;
		}
		if (this.closed || this._state === 'reconnecting') {
			return Promise.resolve();
		}
		this.relaunchTask = this.performRelaunch(dimensions, replacement, this._revivalLaunch).finally(() => {
			this.relaunchTask = undefined;
		});
		return this.relaunchTask;
	}

	private async performRelaunch(dimensions: ITerminalDimensions, replacement?: IShellLaunchConfig, revivalLaunch?: ITerminalSerializedState['launch']): Promise<void> {
		this.dimensions = dimensions;
		this.pollGeneration++;
		this.shellProcessManager?.stop();
		if (this._state === 'running') this.setState('disconnected');
		if (replacement) {
			// Old reads must stop before release yields; the retained screen belongs to the new process next.
			try {
				await this.closeProcess();
			} catch (error) {
				this.handleProcessError(error);
				throw error;
			}
		} else {
			await this.closeProcess().catch(() => {});
		}
		if (this.closed) {
			throw new CancellationError();
		}
		try {
			if (replacement) {
				this.captureEnvironmentVariableCollections(replacement.environmentVariableCollections, replacement.environmentVariableCollectionsPersistable);
				// Explicit reuse has no raw intent; relaunch retains its original intent.
				this._revivalLaunch = revivalLaunch;
				this.shellLifetime.clear();
				this.customLifetime.clear();
				this.shellProcessManager = undefined;
				this.customProcess = undefined;
				this.pendingExit = undefined;
				this.custom = replacement.customPtyImplementation
					? {
							create: replacement.customPtyImplementation,
							instanceNumber: this.instanceNumber,
							dimensions,
							onTitleChanged: this.onTitleChanged,
						}
					: undefined;
				this.launch = Object.freeze({
					type: replacement.type,
					profile: replacement.executable
						? Object.freeze({
								type: 'custom' as const,
								name: replacement.name ?? this._profile.title,
								path: Object.freeze(typeof replacement.executable === 'string' ? [replacement.executable] : [...replacement.executable]),
								args: typeof replacement.args === 'string' ? replacement.args : Object.freeze([...(replacement.args ?? [])]),
							})
						: { type: 'default' as const },
					...(replacement.env === undefined ? {} : { env: Object.freeze({ ...replacement.env }) }),
					...(replacement.strictEnv === undefined ? {} : { strictEnv: replacement.strictEnv }),
					...(replacement.cwd === undefined ? {} : { cwd: replacement.cwd }),
					...(replacement.execution === undefined
						? {}
						: {
								execution:
									replacement.execution.type === 'process'
										? Object.freeze({
												...replacement.execution,
												args: typeof replacement.execution.args === 'string' ? replacement.execution.args : Object.freeze([...replacement.execution.args]),
											})
										: Object.freeze({ ...replacement.execution }),
							}),
				});
				this._customTitle = replacement.name;
				this.initialText = replacement.initialText;
				this.waitOnExit = replacement.waitOnExit;
				this._title = replacement.name ?? this._profile.title;
				this.onTitleChanged();
			}
			if (this.custom) {
				this.customLifetime.clear();
				this.customProcess = undefined;
				this.processCloseTask = undefined;
				this._exitCode = undefined;
				this.processReady = { pid: -1, cwd: replacement?.cwd ?? this.processReady.cwd };
				this.writeInitialText();
				this.custom.dimensions = dimensions;
				this.createCustomProcess(this.custom);
				this.setState('running');
				if (!replacement?.deferStart) this.start();
				return;
			}
			const autoReplies = getTerminalAutoReplyRules(this.configuration);
			const child = await this.backend.createProcess(
				{
					...(autoReplies.length ? { autoReplies } : {}),
					...processWorkspaceFolder(this.processWorkspaceFolderId),
					// Launch presentation metadata must never become process request fields.
					...(this.launch?.env === undefined ? {} : { env: this.launch.env }),
					...(this.launch?.strictEnv === undefined ? {} : { strictEnv: this.launch.strictEnv }),
					...(this.launch?.cwd === undefined ? {} : { cwd: this.launch.cwd }),
					...(this.launch?.execution === undefined ? {} : { execution: this.launch.execution }),
					rows: dimensions.rows,
					cols: dimensions.cols,
					profile: this.launch?.profile ?? { type: 'profile', profileId: this._profile.profileId },
				},
				this.instanceNumber,
			);
			const created = child.creation;
			if (this.closed) {
				await child.close();
				throw new CancellationError();
			}

			this.processReady = created.ready;
			this.connectionPersistence = created.connectionPersistence;
			this.processCloseTask = undefined;
			this._profile = {
				...created.profile,
				icon: replacement?.icon ?? this._profile.icon,
				color: replacement?.color ?? this._profile.color,
			};
			this.shellLifetime.clear();
			this.shellProcessManager = child;
			this.createShellProcessManager();
			this._exitCode = undefined;
			this.writeInitialText();
			this.setState('running');
			if (!replacement?.deferStart) this.start();
		} catch (error) {
			this.handleProcessError(error);
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
		lifetime.add(
			toDisposable(() => {
				if (this.processCapabilities.get(TerminalCapability.NaiveCwdDetection) === cwdQuery) this.processCapabilities.remove(TerminalCapability.NaiveCwdDetection);
			}),
		);
		// The backend owns the child. This instance holds a release lease, not a second disposable owner.
		lifetime.add(
			toDisposable(() => {
				void manager.close().catch(() => {});
			}),
		);
		lifetime.add(
			manager.onProcessReady(ready => {
				this.processReady = ready;
				this.refreshCapabilities();
			}),
		);
		lifetime.add(toDisposable(() => this.statusList.remove(TerminalStatus.ShellIntegrationInfo)));
		lifetime.add(manager.onProcessError(error => this.handleProcessError(error)));
		lifetime.add(manager.onProcessData(event => this.handleProcessData(event)));
		lifetime.add(manager.onDidChangeCommandStatus(event => this._onDidChangeCommandStatus.fire(event)));
		lifetime.add(manager.onDidChangeMetadata(() => this.refreshCapabilities()));
		lifetime.add(
			manager.onPtyReconnect(() => {
				this.setState('running');
			}),
		);
		lifetime.add(manager.onProcessExit(code => this.handleProcessExit(code)));
		this.refreshCapabilities();
	}

	private handleProcessError(error: unknown): void {
		if (this.closed || this.isDisposed) return;
		this.statusList.add({
			id: 'process-error',
			severity: Severity.Error,
			tooltip: localize('terminal.status.processError', 'Terminal process failed: {0}', error instanceof Error ? error.message : String(error)),
		});
		this.setState('error');
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

		let level = localize('terminal.tooltip.none', 'None');
		if (integration?.hasRichCommandDetection) {
			level = localize('terminal.tooltip.rich', 'Rich');
		} else if (integration?.commandDetection) {
			level = localize('terminal.tooltip.basic', 'Basic');
		} else if (this.processReady.launch?.usedShellIntegrationInjection) {
			level = localize('terminal.tooltip.injectionFailed', 'Injection failed to activate');
		}
		const tooltip = localize('terminal.tooltip.shellIntegration', 'Shell integration: {0}', level);
		const details = [tooltip];
		if (this.shellType) {
			details.push(localize('terminal.tooltip.shellType', 'Shell type: {0}', this.shellType));
		}
		const directory = this.cwd ?? this.initialCwd;
		if (directory) {
			details.push(localize('terminal.tooltip.cwd', 'Working directory: {0}', directory));
		}
		if (integration?.promptType) {
			details.push(localize('terminal.tooltip.promptType', 'Prompt type: {0}', integration.promptType));
		}
		const sequences = this.screen?.shellIntegration.seenSequences;
		if (sequences?.size) {
			details.push(localize('terminal.tooltip.seenSequences', 'Seen sequences: {0}', [...sequences].join(', ')));
		}
		const promptInput = this.capabilities.get(TerminalCapability.CommandDetection)?.promptInputModel.getCombinedString();
		if (promptInput !== undefined) {
			details.push(localize('terminal.tooltip.promptInput', 'Prompt input: {0}', promptInput));
		}
		const detailedTooltip = details.join('\n');
		const previous = this.statusList.statuses.find(status => status.id === TerminalStatus.ShellIntegrationInfo);
		// Reads can repeat the same metadata snapshot. Publish only display changes,
		// so unchanged command history never rebuilds an open information card.
		if (previous?.tooltip !== tooltip || previous.detailedTooltip !== detailedTooltip) {
			this.statusList.add({
				id: TerminalStatus.ShellIntegrationInfo,
				severity: Severity.Info,
				tooltip,
				detailedTooltip,
			});
		}
	}

	private async poll(generation: number, initialState: 'running' | 'reconnecting' = 'running', resumeDimensions?: ITerminalDimensions): Promise<void> {
		try {
			if (resumeDimensions) {
				await this.shellProcessManager!.resize(resumeDimensions.cols, resumeDimensions.rows);
				if (this.closed || this.isDisposed || generation !== this.pollGeneration) return;
			}
			await this.shellProcessManager!.start(initialState === 'reconnecting');
		} catch (error) {
			if (!isCancellationError(error) && !this.closed && generation === this.pollGeneration) {
				this.handleProcessError(error);
			}
		}
	}

	private setState(state: TerminalInstanceState): void {
		if (this._state === state || this.closed) return;
		this._state = state;
		if (state === 'reconnecting' || state === 'disconnected') {
			this.statusList.add({
				id: TerminalStatus.Disconnected,
				severity: Severity.Error,
				icon: Lxicon.debugDisconnect,
				tooltip: localize('disconnectStatus', 'Lost connection to process'),
			});
		} else {
			this.statusList.remove(TerminalStatus.Disconnected);
		}
		if (state === 'error') {
			this.shellProcessManager?.stop();
		}
		this._onDidChangeState.fire(state);
	}
}

function processWorkspaceFolder(dirId: string | undefined): { readonly dirId?: string } {
	return dirId === undefined ? {} : { dirId };
}

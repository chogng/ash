import { VSBuffer } from "../../../../base/common/buffer.js";
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, ProcessPropertyType, type IShellLaunchConfig, type ITerminalChildProcess, type IProcessDataEvent, type ITerminalProcessReady, type TerminalProcessConnectionPersistence, type TerminalProcessConnectionState } from "../../../../platform/terminal/common/terminal.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { ITerminalCommandStatusEvent, ITerminalCreateOptions, ITerminalDimensions, ITerminalInstance, ITerminalProfile, ITerminalService, TerminalInstanceState } from "./terminal.js";
import { TerminalProcessManager } from "./terminalProcessManager.js";

const INPUT_BATCH_DELAY_MILLIS = 8;
const INPUT_BATCH_CHARACTERS = 16_384;
const MAX_INPUT_BATCH_BYTES = 60 * 1024;

interface CustomTerminalProcessOptions {
	readonly create: NonNullable<IShellLaunchConfig['customPtyImplementation']>;
	readonly instanceNumber: number;
	dimensions: ITerminalDimensions;
	readonly onTitleChanged: () => void;
}

/** Browser Workbench owner of terminal instances and their process lifecycle. */
export class TerminalService extends Disposable implements ITerminalService {
	private readonly processService: ITerminalProcessService;
	private readonly _instances: TerminalInstance[] = [];
	private readonly _onDidCreateInstance = this._register(new Emitter<ITerminalInstance>());
	private readonly _onDidDisposeInstance = this._register(new Emitter<ITerminalInstance>());
	private readonly _onDidChangeInstances = this._register(new Emitter<void>());
	private readonly _onDidChangeActiveInstance = this._register(new Emitter<ITerminalInstance | undefined>());
	private readonly ownedInstances = this._register(new DisposableMap<string, TerminalInstance>());
	private _activeInstance: TerminalInstance | undefined;
	private nextInstanceId = 1;
	private connectionState: TerminalProcessConnectionState = "ready";
	private connectionRevision = 0;

	readonly onDidCreateInstance: Event<ITerminalInstance> = this._onDidCreateInstance.event;
	readonly onDidDisposeInstance: Event<ITerminalInstance> = this._onDidDisposeInstance.event;
	readonly onDidChangeInstances: Event<void> = this._onDidChangeInstances.event;
	readonly onDidChangeActiveInstance: Event<ITerminalInstance | undefined> = this._onDidChangeActiveInstance.event;

	constructor(@ITerminalProcessService processService: ITerminalProcessService, @IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService, @IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		this.processService = processService;
		this._register(processService.onConnectionState((state) => {
			this.connectionRevision += 1;
			this.setConnectionState(state);
		}));
		const connectionRevision = this.connectionRevision;
		void processService.getConnectionState()
			.then((state) => {
				if (!this.isDisposed && this.connectionRevision === connectionRevision) {
					this.setConnectionState(state);
				}
			})
			.catch(() => {
				if (!this.isDisposed && this.connectionRevision === connectionRevision) {
					this.setConnectionState('crashed');
				}
			});
	}

	protected override disposeCore(): void {
		this._instances.length = 0;
		this._activeInstance = undefined;
		super.disposeCore();
	}

	get instances(): readonly ITerminalInstance[] {
		return this._instances;
	}

	get activeInstance(): ITerminalInstance | undefined {
		return this._activeInstance;
	}

	async getProfiles(): Promise<readonly ITerminalProfile[]> {
		this.requireWorkspaceFolder();
		return this.processService.listProfiles();
	}

	async createTerminal(options: ITerminalCreateOptions): Promise<ITerminalInstance> {
		if (this.isDisposed) {
			throw new CancellationError();
		}
		if (options.config) {
			const instanceNumber = this.nextInstanceId++;
			const name = options.title ?? options.config.name ?? '';
			const instance = this.instantiationService.createInstance(TerminalInstance,
				`terminal-instance-${instanceNumber}`,
				'',
				undefined,
				'',
				{ pid: -1, cwd: '' },
				name,
				{ profileId: `embedder-${instanceNumber}`, title: name, isDefault: false },
				'connectionOwned',
				name,
				() => this.connectionState,
				() => this.removeInstance(instance),
				{
					create: options.config.customPtyImplementation,
					instanceNumber,
					dimensions: options.dimensions,
					onTitleChanged: () => this._onDidChangeInstances.fire(),
				},
			);
			this.ownedInstances.set(instance.id, instance);
			this._instances.push(instance);
			try {
				instance.prepareCustomProcess();
			} catch (error) {
				instance.dispose();
				throw error;
			}
			this._onDidCreateInstance.fire(instance);
			if (this.isDisposed || !this._instances.includes(instance)) {
				throw new CancellationError();
			}
			this.setActiveInstance(instance);
			instance.start();
			this._onDidChangeInstances.fire();
			return instance;
		}
		const workspaceFolder = this.requireWorkspaceFolder(options.dirId);
		const processWorkspaceFolderId = this.workspaceContext.getWorkspace().folders.length > 1
			? workspaceFolder.id
			: undefined;
		const created = await this.processService.create({
			...processWorkspaceFolder(processWorkspaceFolderId),
			rows: options.dimensions.rows,
			cols: options.dimensions.cols,
			profile: options.profile,
		});
		// A completed backend request still owns a PTY even if its window has closed.
		if (this.isDisposed) {
			await this.processService.close({ ...processWorkspaceFolder(processWorkspaceFolderId), terminalId: created.terminalId });
			throw new CancellationError();
		}
		const instanceNumber = this.nextInstanceId++;
		const instance = this.instantiationService.createInstance(TerminalInstance,
			`terminal-instance-${instanceNumber}`,
			workspaceFolder.id,
			processWorkspaceFolderId,
			created.terminalId,
			created.ready,
			options.title ?? terminalProfileTitle(created.profile),
			created.profile,
			created.connectionPersistence,
			options.title,
			() => this.connectionState,
			() => this.removeInstance(instance),
			undefined,
		);
		this.ownedInstances.set(instance.id, instance);
		this._instances.push(instance);
		this.refreshInstanceTitles();
		this._onDidCreateInstance.fire(instance);
		this.setActiveInstance(instance);
		instance.start();
		this._onDidChangeInstances.fire();
		return instance;
	}

	async relaunchTerminal(instance: ITerminalInstance, dimensions: ITerminalDimensions): Promise<void> {
		if (!instance.isReadOnly) {
			this.requireWorkspaceFolder();
		}
		if (!this._instances.includes(instance as TerminalInstance)) {
			throw new Error("Terminal must belong to this TerminalService");
		}
		await (instance as TerminalInstance).relaunch(dimensions);
	}

	setActiveInstance(instance: ITerminalInstance | undefined): void {
		if (instance !== undefined && !this._instances.includes(instance as TerminalInstance)) {
			throw new Error("Active terminal must belong to this TerminalService");
		}
		if (this._activeInstance === instance) return;
		this._activeInstance = instance as TerminalInstance | undefined;
		this._onDidChangeActiveInstance.fire(instance);
	}

	moveTerminal(instance: ITerminalInstance, targetIndex: number): void {
		const currentIndex = this._instances.indexOf(instance as TerminalInstance);
		if (currentIndex < 0) {
			throw new Error("Terminal must belong to this TerminalService");
		}
		this._instances.splice(currentIndex, 1);
		const insertionIndex = Math.min(Math.max(0, targetIndex), this._instances.length);
		this._instances.splice(insertionIndex, 0, instance as TerminalInstance);
		this.refreshInstanceTitles();
		this._onDidChangeInstances.fire();
	}

	async closeTerminal(instance: ITerminalInstance): Promise<void> {
		if (!this._instances.includes(instance as TerminalInstance)) return;
		await instance.close();
	}

	private removeInstance(instance: TerminalInstance): void {
		const index = this._instances.indexOf(instance);
		if (index < 0) return;
		const activeChanged = this._activeInstance === instance;
		this._instances.splice(index, 1);
		// The instance is already disposing; remove the window's reference to it.
		this.ownedInstances.deleteAndLeak(instance.id);
		if (activeChanged) {
			this._activeInstance = this._instances.at(-1);
		}
		this.refreshInstanceTitles();
		this._onDidDisposeInstance.fire(instance);
		if (activeChanged) {
			this._onDidChangeActiveInstance.fire(this._activeInstance);
		}
		this._onDidChangeInstances.fire();
	}

	private refreshInstanceTitles(): void {
		const instancesByProfile = new Map<string, TerminalInstance[]>();
		for (const instance of this._instances) {
			if (instance.isReadOnly) {
				continue;
			}
			const profileInstances = instancesByProfile.get(instance.profile.profileId) ?? [];
			profileInstances.push(instance);
			instancesByProfile.set(instance.profile.profileId, profileInstances);
		}
		for (const profileInstances of instancesByProfile.values()) {
			const baseTitle = terminalProfileTitle(profileInstances[0].profile);
			for (const [index, instance] of profileInstances.entries()) {
				instance.setTitle(instance.customTitle ?? (profileInstances.length === 1 ? baseTitle : `${baseTitle} ${index + 1}`));
			}
		}
	}

	private setConnectionState(state: TerminalProcessConnectionState): void {
		if (this.connectionState === state) return;
		this.connectionState = state;
		if (state === "ready") {
			for (const instance of this._instances) instance.restoreConnection();
			return;
		}
		for (const instance of this._instances) {
			instance.loseConnection();
		}
	}

	private requireWorkspaceFolder(dirId?: string) {
		const folders = this.workspaceContext.getWorkspace().folders;
		const folder = dirId ? folders.find(folder => folder.id === dirId) : folders[0];
		if (!folder) throw new Error("TerminalUnavailable: Terminal requires an open workspace folder");
		return folder;
	}
}

class TerminalInstance extends Disposable implements ITerminalInstance {
	private readonly pendingOutput: IProcessDataEvent[] = [];
	private readonly shellLifetime = this._register(new MutableDisposable<DisposableStore>());
	private shellProcessManager: TerminalProcessManager | undefined;
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
	private pendingInput = "";
	private inputTimer: ReturnType<typeof setTimeout> | undefined;
	private writeChain = Promise.resolve();
	private pendingDimensions: ITerminalDimensions | undefined;
	private resizeScheduled = false;
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
	}

	protected override disposeCore(): void {
		void this.close();
		this.pendingOutput.length = 0;
		this.pendingExit = undefined;
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

	write(data: string): void {
		if (this.isReadOnly || this.closed || this._state !== "running" || data.length === 0) return;
		this.pendingInput += data;
		if (this.pendingInput.length >= INPUT_BATCH_CHARACTERS) {
			this.flushInput();
			return;
		}
		if (this.inputTimer !== undefined) return;
		this.inputTimer = setTimeout(() => {
			this.inputTimer = undefined;
			this.flushInput();
		}, INPUT_BATCH_DELAY_MILLIS);
	}

	public processBinary(data: string): Promise<void> {
		if (this.isReadOnly || this.closed || this._state !== 'running') {
			return Promise.reject(new CancellationError());
		}
		// Flush every preceding text batch before mouse bytes. Later text queues after them.
		this.flushInput();
		const bytes = Uint8Array.from(data, character => character.charCodeAt(0));
		return this.enqueueInput(bytes);
	}

	resize(dimensions: ITerminalDimensions): void {
		if (this.custom) {
			this.custom.dimensions = dimensions;
			return;
		}
		if (this.closed || this._state !== "running") return;
		this.pendingDimensions = dimensions;
		if (this.resizeScheduled) return;
		this.resizeScheduled = true;
		queueMicrotask(() => {
			this.resizeScheduled = false;
			const pending = this.pendingDimensions;
			this.pendingDimensions = undefined;
			if (!pending || this.closed || this._state !== "running") return;
			const generation = this.pollGeneration;
			void this.processService.resize({
				...processWorkspaceFolder(this.processWorkspaceFolderId),
				terminalId: this.serverTerminalId,
				rows: pending.rows,
				cols: pending.cols,
			}).catch(() => {
				if (generation === this.pollGeneration && this._state === "running") {
					this.setState("error");
				}
			});
		});
	}

	public close(): Promise<void> {
		if (this.closeTask) {
			return this.closeTask;
		}
		this.closed = true;
		this.clearPendingInput();
		this.pendingDimensions = undefined;
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
		this.clearPendingInput();
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
			this.shellProcessManager = undefined;
			this._exitCode = undefined;
			this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal relaunched]\r\n").buffer, trackCommit: false });
			this.setState("running");
			this.start();
		} catch (error) {
			this.setState("error");
			throw error;
		}
	}

	private flushInput(): void {
		if (this.inputTimer !== undefined) {
			clearTimeout(this.inputTimer);
			this.inputTimer = undefined;
		}
		if (this.closed || this._state !== "running" || this.pendingInput.length === 0) return;
		while (this.pendingInput.length > 0) {
			const data = takeUtf8Prefix(this.pendingInput, MAX_INPUT_BATCH_BYTES);
			this.pendingInput = this.pendingInput.slice(data.length);
			// Text input has a state event for failures; binary callers also receive rejection.
			void this.enqueueInput(data).catch(() => { });
		}
	}

	private enqueueInput(data: string | Uint8Array): Promise<void> {
		const generation = this.pollGeneration;
		const terminalId = this.serverTerminalId;
		const operation = this.writeChain.then(async () => {
			if (generation !== this.pollGeneration || this.closed || this._state !== 'running') {
				throw new CancellationError();
			}
			await this.processService.write({ ...processWorkspaceFolder(this.processWorkspaceFolderId), terminalId, data });
		});
		this.writeChain = operation.catch(error => {
			if (!isCancellationError(error) && generation === this.pollGeneration && this._state === 'running') {
				this.setState('error');
			}
		});
		return operation;
	}

	private async poll(generation: number, initialState: "running" | "reconnecting" = "running"): Promise<void> {
		if (!this.shellProcessManager) {
			const lifetime = new DisposableStore();
			this.shellLifetime.value = lifetime;
			const manager = this.instantiationService.createInstance(TerminalProcessManager, {
				...processWorkspaceFolder(this.processWorkspaceFolderId),
				terminalId: this.serverTerminalId,
			});
			this.shellProcessManager = lifetime.add(manager);
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
		try {
			await this.shellProcessManager.start(initialState === "reconnecting");
		} catch (error) {
			if (!isCancellationError(error) && !this.closed && generation === this.pollGeneration) {
				if (this._state === "reconnecting") {
					this._onDidWriteData.fire({ data: VSBuffer.fromString("\r\n[terminal recovery failed; relaunch required]\r\n").buffer, trackCommit: false });
				}
				this.setState("error");
			}
		}
	}

	private clearPendingInput(): void {
		if (this.inputTimer !== undefined) {
			clearTimeout(this.inputTimer);
			this.inputTimer = undefined;
		}
		this.pendingInput = "";
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

function takeUtf8Prefix(value: string, maximumBytes: number): string {
	if (VSBuffer.fromString(value).byteLength <= maximumBytes) return value;
	let lower = 1;
	let upper = value.length;
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (VSBuffer.fromString(value.slice(0, middle)).byteLength <= maximumBytes) {
			lower = middle;
		} else {
			upper = middle - 1;
		}
	}
	if (lower < value.length && isHighSurrogate(value.charCodeAt(lower - 1))) {
		lower -= 1;
	}
	return value.slice(0, Math.max(1, lower));
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function processWorkspaceFolder(dirId: string | undefined): { readonly dirId?: string; } {
	return dirId === undefined ? {} : { dirId };
}

function terminalProfileTitle(profile: ITerminalProfile): string {
	if (profile.profileId === "cmd" || profile.profileId === "command-prompt") {
		return "cmd";
	}
	return profile.title;
}

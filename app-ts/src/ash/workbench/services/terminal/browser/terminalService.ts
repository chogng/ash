import { timeout } from "../../../../base/common/async.js";
import { decodeBase64, VSBuffer } from "../../../../base/common/buffer.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { ITerminalProcessCommandStatusEvent, ITerminalProcessOutputChunk, ITerminalProcessService, TerminalProcessConnectionPersistence, TerminalProcessConnectionState } from "../../../../platform/terminal/common/terminalProcessService.js";
import type { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import type { ITerminalCommandStatusEvent, ITerminalCreateOptions, ITerminalDimensions, ITerminalInstance, ITerminalProfile, ITerminalService, TerminalInstanceState } from "../common/terminal.js";

const POLL_DELAY_MILLIS = 35;
const INPUT_BATCH_DELAY_MILLIS = 8;
const INPUT_BATCH_CHARACTERS = 16_384;
const MAX_INPUT_BATCH_BYTES = 60 * 1024;
const MAX_READ_CHUNKS = 128;

/** Browser Workbench owner of terminal instances and their process lifecycle. */
export class TerminalService extends Disposable implements ITerminalService {
	private readonly processService: ITerminalProcessService;
	private readonly _instances: TerminalInstance[] = [];
	private readonly _onDidCreateInstance = this._register(new Emitter<ITerminalInstance>());
	private readonly _onDidDisposeInstance = this._register(new Emitter<ITerminalInstance>());
	private readonly _onDidChangeInstances = this._register(new Emitter<void>());
	private readonly _onDidChangeActiveInstance = this._register(new Emitter<ITerminalInstance | undefined>());
	private _activeInstance: TerminalInstance | undefined;
	private nextInstanceId = 1;
	private connectionState: TerminalProcessConnectionState = "ready";
	private connectionRevision = 0;

	readonly onDidCreateInstance: Event<ITerminalInstance> = this._onDidCreateInstance.event;
	readonly onDidDisposeInstance: Event<ITerminalInstance> = this._onDidDisposeInstance.event;
	readonly onDidChangeInstances: Event<void> = this._onDidChangeInstances.event;
	readonly onDidChangeActiveInstance: Event<ITerminalInstance | undefined> = this._onDidChangeActiveInstance.event;

	constructor(processService: ITerminalProcessService, private readonly workspaceContext: IWorkspaceContextService) {
		super();
		this.processService = processService;
		this._register(processService.onConnectionState((state) => {
			this.connectionRevision += 1;
			this.setConnectionState(state);
		}));
		const connectionRevision = this.connectionRevision;
		void processService.getConnectionState()
			.then((state) => {
				if (this.connectionRevision === connectionRevision) this.setConnectionState(state);
			})
			.catch(() => {
				if (this.connectionRevision === connectionRevision) this.setConnectionState("crashed");
			});
		this._register(toDisposable(() => {
			for (const instance of [...this._instances]) {
				void instance.close().catch(() => {});
			}
			this._instances.length = 0;
			this._activeInstance = undefined;
		}));
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
		const instanceNumber = this.nextInstanceId++;
		const instance = this._register(new TerminalInstance(
			`terminal-instance-${instanceNumber}`,
			workspaceFolder.id,
			processWorkspaceFolderId,
			created.terminalId,
			options.title ?? terminalProfileTitle(created.profile),
			created.profile,
			created.connectionPersistence,
			options.title,
			this.processService,
			() => this.removeInstance(instance),
		));
		this._instances.push(instance);
		this.refreshInstanceTitles();
		this._onDidCreateInstance.fire(instance);
		this.setActiveInstance(instance);
		instance.start();
		return instance;
	}

	async relaunchTerminal(instance: ITerminalInstance, dimensions: ITerminalDimensions): Promise<void> {
		this.requireWorkspaceFolder();
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
		if (activeChanged) {
			this._activeInstance = this._instances.at(-1);
		}
		this.refreshInstanceTitles();
		this._onDidDisposeInstance.fire(instance);
		if (activeChanged) {
			this._onDidChangeActiveInstance.fire(this._activeInstance);
		}
	}

	private refreshInstanceTitles(): void {
		const instancesByProfile = new Map<string, TerminalInstance[]>();
		for (const instance of this._instances) {
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
	private readonly processService: ITerminalProcessService;
	private readonly onClosed: () => void;
	private readonly _onDidWriteData = this._register(new Emitter<Uint8Array>());
	private readonly _onDidChangeCommandStatus = this._register(new Emitter<ITerminalCommandStatusEvent>());
	private readonly _onDidExit = this._register(new Emitter<number | undefined>());
	private readonly _onDidChangeState = this._register(new Emitter<TerminalInstanceState>());
	private _state: TerminalInstanceState = "running";
	private _exitCode: number | undefined;
	private nextSequence = 0;
	private nextCommandSequence = 0;
	private closed = false;
	private pendingInput = "";
	private inputTimer: ReturnType<typeof setTimeout> | undefined;
	private writeChain = Promise.resolve();
	private pendingDimensions: ITerminalDimensions | undefined;
	private resizeScheduled = false;
	private serverTerminalId: string;
	private _profile: ITerminalProfile;
	private _title: string;
	private pollGeneration = 0;

	readonly onDidWriteData: Event<Uint8Array> = this._onDidWriteData.event;
	readonly onDidChangeCommandStatus: Event<ITerminalCommandStatusEvent> = this._onDidChangeCommandStatus.event;
	readonly onDidExit: Event<number | undefined> = this._onDidExit.event;
	readonly onDidChangeState: Event<TerminalInstanceState> = this._onDidChangeState.event;

	constructor(
		readonly id: string,
		readonly dirId: string,
		private readonly processWorkspaceFolderId: string | undefined,
		serverTerminalId: string,
		title: string,
		profile: ITerminalProfile,
		private readonly connectionPersistence: TerminalProcessConnectionPersistence,
		readonly customTitle: string | undefined,
		processService: ITerminalProcessService,
		onClosed: () => void,
	) {
		super();
		this.serverTerminalId = serverTerminalId;
		this._profile = profile;
		this._title = title;
		this.processService = processService;
		this.onClosed = onClosed;
		this._register(toDisposable(() => {
			if (this.inputTimer !== undefined) clearTimeout(this.inputTimer);
		}));
	}

	get state(): TerminalInstanceState {
		return this._state;
	}

	get exitCode(): number | undefined {
		return this._exitCode;
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

	start(): void {
		const generation = ++this.pollGeneration;
		void this.poll(generation);
	}

	write(data: string): void {
		if (this.closed || this._state !== "running" || data.length === 0) return;
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

	resize(dimensions: ITerminalDimensions): void {
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

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.inputTimer !== undefined) {
			clearTimeout(this.inputTimer);
			this.inputTimer = undefined;
		}
		this.pendingInput = "";
		this.pollGeneration += 1;
		try {
			await this.processService.close({ ...processWorkspaceFolder(this.processWorkspaceFolderId), terminalId: this.serverTerminalId });
		} finally {
			this.onClosed();
			this.dispose();
		}
	}

	loseConnection(): void {
		if (this.closed || this._state === "exited" || this._state === "disconnected") return;
		this.pollGeneration += 1;
		this.clearPendingInput();
		if (this.connectionPersistence === "reconnectable") {
			if (this._state !== "reconnecting") {
				this.setState("reconnecting");
				this._onDidWriteData.fire(VSBuffer.fromString("\r\n[terminal reconnecting]\r\n").buffer);
			}
			return;
		}
		this.setState("disconnected");
		this._onDidWriteData.fire(VSBuffer.fromString("\r\n[terminal connection lost; process was not preserved]\r\n").buffer);
	}

	restoreConnection(): void {
		if (this.closed || this._state !== "reconnecting") return;
		const generation = ++this.pollGeneration;
		void this.poll(generation, "reconnecting");
	}

	async relaunch(dimensions: ITerminalDimensions): Promise<void> {
		if (this.closed || this._state === "running" || this._state === "reconnecting") return;
		await this.processService.close({ ...processWorkspaceFolder(this.processWorkspaceFolderId), terminalId: this.serverTerminalId }).catch(() => {});
		try {
			const created = await this.processService.create({
				...processWorkspaceFolder(this.processWorkspaceFolderId),
				rows: dimensions.rows,
				cols: dimensions.cols,
				profile: {
					type: "profile",
					profileId: this._profile.profileId,
				},
			});
			this.serverTerminalId = created.terminalId;
			this._profile = created.profile;
			this.nextSequence = 0;
			this.nextCommandSequence = 0;
			this._exitCode = undefined;
			this._onDidWriteData.fire(VSBuffer.fromString("\r\n[terminal relaunched]\r\n").buffer);
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
		const data = takeUtf8Prefix(this.pendingInput, MAX_INPUT_BATCH_BYTES);
		this.pendingInput = this.pendingInput.slice(data.length);
		const generation = this.pollGeneration;
		this.writeChain = this.writeChain
			.then(() => {
				if (generation !== this.pollGeneration || this._state !== "running") return;
				return this.processService.write({ ...processWorkspaceFolder(this.processWorkspaceFolderId), terminalId: this.serverTerminalId, data });
			})
			.catch(() => {
				if (generation === this.pollGeneration && this._state === "running") {
					this.setState("error");
				}
			})
			.then(() => {
				if (generation === this.pollGeneration && this._state === "running" && this.pendingInput.length > 0) {
					this.flushInput();
				}
			});
	}

	private async poll(generation: number, initialState: "running" | "reconnecting" = "running"): Promise<void> {
		let recoveryPending = initialState === "reconnecting";
		while (!this.closed && generation === this.pollGeneration && (this._state === "running" || (recoveryPending && this._state === "reconnecting"))) {
			try {
				const result = await this.processService.read({
					...processWorkspaceFolder(this.processWorkspaceFolderId),
					terminalId: this.serverTerminalId,
					afterSequence: this.nextSequence,
					afterCommandSequence: this.nextCommandSequence,
					maxChunks: MAX_READ_CHUNKS,
				});
				if (this.closed || generation !== this.pollGeneration) return;
				if (recoveryPending) {
					if (this._state !== "reconnecting") return;
					this._onDidWriteData.fire(VSBuffer.fromString("\r\n[terminal reconnected]\r\n").buffer);
					this.setState("running");
					recoveryPending = false;
				} else if (this._state !== "running") {
					return;
				}
				if (result.outputGap) {
					this._onDidWriteData.fire(VSBuffer.fromString("\r\n[terminal output truncated]\r\n").buffer);
				}
				this.emitReadResult(result.chunks, result.commandEvents);
				this.nextSequence = result.nextSequence;
				this.nextCommandSequence = result.nextCommandSequence;
				if (result.exited) {
					this._exitCode = result.exitCode ?? undefined;
					this.setState("exited");
					this._onDidExit.fire(this._exitCode);
					return;
				}
				if (result.chunks.length === 0) await timeout(POLL_DELAY_MILLIS);
			} catch {
				if (!this.closed && generation === this.pollGeneration) {
					if (recoveryPending && this._state === "reconnecting") {
						this._onDidWriteData.fire(VSBuffer.fromString("\r\n[terminal recovery failed; relaunch required]\r\n").buffer);
					}
					this.setState("error");
				}
				return;
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

	private emitReadResult(chunks: readonly ITerminalProcessOutputChunk[], commandEvents: readonly ITerminalProcessCommandStatusEvent[]): void {
		let outputSequence = this.nextSequence;
		let eventIndex = 0;
		const emitEventsThrough = (sequence: number): void => {
			while (eventIndex < commandEvents.length && commandEvents[eventIndex]!.afterOutputSequence <= sequence) {
				const event = commandEvents[eventIndex++]!;
				this._onDidChangeCommandStatus.fire({
					commandId: event.commandId,
					status: event.status,
					exitCode: event.exitCode ?? undefined,
				});
			}
		};
		emitEventsThrough(outputSequence);
		for (const chunk of chunks) {
			emitEventsThrough(chunk.sequence - 1);
			this._onDidWriteData.fire(decodeBase64(chunk.dataBase64).buffer);
			outputSequence = chunk.sequence;
			emitEventsThrough(outputSequence);
		}
		emitEventsThrough(Number.POSITIVE_INFINITY);
	}

	private setState(state: TerminalInstanceState): void {
		if (this._state === state || this.closed) return;
		this._state = state;
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

function processWorkspaceFolder(dirId: string | undefined): { readonly dirId?: string } {
	return dirId === undefined ? {} : { dirId };
}

function terminalProfileTitle(profile: ITerminalProfile): string {
	if (profile.profileId === "cmd" || profile.profileId === "command-prompt") {
		return "cmd";
	}
	return profile.title;
}

import type { InlineDebugAdapter } from '../common/debugAdapterFactory.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { TaskQueue, timeout } from "../../../../base/common/async.js";
import { groupByMap } from "../../../../base/common/collections.js";
import { CancellationError, getErrorMessage } from "../../../../base/common/errors.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { localize } from "../../../../nls.js";
import { type IDebugAdapterProcessService } from "../../../../platform/debug/common/debugAdapterProcessService.js";
import { isRemoteResource } from "../../../../platform/remote/common/remote.js";
import { type DebugBreakpoint, type DebugEvaluateContext, type DebugSessionState, type DebugSteppingGranularity, type IDisassembledInstruction, type IBaseBreakpoint, type IDataBreakpointInfoResponse, type DataBreakpointAccessType, type IDebugBreakpoint, type IDebugConfiguration, type IDebugEvaluateResult, type IDebugExceptionBreakpointFilter, type IDebugScope, type IDebugSession, type IDebugSessionOptions, type IDebugSessionCapabilities, type IDebugSource, type IDebugSourceContent, type IDebugStackFrame, type IDebugThread, type IDebugVariable, type IDebugAdapterTracker } from "../common/debugService.js";

interface DapRequest { readonly seq: number; readonly type: "request"; readonly command: string; readonly arguments?: unknown; }
interface DapResponse { readonly seq: number; readonly type: "response"; readonly request_seq: number; readonly success: boolean; readonly command: string; readonly message?: string; readonly body?: unknown; }
interface DapEvent { readonly seq: number; readonly type: "event"; readonly event: string; readonly body?: unknown; }

const POLL_DELAY_MS = 40;
const REQUEST_TIMEOUT_MS = 15_000;

export interface DebugAdapterSessionStartOptions {
	readonly id?: string;
	readonly createDebugAdapterTrackers?: (session: IDebugSession) => PromiseLike<readonly IDebugAdapterTracker[]>;
	readonly createDebugAdapterDescriptor?: (session: IDebugSession) => PromiseLike<IDebugConfiguration['adapter'] | null>;
	readonly configuration: IDebugConfiguration;
	readonly sessionOptions?: IDebugSessionOptions;
	readonly onWillStart?: (session: IDebugSession) => void;
	/** Execution data is resolved by DebugService; the source configuration remains available for restart. */
	readonly resolvedConfiguration: Pick<IDebugConfiguration, 'adapter' | 'arguments'>;
	readonly processService: IDebugAdapterProcessService;
	readonly breakpoints: () => readonly IDebugBreakpoint[];
	readonly additionalBreakpoints?: () => readonly Exclude<DebugBreakpoint, IDebugBreakpoint>[];
	readonly workspace?: URI;
	readonly runInTerminal?: (argumentsValue: unknown) => Promise<Readonly<Record<string, unknown>>>;
	readonly startDebugging?: (argumentsValue: unknown) => Promise<void>;
	readonly updateBreakpoints?: (updates: readonly { readonly id: string; readonly verified: boolean; readonly message?: string; }[]) => void;
	/** The catalog owner inserts without notifying; verification publishes after the protocol binding exists. */
	readonly addBreakpoint?: (source: IDebugSource, line: number, column?: number) => IDebugBreakpoint | undefined;
	readonly removeBreakpoint?: (id: string) => void;
	readonly exceptionBreakpoints?: () => readonly string[];
}

/** One initialized DAP client session over the platform process boundary. */
export class DebugAdapterSession extends Disposable implements IDebugSession {
	private _resolvedConfiguration: IDebugConfiguration;
	get resolvedConfiguration(): IDebugConfiguration { return this._resolvedConfiguration; }
	get parentSession(): IDebugSession | undefined { return this.sessionOptions.parentSession; }
	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly customEventEmitter = this._register(new Emitter<{ readonly event: string; readonly body?: unknown; }>());
	private readonly outputEmitter = this._register(new Emitter<string>());
	private retainedOutput = "";
	private readonly pending = new Map<number, { readonly resolve: (response: DapResponse) => void; readonly reject: (error: Error) => void; readonly timeout: ReturnType<typeof setTimeout>; }>();
	private transport: InlineDebugAdapter | undefined;
	private adapterStarted = false;
	private requestSequence = 1;
	private readSequence = 0;
	private polling = false;
	private processClose: Promise<void> | undefined;
	private trackers: readonly IDebugAdapterTracker[] = [];
	private readonly receivedTrackerMessages = new TaskQueue();
	private queuedTrackerMessages = 0;
	private trackerMessagesStopped = false;
	private adapterExitCode: number | undefined;
	private trackersEnded = false;
	private trackersStopping = false;
	private trackerErrorReported = false;
	private _state: DebugSessionState = "starting";
	private _reason: string | undefined;
	private _threadId: number | undefined;
	private readonly threadEmitter = this._register(new Emitter<number | undefined>());
	readonly onDidChangeThread = this.threadEmitter.event;
	private initializedResolver: (() => void) | undefined;
	private initializedRejecter: ((error: Error) => void) | undefined;
	private readonly initializedPromise = new Promise<void>((resolve, reject) => { this.initializedResolver = resolve; this.initializedRejecter = reject; });
	private readonly nameEmitter = this._register(new Emitter<string>());
	private sessionName: string;
	private readonly protocolBreakpoints = new Map<string, { readonly signature: string; readonly value: unknown; }>();
	private readonly syncedBreakpointSources = new Map<string, Readonly<Record<string, unknown>>>();
	private readonly breakpointSync = new TaskQueue();
	private supportsConfigurationDone = false;
	private _capabilities: IDebugSessionCapabilities = Object.freeze({ supportsRestart: false, supportsTerminate: false, supportsSetVariable: false, supportsConditionalBreakpoints: false, supportsHitConditionalBreakpoints: false, supportsLogPoints: false, supportsFunctionBreakpoints: false, supportsDataBreakpoints: false, supportsInstructionBreakpoints: false, supportsDisassembleRequest: false, supportsSteppingGranularity: false, exceptionBreakpointFilters: Object.freeze([]) });

	readonly onDidChangeState: Event<DebugSessionState> = this.stateEmitter.event;
	readonly onDidOutput: Event<string> = this.outputEmitter.event;
	readonly onDidCustomEvent = this.customEventEmitter.event;
	readonly onDidChangeName = this.nameEmitter.event;
	get name(): string { return this.sessionName; }
	setName(name: string): void {
		this.assertNotDisposed();
		if (typeof name !== 'string' || name.length > 32768 || name.includes('\0')) { throw new TypeError('Invalid debug session name'); }
		if (name === this.sessionName) { return; }
		this.sessionName = name;
		this.nameEmitter.fire(name);
	}

	getDebugProtocolBreakpoint(breakpointId: string): unknown {
		this.assertNotDisposed();
		const point = [...this.breakpoints(), ...this.additionalBreakpoints?.() ?? []].find(value => value.id === breakpointId);
		const received = this.protocolBreakpoints.get(breakpointId);
		return point?.enabled && received?.signature === breakpointSignature(point) ? received.value : undefined;
	}

	private rememberProtocolBreakpoints(body: unknown, points: readonly IBaseBreakpoint[]): void {
		for (const point of points) { this.protocolBreakpoints.delete(point.id); }
		if (!body || typeof body !== 'object' || Array.isArray(body)) return;
		const values = (body as { breakpoints?: unknown; }).breakpoints;
		if (!Array.isArray(values)) return;
		for (let index = 0; index < points.length; index++) {
			const value = values[index];
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				this.protocolBreakpoints.set(points[index]!.id, { signature: breakpointSignature(points[index]!), value });
			}
		}
	}

	async customRequest(command: string, args?: unknown): Promise<unknown> {
		this.assertNotDisposed();
		if (this.state === "terminated" || this.state === "error") throw new Error("Debug session has ended");
		if (!command || command.length > 256 || command.includes("\0")) throw new TypeError("Invalid Debug Adapter command");
		return (await this.request(command, args)).body;
	}
	get output(): string { return this.retainedOutput; }

	private constructor(
		readonly configuration: IDebugConfiguration,
		readonly id: string,
		private readonly breakpoints: () => readonly IDebugBreakpoint[],
		private readonly workspace: URI | undefined,
		private readonly runInTerminal: DebugAdapterSessionStartOptions["runInTerminal"],
		private readonly startDebugging: DebugAdapterSessionStartOptions['startDebugging'],
		private readonly updateBreakpoints: DebugAdapterSessionStartOptions["updateBreakpoints"],
		private readonly addBreakpoint: DebugAdapterSessionStartOptions['addBreakpoint'],
		private readonly removeBreakpoint: DebugAdapterSessionStartOptions['removeBreakpoint'],
		private readonly exceptionBreakpoints: DebugAdapterSessionStartOptions["exceptionBreakpoints"],
		private readonly additionalBreakpoints: DebugAdapterSessionStartOptions["additionalBreakpoints"],
		resolvedConfiguration: DebugAdapterSessionStartOptions["resolvedConfiguration"],
		readonly sessionOptions: IDebugSessionOptions,
	) {
		super();
		this._resolvedConfiguration = Object.freeze({ ...configuration, ...resolvedConfiguration });
		this.sessionName = this._resolvedConfiguration.name;
		// Prepared sessions can be stopped before initialize attaches its waiter.
		// Keep that rejection handled while initialize still observes the original promise.
		void this.initializedPromise.catch(() => { });
		this._register(toDisposable(() => {
			void this.closeProcess();
			this.trackers = [];
			this.breakpointSync.clearPending();
			this.receivedTrackerMessages.clearPending();
			for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("Debug session was disposed")); }
			this.pending.clear();
			this.protocolBreakpoints.clear();
		}));
	}

	static async start(options: DebugAdapterSessionStartOptions): Promise<DebugAdapterSession> {
		const session = new DebugAdapterSession(
			options.configuration, options.id ?? generateUuid(), options.breakpoints,
			options.workspace, options.runInTerminal, options.startDebugging, options.updateBreakpoints, options.addBreakpoint, options.removeBreakpoint,
			options.exceptionBreakpoints, options.additionalBreakpoints, options.resolvedConfiguration, Object.freeze({ ...options.sessionOptions }),
		);
		try {
			options.onWillStart?.(session);
			let adapter = options.resolvedConfiguration.adapter;
			if (!adapter) {
				if (!options.createDebugAdapterDescriptor) throw new Error(localize('debug.adapterDescriptorUnavailable', 'The Debug Adapter factory did not provide an adapter.'));
				adapter = await options.createDebugAdapterDescriptor(session) ?? undefined;
				if (!adapter) throw new Error(localize('debug.adapterDescriptorUnavailable', 'The Debug Adapter factory did not provide an adapter.'));
				session._resolvedConfiguration = Object.freeze({ ...session.resolvedConfiguration, adapter });
			}
			if (adapter.inline) { session.transport = adapter.inline; }
			if (session.isDisposed) { throw new CancellationError(); }
			const trackers = await options.createDebugAdapterTrackers?.(session) ?? [];
			if (session.isDisposed) {
				for (const tracker of trackers) { tracker.dispose(); }
				throw new CancellationError();
			}
			session.trackers = trackers.map(tracker => session._register(tracker));
			await session.callTrackers(tracker => tracker.onWillStartSession?.());
			if (session.isDisposed) { throw new CancellationError(); }
			if (!adapter.inline) {
				const id = await options.processService.start({ ...adapter, ...(options.configuration.dirId ? { dirId: options.configuration.dirId } : {}) });
				session.transport = {
					send: message => options.processService.send(id, message),
					read: (afterSequence, maxMessages) => options.processService.read(id, afterSequence, maxMessages),
					close: () => options.processService.close(id),
				};
			}
			if (session.isDisposed) { throw new CancellationError(); }
			session.adapterStarted = true;
			session.polling = true;
			void session.poll();
			await session.initialize(options.resolvedConfiguration.arguments);
			return session;
		} catch (error) {
			const cancelled = session.isDisposed;
			if (!cancelled) { await session.reportTrackerError(error); }
			await session.closeProcess();
			await session.stopTrackers();
			await session.endTrackers();
			session.dispose();
			throw cancelled ? new CancellationError() : error;
		}
	}

	get state() { return this._state; }
	get reason() { return this._reason; }
	get threadId() { return this._threadId; }
	get capabilities() { return this._capabilities; }

	continue(): Promise<void> { return this.threadCommand("continue"); }
	pause(): Promise<void> { return this.threadCommand("pause"); }
	stepOver(granularity?: DebugSteppingGranularity): Promise<void> { return this.threadCommand("next", granularity); }
	stepInto(granularity?: DebugSteppingGranularity): Promise<void> { return this.threadCommand("stepIn", granularity); }
	stepOut(granularity?: DebugSteppingGranularity): Promise<void> { return this.threadCommand("stepOut", granularity); }

	async restart(): Promise<void> {
		if (!this._capabilities.supportsRestart) throw new Error("The Debug Adapter does not support restart requests");
		this.setState("running");
		await this.request("restart");
	}

	async threads(): Promise<readonly IDebugThread[]> {
		const body = record((await this.request("threads")).body, "threads body");
		return Object.freeze(array(body.threads, "threads").map((value, index) => thread(value, index)));
	}

	selectThread(threadId: number): void {
		this.setSelectedThread(integer(threadId, "threadId"));
	}

	private setSelectedThread(threadId: number | undefined): void {
		if (this._threadId === threadId) return;
		this._threadId = threadId;
		this.threadEmitter.fire(threadId);
	}

	async stackTrace(threadId?: number): Promise<readonly IDebugStackFrame[]> {
		const selectedThreadId = threadId === undefined ? await this.requireThreadId() : integer(threadId, "threadId");
		this.setSelectedThread(selectedThreadId);
		const body = record((await this.request("stackTrace", { threadId: selectedThreadId, startFrame: 0, levels: 100 })).body, "stackTrace body");
		return array(body.stackFrames, "stackFrames").map((value, index) => ({ ...stackFrame(value, index, this.workspace), threadId: selectedThreadId }));
	}

	async scopes(frameId: number): Promise<readonly IDebugScope[]> {
		const body = record((await this.request("scopes", { frameId: integer(frameId, 'frameId') })).body, "scopes body");
		return array(body.scopes, "scopes").map((value, index) => scope(value, index));
	}

	async variables(reference: number): Promise<readonly IDebugVariable[]> {
		const body = record((await this.request("variables", { variablesReference: reference })).body, "variables body");
		return array(body.variables, "variables").map((value, index) => variable(value, index));
	}

	async setVariable(variablesReference: number, name: string, value: string): Promise<IDebugVariable> {
		if (!this._capabilities.supportsSetVariable) {
			throw new Error(localize("debug.setVariableUnsupported", "The debug adapter does not support changing variables."));
		}
		if (this._state !== "stopped") {
			throw new Error(localize("debug.setVariableNotStopped", "Pause execution before changing a variable."));
		}
		if (value.length > 32_768 || value.includes("\0")) {
			throw new TypeError(localize("debug.invalidVariableValue", "The variable value must contain at most 32768 characters and no null characters."));
		}
		const body = record((await this.request("setVariable", { variablesReference: positiveInteger(variablesReference, "variablesReference"), name, value })).body, "setVariable body");
		// In a setVariable response an omitted child reference denotes a scalar.
		return variable({ ...body, name, variablesReference: body.variablesReference === undefined ? 0 : body.variablesReference }, 0);
	}

	async evaluate(expression: string, frameId: number | undefined, context: DebugEvaluateContext): Promise<IDebugEvaluateResult> {
		const normalized = expression.trim();
		if (!normalized || normalized.length > 32_768 || normalized.includes("\0")) throw new TypeError("Debug expression must contain 1 to 32768 characters");
		const body = record((await this.request("evaluate", { expression: normalized, context, ...(frameId === undefined ? {} : { frameId: integer(frameId, "frameId") }) })).body, "evaluate body");
		return Object.freeze({ result: string(body.result, "evaluate result"), variablesReference: positiveInteger(body.variablesReference, "evaluate variablesReference", true), ...(typeof body.type === "string" ? { type: body.type } : {}) });
	}

	async source(sourceValue: IDebugSource): Promise<IDebugSourceContent> {
		const sourceReference = positiveInteger(sourceValue.sourceReference, "sourceReference");
		const body = record((await this.request("source", { source: sourceValue, sourceReference })).body, "source body");
		return Object.freeze({ content: string(body.content, "source content"), ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}) });
	}

	async setExceptionBreakpoints(filters: readonly string[]): Promise<void> {
		const supported = new Set(this._capabilities.exceptionBreakpointFilters.map(candidate => candidate.filter));
		const normalized = Object.freeze([...new Set((this.resolvedConfiguration.arguments.noDebug === true ? [] : filters).map(filter => string(filter, "exception breakpoint filter").trim()).filter(Boolean))]);
		const unknown = normalized.find(filter => !supported.has(filter));
		if (unknown) throw new Error(`The Debug Adapter does not provide exception breakpoint filter '${unknown}'`);
		await this.request("setExceptionBreakpoints", { filters: normalized });
	}

	async dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number): Promise<IDataBreakpointInfoResponse> {
		if (!this._capabilities.supportsDataBreakpoints) throw new Error(localize("debug.unsupportedDataBreakpoints", "Debug Adapter does not support data breakpoints"));
		if (this._state !== "stopped") throw new Error(localize("debug.dataRequiresPause", "Data breakpoints require the paused session that identified the variable."));
		const argumentsValue: Record<string, unknown> = { name: string(name, "data breakpoint name") };
		if (variablesReference !== undefined) argumentsValue.variablesReference = positiveInteger(variablesReference, "variablesReference");
		if (frameId !== undefined) argumentsValue.frameId = integer(frameId, "frameId");
		const response = await this.request("dataBreakpointInfo", argumentsValue);
		const body = record(response.body, "dataBreakpointInfo");
		const dataId = body.dataId === null ? null : string(body.dataId, "dataId");
		const accessTypes = body.accessTypes === undefined ? ["write"] : array(body.accessTypes, "accessTypes");
		if (!accessTypes.every(type => type === "read" || type === "write" || type === "readWrite")) throw new TypeError("Invalid data breakpoint access types");
		return { dataId, description: string(body.description, "description"), canPersist: body.canPersist === true, accessTypes: Object.freeze(accessTypes as DataBreakpointAccessType[]) };
	}

	async disassemble(memoryReference: string, offset: number, instructionOffset: number, instructionCount: number): Promise<readonly IDisassembledInstruction[]> {
		if (!this._capabilities.supportsDisassembleRequest) {
			throw new Error(localize("debug.disassemblyUnsupported", "The debug adapter does not support disassembly."));
		}
		if (this._state !== "stopped") {
			throw new Error(localize("debug.disassemblyRequiresPause", "Pause debugging to view disassembly."));
		}
		if (!memoryReference.trim() || memoryReference.includes("\0") || memoryReference.length > 32_768) {
			throw new TypeError("Invalid disassembly memory reference");
		}
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(instructionOffset) || !Number.isSafeInteger(instructionCount) || instructionCount <= 0 || instructionCount > 200) {
			throw new TypeError("Disassembly offsets must be integers and instruction count must be between 1 and 200");
		}
		const response = await this.request("disassemble", { memoryReference, offset, instructionOffset, instructionCount, resolveSymbols: true });
		const instructions = array(record(response.body, "disassemble").instructions, "instructions");
		if (instructions.length > instructionCount) { throw new TypeError("Disassembly returned more instructions than requested"); }
		let location: IDebugSource | undefined;
		return Object.freeze(instructions.map((value, index) => {
			const item = record(value, `instructions[${index}]`);
			const instruction: { -readonly [K in keyof IDisassembledInstruction]: IDisassembledInstruction[K] } = {
				address: string(item.address, "instruction address"),
				instruction: string(item.instruction, "instruction"),
			};
			if (!instruction.address) { throw new TypeError("Instruction address must not be empty"); }
			if (item.instructionBytes !== undefined) { instruction.instructionBytes = string(item.instructionBytes, "instructionBytes"); }
			if (item.symbol !== undefined) { instruction.symbol = string(item.symbol, "symbol"); }
			// DAP permits the source to be omitted when adjacent instructions share a file.
			if (item.location !== undefined) { location = source(item.location, "instruction location", this.workspace); }
			if (location) { instruction.location = location; }
			if (item.line !== undefined) { instruction.line = positiveInteger(item.line, "instruction line", true); }
			if (item.column !== undefined) { instruction.column = positiveInteger(item.column, "instruction column", true); }
			if (item.endLine !== undefined) { instruction.endLine = positiveInteger(item.endLine, "instruction end line", true); }
			if (item.endColumn !== undefined) { instruction.endColumn = positiveInteger(item.endColumn, "instruction end column", true); }
			if (item.presentationHint !== undefined) {
				if (item.presentationHint !== "normal" && item.presentationHint !== "invalid") { throw new TypeError("Invalid instruction presentation hint"); }
				instruction.presentationHint = item.presentationHint;
			}
			return Object.freeze(instruction);
		}));
	}

	syncBreakpoints(): Promise<void> {
		// DAP replaces each source's entire breakpoint set. Keep edits in order so
		// a slower previous request cannot reinstall a removed or disabled point.
		return this.breakpointSync.schedule(() => this.sendBreakpoints());
	}

	private async sendBreakpoints(): Promise<void> {
		if (this.resolvedConfiguration.arguments.noDebug === true) return;
		const enabled = new Set([...this.breakpoints(), ...this.additionalBreakpoints?.() ?? []].filter(point => point.enabled).map(point => point.id));
		for (const id of this.protocolBreakpoints.keys()) if (!enabled.has(id)) this.protocolBreakpoints.delete(id);
		const addresses = new Map<string, Readonly<Record<string, unknown>>>();
		const supportedBreakpoints = this.breakpoints().filter(breakpoint => {
			const address = this.breakpointSource(breakpoint.resource);
			if (!breakpoint.enabled || !address) return false;
			addresses.set(address.key, address.source);
			return true;
		}).filter(breakpoint => {
			const unsupported = breakpoint.logMessage && !this._capabilities.supportsLogPoints ? localize("debug.unsupportedLogpoints", "Debug Adapter does not support logpoints")
				: breakpoint.condition && !this._capabilities.supportsConditionalBreakpoints ? localize("debug.unsupportedConditionalBreakpoints", "Debug Adapter does not support conditional breakpoints")
					: breakpoint.hitCondition && !this._capabilities.supportsHitConditionalBreakpoints ? localize("debug.unsupportedHitConditions", "Debug Adapter does not support hit conditions") : undefined;
			if (unsupported) {
				this.updateBreakpoints?.([{ id: breakpoint.id, verified: false, message: unsupported }]);
				return false;
			}
			return true;
		});
		const groups = groupByMap(supportedBreakpoints, breakpoint => this.breakpointSource(breakpoint.resource)!.key);
		const sources = new Set([...this.syncedBreakpointSources.keys(), ...groups.keys()]);
		for (const path of sources) {
			const breakpoints = groups.get(path) ?? [];
			const source = addresses.get(path) ?? this.syncedBreakpointSources.get(path)!;
			const response = await this.request("setBreakpoints", {
				source, breakpoints: breakpoints.map(breakpoint => ({
					line: breakpoint.lineNumber,
					...(breakpoint.columnNumber === undefined ? {} : { column: breakpoint.columnNumber }),
					...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
					...(breakpoint.hitCondition === undefined ? {} : { hitCondition: breakpoint.hitCondition }),
					...(breakpoint.logMessage === undefined ? {} : { logMessage: breakpoint.logMessage }),
				}))
			});
			const current = new Map(this.breakpoints().map(breakpoint => [breakpoint.id, breakpoint]));
			// Verification changes from another session do not change the request.
			// Only apply a reply while the user's breakpoint configuration matches.
			this.rememberProtocolBreakpoints(response.body, breakpoints);
			this.updateBreakpoints?.(breakpointUpdates(response.body, breakpoints).filter(update => {
				const requested = breakpoints.find(breakpoint => breakpoint.id === update.id)!;
				const latest = current.get(update.id);
				return latest?.enabled === requested.enabled && latest.lineNumber === requested.lineNumber && latest.columnNumber === requested.columnNumber
					&& latest.condition === requested.condition && latest.hitCondition === requested.hitCondition && latest.logMessage === requested.logMessage;
			}));
			if (breakpoints.length === 0 && ![...current.values()].some(point => this.breakpointSource(point.resource)?.key === path)) this.syncedBreakpointSources.delete(path);
			else this.syncedBreakpointSources.set(path, source);
		}
		await this.sendAdditionalBreakpoints();
	}

	private breakpointSource(resource: URI): { readonly key: string; readonly source: Readonly<Record<string, unknown>>; } | undefined {
		if (resource.scheme === 'debug') {
			const query = new URLSearchParams(resource.query);
			const reference = query.get('ref');
			if (query.get('session') !== this.id || !reference || !/^[1-9]\d*$/.test(reference) || !Number.isSafeInteger(Number(reference))) return undefined;
			return { key: resource.toString(), source: { sourceReference: Number(reference) } };
		}
		if (resource.scheme !== 'file' && !isRemoteResource(resource)) return undefined;
		const path = resource.scheme === 'file' ? resource.fsPath : resource.path;
		return { key: path, source: { path } };
	}

	private async sendAdditionalBreakpoints(): Promise<void> {
		const configured = this.additionalBreakpoints?.() ?? [];
		const families = [
			{ kind: "function", command: "setFunctionBreakpoints", supported: this._capabilities.supportsFunctionBreakpoints, reason: localize("debug.unsupportedFunctionBreakpoints", "Debug Adapter does not support function breakpoints") },
			{ kind: "data", command: "setDataBreakpoints", supported: this._capabilities.supportsDataBreakpoints, reason: localize("debug.unsupportedDataBreakpoints", "Debug Adapter does not support data breakpoints") },
			{ kind: "instruction", command: "setInstructionBreakpoints", supported: this._capabilities.supportsInstructionBreakpoints, reason: localize("debug.unsupportedInstructionBreakpoints", "Debug Adapter does not support instruction breakpoints") },
		] as const;
		for (const family of families) {
			const candidates = configured.filter(point => {
				if (point.kind !== family.kind || !point.enabled) return false;
				if (point.kind === "data") return point.canPersist ? point.adapterType === this.resolvedConfiguration.type : point.sessionId === this.id;
				if (point.kind === "instruction") return point.sessionId === this.id;
				return true;
			});
			if (!family.supported) {
				this.updateBreakpoints?.(candidates.map(point => ({ id: point.id, verified: false, message: family.reason })));
				continue;
			}
			const points = candidates.filter(point => {
				const unsupported = point.condition && !this._capabilities.supportsConditionalBreakpoints
					? localize("debug.unsupportedConditionalBreakpoints", "Debug Adapter does not support conditional breakpoints")
					: point.hitCondition && !this._capabilities.supportsHitConditionalBreakpoints
						? localize("debug.unsupportedHitConditions", "Debug Adapter does not support hit conditions") : undefined;
				if (!unsupported) return true;
				this.updateBreakpoints?.([{ id: point.id, verified: false, message: unsupported }]);
				return false;
			});
			const response = await this.request(family.command, { breakpoints: points.map(additionalBreakpointArguments) });
			const current = new Map((this.additionalBreakpoints?.() ?? []).map(point => [point.id, point]));
			this.rememberProtocolBreakpoints(response.body, points);
			this.updateBreakpoints?.(breakpointUpdates(response.body, points).filter(update => {
				const latest = current.get(update.id);
				const requested = points.find(point => point.id === update.id)!;
				return latest?.enabled === true && JSON.stringify(additionalBreakpointArguments(latest)) === JSON.stringify(additionalBreakpointArguments(requested));
			}));
		}
	}

	async disconnect(): Promise<void> {
		if (!this.isDisposed && this._state !== "terminated" && this._state !== "error") {
			try { await this.request("disconnect", { restart: false, ...(this._capabilities.supportsTerminate ? { terminateDebuggee: true } : {}) }); } catch (error) { this.emitOutput(`Debug disconnect failed: ${getErrorMessage(error)}\n`); }
		}
		await this.closeProcess();
		this.setState("terminated");
		this.dispose();
	}

	private async initialize(launchArguments: Readonly<Record<string, unknown>>): Promise<void> {
		const initialized = await this.request("initialize", { clientID: "ash", clientName: "Ash Code", adapterID: this.resolvedConfiguration.type, pathFormat: "path", linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsVariablePaging: true, supportsMemoryReferences: true, supportsRunInTerminalRequest: Boolean(this.runInTerminal), supportsArgsCanBeInterpretedByShell: Boolean(this.runInTerminal), supportsStartDebuggingRequest: Boolean(this.startDebugging) });
		const capabilities = initialized.body && typeof initialized.body === "object" ? initialized.body as Record<string, unknown> : {};
		this.supportsConfigurationDone = capabilities.supportsConfigurationDoneRequest === true;
		this._capabilities = Object.freeze({
			supportsRestart: capabilities.supportsRestartRequest === true,
			supportsTerminate: capabilities.supportsTerminateRequest === true || capabilities.supportTerminateDebuggee === true,
			supportsSetVariable: capabilities.supportsSetVariable === true,
			supportsConditionalBreakpoints: capabilities.supportsConditionalBreakpoints === true,
			supportsHitConditionalBreakpoints: capabilities.supportsHitConditionalBreakpoints === true,
			supportsLogPoints: capabilities.supportsLogPoints === true,
			supportsFunctionBreakpoints: capabilities.supportsFunctionBreakpoints === true,
			supportsDataBreakpoints: capabilities.supportsDataBreakpoints === true,
			supportsInstructionBreakpoints: capabilities.supportsInstructionBreakpoints === true,
			supportsDisassembleRequest: capabilities.supportsDisassembleRequest === true,
			supportsSteppingGranularity: capabilities.supportsSteppingGranularity === true,
			exceptionBreakpointFilters: exceptionBreakpointFilters(capabilities.exceptionBreakpointFilters),
		});
		const launch = this.request(this.resolvedConfiguration.request, launchArguments);
		void launch.catch(error => { this.initializedRejecter?.(error instanceof Error ? error : new Error(getErrorMessage(error))); });
		await withTimeout(this.initializedPromise, REQUEST_TIMEOUT_MS, "Debug Adapter did not emit the initialized event");
		await this.syncBreakpoints();
		const configuredExceptionBreakpoints = this.exceptionBreakpoints?.() ?? [];
		await this.setExceptionBreakpoints(configuredExceptionBreakpoints.length > 0 ? configuredExceptionBreakpoints : this._capabilities.exceptionBreakpointFilters.filter(filter => filter.default).map(filter => filter.filter));
		if (this.supportsConfigurationDone) await this.request("configurationDone");
		await launch;
		if (this._state === "starting") this.setState("running");
	}

	private async threadCommand(command: string, granularity?: DebugSteppingGranularity): Promise<void> {
		if (granularity && !this._capabilities.supportsSteppingGranularity) {
			throw new Error(localize("debug.instructionStepUnsupported", "The debug adapter does not support instruction stepping."));
		}
		const previousState = this._state;
		if (command !== "pause") this.setState("running");
		try { await this.request(command, { threadId: await this.requireThreadId(), ...(granularity ? { granularity } : {}) }); }
		catch (error) { if (command !== "pause" && this._state === "running") this.setState(previousState); throw error; }
	}

	private async requireThreadId(): Promise<number> {
		if (this._threadId !== undefined) return this._threadId;
		const first = (await this.threads())[0];
		if (!first) throw new Error("The Debug Adapter did not report any threads");
		this.setSelectedThread(first.id);
		return first.id;
	}

	private request(command: string, args?: unknown): Promise<DapResponse> {
		if (this.processClose) { return Promise.reject(new CancellationError()); }
		if (!this.transport || !this.adapterStarted) throw new Error("Debug Adapter has not started");
		const sequence = this.requestSequence++;
		const request: DapRequest = { seq: sequence, type: "request", command, ...(args === undefined ? {} : { arguments: args }) };
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(sequence);
				reject(new Error(`Debug adapter '${command}' request timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(sequence, { resolve, reject, timeout });
			void this.sendMessage(request, sequence).catch(error => {
				const pending = this.pending.get(sequence);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pending.delete(sequence);
				pending.reject(error instanceof CancellationError ? error : new Error(`Could not send Debug Adapter request: ${getErrorMessage(error)}`));
			});
		});
	}

	private async callTrackers(invoke: (tracker: IDebugAdapterTracker) => void | PromiseLike<void>): Promise<void> {
		for (const tracker of this.trackers) {
			if (this.isDisposed) { return; }
			try { await invoke(tracker); }
			catch (error) { this.emitOutput(localize('debug.adapterTrackerFailed', 'Debug Adapter tracker failed: {0}', getErrorMessage(error)) + '\n'); }
		}
	}

	private trackReceivedMessage(message: unknown): void {
		if (!this.trackers.length || this.trackerMessagesStopped) { return; }
		if (this.queuedTrackerMessages >= 2048) {
			this.trackerMessagesStopped = true;
			this.receivedTrackerMessages.clearPending();
			this.emitOutput(localize('debug.adapterTrackerQueueExceeded', 'Debug Adapter tracker message queue exceeded its limit; message observation stopped.') + '\n');
			return;
		}
		this.queuedTrackerMessages++;
		// Serial callback delivery avoids exhausting the Host invocation budget.
		// The reader still pairs responses immediately, including requests made
		// by the callback currently waiting at the head of this queue.
		void this.receivedTrackerMessages.scheduleSkipIfCleared(() => this.callTrackers(tracker => tracker.onDidSendMessage?.(message))).finally(() => { this.queuedTrackerMessages--; });
	}

	private async sendMessage(message: unknown, pendingSequence?: number): Promise<void> {
		await this.callTrackers(tracker => tracker.onWillReceiveMessage?.(message));
		this.assertNotDisposed();
		if (this.processClose) { throw new CancellationError(); }
		if (pendingSequence !== undefined && !this.pending.has(pendingSequence)) { return; }
		await this.transport!.send(message);
	}

	private async reportTrackerError(error: unknown): Promise<void> {
		if (this.trackerErrorReported) { return; }
		this.trackerErrorReported = true;
		await this.callTrackers(tracker => tracker.onError?.(error instanceof Error ? error : new Error(getErrorMessage(error))));
	}

	private async stopTrackers(): Promise<void> {
		if (this.trackersStopping) { return; }
		this.trackersStopping = true;
		if (!this.isDisposed) { await this.receivedTrackerMessages.scheduleSkipIfCleared(() => { }); }
		await this.callTrackers(tracker => tracker.onWillStopSession?.());
	}

	private async endTrackers(): Promise<void> {
		if (this.trackersEnded) { return; }
		this.trackersEnded = true;
		await this.callTrackers(tracker => tracker.onExit?.(this.adapterExitCode, undefined));
	}

	private async poll(): Promise<void> {
		while (this.polling && !this.isDisposed) {
			try {
				const read = await this.transport!.read(this.readSequence, 128);
				if (this.isDisposed || !this.polling) return;
				if (read.outputGap) throw new Error("Debug Adapter output exceeded the retained buffer");
				this.readSequence = read.nextSequence;
				if (read.stderr) this.emitOutput(read.stderr);
				if (read.protocolError) throw new Error(read.protocolError);
				for (const entry of read.messages) {
					// A callback can await another DAP request. Keep the reader free to
					// receive that response while the independent Host invocation runs.
					this.trackReceivedMessage(entry.message);
					this.acceptMessage(entry.message);
				}
				if (read.exited) {
					this.adapterExitCode = read.exitCode ?? undefined;
					this._reason = `Debug adapter exited${read.exitCode === null ? "" : ` with code ${read.exitCode}`}`;
					this.setState("terminated");
					break;
				}
			} catch (error) {
				this._reason = getErrorMessage(error);
				void this.reportTrackerError(error);
				this.setState("error");
				break;
			}
			await timeout(POLL_DELAY_MS);
		}
		this.polling = false;
	}

	private acceptMessage(value: unknown): void {
		const messageValue = record(value, "DAP message");
		const kind = string(messageValue.type, "DAP message type");
		if (kind === "response") { this.acceptResponse(response(messageValue)); return; }
		if (kind === "event") { this.acceptEvent(event(messageValue)); return; }
		if (kind === "request") void this.answerReverseRequest(messageValue);
	}

	private acceptResponse(responseValue: DapResponse): void {
		const pending = this.pending.get(responseValue.request_seq);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pending.delete(responseValue.request_seq);
		if (responseValue.success) pending.resolve(responseValue);
		else pending.reject(new Error(responseValue.message || `Debug Adapter '${responseValue.command}' request failed`));
	}

	private acceptEvent(eventValue: DapEvent): void {
		const body = eventValue.body && typeof eventValue.body === "object" ? eventValue.body as Record<string, unknown> : {};
		if (eventValue.event === "output") {
			const output = typeof body.output === "string" ? body.output : "";
			if (output) this.emitOutput(output);
			return;
		}
		if (eventValue.event === "initialized") {
			this.initializedResolver?.();
			this.initializedResolver = undefined;
			this.initializedRejecter = undefined;
			return;
		}
		if (eventValue.event === "stopped") {
			this.setSelectedThread(Number.isSafeInteger(body.threadId) ? body.threadId as number : undefined);
			this._reason = typeof body.reason === "string" ? body.reason : "paused";
			this.setState("stopped");
			return;
		}
		if (eventValue.event === "continued") { this.setState("running"); return; }
		if (eventValue.event === "terminated" || eventValue.event === "exited") {
			this.setState("terminated");
			return;
		}
		if (eventValue.event === "breakpoint") {
			if (!['new', 'changed', 'removed'].includes(String(body.reason))) return;
			const value = body.breakpoint;
			if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
			const point = value as Record<string, unknown>;
			if (point.id !== undefined && !Number.isSafeInteger(point.id)) { return; }
			let matched = false;
			for (const [id, binding] of this.protocolBreakpoints) {
				if (point.id === undefined) break;
				if ((binding.value as { id?: unknown; }).id !== point.id) { continue; }
				matched = true;
				if (this.getDebugProtocolBreakpoint(id) === undefined) { this.protocolBreakpoints.delete(id); continue; }
				if (body.reason === 'removed') {
					const point = this.breakpoints().find(point => point.id === id);
					const address = point && this.breakpointSource(point.resource);
					this.protocolBreakpoints.delete(id);
					this.removeBreakpoint?.(id);
					if (address && !this.breakpoints().some(point => this.breakpointSource(point.resource)?.key === address.key)) this.syncedBreakpointSources.delete(address.key);
					continue;
				}
				else if (body.reason === 'changed' || body.reason === 'new') {
					this.protocolBreakpoints.set(id, { signature: binding.signature, value: point });
				}
				this.updateBreakpoints?.([{ id, verified: body.reason !== 'removed' && point.verified === true, ...(typeof point.message === 'string' ? { message: point.message } : {}) }]);
			}
			if (!matched && body.reason === 'new' && point.source && typeof point.source === 'object' && !Array.isArray(point.source)
				&& Number.isSafeInteger(point.line) && (point.line as number) > 0
				&& (point.column === undefined || Number.isSafeInteger(point.column) && (point.column as number) > 0)) {
				const location = source(point.source, 'breakpoint source', this.workspace);
				if (!location?.resource && !(location?.sourceReference && location.sourceReference > 0)) return;
				const added = this.addBreakpoint?.(location, point.line as number, point.column as number | undefined);
				if (added) {
					// No setBreakpoints request preceded this point; retain its address for a later user removal.
					const address = this.breakpointSource(added.resource);
					if (address) this.syncedBreakpointSources.set(address.key, address.source);
					this.protocolBreakpoints.set(added.id, { signature: breakpointSignature(added), value: point });
					this.updateBreakpoints?.([{ id: added.id, verified: point.verified === true, ...(typeof point.message === 'string' ? { message: point.message } : {}) }]);
				}
			}
			return;
		}
		if (["thread", "process", "module", "progressStart", "progressUpdate", "progressEnd", "invalidated", "memory"].includes(eventValue.event)) return;
		this.customEventEmitter.fire({ event: eventValue.event, ...(eventValue.body === undefined ? {} : { body: eventValue.body }) });
	}

	private async answerReverseRequest(request: Record<string, unknown>): Promise<void> {
		const sequence = positiveInteger(request.seq, "reverse request seq", true);
		const command = string(request.command, "reverse request command");
		try {
			let body: Readonly<Record<string, unknown>> | undefined;
			if (command === 'runInTerminal' && this.runInTerminal) body = await this.runInTerminal(request.arguments);
			else if (command === 'startDebugging' && this.startDebugging) await this.startDebugging(request.arguments);
			else throw new Error(`Ash does not support Debug Adapter reverse request '${command}'`);
			await this.sendMessage({ seq: this.requestSequence++, type: "response", request_seq: sequence, success: true, command, ...(body === undefined ? {} : { body }) });
		} catch (error) {
			await this.sendMessage({ seq: this.requestSequence++, type: "response", request_seq: sequence, success: false, command, message: getErrorMessage(error) }).catch(sendError => this.emitOutput(`Could not answer Debug Adapter request: ${getErrorMessage(sendError)}\n`));
		}
	}

	private emitOutput(value: string): void {
		if (!value) return;
		this.retainedOutput = `${this.retainedOutput}${value}`.slice(-128_000);
		this.outputEmitter.fire(value);
	}

	private setState(state: DebugSessionState): void {
		if (state === this._state) return;
		this._state = state;
		this.stateEmitter.fire(state);
		if (state === "terminated" || state === "error") {
			const error = new Error(this._reason ?? `Debug session ${state}`);
			this.initializedRejecter?.(error);
			this.initializedRejecter = undefined;
			void this.closeProcess();
		}
	}

	private closeProcess(): Promise<void> {
		// A start can return its process after cancellation. Do not memoize the
		// absent process: that late handle must still be released by start().
		const transport = this.transport;
		if (!transport) { return Promise.resolve(); }
		if (this.isDisposed || this.trackers.length === 0) {
			this.polling = false;
			return this.processClose ??= transport.close().catch(() => { }).finally(() => { this.transport = undefined; });
		}
		return this.processClose ??= (async () => {
			await this.stopTrackers();
			this.polling = false;
			await transport.close().catch(() => { /* Process may already be gone. */ });
			await this.endTrackers();
		})().finally(() => { this.transport = undefined; });
	}
}

function response(value: Record<string, unknown>): DapResponse {
	return { seq: positiveInteger(value.seq, "response seq", true), type: "response", request_seq: positiveInteger(value.request_seq, "response request_seq"), success: boolean(value.success, "response success"), command: string(value.command, "response command"), ...(typeof value.message === "string" ? { message: value.message } : {}), ...(value.body === undefined ? {} : { body: value.body }) };
}

function event(value: Record<string, unknown>): DapEvent {
	return { seq: positiveInteger(value.seq, "event seq", true), type: "event", event: string(value.event, "event name"), ...(value.body === undefined ? {} : { body: value.body }) };
}

function stackFrame(value: unknown, index: number, workspace: URI | undefined): IDebugStackFrame {
	const frame = record(value, `stackFrames[${index}]`);
	return { id: integer(frame.id, `stackFrames[${index}].id`), name: string(frame.name, `stackFrames[${index}].name`), lineNumber: positiveInteger(frame.line, `stackFrames[${index}].line`, true), columnNumber: positiveInteger(frame.column, `stackFrames[${index}].column`, true), ...(frame.source === undefined ? {} : { source: source(frame.source, `stackFrames[${index}].source`, workspace) }), ...(frame.instructionPointerReference === undefined ? {} : { instructionPointerReference: string(frame.instructionPointerReference, "instructionPointerReference") }) };
}

function thread(value: unknown, index: number): IDebugThread {
	const input = record(value, `threads[${index}]`);
	return Object.freeze({ id: integer(input.id, `threads[${index}].id`), name: string(input.name, `threads[${index}].name`) });
}

function source(value: unknown, path: string, workspace: URI | undefined): IDebugStackFrame["source"] {
	const input = record(value, path);
	const adapterPath = typeof input.path === "string" ? input.path : undefined;
	const resource = adapterPath ? sourceResource(workspace, adapterPath) : undefined;
	return { ...(typeof input.name === "string" ? { name: input.name } : {}), ...(adapterPath ? { path: adapterPath } : {}), ...(resource ? { resource } : {}), ...(Number.isSafeInteger(input.sourceReference) ? { sourceReference: input.sourceReference as number } : {}) };
}

function scope(value: unknown, index: number): IDebugScope {
	const input = record(value, `scopes[${index}]`);
	return { name: string(input.name, `scopes[${index}].name`), variablesReference: positiveInteger(input.variablesReference, `scopes[${index}].variablesReference`, true), expensive: typeof input.expensive === "boolean" ? input.expensive : false };
}

function variable(value: unknown, index: number): IDebugVariable {
	const input = record(value, `variables[${index}]`);
	const hint = input.presentationHint === undefined ? undefined : record(input.presentationHint, `variables[${index}].presentationHint`);
	return {
		name: string(input.name, `variables[${index}].name`),
		value: string(input.value, `variables[${index}].value`),
		variablesReference: positiveInteger(input.variablesReference, `variables[${index}].variablesReference`, true),
		...(typeof input.type === "string" ? { type: input.type } : {}),
		...(hint ? {
			presentationHint: {
				...(hint.attributes === undefined ? {} : { attributes: array(hint.attributes, "presentationHint.attributes").map(attribute => string(attribute, "presentationHint attribute")) }),
				...(hint.lazy === undefined ? {} : { lazy: boolean(hint.lazy, "presentationHint.lazy") }),
			}
		} : {}),
	};
}

function exceptionBreakpointFilters(value: unknown): readonly IDebugExceptionBreakpointFilter[] {
	if (value === undefined) return Object.freeze([]);
	return Object.freeze(array(value, "exceptionBreakpointFilters").map((candidate, index) => {
		const input = record(candidate, `exceptionBreakpointFilters[${index}]`);
		return Object.freeze({ filter: string(input.filter, `exceptionBreakpointFilters[${index}].filter`), label: string(input.label, `exceptionBreakpointFilters[${index}].label`), default: input.default === true, ...(typeof input.description === "string" ? { description: input.description } : {}) });
	}));
}

function additionalBreakpointArguments(point: Exclude<DebugBreakpoint, IDebugBreakpoint>): Record<string, unknown> {
	const argumentsValue: Record<string, unknown> = {};
	switch (point.kind) {
		case "function": argumentsValue.name = point.name; break;
		case "data": argumentsValue.dataId = point.dataId; argumentsValue.accessType = point.accessType; break;
		case "instruction":
			argumentsValue.instructionReference = point.instructionReference;
			if (point.offset !== undefined) argumentsValue.offset = point.offset;
			break;
	}
	if (point.condition !== undefined) argumentsValue.condition = point.condition;
	if (point.hitCondition !== undefined) argumentsValue.hitCondition = point.hitCondition;
	return argumentsValue;
}

function breakpointUpdates(value: unknown, requested: readonly IBaseBreakpoint[]): readonly { readonly id: string; readonly verified: boolean; readonly message?: string; }[] {
	if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).breakpoints)) return [];
	const received = (value as Record<string, unknown>).breakpoints as readonly unknown[];
	return Object.freeze(requested.flatMap((breakpoint, index) => {
		const candidate = received[index];
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
		const input = candidate as Record<string, unknown>;
		return [Object.freeze({ id: breakpoint.id, verified: input.verified === true, ...(typeof input.message === "string" ? { message: input.message } : {}) })];
	}));
}

function record(value: unknown, path: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, path: string): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`); return value; }
function string(value: unknown, path: string): string { if (typeof value !== "string") throw new TypeError(`${path} must be a string`); return value; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`); return value; }
function positiveInteger(value: unknown, path: string, allowZero = false): number { if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) throw new TypeError(`${path} must be ${allowZero ? "non-negative" : "positive"}`); return value as number; }
function integer(value: unknown, path: string): number { if (!Number.isSafeInteger(value)) throw new TypeError(localize('debug.invalidIdentifier', '{0} must be an integer.', path)); return value as number; }
function withTimeout<T>(promise: Promise<T>, milliseconds: number, timeoutMessage: string): Promise<T> { return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(timeoutMessage)), milliseconds); promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); }); }); }

function sourceResource(workspace: URI | undefined, adapterPath: string): URI | undefined {
	if (!workspace || workspace.scheme === "file") {
		try { return URI.file(/^(?:[a-z]:[\\/]|\\\\)/i.test(adapterPath) ? adapterPath.replaceAll('\\', '/') : adapterPath); } catch { return undefined; }
	}
	if (!isRemoteResource(workspace)) return undefined;
	if (!adapterPath.startsWith("/") || adapterPath.includes("\0")) return undefined;
	const segments = adapterPath.split("/");
	if (adapterPath !== "/" && (adapterPath.endsWith("/") || segments.slice(1).some(segment => segment.length === 0 || segment === "." || segment === ".."))) return undefined;
	return workspace.with({ path: adapterPath });
}


function breakpointSignature(point: IBaseBreakpoint): string {
	const { verified: _verified, message: _message, ...configuration } = point;
	return JSON.stringify(configuration);
}

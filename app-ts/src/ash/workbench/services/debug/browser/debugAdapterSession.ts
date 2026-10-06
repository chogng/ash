import { TaskQueue, timeout } from "../../../../base/common/async.js";
import { getErrorMessage } from "../../../../base/common/errors.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { localize } from "../../../../nls.js";
import { type IDebugAdapterProcessService } from "../../../../platform/debug/common/debugAdapterProcessService.js";
import { isRemoteResource } from "../../../../platform/remote/common/remote.js";
import { type DebugBreakpoint, type DebugEvaluateContext, type DebugSessionState, type DebugSteppingGranularity, type IDisassembledInstruction, type IBaseBreakpoint, type IDataBreakpointInfoResponse, type DataBreakpointAccessType, type IDebugBreakpoint, type IDebugConfiguration, type IDebugEvaluateResult, type IDebugExceptionBreakpointFilter, type IDebugScope, type IDebugSession, type IDebugSessionCapabilities, type IDebugSource, type IDebugSourceContent, type IDebugStackFrame, type IDebugThread, type IDebugVariable } from "../common/debugService.js";

interface DapRequest { readonly seq: number; readonly type: "request"; readonly command: string; readonly arguments?: unknown; }
interface DapResponse { readonly seq: number; readonly type: "response"; readonly request_seq: number; readonly success: boolean; readonly command: string; readonly message?: string; readonly body?: unknown; }
interface DapEvent { readonly seq: number; readonly type: "event"; readonly event: string; readonly body?: unknown; }

const POLL_DELAY_MS = 40;
const REQUEST_TIMEOUT_MS = 15_000;

export interface DebugAdapterSessionStartOptions {
	readonly configuration: IDebugConfiguration;
	readonly processService: IDebugAdapterProcessService;
	readonly breakpoints: () => readonly IDebugBreakpoint[];
	readonly additionalBreakpoints?: () => readonly Exclude<DebugBreakpoint, IDebugBreakpoint>[];
	readonly workspace: URI;
	readonly runInTerminal?: (argumentsValue: unknown) => Promise<Readonly<Record<string, unknown>>>;
	readonly updateBreakpoints?: (updates: readonly { readonly id: string; readonly verified: boolean; readonly message?: string; }[]) => void;
	readonly exceptionBreakpoints?: () => readonly string[];
}

/** One initialized DAP client session over the platform process boundary. */
export class DebugAdapterSession extends Disposable implements IDebugSession {
	private readonly stateEmitter = this._register(new Emitter<DebugSessionState>());
	private readonly outputEmitter = this._register(new Emitter<string>());
	private retainedOutput = "";
	private readonly pending = new Map<number, { readonly resolve: (response: DapResponse) => void; readonly reject: (error: Error) => void; readonly timeout: ReturnType<typeof setTimeout>; }>();
	private readonly sessionId: string;
	private requestSequence = 1;
	private readSequence = 0;
	private polling = false;
	private _state: DebugSessionState = "starting";
	private _reason: string | undefined;
	private _threadId: number | undefined;
	private initializedResolver: (() => void) | undefined;
	private initializedRejecter: ((error: Error) => void) | undefined;
	private readonly initializedPromise = new Promise<void>((resolve, reject) => { this.initializedResolver = resolve; this.initializedRejecter = reject; });
	private readonly syncedBreakpointSources = new Set<string>();
	private readonly breakpointSync = new TaskQueue();
	private supportsConfigurationDone = false;
	private _capabilities: IDebugSessionCapabilities = Object.freeze({ supportsRestart: false, supportsTerminate: false, supportsSetVariable: false, supportsConditionalBreakpoints: false, supportsHitConditionalBreakpoints: false, supportsLogPoints: false, supportsFunctionBreakpoints: false, supportsDataBreakpoints: false, supportsInstructionBreakpoints: false, supportsDisassembleRequest: false, supportsSteppingGranularity: false, exceptionBreakpointFilters: Object.freeze([]) });

	readonly onDidChangeState: Event<DebugSessionState> = this.stateEmitter.event;
	readonly onDidOutput: Event<string> = this.outputEmitter.event;
	get output(): string { return this.retainedOutput; }

	private constructor(
		readonly configuration: IDebugConfiguration,
		private readonly processService: IDebugAdapterProcessService,
		readonly id: string,
		private readonly breakpoints: () => readonly IDebugBreakpoint[],
		private readonly workspace: URI,
		private readonly runInTerminal: DebugAdapterSessionStartOptions["runInTerminal"],
		private readonly updateBreakpoints: DebugAdapterSessionStartOptions["updateBreakpoints"],
		private readonly exceptionBreakpoints: DebugAdapterSessionStartOptions["exceptionBreakpoints"],
		private readonly additionalBreakpoints: DebugAdapterSessionStartOptions["additionalBreakpoints"],
	) {
		super();
		this.sessionId = id;
		this._register(toDisposable(() => {
			this.breakpointSync.clearPending();
			for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("Debug session was disposed")); }
			this.pending.clear();
		}));
	}

	static async start(options: DebugAdapterSessionStartOptions): Promise<DebugAdapterSession> {
		const workspaceFolder = workspaceFolderPath(options.workspace);
		const adapter = replaceWorkspaceVariables(options.configuration.adapter, workspaceFolder) as IDebugConfiguration["adapter"];
		const sessionId = await options.processService.start({
			...adapter,
			...(options.configuration.dirId ? { dirId: options.configuration.dirId } : {}),
		});
		const session = new DebugAdapterSession(options.configuration, options.processService, sessionId, options.breakpoints, options.workspace, options.runInTerminal, options.updateBreakpoints, options.exceptionBreakpoints, options.additionalBreakpoints);
		try {
			session.polling = true;
			void session.poll();
			await session.initialize(workspaceFolder);
			return session;
		} catch (error) {
			await session.closeProcess();
			session.dispose();
			throw error;
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
		this._threadId = positiveInteger(threadId, "threadId");
	}

	async stackTrace(threadId?: number): Promise<readonly IDebugStackFrame[]> {
		const selectedThreadId = threadId === undefined ? await this.requireThreadId() : positiveInteger(threadId, "threadId");
		this._threadId = selectedThreadId;
		const body = record((await this.request("stackTrace", { threadId: selectedThreadId, startFrame: 0, levels: 100 })).body, "stackTrace body");
		return array(body.stackFrames, "stackFrames").map((value, index) => stackFrame(value, index, this.workspace));
	}

	async scopes(frameId: number): Promise<readonly IDebugScope[]> {
		const body = record((await this.request("scopes", { frameId })).body, "scopes body");
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
		const body = record((await this.request("evaluate", { expression: normalized, context, ...(frameId === undefined ? {} : { frameId: positiveInteger(frameId, "frameId") }) })).body, "evaluate body");
		return Object.freeze({ result: string(body.result, "evaluate result"), variablesReference: positiveInteger(body.variablesReference, "evaluate variablesReference", true), ...(typeof body.type === "string" ? { type: body.type } : {}) });
	}

	async source(sourceValue: IDebugSource): Promise<IDebugSourceContent> {
		const sourceReference = positiveInteger(sourceValue.sourceReference, "sourceReference");
		const body = record((await this.request("source", { source: sourceValue, sourceReference })).body, "source body");
		return Object.freeze({ content: string(body.content, "source content"), ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}) });
	}

	async setExceptionBreakpoints(filters: readonly string[]): Promise<void> {
		const supported = new Set(this._capabilities.exceptionBreakpointFilters.map(candidate => candidate.filter));
		const normalized = Object.freeze([...new Set(filters.map(filter => string(filter, "exception breakpoint filter").trim()).filter(Boolean))]);
		const unknown = normalized.find(filter => !supported.has(filter));
		if (unknown) throw new Error(`The Debug Adapter does not provide exception breakpoint filter '${unknown}'`);
		await this.request("setExceptionBreakpoints", { filters: normalized });
	}

	async dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number): Promise<IDataBreakpointInfoResponse> {
		if (!this._capabilities.supportsDataBreakpoints) throw new Error(localize("debug.unsupportedDataBreakpoints", "Debug Adapter does not support data breakpoints"));
		if (this._state !== "stopped") throw new Error(localize("debug.dataRequiresPause", "Data breakpoints require the paused session that identified the variable."));
		const argumentsValue: Record<string, unknown> = { name: string(name, "data breakpoint name") };
		if (variablesReference !== undefined) argumentsValue.variablesReference = positiveInteger(variablesReference, "variablesReference");
		if (frameId !== undefined) argumentsValue.frameId = positiveInteger(frameId, "frameId");
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
		const groups = new Map<string, IDebugBreakpoint[]>();
		for (const breakpoint of this.breakpoints().filter(breakpoint => breakpoint.enabled && (breakpoint.resource.scheme === "file" || isRemoteResource(breakpoint.resource)))) {
			const unsupported = breakpoint.logMessage && !this._capabilities.supportsLogPoints ? localize("debug.unsupportedLogpoints", "Debug Adapter does not support logpoints")
				: breakpoint.condition && !this._capabilities.supportsConditionalBreakpoints ? localize("debug.unsupportedConditionalBreakpoints", "Debug Adapter does not support conditional breakpoints")
					: breakpoint.hitCondition && !this._capabilities.supportsHitConditionalBreakpoints ? localize("debug.unsupportedHitConditions", "Debug Adapter does not support hit conditions") : undefined;
			if (unsupported) {
				this.updateBreakpoints?.([{ id: breakpoint.id, verified: false, message: unsupported }]);
				continue;
			}
			const path = breakpoint.resource.scheme === "file" ? breakpoint.resource.fsPath : breakpoint.resource.path;
			const group = groups.get(path) ?? [];
			group.push(breakpoint);
			groups.set(path, group);
		}
		const sources = new Set([...this.syncedBreakpointSources, ...groups.keys()]);
		for (const path of sources) {
			const breakpoints = groups.get(path) ?? [];
			const response = await this.request("setBreakpoints", {
				source: { path }, breakpoints: breakpoints.map(breakpoint => ({
					line: breakpoint.lineNumber,
					...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
					...(breakpoint.hitCondition === undefined ? {} : { hitCondition: breakpoint.hitCondition }),
					...(breakpoint.logMessage === undefined ? {} : { logMessage: breakpoint.logMessage }),
				}))
			});
			const current = new Map(this.breakpoints().map(breakpoint => [breakpoint.id, breakpoint]));
			// Verification changes from another session do not change the request.
			// Only apply a reply while the user's breakpoint configuration matches.
			this.updateBreakpoints?.(breakpointUpdates(response.body, breakpoints).filter(update => {
				const requested = breakpoints.find(breakpoint => breakpoint.id === update.id)!;
				const latest = current.get(update.id);
				return latest?.enabled === requested.enabled && latest.lineNumber === requested.lineNumber
					&& latest.condition === requested.condition && latest.hitCondition === requested.hitCondition && latest.logMessage === requested.logMessage;
			}));
			if (breakpoints.length === 0) this.syncedBreakpointSources.delete(path);
			else this.syncedBreakpointSources.add(path);
		}
		await this.sendAdditionalBreakpoints();
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
				if (point.kind === "data") return point.canPersist ? point.adapterType === this.configuration.type : point.sessionId === this.id;
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
			this.updateBreakpoints?.(breakpointUpdates(response.body, points).filter(update => {
				const latest = current.get(update.id);
				const requested = points.find(point => point.id === update.id)!;
				return latest?.enabled === true && JSON.stringify(additionalBreakpointArguments(latest)) === JSON.stringify(additionalBreakpointArguments(requested));
			}));
		}
	}

	async disconnect(): Promise<void> {
		if (this._state !== "terminated") {
			try { await this.request("disconnect", { restart: false, ...(this._capabilities.supportsTerminate ? { terminateDebuggee: true } : {}) }); } catch (error) { this.emitOutput(`Debug disconnect failed: ${getErrorMessage(error)}\n`); }
		}
		await this.closeProcess();
		this.setState("terminated");
		this.dispose();
	}

	private async initialize(workspaceFolder: string): Promise<void> {
		const initialized = await this.request("initialize", { clientID: "ash", clientName: "Ash Code", adapterID: this.configuration.type, pathFormat: "path", linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsVariablePaging: true, supportsMemoryReferences: true, supportsRunInTerminalRequest: Boolean(this.runInTerminal), supportsArgsCanBeInterpretedByShell: Boolean(this.runInTerminal) });
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
		const launch = this.request(this.configuration.request, expandWorkspaceVariables(this.configuration.arguments, workspaceFolder));
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
		if (Number.isSafeInteger(this._threadId) && this._threadId! > 0) return this._threadId!;
		const first = (await this.threads())[0];
		if (!first) throw new Error("The Debug Adapter did not report any threads");
		this._threadId = first.id;
		return this._threadId;
	}

	private request(command: string, args?: unknown): Promise<DapResponse> {
		const sequence = this.requestSequence++;
		const request: DapRequest = { seq: sequence, type: "request", command, ...(args === undefined ? {} : { arguments: args }) };
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(sequence);
				reject(new Error(`Debug adapter '${command}' request timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(sequence, { resolve, reject, timeout });
			void this.processService.send(this.sessionId, request).catch(error => {
				const pending = this.pending.get(sequence);
				if (!pending) return;
				clearTimeout(pending.timeout);
				this.pending.delete(sequence);
				pending.reject(new Error(`Could not send Debug Adapter request: ${getErrorMessage(error)}`));
			});
		});
	}

	private async poll(): Promise<void> {
		while (this.polling && !this.isDisposed) {
			try {
				const read = await this.processService.read(this.sessionId, this.readSequence, 128);
				if (read.outputGap) throw new Error("Debug Adapter output exceeded the retained buffer");
				this.readSequence = read.nextSequence;
				if (read.stderr) this.emitOutput(read.stderr);
				if (read.protocolError) throw new Error(read.protocolError);
				for (const entry of read.messages) this.acceptMessage(entry.message);
				if (read.exited) {
					this._reason = `Debug adapter exited${read.exitCode === null ? "" : ` with code ${read.exitCode}`}`;
					this.setState("terminated");
					break;
				}
			} catch (error) {
				this._reason = getErrorMessage(error);
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
			this._threadId = Number.isSafeInteger(body.threadId) && (body.threadId as number) > 0 ? body.threadId as number : undefined;
			this._reason = typeof body.reason === "string" ? body.reason : "paused";
			this.setState("stopped");
			return;
		}
		if (eventValue.event === "continued") { this.setState("running"); return; }
		if (eventValue.event === "terminated" || eventValue.event === "exited") this.setState("terminated");
	}

	private async answerReverseRequest(request: Record<string, unknown>): Promise<void> {
		const sequence = positiveInteger(request.seq, "reverse request seq", true);
		const command = string(request.command, "reverse request command");
		try {
			if (command !== "runInTerminal" || !this.runInTerminal) throw new Error(`Ash does not support Debug Adapter reverse request '${command}'`);
			const body = await this.runInTerminal(request.arguments);
			await this.processService.send(this.sessionId, { seq: this.requestSequence++, type: "response", request_seq: sequence, success: true, command, body });
		} catch (error) {
			await this.processService.send(this.sessionId, { seq: this.requestSequence++, type: "response", request_seq: sequence, success: false, command, message: getErrorMessage(error) }).catch(sendError => this.emitOutput(`Could not answer Debug Adapter request: ${getErrorMessage(sendError)}\n`));
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

	private async closeProcess(): Promise<void> {
		this.polling = false;
		try { await this.processService.close(this.sessionId); } catch { /* Process may already be gone. */ }
	}
}

function response(value: Record<string, unknown>): DapResponse {
	return { seq: positiveInteger(value.seq, "response seq", true), type: "response", request_seq: positiveInteger(value.request_seq, "response request_seq"), success: boolean(value.success, "response success"), command: string(value.command, "response command"), ...(typeof value.message === "string" ? { message: value.message } : {}), ...(value.body === undefined ? {} : { body: value.body }) };
}

function event(value: Record<string, unknown>): DapEvent {
	return { seq: positiveInteger(value.seq, "event seq", true), type: "event", event: string(value.event, "event name"), ...(value.body === undefined ? {} : { body: value.body }) };
}

function stackFrame(value: unknown, index: number, workspace: URI): IDebugStackFrame {
	const frame = record(value, `stackFrames[${index}]`);
	return { id: positiveInteger(frame.id, `stackFrames[${index}].id`), name: string(frame.name, `stackFrames[${index}].name`), lineNumber: positiveInteger(frame.line, `stackFrames[${index}].line`, true), columnNumber: positiveInteger(frame.column, `stackFrames[${index}].column`, true), ...(frame.source === undefined ? {} : { source: source(frame.source, `stackFrames[${index}].source`, workspace) }), ...(frame.instructionPointerReference === undefined ? {} : { instructionPointerReference: string(frame.instructionPointerReference, "instructionPointerReference") }) };
}

function thread(value: unknown, index: number): IDebugThread {
	const input = record(value, `threads[${index}]`);
	return Object.freeze({ id: positiveInteger(input.id, `threads[${index}].id`), name: string(input.name, `threads[${index}].name`) });
}

function source(value: unknown, path: string, workspace: URI): IDebugStackFrame["source"] {
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
function withTimeout<T>(promise: Promise<T>, milliseconds: number, timeoutMessage: string): Promise<T> { return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(timeoutMessage)), milliseconds); promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); }); }); }
function workspaceFolderPath(workspace: URI): string { return workspace.scheme === "file" ? workspace.fsPath : workspace.path; }

function sourceResource(workspace: URI, adapterPath: string): URI | undefined {
	if (workspace.scheme === "file") {
		try { return URI.file(adapterPath); } catch { return undefined; }
	}
	if (!isRemoteResource(workspace)) return undefined;
	if (!adapterPath.startsWith("/") || adapterPath.includes("\0")) return undefined;
	const segments = adapterPath.split("/");
	if (adapterPath !== "/" && (adapterPath.endsWith("/") || segments.slice(1).some(segment => segment.length === 0 || segment === "." || segment === ".."))) return undefined;
	return workspace.with({ path: adapterPath });
}

function expandWorkspaceVariables(value: Readonly<Record<string, unknown>>, workspaceFolder: string): Readonly<Record<string, unknown>> {
	return replaceWorkspaceVariables(value, workspaceFolder) as Readonly<Record<string, unknown>>;
}

function replaceWorkspaceVariables(value: unknown, workspaceFolder: string): unknown {
	if (typeof value === "string") return value.replaceAll("${workspaceFolder}", workspaceFolder).replaceAll("${workspaceFolderBasename}", workspaceFolder.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "");
	if (Array.isArray(value)) return value.map(item => replaceWorkspaceVariables(item, workspaceFolder));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceWorkspaceVariables(item, workspaceFolder)]));
	return value;
}

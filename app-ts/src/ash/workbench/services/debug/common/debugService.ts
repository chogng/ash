import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface IDebugConfiguration {
	readonly id: string;
	readonly dirId?: string;
	readonly workspaceFolderName?: string;
	readonly name: string;
	readonly type: string;
	readonly request: "launch" | "attach";
	readonly adapter: { readonly program: string; readonly arguments: readonly string[] };
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly preLaunchTask?: string;
	readonly postDebugTask?: string;
}

export interface IDebugCompound {
	readonly id: string;
	readonly dirId?: string;
	readonly workspaceFolderName?: string;
	readonly name: string;
	readonly configurations: readonly string[];
	readonly preLaunchTask?: string;
	readonly stopAll: boolean;
}

export interface IBaseBreakpoint {
	readonly id: string;
	readonly enabled: boolean;
	readonly verified: boolean;
	readonly message?: string;
	readonly condition?: string;
	readonly hitCondition?: string;
}

export interface IDebugBreakpoint extends IBaseBreakpoint {
	readonly resource: URI;
	readonly lineNumber: number;
	readonly logMessage?: string;
}

export interface IFunctionBreakpoint extends IBaseBreakpoint {
	readonly kind: "function";
	readonly name: string;
}

export type DataBreakpointAccessType = "read" | "write" | "readWrite";

export interface IDataBreakpointInfoResponse {
	readonly dataId: string | null;
	readonly description: string;
	readonly accessTypes: readonly DataBreakpointAccessType[];
	readonly canPersist: boolean;
}

export interface IDataBreakpoint extends IBaseBreakpoint {
	readonly kind: "data";
	readonly dataId: string;
	readonly description: string;
	readonly accessType: DataBreakpointAccessType;
	readonly accessTypes: readonly DataBreakpointAccessType[];
	readonly canPersist: boolean;
	readonly adapterType: string;
	/** Non-persistent data identifiers belong only to the session that issued them. */
	readonly sessionId?: string;
}

export interface IInstructionBreakpoint extends IBaseBreakpoint {
	readonly kind: "instruction";
	readonly instructionReference: string;
	readonly offset?: number;
	/** Instruction addresses are valid only for the current debuggee. */
	readonly sessionId: string;
}

export type DebugBreakpoint = IDebugBreakpoint | IFunctionBreakpoint | IDataBreakpoint | IInstructionBreakpoint;

export interface IFunctionBreakpointOptions {
	readonly name: string;
	readonly condition?: string;
	readonly hitCondition?: string;
}

export interface IDataBreakpointOptions extends IDataBreakpointInfoResponse {
	readonly dataId: string;
	readonly sessionId: string;
	readonly accessType: DataBreakpointAccessType;
	readonly condition?: string;
	readonly hitCondition?: string;
}

export interface IInstructionBreakpointOptions {
	readonly instructionReference: string;
	readonly offset?: number;
	readonly condition?: string;
	readonly hitCondition?: string;
}

export interface IDebugBreakpointUpdate {
	readonly enabled?: boolean;
	/** Empty text removes the corresponding expression. */
	readonly condition?: string;
	readonly hitCondition?: string;
	readonly logMessage?: string;
	readonly name?: string;
	readonly accessType?: DataBreakpointAccessType;
	readonly instructionReference?: string;
	readonly offset?: number;
}

export interface IDebugSource {
	readonly name?: string;
	readonly path?: string;
	readonly resource?: URI;
	readonly sourceReference?: number;
}

export interface IDebugThread {
	readonly id: number;
	readonly name: string;
}

// DAP uses zero for an unavailable source line or column; retain that fact
// so callers can inspect a frame without inventing an editor position.
export interface IDebugStackFrame {
	readonly id: number;
	readonly name: string;
	readonly source?: IDebugSource;
	readonly lineNumber: number;
	readonly columnNumber: number;
	readonly instructionPointerReference?: string;
}

export interface IDisassembledInstruction {
	readonly address: string;
	readonly instruction: string;
	readonly instructionBytes?: string;
	readonly symbol?: string;
	readonly location?: IDebugSource;
	readonly line?: number;
	readonly column?: number;
	readonly endLine?: number;
	readonly endColumn?: number;
	readonly presentationHint?: "normal" | "invalid";
}

export type DebugSteppingGranularity = "statement" | "line" | "instruction";

export interface IDebugScope {
	readonly name: string;
	readonly variablesReference: number;
	readonly expensive: boolean;
}

export interface IDebugVariable {
	readonly name: string;
	readonly value: string;
	readonly type?: string;
	readonly variablesReference: number;
	readonly presentationHint?: {
		readonly attributes?: readonly string[];
		readonly lazy?: boolean;
	};
}

export type DebugEvaluateContext = "watch" | "repl" | "hover";

export interface IDebugEvaluateResult {
	readonly result: string;
	readonly type?: string;
	readonly variablesReference: number;
}

export interface IDebugSourceContent {
	readonly content: string;
	readonly mimeType?: string;
}

export interface IDebugExceptionBreakpointFilter {
	readonly filter: string;
	readonly label: string;
	readonly description?: string;
	readonly default: boolean;
}

export interface IDebugSessionCapabilities {
	readonly supportsRestart: boolean;
	readonly supportsTerminate: boolean;
	readonly supportsSetVariable: boolean;
	readonly supportsConditionalBreakpoints: boolean;
	readonly supportsHitConditionalBreakpoints: boolean;
	readonly supportsLogPoints: boolean;
	readonly supportsFunctionBreakpoints: boolean;
	readonly supportsDataBreakpoints: boolean;
	readonly supportsInstructionBreakpoints: boolean;
	readonly supportsDisassembleRequest: boolean;
	readonly supportsSteppingGranularity: boolean;
	readonly exceptionBreakpointFilters: readonly IDebugExceptionBreakpointFilter[];
}

export type DebugSessionState = "starting" | "running" | "stopped" | "terminated" | "error";

export interface IDebugSession extends IDisposable {
	readonly id: string;
	readonly configuration: IDebugConfiguration;
	readonly capabilities: IDebugSessionCapabilities;
	readonly state: DebugSessionState;
	readonly reason?: string;
	readonly threadId?: number;
	readonly output: string;
	readonly onDidChangeState: Event<DebugSessionState>;
	readonly onDidOutput: Event<string>;
	continue(): Promise<void>;
	pause(): Promise<void>;
	stepOver(granularity?: DebugSteppingGranularity): Promise<void>;
	stepInto(granularity?: DebugSteppingGranularity): Promise<void>;
	stepOut(granularity?: DebugSteppingGranularity): Promise<void>;
	restart(): Promise<void>;
	threads(): Promise<readonly IDebugThread[]>;
	selectThread(threadId: number): void;
	stackTrace(threadId?: number): Promise<readonly IDebugStackFrame[]>;
	scopes(frameId: number): Promise<readonly IDebugScope[]>;
	variables(reference: number): Promise<readonly IDebugVariable[]>;
	setVariable(variablesReference: number, name: string, value: string): Promise<IDebugVariable>;
	evaluate(expression: string, frameId: number | undefined, context: DebugEvaluateContext): Promise<IDebugEvaluateResult>;
	source(source: IDebugSource): Promise<IDebugSourceContent>;
	dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number): Promise<IDataBreakpointInfoResponse>;
	/** Byte offset and instruction offset use different DAP units. */
	disassemble(memoryReference: string, offset: number, instructionOffset: number, instructionCount: number): Promise<readonly IDisassembledInstruction[]>;
	setExceptionBreakpoints(filters: readonly string[]): Promise<void>;
	disconnect(): Promise<void>;
}

/** Code Workbench owner for launch configurations, breakpoints, and DAP session semantics. */
export interface IDebugService extends IDisposable {
	readonly configurations: readonly IDebugConfiguration[];
	readonly compounds: readonly IDebugCompound[];
	readonly breakpoints: readonly IDebugBreakpoint[];
	readonly functionBreakpoints: readonly IFunctionBreakpoint[];
	readonly dataBreakpoints: readonly IDataBreakpoint[];
	readonly instructionBreakpoints: readonly IInstructionBreakpoint[];
	readonly watchExpressions: readonly string[];
	readonly exceptionBreakpoints: readonly string[];
	readonly sessions: readonly IDebugSession[];
	readonly session: IDebugSession | undefined;
	readonly focusedStackFrame: IDebugStackFrame | undefined;
	readonly onDidFocusStackFrame: Event<IDebugStackFrame | undefined>;
	readonly onDidChangeConfigurations: Event<readonly IDebugConfiguration[]>;
	readonly onDidChangeBreakpoints: Event<readonly DebugBreakpoint[]>;
	readonly onDidChangeWatchExpressions: Event<readonly string[]>;
	readonly onDidChangeExceptionBreakpoints: Event<readonly string[]>;
	readonly onDidChangeSession: Event<IDebugSession | undefined>;
	refresh(): Promise<readonly IDebugConfiguration[]>;
	start(configuration: IDebugConfiguration): Promise<IDebugSession>;
	/** Starts a supplied configuration without adding it to launch.json. */
	startDebugging(configuration: IDebugConfiguration): Promise<IDebugSession>;
	startCompound(compound: IDebugCompound): Promise<readonly IDebugSession[]>;
	setActiveSession(session: IDebugSession): void;
	focusStackFrame(frame: IDebugStackFrame | undefined): void;
	restart(session?: IDebugSession): Promise<IDebugSession>;
	stop(session?: IDebugSession): Promise<void>;
	stopAll(): Promise<void>;
	toggleBreakpoint(resource: URI, lineNumber: number): void;
	removeBreakpoint(id: string): void;
	updateBreakpoint(id: string, update: IDebugBreakpointUpdate): void;
	setBreakpointsEnabled(enabled: boolean): void;
	removeAllBreakpoints(): void;
	addFunctionBreakpoint(options: IFunctionBreakpointOptions): void;
	addDataBreakpoint(options: IDataBreakpointOptions): void;
	addInstructionBreakpoint(options: IInstructionBreakpointOptions): void;
	addWatchExpression(expression: string): void;
	removeWatchExpression(expression: string): void;
	setExceptionBreakpoints(filters: readonly string[]): Promise<void>;
}

export const IDebugService = createServiceIdentifier<IDebugService>("debugService");

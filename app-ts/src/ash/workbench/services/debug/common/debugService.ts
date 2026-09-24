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

export interface IDebugBreakpoint {
	readonly id: string;
	readonly resource: URI;
	readonly lineNumber: number;
	readonly enabled: boolean;
	readonly verified: boolean;
	readonly message?: string;
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

export interface IDebugStackFrame {
	readonly id: number;
	readonly name: string;
	readonly source?: IDebugSource;
	readonly lineNumber: number;
	readonly columnNumber: number;
}

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
	stepOver(): Promise<void>;
	stepInto(): Promise<void>;
	stepOut(): Promise<void>;
	restart(): Promise<void>;
	threads(): Promise<readonly IDebugThread[]>;
	selectThread(threadId: number): void;
	stackTrace(threadId?: number): Promise<readonly IDebugStackFrame[]>;
	scopes(frameId: number): Promise<readonly IDebugScope[]>;
	variables(reference: number): Promise<readonly IDebugVariable[]>;
	evaluate(expression: string, frameId: number | undefined, context: DebugEvaluateContext): Promise<IDebugEvaluateResult>;
	source(source: IDebugSource): Promise<IDebugSourceContent>;
	setExceptionBreakpoints(filters: readonly string[]): Promise<void>;
	disconnect(): Promise<void>;
}

/** Code Workbench owner for launch configurations, breakpoints, and DAP session semantics. */
export interface IDebugService extends IDisposable {
	readonly configurations: readonly IDebugConfiguration[];
	readonly compounds: readonly IDebugCompound[];
	readonly breakpoints: readonly IDebugBreakpoint[];
	readonly watchExpressions: readonly string[];
	readonly exceptionBreakpoints: readonly string[];
	readonly sessions: readonly IDebugSession[];
	readonly session: IDebugSession | undefined;
	readonly onDidChangeConfigurations: Event<readonly IDebugConfiguration[]>;
	readonly onDidChangeBreakpoints: Event<readonly IDebugBreakpoint[]>;
	readonly onDidChangeWatchExpressions: Event<readonly string[]>;
	readonly onDidChangeExceptionBreakpoints: Event<readonly string[]>;
	readonly onDidChangeSession: Event<IDebugSession | undefined>;
	refresh(): Promise<readonly IDebugConfiguration[]>;
	start(configuration: IDebugConfiguration): Promise<IDebugSession>;
	startCompound(compound: IDebugCompound): Promise<readonly IDebugSession[]>;
	setActiveSession(session: IDebugSession): void;
	restart(session?: IDebugSession): Promise<IDebugSession>;
	stop(session?: IDebugSession): Promise<void>;
	stopAll(): Promise<void>;
	toggleBreakpoint(resource: URI, lineNumber: number): void;
	removeBreakpoint(id: string): void;
	addWatchExpression(expression: string): void;
	removeWatchExpression(expression: string): void;
	setExceptionBreakpoints(filters: readonly string[]): Promise<void>;
}

export const IDebugService = createServiceIdentifier<IDebugService>("debugService");

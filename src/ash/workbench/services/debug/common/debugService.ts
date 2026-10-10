import type { DebugAdapterDescriptor } from './debugAdapterFactory.js';
import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface IDebugConfiguration {
	readonly id: string;
	/** null is an explicitly folderless launch; undefined retains default selection. */
	readonly dirId?: string | null;
	readonly workspaceFolderName?: string;
	readonly name: string;
	readonly type: string;
	readonly request: "launch" | "attach";
	/** Contributed executables are internal defaults, not extension configuration properties. */
	readonly adapterExplicit?: boolean;
	readonly adapter?: DebugAdapterDescriptor;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly preLaunchTask?: string;
	readonly postDebugTask?: string;
}

/** A session can start only after its adapter descriptor has been resolved. */
export interface IResolvedDebugConfiguration extends IDebugConfiguration {
	readonly adapter: NonNullable<IDebugConfiguration['adapter']>;
}

export enum DebugConfigurationProviderTriggerKind {
	Initial = 1,
	Dynamic = 2,
}

/** Extension-facing launch data, before it becomes an owned execution snapshot. */
export interface DebugConfiguration {
	readonly name: string;
	readonly type: string;
	readonly request: 'launch' | 'attach';
	readonly [key: string]: unknown;
}

export interface IDebugConfigurationProvider {
	readonly id: string;
	readonly type: string;
	readonly triggerKind: DebugConfigurationProviderTriggerKind;
	provideDebugConfigurations?(folder: URI | undefined, signal: AbortSignal): readonly DebugConfiguration[] | PromiseLike<readonly DebugConfiguration[]>;
	resolveDebugConfiguration?(folder: URI | undefined, configuration: DebugConfiguration, signal: AbortSignal): DebugConfiguration | null | undefined | PromiseLike<DebugConfiguration | null | undefined>;
	resolveDebugConfigurationWithSubstitutedVariables?(folder: URI | undefined, configuration: DebugConfiguration, signal: AbortSignal): DebugConfiguration | null | undefined | PromiseLike<DebugConfiguration | null | undefined>;
}

export interface DebugConfigurationProviderRegistration extends IDisposable {
	replace(providers: readonly IDebugConfigurationProvider[]): void;
}

/** Hooks belong to the DAP session; factories belong to their extension registration. */
export interface IDebugAdapterTracker extends IDisposable {
	onWillStartSession?(): void | PromiseLike<void>;
	onWillReceiveMessage?(message: unknown): void | PromiseLike<void>;
	onDidSendMessage?(message: unknown): void | PromiseLike<void>;
	onWillStopSession?(): void | PromiseLike<void>;
	onError?(error: Error): void | PromiseLike<void>;
	onExit?(code: number | undefined, signal: string | undefined): void | PromiseLike<void>;
}

export interface IDebugAdapterTrackerFactory {
	readonly id: string;
	readonly type: string;
	createDebugAdapterTracker(session: IDebugSession, signal: AbortSignal): IDebugAdapterTracker | undefined | PromiseLike<IDebugAdapterTracker | undefined>;
}

export interface DebugAdapterTrackerFactoryRegistration extends IDisposable {
	replace(factories: readonly IDebugAdapterTrackerFactory[]): void;
}

export interface IDebugCompound {
	readonly id: string;
	readonly dirId?: string;
	readonly workspaceFolderName?: string;
	readonly name: string;
	readonly configurations: readonly (string | { readonly name: string; readonly folder: string; })[];
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
	readonly columnNumber?: number;
	readonly logMessage?: string;
}

export interface IFunctionBreakpoint extends IBaseBreakpoint {
	readonly kind: "function";
	readonly name: string;
	readonly logMessage?: string;
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
	/** Thread that produced this frame; an asynchronous reply cannot change its identity. */
	readonly threadId?: number;
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

export enum DebugConsoleMode {
	Separate = 0,
	MergeWithParent = 1,
}

/** Session relationships stay with DebugService; extensions pass canonical handles. */
export interface IDebugSessionOptions {
	readonly parentSession?: IDebugSession;
	readonly lifecycleManagedByParent?: boolean;
	readonly consoleMode?: DebugConsoleMode;
	readonly noDebug?: boolean;
	readonly suppressSaveBeforeStart?: boolean;
}

export interface IDebugSession extends IDisposable {
	readonly id: string;
	readonly name: string;
	readonly onDidChangeName: Event<string>;
	setName(name: string): void;
	readonly parentSession?: IDebugSession;
	readonly sessionOptions?: IDebugSessionOptions;
	readonly configuration: IDebugConfiguration;
	/** Resolved launch snapshot for extension inspection; source configuration remains available for restart. */
	readonly resolvedConfiguration?: IDebugConfiguration;
	readonly capabilities: IDebugSessionCapabilities;
	readonly state: DebugSessionState;
	readonly reason?: string;
	readonly threadId?: number;
	readonly onDidChangeThread: Event<number | undefined>;
	readonly output: string;
	readonly onDidChangeState: Event<DebugSessionState>;
	readonly onDidOutput: Event<string>;
	readonly onDidCustomEvent: Event<{ readonly event: string; readonly body?: unknown; }>;
	customRequest(command: string, args?: unknown): Promise<unknown>;
	getDebugProtocolBreakpoint(breakpointId: string): unknown;
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
	/** Includes the prepared session while its descriptor is being resolved. */
	getSession(id: string): IDebugSession | undefined;
	readonly session: IDebugSession | undefined;
	readonly focusedStackFrame: IDebugStackFrame | undefined;
	readonly onDidFocusStackFrame: Event<IDebugStackFrame | undefined>;
	readonly onDidChangeConfigurations: Event<readonly IDebugConfiguration[]>;
	readonly onDidChangeBreakpoints: Event<readonly DebugBreakpoint[]>;
	readonly onDidChangeWatchExpressions: Event<readonly string[]>;
	readonly onDidChangeExceptionBreakpoints: Event<readonly string[]>;
	readonly onDidChangeSession: Event<IDebugSession | undefined>;
	readonly onWillNewSession: Event<IDebugSession>;
	readonly onDidNewSession: Event<IDebugSession>;
	readonly onDidEndSession: Event<IDebugSession>;
	refresh(): Promise<readonly IDebugConfiguration[]>;
	registerDebugAdapterTrackerFactories(factories: readonly IDebugAdapterTrackerFactory[]): DebugAdapterTrackerFactoryRegistration;
	registerDebugConfigurationProviders(providers: readonly IDebugConfigurationProvider[]): DebugConfigurationProviderRegistration;
	/** Supplies validated initial templates or configurations for dynamic selection. */
	provideDebugConfigurations(folder: URI, signal?: AbortSignal, triggerKind?: DebugConfigurationProviderTriggerKind): Promise<readonly DebugConfiguration[]>;
	start(configuration: IDebugConfiguration, options?: IDebugSessionOptions): Promise<IDebugSession>;
	/** Binds a dynamic provider result to its current canonical workspace folder. */
	startDynamicDebugging(folder: URI | undefined, configuration: DebugConfiguration, options?: IDebugSessionOptions): Promise<IDebugSession>;
	/** Starts a supplied configuration without adding it to launch.json. */
	startDebugging(configuration: IDebugConfiguration, options?: IDebugSessionOptions): Promise<IDebugSession>;
	startCompound(compound: IDebugCompound): Promise<readonly IDebugSession[]>;
	setActiveSession(session: IDebugSession): void;
	focusStackFrame(frame: IDebugStackFrame | undefined): void;
	restart(session?: IDebugSession): Promise<IDebugSession>;
	stop(session?: IDebugSession): Promise<void>;
	stopAll(): Promise<void>;
	addBreakpoints(breakpoints: readonly (IDebugBreakpoint | IFunctionBreakpoint)[]): void;
	removeBreakpoints(breakpointIds: readonly string[]): void;
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

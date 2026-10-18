import type { IDebugAdapterProcessReadResult, DebugAdapterConnection, DebugConsoleEntry } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Position } from '../../../../editor/common/core/position.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const CONTEXT_DISASSEMBLY_VIEW_FOCUS = new RawContextKey<boolean>('disassemblyViewFocus', false);
export const CONTEXT_DEBUG_STATE = new RawContextKey<string>('debugState', 'inactive');
export const DEBUG_VIEW_ID = "workbench.view.debug";
export const DISASSEMBLY_VIEW_ID = 'workbench.debug.disassemblyView';
export const OPEN_DISASSEMBLY_VIEW_COMMAND_ID = 'debug.action.openDisassemblyView';
export const DEBUG_CONSOLE_VIEW_ID = "workbench.panel.debugConsole";
export const FOCUS_DEBUG_CONSOLE_COMMAND_ID = "workbench.debug.action.focusRepl";
export const CLEAR_DEBUG_CONSOLE_COMMAND_ID = "workbench.debug.panel.action.clearReplAction";
export const SELECT_AND_START_ID = 'workbench.action.debug.selectandstart';
export const START_DEBUG_COMMAND_ID = "workbench.action.debug.start";
export const STOP_DEBUG_COMMAND_ID = "workbench.action.debug.stop";
export const STOP_ALL_DEBUG_COMMAND_ID = "workbench.action.debug.stopAll";
export const RESTART_DEBUG_COMMAND_ID = "workbench.action.debug.restart";
export const CONTINUE_DEBUG_COMMAND_ID = "workbench.action.debug.continue";
export const PAUSE_DEBUG_COMMAND_ID = "workbench.action.debug.pause";
export const STEP_OVER_DEBUG_COMMAND_ID = "workbench.action.debug.stepOver";
export const STEP_INTO_DEBUG_COMMAND_ID = "workbench.action.debug.stepInto";
export const STEP_OUT_DEBUG_COMMAND_ID = "workbench.action.debug.stepOut";
export const BREAKPOINT_EDITOR_CONTRIBUTION_ID = 'editor.contrib.breakpoint';

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

/** Session-owned, ordered DAP observation. Callback promises do not hold transport IO;
 * the session retires trackers whose callbacks exceed their observation deadline. */
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
	readonly supportsCompletionsRequest: boolean;
	readonly supportsCancelRequest: boolean;
	readonly completionTriggerCharacters: readonly string[];
	readonly exceptionBreakpointFilters: readonly IDebugExceptionBreakpointFilter[];
}

export type DebugSessionState = "starting" | "running" | "stopped" | "terminated" | "error";

export enum DebugConsoleMode {
	Separate = 0,
	MergeWithParent = 1,
}

/** Extensions pass canonical Workbench handles; Rust owns session relationships. */
export interface IDebugSessionOptions {
	readonly parentSession?: IDebugSession;
	readonly lifecycleManagedByParent?: boolean;
	readonly consoleMode?: DebugConsoleMode;
	readonly noDebug?: boolean;
	readonly suppressSaveBeforeStart?: boolean;
}

export interface IDebugStackInspection {
	readonly threads: readonly IDebugThread[];
	readonly frames: readonly IDebugStackFrame[];
	readonly threadId?: number;
}
export interface IDebugScopeInspection {
	readonly scope: IDebugScope;
	readonly variables: readonly IDebugVariable[];
	readonly error?: string;
}
export interface IDebugWatchResult {
	readonly expression: string;
	readonly result?: IDebugEvaluateResult;
	readonly error?: string;
}

/** DAP completion coordinates use UTF-16. start is one-based like the request
 * column; selection offsets are zero-based within text (or label when omitted). */
export interface IDebugCompletionItem {
	readonly label: string;
	readonly text?: string;
	readonly sortText?: string;
	readonly detail?: string;
	readonly type?: string;
	readonly start?: number;
	readonly length?: number;
	readonly selectionStart?: number;
	readonly selectionLength?: number;
}

export interface IDebugCompletionsResponse {
	readonly body: { readonly targets: readonly IDebugCompletionItem[]; };
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
	readonly exceptionBreakpoints: readonly string[];
	readonly onDidChangeExceptionBreakpoints: Event<readonly string[]>;
	readonly output: string;
	readonly onDidChangeState: Event<DebugSessionState>;
	readonly onDidChangeReplElements: Event<void>;
	readonly consoleSessionId: string;
	readonly replElementsRevision: number;
	readonly retainedConsoleSessionIds: readonly string[];
	readonly consoleCatalogRevision: number;
	getReplElements(): readonly DebugConsoleEntry[];
	clearRepl(): Promise<void>;
	readonly onDidCustomEvent: Event<{ readonly event: string; readonly body?: unknown; }>;
	customRequest(command: string, args?: unknown): Promise<unknown>;
	getDebugProtocolBreakpoint(breakpointId: string): unknown;
	continue(): Promise<void>;
	pause(): Promise<void>;
	stepOver(granularity?: DebugSteppingGranularity): Promise<void>;
	stepInto(granularity?: DebugSteppingGranularity): Promise<void>;
	stepOut(granularity?: DebugSteppingGranularity): Promise<void>;
	restart(): Promise<void>;
	inspectStack(threadId?: number): Promise<IDebugStackInspection>;
	inspectFrame(frameId: number): Promise<readonly IDebugScopeInspection[]>;
	evaluateWatchExpressions(expressions: readonly string[], frameId?: number): Promise<readonly IDebugWatchResult[]>;
	threads(): Promise<readonly IDebugThread[]>;
	selectThread(threadId: number): void;
	stackTrace(threadId?: number): Promise<readonly IDebugStackFrame[]>;
	scopes(frameId: number): Promise<readonly IDebugScope[]>;
	variables(reference: number, inspectionRevision?: number): Promise<readonly IDebugVariable[]>;
	setVariable(variablesReference: number, name: string, value: string): Promise<IDebugVariable>;
	evaluate(expression: string, frameId: number | undefined, context: DebugEvaluateContext): Promise<IDebugEvaluateResult>;
	completions(frameId: number | undefined, threadId: number, text: string, position: Position, token: CancellationToken): Promise<IDebugCompletionsResponse | undefined>;
	source(source: IDebugSource): Promise<IDebugSourceContent>;
	dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number): Promise<IDataBreakpointInfoResponse>;
	/** Byte offset and instruction offset use different DAP units. */
	disassemble(memoryReference: string, offset: number, instructionOffset: number, instructionCount: number): Promise<readonly IDisassembledInstruction[]>;
	setExceptionBreakpoints(filters: readonly string[]): Promise<void>;
	disconnect(): Promise<void>;
}

/** Launch catalog and selection use Ash domain configurations, including compounds. */
export interface IConfigurationManager {
	readonly configurations: readonly IDebugConfiguration[];
	readonly compounds: readonly IDebugCompound[];
	readonly selectedConfiguration: IDebugConfiguration | IDebugCompound | undefined;
	readonly onDidSelectConfiguration: Event<void>;
	selectConfiguration(configuration: IDebugConfiguration | IDebugCompound | undefined): Promise<void>;
	getAllConfigurations(): readonly (IDebugConfiguration | IDebugCompound)[];
}

/** Client inspection selection shared by the Debug views and Extension Host facade. */
export interface IViewModel {
	readonly focusedSession: IDebugSession | undefined;
	readonly focusedThread: IDebugThread | undefined;
	readonly focusedStackFrame: IDebugStackFrame | undefined;
	readonly onDidFocusStackFrame: Event<{ stackFrame: IDebugStackFrame | undefined; explicit: boolean; session: IDebugSession | undefined; }>;
	readonly onDidFocusThread: Event<{ thread: IDebugThread | undefined; explicit: boolean; session: IDebugSession | undefined; }>;
}

/** Code Workbench owner for launch, workspace facades and host interactions. */
export interface IDebugService extends IDisposable {
	getConfigurationManager(): IConfigurationManager;
	/** Retained console output and evaluation, owned for the Debug service lifetime. */
	readonly replModel: IReplModel;
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
	getViewModel(): IViewModel;
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
	focusStackFrame(frame: IDebugStackFrame | undefined, thread?: IDebugThread): void;
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

/** Session-owned inline IO. DAP state and request pairing remain in DebugSession. */
export interface InlineDebugAdapter {
	send(message: unknown): Promise<void>;
	read(afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult>;
	close(): Promise<void>;
}

export type DebugAdapterDescriptor = DebugAdapterExecutable | {
	readonly inline: InlineDebugAdapter;
	readonly arguments: readonly string[];
	readonly connection?: never;
	readonly program?: never;
	readonly cwd?: never;
	readonly env?: never;
} | {
	readonly inline?: never;
	readonly connection: DebugAdapterConnection;
	readonly arguments: readonly string[];
	readonly program?: never;
	readonly cwd?: never;
	readonly env?: never;
};

export interface DebugAdapterExecutable {
	readonly inline?: never;
	readonly connection?: never;
	readonly program: string;
	readonly arguments: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | null>>;
}

/** One Debug domain factory contributed by a declarative package or executable Extension Host. */
export interface DebugAdapterFactory {
	readonly type: string;
	readonly label: string;
	readonly sourceId: string;
	createDebugAdapter?(): DebugAdapterDescriptor;
	/** Resolves invocation-dependent descriptors at dispatch, never during discovery. */
	createDebugAdapterDescriptor?(configuration: IDebugConfiguration, signal: AbortSignal, session: IDebugSession): PromiseLike<DebugAdapterDescriptor | undefined | null>;
}

export interface IAdapterManager extends IDisposable {
	registerFactories(factories: readonly DebugAdapterFactory[]): DebugAdapterFactoryRegistration;
	readonly factories: readonly DebugAdapterFactory[];
	readonly onDidChange: Event<readonly DebugAdapterFactory[]>;
	get(type: string): DebugAdapterFactory | undefined;
}

export const IAdapterManager = createServiceIdentifier<IAdapterManager>("debugAdapterManager");

/** One caller-owned factory set that can be atomically replaced. */
export interface DebugAdapterFactoryRegistration extends IDisposable {
	replace(factories: readonly DebugAdapterFactory[]): void;
}

export interface IDebugConsoleSession {
	readonly elements: readonly DebugConsoleEntry[];
	readonly id: string;
	readonly label: string;
	readonly state: "starting" | "running" | "stopped" | "terminated" | "error";
	readonly output: string;
	readonly canEvaluate: boolean;
}

/** Retained, session-aware Debug Console model kept separate from generic Output channels. */
export interface IReplModel extends IDisposable {
	readonly sessions: readonly IDebugConsoleSession[];
	readonly activeSession: IDebugConsoleSession | undefined;
	readonly onDidChange: Event<void>;
	selectSession(id: string): void;
	clear(sessionId?: string): void | Promise<void>;
	evaluate(expression: string): Promise<void>;
}


export function createStaticDebugAdapterFactory(type: string, label: string, sourceId: string, executable: DebugAdapterExecutable): DebugAdapterFactory {
	const normalizedExecutable = normalizeExecutable(executable, `Debug Adapter '${type}'`);
	return normalizeDebugAdapterFactory({ type, label, sourceId, createDebugAdapter: () => normalizedExecutable });
}

export function normalizeDebugAdapterFactory(factory: DebugAdapterFactory): DebugAdapterFactory {
	if (!factory || typeof factory !== "object") throw new TypeError("Debug Adapter factory must be an object");
	const type = normalizeIdentifier(factory.type, "Debug Adapter type");
	const label = normalizeText(factory.label, "Debug Adapter label", 256);
	const sourceId = normalizeIdentifier(factory.sourceId, "Debug Adapter source ID");
	if (typeof factory.createDebugAdapter !== "function" && typeof factory.createDebugAdapterDescriptor !== "function") throw new TypeError(`Debug Adapter '${type}' must provide a factory`);
	return Object.freeze({
		type,
		label,
		sourceId,
		...(factory.createDebugAdapter ? { createDebugAdapter: () => normalizeDebugAdapterDescriptor(factory.createDebugAdapter!.call(factory), `Debug Adapter '${type}'`) } : {}),
		...(factory.createDebugAdapterDescriptor ? {
			createDebugAdapterDescriptor: async (configuration: IDebugConfiguration, signal: AbortSignal, session: IDebugSession) => {
				const descriptor = await factory.createDebugAdapterDescriptor!.call(factory, configuration, signal, session);
				return descriptor === undefined || descriptor === null ? undefined : normalizeDebugAdapterDescriptor(descriptor, `Debug Adapter '${type}'`);
			}
		} : {}),
	});
}

/** Validates a complete descriptor at the factory and Host callback boundaries. */
export function normalizeDebugAdapterDescriptor(value: unknown, owner: string): DebugAdapterDescriptor {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError(`${owner} descriptor must be an object`); }
	const input = value as Record<string, unknown>;
	if (input.inline !== undefined) {
		if (Object.keys(input).some(key => !['inline', 'arguments'].includes(key)) || !Array.isArray(input.arguments) || input.arguments.length !== 0) { throw new TypeError(`${owner} inline adapter cannot include executable options`); }
		const inline = input.inline as InlineDebugAdapter;
		if (!inline || typeof inline.send !== 'function' || typeof inline.read !== 'function' || typeof inline.close !== 'function') { throw new TypeError(`${owner} inline adapter requires owned IO`); }
		return Object.freeze({ inline, arguments: Object.freeze([]) });
	}
	if (input.connection !== undefined) {
		if (Object.keys(input).some(key => !['connection', 'arguments'].includes(key))) { throw new TypeError(`${owner} connection contains unknown fields`); }
		if (input.program !== undefined || input.cwd !== undefined || input.env !== undefined || input.arguments !== undefined && (!Array.isArray(input.arguments) || input.arguments.length !== 0)) { throw new TypeError(`${owner} connection cannot include executable options`); }
		if (!input.connection || typeof input.connection !== 'object' || Array.isArray(input.connection)) { throw new TypeError(`${owner} connection must be an object`); }
		const connection = input.connection as Record<string, unknown>;
		if (connection.type === 'server') {
			if (Object.keys(connection).some(key => !['type', 'port', 'host'].includes(key)) || !Number.isInteger(connection.port) || (connection.port as number) < 1 || (connection.port as number) > 65535) { throw new TypeError(`${owner} server port is invalid`); }
			const host = connection.host === undefined ? undefined : normalizeText(connection.host as string, `${owner} server host`, 256);
			return Object.freeze({ connection: Object.freeze({ type: 'server', port: connection.port as number, ...(host === undefined ? {} : { host }) }), arguments: Object.freeze([]) });
		}
		if (connection.type === 'namedPipe') {
			if (Object.keys(connection).some(key => !['type', 'path'].includes(key))) { throw new TypeError(`${owner} named pipe contains unknown fields`); }
			normalizeText(connection.path as string, `${owner} named pipe path`, 32768);
			const path = connection.path as string;
			return Object.freeze({ connection: Object.freeze({ type: 'namedPipe', path }), arguments: Object.freeze([]) });
		}
		throw new TypeError(`${owner} connection type is invalid`);
	}
	return normalizeExecutable(value as DebugAdapterExecutable, owner);
}

function normalizeExecutable(executable: DebugAdapterExecutable, owner: string): DebugAdapterExecutable {
	if (!executable || typeof executable !== "object") throw new TypeError(`${owner} executable must be an object`);
	const program = normalizeText(executable.program, `${owner} program`, 4096);
	if (!Array.isArray(executable.arguments)) throw new TypeError(`${owner} arguments must be an array`);
	const argumentsList = executable.arguments.map((argument, index) => {
		if (typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0')) throw new TypeError(`${owner} argument ${index} must be a bounded string without NUL`);
		return argument;
	});
	if (argumentsList.length > 256) throw new RangeError(`${owner} has too many arguments`);
	const cwd = executable.cwd === undefined ? undefined : normalizeText(executable.cwd, `${owner} cwd`, 32768);
	const env = executable.env;
	if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 128 || Object.entries(env).some(([key, value]) => !key || key.length > 256 || /[=\0]/.test(key) || value !== null && (typeof value !== 'string' || value.length > 32768 || value.includes('\0'))))) throw new TypeError(`${owner} environment is invalid`);
	return Object.freeze({ program, arguments: Object.freeze(argumentsList), ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env: Object.freeze({ ...env }) }) });
}

function normalizeIdentifier(value: string, owner: string): string {
	return normalizeText(value, owner, 256);
}

function normalizeText(value: string, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} must contain 1 to ${maximum} characters without NUL`);
	return value.trim();
}

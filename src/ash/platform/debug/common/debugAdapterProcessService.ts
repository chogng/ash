import { type IDisposable } from '../../../base/common/lifecycle.js';
import { type AppServerConnectionState } from '../../agentHost/common/appServerApi.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type DebugAdapterConnection = {
	readonly type: 'client';
} | {
	readonly type: 'server';
	readonly port: number;
	readonly host?: string;
} | {
	readonly type: 'namedPipe';
	readonly path: string;
};

export type IDebugAdapterProcessStartOptions = {
	readonly dirId?: string;
	readonly arguments: readonly string[];
} & ({
	readonly program: string;
	readonly connection?: never;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | null>>;
} | {
	readonly connection: DebugAdapterConnection;
	readonly program?: never;
	readonly cwd?: never;
	readonly env?: never;
});

export interface IDebugAdapterProcessMessage {
	readonly sequence: number;
	/** Raw inline transports supply incoming messages; managed readers mark both directions. */
	readonly direction?: 'incoming' | 'outgoing';
	readonly message: unknown;
}

export interface IDebugAdapterProcessReadResult {
	/** Present on managed reads; raw inline IO has no session model. */
	readonly session?: DebugSessionSnapshot;
	readonly breakpointRevision?: number;
	readonly consoleRevision?: number;
	readonly exceptions?: DebugExceptionsSnapshot;
	readonly messages: readonly IDebugAdapterProcessMessage[];
	readonly nextSequence: number;
	readonly outputGap: boolean;
	readonly stderr: string;
	readonly exited: boolean;
	readonly exitCode: number | null;
	readonly protocolError: string | null;
}

/** Platform contract for connection-owned Rust DAP clients and their transports. */
export interface IDebugAdapterProcessService {
	readWorkspaceState(workspaceId: string, legacy?: DebugWorkspaceState): Promise<DebugWorkspaceResult>;
	editWorkspaceState(workspaceId: string, revision: number, edits: readonly DebugWorkspaceEdit[]): Promise<DebugWorkspaceResult>;

	prepareSession(id: string, noDebug: boolean | undefined): Promise<DebugSessionRelation>;
	reserveSession(options: DebugSessionAdmission): Promise<DebugSessionRelation>;
	manageSession(id: string, action: 'read' | 'route' | 'end'): Promise<DebugSessionRelation>;
	readConsole(id: string, options?: { readonly clear?: boolean; readonly diagnostic?: string; }): Promise<DebugConsoleSnapshot>;
	start(options: IDebugAdapterProcessStartOptions): Promise<string>;
	send(sessionId: string, message: unknown): Promise<void>;
	read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult>;
	close(sessionId: string): Promise<void>;
	initializeSession(sessionId: string, options: DebugSessionInitializeOptions): Promise<void>;
	completeConfiguration(sessionId: string, exceptionFilters: readonly string[] | undefined): Promise<void>;
	setExceptionBreakpoints(sessionId: string, filters: readonly string[]): Promise<number>;
	setBreakpoints(sessionId: string, version: number, intents: readonly DebugBreakpointIntent[]): Promise<void>;
	readBreakpoints(sessionId: string): Promise<DebugBreakpointsSnapshot>;
	startInspection(sessionId: string, query: DebugInspection, inspectionRevision: number): Promise<number | undefined>;
	readInspection(sessionId: string, inspectionId: number): Promise<DebugInspectionResult>;
	/** Returns the Rust-allocated DAP sequence for response polling and DAP cancel's requestId; scoped to this adapter session. */
	startRequest(sessionId: string, command: string, args?: unknown): Promise<number>;
	readResponse(sessionId: string, requestId: number): Promise<DebugAdapterResponseResult>;
	acceptInput(sessionId: string, input: IDebugAdapterProcessReadResult): Promise<void>;
	getConnectionState(): Promise<AppServerConnectionState>;
	onConnectionState(listener: (state: AppServerConnectionState) => void): IDisposable;
}

/** Request pairing and deadlines belong to the Rust client, independently of view reads. */
export type DebugAdapterResponseResult = { readonly state: 'pending'; } | { readonly state: 'complete'; readonly response: unknown; } | { readonly state: 'failed'; readonly message: string; };

/** Debug composition registers its selected capability; undefined means the host cannot launch DAP processes. */
export const IDebugAdapterProcessService = createServiceIdentifier<IDebugAdapterProcessService | undefined>('debugAdapterProcessService');

export interface DebugSessionInitializeOptions {
	readonly publicId: string;
	readonly adapterId: string;
	readonly request: 'launch' | 'attach';
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly runInTerminal: boolean;
	readonly startDebugging: boolean;
}

/** Immutable backend runtime facts, independent of Workbench focus/selection. */
export interface DebugSessionSnapshot {
	readonly revision: number;
	readonly executionRevision: number;
	readonly inspectionRevision: number;
	readonly state: 'starting' | 'running' | 'stopped' | 'terminated' | 'error';
	readonly phase: 'uninitialized' | 'initializing' | 'awaitingInitialized' | 'configuring' | 'launching' | 'active' | 'ended';
	readonly reason: string | null;
	readonly stoppedThreadId: number | null;
	readonly capabilities: {
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
		readonly supportsReadMemoryRequest?: boolean;
		readonly supportsWriteMemoryRequest?: boolean;
		readonly supportsLoadedSourcesRequest?: boolean;
		readonly supportsExceptionInfoRequest?: boolean;
		readonly supportsSteppingGranularity: boolean;
		readonly supportsCompletionsRequest: boolean;
		readonly supportsCancelRequest: boolean;
		readonly completionTriggerCharacters: readonly string[];
		readonly exceptionBreakpointFilters: readonly { readonly filter: string; readonly label: string; readonly description?: string; readonly default: boolean; }[];
	};
}

export type DebugSourceAddress = { readonly path?: string; readonly sourceReference?: number; };
export type DebugBreakpointLocation =
	| { readonly kind: 'source'; readonly source: DebugSourceAddress; readonly line: number; readonly column?: number; }
	| { readonly kind: 'function'; readonly name: string; }
	| { readonly kind: 'data'; readonly dataId: string; readonly accessType: 'read' | 'write' | 'readWrite'; readonly adapterType: string; readonly canPersist: boolean; readonly sessionId?: string; }
	| { readonly kind: 'instruction'; readonly instructionReference: string; readonly offset?: number; readonly sessionId: string; };
export interface DebugBreakpointIntent {
	readonly id: string;
	readonly enabled: boolean;
	readonly location: DebugBreakpointLocation;
	readonly condition?: string;
	readonly hitCondition?: string;
	readonly logMessage?: string;
}
export type DebugBreakpointUnsupported = 'conditional' | 'hitConditional' | 'logPoint' | 'function' | 'data' | 'instruction';
export interface DebugBreakpointBinding {
	readonly intent: DebugBreakpointIntent;
	readonly verified: boolean;
	readonly applicable: boolean;
	readonly pending: boolean;
	readonly removed: boolean;
	readonly created: boolean;
	readonly unsupported: DebugBreakpointUnsupported | null;
	readonly message: string | null;
	readonly protocol: unknown;
}
export interface DebugBreakpointsSnapshot {
	readonly revision: number;
	readonly version: number;
	readonly appliedVersion: number;
	readonly bindings: readonly DebugBreakpointBinding[];
	readonly error: string | null;
}
export type DebugInspection = { readonly kind: 'stack'; readonly threadId?: number; }
	| { readonly kind: 'frame'; readonly frameId: number; }
	| { readonly kind: 'variables'; readonly variablesReference: number; }
	| { readonly kind: 'watch'; readonly expressions: readonly string[]; readonly frameId?: number; };
export type DebugInspectionValue =
	| { readonly kind: 'stack'; readonly threads: readonly unknown[]; readonly frames: readonly unknown[]; readonly threadId: number | null; }
	| { readonly kind: 'frame'; readonly scopes: readonly { readonly scope: unknown; readonly variables: readonly unknown[]; readonly variablesLoaded: boolean; readonly error: string | null; }[]; }
	| { readonly kind: 'variables'; readonly variables: readonly unknown[]; }
	| { readonly kind: 'watch'; readonly values: readonly { readonly expression: string; readonly result: unknown; readonly error: string | null; }[]; };
export type DebugInspectionResult = { readonly state: 'pending'; } | { readonly state: 'complete'; readonly value: DebugInspectionValue; } | { readonly state: 'failed'; readonly message: string; } | { readonly state: 'invalidated'; };

/** Durable definitions have no adapter verification or session-owned address. */
export interface DebugBreakpointDefinition {
	readonly id: string;
	readonly enabled: boolean;
	readonly condition?: string;
	readonly hitCondition?: string;
	readonly logMessage?: string;
}
export interface DebugWorkspaceState {
	readonly breakpoints: readonly (DebugBreakpointDefinition & { readonly resource: string; readonly lineNumber: number; readonly columnNumber?: number; })[];
	readonly functionBreakpoints: readonly (DebugBreakpointDefinition & { readonly name: string; })[];
	readonly dataBreakpoints: readonly (DebugBreakpointDefinition & { readonly dataId: string; readonly description: string; readonly adapterType: string; readonly accessType: 'read' | 'write' | 'readWrite'; readonly accessTypes: readonly ('read' | 'write' | 'readWrite')[]; })[];
	readonly watchExpressions: readonly string[];
	readonly exceptionBreakpoints: Readonly<Record<string, readonly string[]>>;
}
export interface DebugWorkspaceSnapshot { readonly revision: number; readonly state: DebugWorkspaceState; }
export interface DebugWorkspaceResult { readonly status: 'current' | 'applied' | 'conflict'; readonly snapshot: DebugWorkspaceSnapshot; }
export type DebugWorkspaceEdit =
	| { readonly kind: 'clearBreakpoints'; }
	| { readonly kind: 'setEnabled'; readonly enabled: boolean; }
	| { readonly kind: 'source'; readonly point: DebugWorkspaceState['breakpoints'][number]; }
	| { readonly kind: 'function'; readonly point: DebugWorkspaceState['functionBreakpoints'][number]; }
	| { readonly kind: 'data'; readonly point: DebugWorkspaceState['dataBreakpoints'][number]; }
	| { readonly kind: 'remove'; readonly ids: readonly string[]; }
	| { readonly kind: 'addWatch' | 'removeWatch'; readonly expression: string; }
	| { readonly kind: 'exceptions'; readonly adapterType: string; readonly filters: readonly string[]; };

export interface DebugExceptionsSnapshot { readonly version: number; readonly appliedVersion: number; readonly appliedFilters: readonly string[]; readonly filters: readonly string[]; readonly error: string | null; }

export interface DebugSessionAdmission {
	readonly id: string;
	readonly workspaceId: string;
	readonly parentId: string | null;
	readonly lifecycleManagedByParent: boolean;
	readonly mergeConsole: boolean;
	readonly noDebug: boolean | null;
}
export interface DebugSessionRelation {
	readonly id: string;
	readonly parentId: string | null;
	readonly consoleId: string;
	readonly consoleIds: readonly string[];
	readonly consoleCatalogRevision: number;
	readonly lifecycleTargetId: string;
	readonly noDebug: boolean | null;
	readonly ended: boolean;
	readonly descendants: readonly string[];
}
export interface DebugConsoleEntry {
	readonly id: number;
	readonly sessionId: string;
	readonly kind: 'output' | 'input' | 'evaluation' | 'group';
	readonly output: string;
	readonly category: string;
	readonly parentId: number | null;
	readonly collapsed: boolean;
	readonly variablesReference: number | null;
	readonly inspectionRevision?: number | null;
	readonly source: unknown;
	readonly line: number | null;
	readonly column: number | null;
	readonly data: unknown;
}
export interface DebugConsoleSnapshot { readonly revision: number; readonly entries: readonly DebugConsoleEntry[]; }

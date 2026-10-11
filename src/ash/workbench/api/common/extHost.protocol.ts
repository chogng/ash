import type { ExtensionClientSource, ExtensionHostInitialization, ExtensionStatusBarEntry, JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';

export interface ExtensionDocumentSnapshot {
	readonly uri: string;
	readonly version: number;
	readonly languageId: string;
	readonly text: string;
}

export interface ExtensionDocumentEdit {
	readonly uri: string;
	readonly version: number;
	readonly edits: { start: { line: number; character: number; }; end: { line: number; character: number; }; text: string; }[];
}

/** Window services available during a connection-owned extension invocation. */
export type ExtensionClientOperation =
	| { operation: 'scmUpdate'; registrationId: string; revision: number; providers: readonly JsonValue[]; }
	| { operation: 'backendRequest'; capability: string; method: string; params: JsonValue; }
	| { operation: 'editorOperation'; payload: JsonValue; }
	| { operation: 'backendState'; capability: string; after: number; }
	| { operation: 'readResourceFile' | 'statResource' | 'readResourceDirectory'; uri: string; }
	| { operation: 'readInitialization'; }
	| { operation: 'openRemoteConnection'; authority: string; }
	| { operation: 'setStatusBarEntries'; registrationId: string; revision: number; entries: readonly ExtensionStatusBarEntry[]; }
	| { operation: 'setDiagnostics'; collection: string; entries: ExtensionDiagnosticEntry[]; }
	| { operation: 'executeCommand'; command: string; arguments: JsonValue[]; }
	| { operation: 'addDebugBreakpoints'; breakpoints: readonly JsonValue[]; }
	| { operation: 'removeDebugBreakpoints'; breakpointIds: readonly string[]; }
	| { operation: 'getDebugProtocolBreakpoint'; sessionId: string; breakpointId: string; }
	| { operation: 'setDebugSessionName'; sessionId: string; name: string; }
	| { operation: 'listDebugSessions'; }
	| { operation: 'startDebugging'; folder: string | null; configuration: JsonValue; options?: { parentSessionId?: string; lifecycleManagedByParent?: boolean; consoleMode?: number; noDebug?: boolean; suppressSaveBeforeStart?: boolean; }; }
	| { operation: 'stopDebugging'; sessionId: string | null; }
	| { operation: 'debugCustomRequest'; sessionId: string; command: string; arguments: JsonValue; hasArguments: boolean; }
	| { operation: 'fetchTasks'; version: string | null; taskType: string | null; }
	| { operation: 'executeTask'; taskId: string | null; task: JsonValue | null; }
	| { operation: 'terminateTask'; executionId: string; }
	| { operation: 'readDocument'; uri: string; }
	| { operation: 'listDocuments'; }
	| { operation: 'applyEdit'; documents: ExtensionDocumentEdit[]; }
	| { operation: 'readConfiguration'; section: string; resource: string | null; }
	| { operation: 'updateConfiguration'; section: string; value: JsonValue; target: 'user' | 'workspace'; }
	| { operation: 'showMessage'; message: string; severity: 'information' | 'warning' | 'error'; }
	| { operation: 'showQuickPick'; items: string[]; placeholder: string; };

export type ExtensionClientResult =
	| { result: 'value'; value: JsonValue; }
	| { readonly result: "resourceFile"; readonly bytes: readonly number[]; }
	| { readonly result: "resourceStat"; readonly fileType: number; readonly size: number; readonly mtime: number; }
	| { readonly result: "resourceDirectory"; readonly entries: readonly (readonly [string, number])[]; }
	| { result: 'initialization'; initialization: ExtensionHostInitialization; }
	| { result: 'debugSessions'; sequence: number; sessions: readonly JsonValue[]; activeSession: string | null; breakpoints: readonly JsonValue[]; }
	| { result: 'debugStarted'; started: boolean; }
	| { result: 'debugResponse'; value: JsonValue; hasBody: boolean; }
	| { result: 'command'; value: JsonValue; hasValue?: boolean; }
	| { result: 'tasks'; sequence: number; tasks: readonly JsonValue[]; executions: readonly JsonValue[]; }
	| { result: 'taskExecution'; sequence: number; execution: JsonValue; }
	| { result: 'document'; document: ExtensionDocumentSnapshot; }
	| { result: 'documents'; documents: ExtensionDocumentSnapshot[]; }
	| { result: 'applied'; applied: boolean; }
	| { result: 'configuration'; value: JsonValue; }
	| { result: 'selection'; index: number | null; }
	| { result: 'done'; };

export interface ExtensionDiagnosticEntry {
	readonly uri: string;
	readonly version: number | null;
	readonly diagnostics: readonly {
		readonly start: { readonly line: number; readonly character: number; };
		readonly end: { readonly line: number; readonly character: number; };
		readonly message: string;
		readonly severity: 'error' | 'warning' | 'information' | 'hint';
		readonly source: string | null;
		readonly code: string | null;
	}[];
}

export type ExtensionClientHandler = (operation: ExtensionClientOperation, signal: AbortSignal, source: ExtensionClientSource) => Promise<ExtensionClientResult>;

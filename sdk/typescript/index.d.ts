/** Public author API. The host binds identity and permissions; callers never supply an extension ID. */
export const apiVersion: 1;
/** Rust service failures retain a stable protocol code; extension callback errors stay ordinary Error objects. */
export class ExtensionError extends Error {
	readonly code: string;
	constructor(code: string, message: string);
}
export interface Disposable { dispose(): void; }
export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: (listener: (event: undefined) => void, thisArg?: unknown, disposables?: Disposable[]) => Disposable;
}
export class CancellationTokenSource implements Disposable {
	readonly token: CancellationToken;
	cancel(): void;
	dispose(): void;
}
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface TextDocument {
	readonly uri: string | undefined;
	readonly version: number;
	readonly languageId: string;
	readonly text: string;
	getText(): string;
}
/** Zero-based UTF-16 coordinates, including for documents containing surrogate pairs. */
export interface Position { readonly line: number; readonly character: number; }
export interface Range { readonly start: Position; readonly end: Position; }
export interface Hover {
	readonly contents: readonly (string | { readonly value: string; readonly language?: string; })[];
	readonly range?: Range;
}
export interface HoverProvider {
	provideHover(context: InvocationContext, document: TextDocument, position: Position): Hover | undefined | Promise<Hover | undefined>;
}
export interface CompletionItem {
	readonly id: string;
	readonly label: string;
	readonly kind: 'text' | 'method' | 'function' | 'constructor' | 'field' | 'variable' | 'class' | 'interface' | 'module' | 'property' | 'unit' | 'value' | 'enum' | 'keyword' | 'snippet' | 'file' | 'reference' | 'folder' | 'typeParameter';
	readonly range: Range;
	readonly insertText: string;
	readonly insertTextFormat: 'plainText' | 'snippet';
	readonly detail?: string;
	readonly documentation?: string;
	readonly filterText?: string;
	readonly sortText?: string;
	readonly preselect?: boolean;
	readonly commitCharacters?: readonly string[];
	readonly additionalTextEdits?: readonly { readonly range: Range; readonly text: string; }[];
}
export type CompletionContext = { readonly kind: 'invoke' | 'incompleteRefresh'; } | { readonly kind: 'triggerCharacter'; readonly triggerCharacter: string; };
export interface CompletionProvider {
	provideCompletionItems(context: InvocationContext, document: TextDocument, position: Position, trigger: CompletionContext): { readonly isIncomplete: boolean; readonly items: readonly CompletionItem[]; } | Promise<{ readonly isIncomplete: boolean; readonly items: readonly CompletionItem[]; }>;
}
export interface Diagnostic {
	readonly start: Position;
	readonly end: Position;
	readonly message: string;
	readonly severity: 'error' | 'warning' | 'information' | 'hint';
	readonly source: string | null;
	readonly code: string | null;
}
export interface DiagnosticEntry {
	readonly uri: string;
	/** Null is reserved for resources not read in this invocation. */
	readonly version: number | null;
	readonly diagnostics: readonly Diagnostic[];
}
export type TextDocumentEvent =
	| { readonly type: 'open' | 'close'; readonly document: Omit<TextDocument, 'getText' | 'uri'> & { readonly uri: string; }; }
	| { readonly type: 'change'; readonly document: Omit<TextDocument, 'getText' | 'uri'> & { readonly uri: string; }; readonly reason: string; readonly contentChanges: readonly { readonly range: Range; readonly rangeOffset: number; readonly rangeLength: number; readonly text: string; }[]; };
/** Operations are scoped to this invocation and stop when its parent is cancelled or retired. */
export interface InvocationContext {
	readonly cancellationToken: CancellationToken;
	readonly languages: {
		/** Replaces this incarnation's entire named collection; an empty array clears it. */
		setDiagnostics(collection: string, entries: readonly DiagnosticEntry[]): Promise<void>;
	};
	readonly workspace: {
		/** Requests a confirmed connection through the registered resolver; requires remoteAuthorityResolver. */
		openRemoteConnection(authority: string): Promise<void>;
		/** Reads the editor's current text, including unsaved changes. */
		openTextDocument(uri: string): Promise<TextDocument>;
		/** Reads UTF-8 disk content beneath the invocation's granted workspace; maximum 256 KiB. */
		readTextFile(path: string): Promise<string>;
	};
	readonly window: {
		setStatusBarEntries(registrationId: string, revision: number, entries: readonly StatusBarEntry[]): Promise<void>;
		showInformationMessage(message: string): Promise<void>;
		showWarningMessage(message: string): Promise<void>;
		showErrorMessage(message: string): Promise<void>;
		showQuickPick(items: readonly string[], placeholder: string): Promise<string | undefined>;
	};
}
/** Ash saved-target selector, distinct from VS Code’s transport endpoint resolver. */
export interface RemoteConnectionResolver {
	resolve(context: InvocationContext, authority: string): { readonly connectionName: string; } | Promise<{ readonly connectionName: string; }>;
}
export class ResolvedAuthority {
	readonly host: string;
	readonly port: number;
	readonly connectionToken: string | undefined;
	constructor(host: string, port: number, connectionToken?: string);
}
export interface ManagedMessagePassing {
	readonly onDidReceiveMessage: (listener: (data: Uint8Array) => void) => Disposable;
	readonly onDidClose: (listener: (error: Error | undefined) => void) => Disposable;
	readonly onDidEnd: (listener: () => void) => Disposable;
	send(data: Uint8Array): void;
	end(): void;
	drain?(): Promise<void>;
}
export class ManagedResolvedAuthority {
	readonly makeConnection: () => Promise<ManagedMessagePassing>;
	readonly connectionToken: string | undefined;
	constructor(makeConnection: () => Promise<ManagedMessagePassing>, connectionToken?: string);
}
export interface RemoteAuthorityResolverContext { readonly resolveAttempt: number; }
export interface AuthenticationSession {
	readonly id: string;
	readonly accessToken: string;
	readonly account: { readonly id: string; readonly label: string; };
	readonly scopes: readonly string[];
}
export interface ResolvedOptions {
	extensionHostEnv?: { [key: string]: string | null; };
	isTrusted?: boolean;
	authenticationSessionForInitializingExtensions?: AuthenticationSession & { providerId: string; };
}
export type ResolverResult = (ResolvedAuthority | ManagedResolvedAuthority) & ResolvedOptions;
/** Decoded resource identity passed to resolver callbacks; it grants no filesystem access. */
export class Uri {
	private constructor();
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;
	static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string; }): Uri;
	with(change: { scheme?: string; authority?: string | null; path?: string | null; query?: string | null; fragment?: string | null; }): Uri;
	toString(): string;
	toJSON(): { scheme: string; authority: string; path: string; query: string; fragment: string; external: string; };
}
export interface RemoteAuthorityResolver {
	resolve(authority: string, context: RemoteAuthorityResolverContext): ResolverResult | Promise<ResolverResult>;
	getCanonicalURI?(uri: Uri): Uri | null | undefined | Promise<Uri | null | undefined>;
}
export class RemoteAuthorityResolverError extends Error {
	constructor(message?: string);
	static NotAvailable(message?: string, handled?: boolean): RemoteAuthorityResolverError;
	static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError;
}
export interface ExtensionContext {
	readonly extensionId: string;
	readonly subscriptions: Disposable[];
}
/** Registration occurs during activate; dispose revokes its callback. The host publishes the activation atomically. */
export const commands: {
	registerCommand(command: string, title: string, callback: (context: InvocationContext, ...arguments_: JsonValue[]) => JsonValue | undefined | Promise<JsonValue | undefined>): Disposable;
};

export interface StatusBarEntry {
	readonly id: string;
	readonly text: string;
	readonly tooltip: string | null;
	readonly ariaLabel: string | null;
	readonly alignment: 'left' | 'right';
	readonly priority: number;
	readonly command: { readonly command: string; readonly arguments: readonly JsonValue[]; } | null;
}
/** Activation snapshot is computed without retaining obsolete values. Requires statusBar capability. */
export const window: {
	registerStatusBar(registrationId: string, snapshot: () => { readonly revision: number; readonly entries: readonly StatusBarEntry[]; }): Disposable;
};
/** Uses the initiating editor's immutable snapshot. Cancellation retires the host, including pending provider callbacks. */
export const languages: {
	registerHoverProvider(registrationId: string, languageIds: readonly string[], provider: HoverProvider): Disposable;
	registerCompletionProvider(registrationId: string, languageIds: readonly string[], provider: CompletionProvider, triggerCharacters?: readonly string[]): Disposable;
};
export const workspace: {
    /** Window facts are owned by the editor; each domain preserves callback commit order. */
    registerWorkspaceEvents(registrationId: string, listener: (context: InvocationContext, event: JsonValue) => void | Promise<void>): Disposable;
	/** Resolves in the local host before connecting the remote window. Requires remoteAuthorityResolver. */
	registerRemoteAuthorityResolver(authorityPrefix: string, resolver: RemoteAuthorityResolver): Disposable;
	/** Ash saved-target API. Requires remoteAuthorityResolver; ssh belongs to the built-in selector. */
	registerRemoteConnectionResolver(authorityPrefix: string, resolver: RemoteConnectionResolver): Disposable;
	/** Ordered callbacks, beginning with open events for existing models after activation. */
	registerTextDocumentEvents(registrationId: string, listener: (context: InvocationContext, event: TextDocumentEvent) => void | Promise<void>): Disposable;
};
/** These descriptors use the existing Tasks and Debug resource owners. */
export interface TaskDescriptor {
	readonly scope?: 1 | 2 | { readonly uri: string; };
	readonly source?: string;
	readonly id: string;
	readonly label: string;
	readonly group: 'build' | 'test' | 'clean' | 'rebuild' | 'run' | 'other';
	readonly groupIsDefault?: boolean;
	readonly runOptions?: { readonly reevaluateOnRerun?: boolean; };
	readonly presentation?: { readonly echo?: boolean; readonly showReuseMessage?: boolean; readonly panel?: 'shared' | 'dedicated' | 'new'; readonly clear?: boolean; readonly reveal?: 'always' | 'silent' | 'never'; readonly revealProblems?: 'always' | 'onProblem' | 'never'; readonly focus?: boolean; readonly close?: boolean; };
	readonly definition?: { readonly type: string; readonly [key: string]: JsonValue; };
	readonly command?: string;
	readonly execution?: { readonly type: 'process'; readonly program: string; readonly args: readonly string[]; } | ShellExecution | { readonly type: 'custom'; readonly id: string; };
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | null>>;
	readonly detail?: string;
	readonly isBackground?: boolean;
	readonly problemMatchers?: readonly JsonValue[];
}
export type ShellArgument = string | { readonly value: string; readonly quoting: 1 | 2 | 3; };
export type ShellExecution = {
	readonly type: 'shell';
	readonly options?: {
		readonly executable?: string;
		readonly shellArgs?: readonly string[];
		readonly shellQuoting?: { readonly escape?: string | { readonly escapeChar: string; readonly charsToEscape: string; }; readonly strong?: string; readonly weak?: string; };
	};
} & ({ readonly commandLine: string; } | { readonly command: ShellArgument; readonly args: readonly ShellArgument[]; });
export const tasks: {
	registerTaskEvents(registrationId: string, listener: (context: InvocationContext, event: TaskEvent) => void | Promise<void>, createTaskTerminal?: (context: InvocationContext, executionId: string, definition: JsonValue) => Pseudoterminal | PromiseLike<Pseudoterminal>): Disposable;
	registerTaskProvider(registrationId: string, taskType: string, provider: {
		provideTasks(context: InvocationContext): readonly TaskDescriptor[] | Promise<readonly TaskDescriptor[]>;
		resolveTask?(context: InvocationContext, task: JsonValue): TaskDescriptor | undefined | Promise<TaskDescriptor | undefined>;
		createTaskTerminal?(context: InvocationContext, executionId: string, definition: JsonValue): Pseudoterminal | Promise<Pseudoterminal>;
	}): Disposable;
};
export type TaskEvent = { readonly sequence: number; } & (
	| { readonly type: 'snapshot'; readonly executions: readonly JsonValue[]; }
	| { readonly type: 'start' | 'end'; readonly execution: JsonValue; }
	| { readonly type: 'processStart'; readonly execution: JsonValue; readonly processId: number; }
	| { readonly type: 'processEnd'; readonly execution: JsonValue; readonly exitCode: number | null; });
export interface Pseudoterminal {
	readonly onDidWrite: (listener: (data: string) => void) => Disposable;
	readonly onDidClose?: (listener: (code: number | void) => void) => Disposable;
	readonly onDidChangeName?: (listener: (name: string) => void) => Disposable;
	open(dimensions: { readonly columns: number; readonly rows: number; } | undefined): void;
	close(): void;
	handleInput?(data: string): void;
	setDimensions?(dimensions: { readonly columns: number; readonly rows: number; }): void;
}
export const debug: {
	registerDebugEvents(registrationId: string, listener: (context: InvocationContext, event: JsonValue) => void | Promise<void>): Disposable;
	/** Undefined cancels startup; null also opens the selected workspace launch configuration. */
	registerDebugConfigurationProvider(registrationId: string, debuggerType: string, provider: {
		provideDebugConfigurations?(context: InvocationContext, folder: DebugWorkspaceFolder | undefined): readonly JsonValue[] | Promise<readonly JsonValue[]>;
		resolveDebugConfiguration?(context: InvocationContext, folder: DebugWorkspaceFolder | undefined, configuration: JsonValue): JsonValue | undefined | Promise<JsonValue | undefined>;
		resolveDebugConfigurationWithSubstitutedVariables?(context: InvocationContext, folder: DebugWorkspaceFolder | undefined, configuration: JsonValue): JsonValue | undefined | Promise<JsonValue | undefined>;
	}, triggerKind?: 1 | 2): Disposable;
	registerDebugAdapterTrackerFactory(registrationId: string, debuggerType: string, factory: {
		createDebugAdapterTracker(context: InvocationContext, session: JsonValue): DebugAdapterTracker | undefined | Promise<DebugAdapterTracker | undefined>;
	}): Disposable;
	registerDebugAdapterDescriptorFactory(registrationId: string, debuggerType: string, factory: {
		createDebugAdapterDescriptor(context: InvocationContext, configuration: JsonValue, session: { readonly id: string; readonly parentSessionId?: string; readonly workspaceFolder: DebugWorkspaceFolder | null; }, executable?: { readonly program: string; readonly arguments: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string | null>>; }): DebugAdapterDescriptor | undefined | null | PromiseLike<DebugAdapterDescriptor | undefined | null>;
	}): Disposable;
};
export interface DebugAdapterTracker {
	onWillStartSession?(context: InvocationContext): void | Promise<void>;
	onWillReceiveMessage?(context: InvocationContext, message: JsonValue): void | Promise<void>;
	onDidSendMessage?(context: InvocationContext, message: JsonValue): void | Promise<void>;
	onWillStopSession?(context: InvocationContext): void | Promise<void>;
	onError?(context: InvocationContext, error: Error): void | Promise<void>;
	onExit?(context: InvocationContext, code: number | undefined, signal: string | undefined): void | Promise<void>;
}
export type DebugAdapterDescriptor =
	| { readonly program: string; readonly arguments: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string | null>>; }
	| { readonly implementation: { handleMessage(context: InvocationContext, message: JsonValue): void | Promise<void>; readonly onDidSendMessage: (listener: (message: JsonValue) => void) => Disposable; dispose(context?: InvocationContext): void | Promise<void>; }; }
	| { readonly connection: { readonly type: 'server'; readonly port: number; readonly host?: string; } | { readonly type: 'namedPipe'; readonly path: string; }; };
export interface DebugWorkspaceFolder { readonly uri: string; readonly name: string; readonly index: number; }
/** Export activate from the ESM entry. Import the SDK as '@ash/extension'; no Node module loader is supplied. */
export type Activate = (context: ExtensionContext) => void | Promise<void>;
export type Deactivate = () => void | Promise<void>;

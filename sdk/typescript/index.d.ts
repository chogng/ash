/** Values exchanged by commands and provider contracts cross a JSON boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ProviderResult<T> = T | undefined | null | PromiseLike<T | undefined | null>;
export interface Disposable { dispose(): void | Promise<void>; }
export class Disposable {
	constructor(callback: () => void);
	dispose(): void;
	static from(...resources: Disposable[]): Disposable;
}
export type Event<T> = (listener: (event: T) => unknown, thisArg?: unknown, disposables?: Disposable[]) => Disposable;
export class EventEmitter<T> implements Disposable { readonly event: Event<T>; fire(value: T): void; dispose(): void; }
export interface CancellationToken { readonly isCancellationRequested: boolean; readonly onCancellationRequested: Event<void>; }
export class CancellationTokenSource implements Disposable { readonly token: CancellationToken; cancel(): void; dispose(): void; }
export interface Extension<T = unknown> { readonly id: string; readonly extensionUri: Uri; readonly extensionPath: string; readonly packageJSON: Readonly<Record<string, unknown>>; readonly extensionKind: ExtensionKind; readonly isActive: boolean; readonly exports: T; activate(): Promise<T>; }
/** Activation resources are retired with this exact extension instance. */
export interface ExtensionContext { readonly subscriptions: Disposable[]; readonly extensionUri: Uri; readonly extensionPath: string; readonly extensionMode: ExtensionMode; readonly extension: Extension; readonly environmentVariableCollection: EnvironmentVariableCollection; asAbsolutePath(path: string): string; }
export enum ExtensionMode { Production = 1, Development = 2, Test = 3 }
export enum ExtensionKind { UI = 1, Workspace = 2 }
export namespace commands {
	/** Register a declared command during activation. Validate arguments at their JSON boundary. */
	function register<Arguments extends unknown[], Result>(id: string, callback: (...arguments_: Arguments) => Result, thisArg?: unknown): Disposable;
	function execute<T = unknown>(id: string, ...arguments_: unknown[]): Promise<T | undefined>;
}
export namespace files {
	/** Read persisted UTF-8 through Rust during an admitted callback. Currently requires a local Plugin with package and directory-read permission; registry JS reads are denied. Limited to 256 KiB. */
	function readTextFile(path: string): Promise<string>;
}
export interface UriComponents { scheme: string; authority?: string; path?: string; query?: string; fragment?: string; }
export class Uri {
	private constructor();
	readonly scheme: string; readonly authority: string; readonly path: string; readonly query: string; readonly fragment: string; readonly fsPath: string;
	static parse(value: string): Uri; static file(path: string): Uri; static from(value: UriComponents): Uri; static joinPath(base: Uri, ...segments: string[]): Uri;
	with(change: Partial<UriComponents>): Uri; toString(skipEncoding?: boolean): string; toJSON(): UriComponents;
}
export class Position {
	constructor(line: number, character: number); readonly line: number; readonly character: number;
	compareTo(other: Position): number; isEqual(other: Position): boolean; isBefore(other: Position): boolean; isAfter(other: Position): boolean; isBeforeOrEqual(other: Position): boolean; isAfterOrEqual(other: Position): boolean;
	translate(lineDelta?: number, characterDelta?: number): Position; translate(change: { lineDelta?: number; characterDelta?: number }): Position;
	with(line?: number, character?: number): Position; with(change: { line?: number; character?: number }): Position;
}
export class Range {
	constructor(start: Position, end: Position); constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
	readonly start: Position; readonly end: Position; readonly isEmpty: boolean; readonly isSingleLine: boolean;
	contains(value: Range | Position): boolean; isEqual(other: Range): boolean;
}
export class Location { constructor(uri: Uri, rangeOrPosition: Range | Position); uri: Uri; range: Range; }
export class TextEdit { constructor(range: Range, newText: string); range: Range; newText: string; static replace(range: Range, text: string): TextEdit; static insert(position: Position, text: string): TextEdit; static delete(range: Range): TextEdit; }
/** Text edits can be applied by workspace.applyEdit; file rename entries are accepted only in language-provider results. */
export class WorkspaceEdit { replace(uri: Uri, range: Range, text: string): void; insert(uri: Uri, position: Position, text: string): void; delete(uri: Uri, range: Range): void; set(uri: Uri, edits: readonly TextEdit[]): void; renameFile(oldUri: Uri, newUri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void; entries(): [Uri, TextEdit[]][]; }
export interface TextLine { readonly lineNumber: number; readonly text: string; readonly range: Range; readonly rangeIncludingLineBreak: Range; readonly firstNonWhitespaceCharacterIndex: number; readonly isEmptyOrWhitespace: boolean; }
export interface TextDocument { readonly uri: Uri; readonly version: number; readonly languageId: string; readonly isClosed: boolean; readonly lineCount: number; getText(range?: Range): string; offsetAt(position: Position): number; positionAt(offset: number): Position; lineAt(line: number | Position): TextLine; getWordRangeAtPosition(position: Position): Range | undefined; }
export interface TextEditor { readonly document: TextDocument; readonly viewColumn: number | undefined; }
export interface WorkspaceFolder { readonly uri: Uri; readonly name: string; readonly index: number; }
export interface ConfigurationScope { readonly uri?: Uri; readonly languageId?: string; }
export interface ConfigurationInspection<T> { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T; defaultLanguageValue?: T; globalLanguageValue?: T; workspaceLanguageValue?: T; workspaceFolderLanguageValue?: T; languageIds?: string[]; }
export interface WorkspaceConfiguration { get<T>(key: string): T | undefined; get<T>(key: string, defaultValue: T): T; has(key: string): boolean; inspect<T>(key: string): ConfigurationInspection<T> | undefined; }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export interface FileStat { type: FileType; size: number; mtime: number; ctime: number; }
export interface TextDocumentChangeEvent { document: TextDocument; contentChanges: readonly { range: Range; rangeOffset: number; rangeLength: number; text: string }[]; }
export namespace workspace {
	const fs: { readFile(uri: Uri): Promise<Uint8Array>; stat(uri: Uri): Promise<FileStat>; readDirectory(uri: Uri): Promise<[string, FileType][]> };
	const workspaceFolders: readonly WorkspaceFolder[] | undefined; const name: string | undefined; const workspaceFile: Uri | undefined; const rootPath: string | undefined; const textDocuments: readonly TextDocument[];
	const onDidOpenTextDocument: Event<TextDocument>; const onDidChangeTextDocument: Event<TextDocumentChangeEvent>; const onDidCloseTextDocument: Event<TextDocument>;
	const onDidChangeConfiguration: Event<{ affectsConfiguration(section: string, scope?: Uri | ConfigurationScope): boolean }>;
	const onDidChangeWorkspaceFolders: Event<{ added: readonly WorkspaceFolder[]; removed: readonly WorkspaceFolder[] }>;
	function getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined; function getConfiguration(section?: string, scope?: Uri | ConfigurationScope | null): WorkspaceConfiguration;
	function openTextDocument(uri: Uri | string): Promise<TextDocument>;
	/** Apply text edits through the client model owner. File operations are rejected. */
	function applyEdit(edit: WorkspaceEdit): Promise<boolean>;
	function registerRemoteAuthorityResolver(prefix: string, resolver: RemoteAuthorityResolver): Disposable;
}
export class MarkdownString { constructor(value?: string); value: string; appendText(text: string): this; appendMarkdown(text: string): this; }
export class SnippetString { constructor(value?: string); value: string; }
export class Hover { constructor(contents: string | MarkdownString | { language: string; value: string } | readonly (string | MarkdownString | { language: string; value: string })[], range?: Range); contents: readonly (string | MarkdownString | { language: string; value: string })[]; range?: Range; }
export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export class Diagnostic { constructor(range: Range, message: string, severity?: DiagnosticSeverity); range: Range; message: string; severity: DiagnosticSeverity; source?: string; code?: string | number; }
export interface DiagnosticCollection extends Disposable, Iterable<[Uri, readonly Diagnostic[]]> { readonly name: string; set(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void; set(entries: readonly [Uri, readonly Diagnostic[] | undefined][]): void; delete(uri: Uri): void; clear(): void; get(uri: Uri): readonly Diagnostic[] | undefined; has(uri: Uri): boolean; forEach(callback: (uri: Uri, diagnostics: readonly Diagnostic[]) => unknown): void; }
export enum CompletionItemKind { Text = 0, Method = 1, Function = 2, Constructor = 3, Field = 4, Variable = 5, Class = 6, Interface = 7, Module = 8, Property = 9, Unit = 10, Value = 11, Enum = 12, Keyword = 13, Snippet = 14, File = 16, Reference = 17, Folder = 18, TypeParameter = 24 }
export enum CompletionTriggerKind { Invoke = 0, TriggerCharacter = 1, TriggerForIncompleteCompletions = 2 }
export class CompletionItem { constructor(label: string | { label: string; detail?: string; description?: string }, kind?: CompletionItemKind); label: string | { label: string; detail?: string; description?: string }; kind?: CompletionItemKind; detail?: string; documentation?: string | MarkdownString; insertText?: string | SnippetString; range?: Range; textEdit?: TextEdit; filterText?: string; sortText?: string; preselect?: boolean; additionalTextEdits?: TextEdit[]; commitCharacters?: string[]; }
export class CompletionList<T extends CompletionItem = CompletionItem> { constructor(items?: T[], isIncomplete?: boolean); items: T[]; isIncomplete: boolean; }
export interface Command { command: string; title: string; arguments?: unknown[]; }
export class CodeActionKind { constructor(value: string); value: string; }
export enum SymbolKind { File, Module, Namespace, Package, Class, Method, Property, Field, Constructor, Enum, Interface, Function, Variable, Constant, String, Number, Boolean, Array, Object, Key, Null, EnumMember, Struct, Event, Operator, TypeParameter }
export interface DocumentSymbol { name: string; detail?: string; kind: SymbolKind; range: Range; selectionRange: Range; children?: DocumentSymbol[]; }
export interface SymbolInformation { name: string; kind: SymbolKind; location: Location; containerName?: string; }
export type DocumentSelector = string | readonly string[];
export interface CompletionItemProvider { provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: { triggerKind: CompletionTriggerKind; triggerCharacter?: string }): ProviderResult<CompletionItem[] | CompletionList>; }
export interface HoverProvider { provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover>; }
export interface DefinitionProvider { provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Location | Location[]>; }
export interface ReferenceProvider { provideReferences(document: TextDocument, position: Position, context: { includeDeclaration: boolean }, token: CancellationToken): ProviderResult<Location[]>; }
export interface RenameProvider { prepareRename?(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Range | { range: Range; placeholder: string }>; provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): ProviderResult<WorkspaceEdit>; }
export interface DocumentSymbolProvider { provideDocumentSymbols(document: TextDocument, token: CancellationToken): ProviderResult<DocumentSymbol[]>; }
export interface FoldingRange { start: number; end: number; kind?: string; }
export interface DocumentLink { range: Range; target?: Uri; tooltip?: string; }
export interface SelectionRange { range: Range; parent?: SelectionRange; }
export interface CodeAction { title: string; kind?: CodeActionKind; edit?: WorkspaceEdit; disabled?: { reason: string }; }
export namespace languages {
	function createDiagnosticCollection(name?: string): DiagnosticCollection;
	function registerCompletionItemProvider(selector: DocumentSelector, provider: CompletionItemProvider, ...triggerCharacters: string[]): Disposable;
	function registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable;
	function registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable;
	function registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable;
	function registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable;
	function registerDocumentSymbolProvider(selector: DocumentSelector, provider: DocumentSymbolProvider): Disposable;
	function registerFoldingRangeProvider(selector: DocumentSelector, provider: { provideFoldingRanges(document: TextDocument, context: Record<string, unknown>, token: CancellationToken): ProviderResult<FoldingRange[]> }): Disposable;
	function registerDocumentLinkProvider(selector: DocumentSelector, provider: { provideDocumentLinks(document: TextDocument, token: CancellationToken): ProviderResult<DocumentLink[]> }): Disposable;
	function registerCodeActionsProvider(selector: DocumentSelector, provider: { provideCodeActions(document: TextDocument, range: Range, context: { diagnostics: Diagnostic[]; only?: CodeActionKind }, token: CancellationToken): ProviderResult<CodeAction[]> }): Disposable;
	function registerSelectionRangeProvider(selector: DocumentSelector, provider: { provideSelectionRanges(document: TextDocument, positions: Position[], token: CancellationToken): ProviderResult<SelectionRange[]> }): Disposable;
	function registerWorkspaceSymbolProvider(provider: { provideWorkspaceSymbols(query: string, token: CancellationToken): ProviderResult<SymbolInformation[]> }): Disposable;
	function registerDocumentHighlightProvider(selector: DocumentSelector, provider: { provideDocumentHighlights(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<{ range: Range; kind?: number }[]> }): Disposable;
}
export interface QuickPickItem { label: string; description?: string; detail?: string; }
export interface AccessibilityInformation { label: string; role?: 'button'; }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export interface StatusBarItem extends Disposable { readonly id: string; readonly alignment: StatusBarAlignment; readonly priority: number | undefined; text: string; name?: string; tooltip?: string; command?: string | Command; accessibilityInformation?: AccessibilityInformation; show(): void; hide(): void; }
export enum LogLevel { Off = 0, Trace = 1, Debug = 2, Info = 3, Warning = 4, Error = 5 }
export interface OutputChannel extends Disposable { readonly name: string; append(text: string): void; appendLine(text: string): void; replace(text: string): void; clear(): void; show(preserveFocus?: boolean): void; hide(): void; }
export interface LogOutputChannel extends OutputChannel { readonly logLevel: LogLevel; readonly onDidChangeLogLevel: Event<LogLevel>; trace(message: string | Error, ...args: unknown[]): void; debug(message: string | Error, ...args: unknown[]): void; info(message: string | Error, ...args: unknown[]): void; warn(message: string | Error, ...args: unknown[]): void; error(message: string | Error, ...args: unknown[]): void; }
export interface Webview { html: string; readonly options: Readonly<Record<string, unknown>>; asWebviewUri(uri: Uri): Uri; postMessage(message: unknown): Promise<boolean>; readonly onDidReceiveMessage: Event<unknown>; }
export interface WebviewPanel extends Disposable { readonly webview: Webview; readonly onDidDispose: Event<void>; }
export interface CustomTextEditorProvider { resolveCustomTextEditor(document: TextDocument, panel: WebviewPanel, token: CancellationToken): ProviderResult<void>; }
export interface ComparisonResource { resource: string; label?: string; initialText?: string; initialBytes?: number[]; contentType?: string; }
export type ComparisonInput = { kind: 'diff' | 'binaryDiff'; label?: string; original: ComparisonResource; modified: ComparisonResource } | { kind: 'multiDiff'; resource: string; label?: string; items: { label?: string; binary?: boolean; original?: ComparisonResource; modified?: ComparisonResource }[] };
export interface EditorOpenOptions { preserveFocus?: boolean; pinned?: boolean; revealIfOpened?: boolean; }
export namespace window {
	const activeTextEditor: TextEditor | undefined;
	function showInformationMessage<T extends string | { title: string }>(text: string, ...items: T[]): Promise<T | undefined>;
	function showWarningMessage<T extends string | { title: string }>(text: string, ...items: T[]): Promise<T | undefined>;
	function showErrorMessage<T extends string | { title: string }>(text: string, ...items: T[]): Promise<T | undefined>;
	function showQuickPick<T extends string | QuickPickItem>(items: readonly T[], options?: { placeHolder?: string }): Promise<T | undefined>;
	function createOutputChannel(name: string, languageId?: string): OutputChannel; function createOutputChannel(name: string, options: { log: true }): LogOutputChannel;
	function createStatusBarItem(id: string, alignment?: StatusBarAlignment, priority?: number): StatusBarItem; function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
	function registerCustomEditorProvider(viewType: string, provider: CustomTextEditorProvider): Disposable;
	function openComparison(input: ComparisonInput, options?: EditorOpenOptions, sideBySide?: boolean): Promise<void>;
	function registerTerminalProfileProvider(id: string, provider: TerminalProfileProvider): Disposable;
	function registerTerminalLinkProvider<T extends TerminalLink>(provider: TerminalLinkProvider<T>): Disposable;
	function registerTerminalCompletionProvider(provider: TerminalCompletionProvider, ...triggerCharacters: string[]): Disposable;
	function registerTerminalQuickFixProvider(id: string, provider: TerminalQuickFixProvider): Disposable;
}
export namespace env { const language: string; }
export namespace l10n { const bundle: Readonly<Record<string, string>> | undefined; const uri: Uri | undefined; function t(message: string, ...args: (string | number | boolean)[]): string; function t(options: { message: string; args?: Record<string, string | number | boolean>; comment?: string | string[] }): string; }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum TreeItemCheckboxState { Unchecked = 0, Checked = 1 }
export class TreeItem { constructor(label: string | { label: string; highlights?: [number, number][] } | Uri, collapsibleState?: TreeItemCollapsibleState); label?: string | { label: string; highlights?: [number, number][] }; resourceUri?: Uri; collapsibleState: TreeItemCollapsibleState; description?: string | boolean; tooltip?: string | MarkdownString; iconPath?: Uri | { light: Uri; dark: Uri } | { id: string }; contextValue?: string; command?: Command; checkboxState?: TreeItemCheckboxState; }
export interface Terminal { readonly name: string; readonly processId: Promise<number | undefined>; }
export interface TerminalDimensions { columns: number; rows: number; }
export interface Pseudoterminal { readonly onDidWrite: Event<string>; readonly onDidClose?: Event<void | number>; readonly onDidChangeName?: Event<string>; readonly onDidOverrideDimensions?: Event<TerminalDimensions | undefined>; open(dimensions?: TerminalDimensions): void; close(): void; handleInput?(text: string): void; setDimensions?(dimensions: TerminalDimensions): void; }
export interface TerminalOptions { name?: string; shellPath?: string; shellArgs?: string | string[]; cwd?: Uri | string; env?: Record<string, string | null>; iconPath?: { id: string }; color?: { id: string }; }
export interface ExtensionTerminalOptions { name?: string; pty: Pseudoterminal; iconPath?: { id: string }; color?: { id: string }; }
export class TerminalProfile { constructor(options: TerminalOptions | ExtensionTerminalOptions); options: TerminalOptions | ExtensionTerminalOptions; }
export interface TerminalProfileProvider { provideTerminalProfile(token: CancellationToken): ProviderResult<TerminalProfile>; }
export interface TerminalLink { startIndex: number; length: number; tooltip?: string; }
export interface TerminalLinkProvider<T extends TerminalLink = TerminalLink> { provideTerminalLinks(context: { line: string; terminal: Terminal }, token: CancellationToken): ProviderResult<T[]>; handleTerminalLink(link: T): ProviderResult<void>; }
export enum TerminalCompletionItemKind { File, Folder, Method, Alias, Argument, Option, OptionValue, Flag, SymbolicLinkFile, SymbolicLinkFolder, ScmCommit, ScmBranch, ScmTag, ScmStash, ScmRemote, PullRequest, PullRequestDone }
export class TerminalCompletionItem { constructor(label: string | { label: string; detail?: string; description?: string }, replacementRange: [number, number], kind?: TerminalCompletionItemKind); label: string | { label: string; detail?: string; description?: string }; replacementRange: [number, number]; kind?: TerminalCompletionItemKind; detail?: string; documentation?: string; }
export class TerminalCompletionList { constructor(items: TerminalCompletionItem[], resourceOptions?: { cwd: Uri; filesRequested?: boolean; foldersRequested?: boolean }); items: TerminalCompletionItem[]; resourceOptions?: { cwd: Uri; filesRequested?: boolean; foldersRequested?: boolean }; }
export interface TerminalCompletionProvider { provideTerminalCompletions(terminal: Terminal, context: { commandLine: string; cursorIndex: number }, token: CancellationToken): ProviderResult<TerminalCompletionItem[] | TerminalCompletionList>; }
export enum TerminalOutputAnchor { Top = 0, Bottom = 1 }
export class TerminalQuickFixTerminalCommand { constructor(terminalCommand: string, shouldExecute?: boolean); terminalCommand: string; shouldExecute?: boolean; }
export class TerminalQuickFixOpener { constructor(uri: Uri); uri: Uri; }
export interface TerminalQuickFixProvider { provideTerminalQuickFixes(match: { commandLineMatch: RegExpMatchArray; outputMatch?: { regexMatch: RegExpMatchArray } }, token: CancellationToken): ProviderResult<TerminalQuickFixTerminalCommand | TerminalQuickFixOpener | Command | (TerminalQuickFixTerminalCommand | TerminalQuickFixOpener | Command)[]>; }
export interface EnvironmentVariableMutator { readonly variable: string; readonly value: string; readonly type: number; readonly options?: { applyAtProcessCreation?: boolean; applyAtShellIntegration?: boolean }; }
export interface EnvironmentVariableCollection extends Iterable<[string, EnvironmentVariableMutator]> { persistent: boolean; description: string | undefined; replace(variable: string, value: string, options?: EnvironmentVariableMutator['options']): void; append(variable: string, value: string, options?: EnvironmentVariableMutator['options']): void; prepend(variable: string, value: string, options?: EnvironmentVariableMutator['options']): void; get(variable: string): EnvironmentVariableMutator | undefined; delete(variable: string): void; clear(): void; forEach(callback: (variable: string, mutator: EnvironmentVariableMutator, collection: EnvironmentVariableCollection) => unknown): void; getScoped(scope: { workspaceFolder: WorkspaceFolder }): EnvironmentVariableCollection; }
export enum TaskScope { Global = 1, Workspace = 2 }
export enum TaskPanelKind { Shared = 1, Dedicated = 2, New = 3 }
export enum TaskRevealKind { Always = 1, Silent = 2, Never = 3 }
export enum ShellQuoting { Escape = 1, Strong = 2, Weak = 3 }
export interface TaskDefinition { type: string; [key: string]: unknown; }
export interface ProcessExecutionOptions { cwd?: string; env?: Record<string, string>; }
export interface ShellExecutionOptions extends ProcessExecutionOptions { executable?: string; shellArgs?: string[]; }
export interface ShellQuotedString { value: string; quoting: ShellQuoting; }
export class ProcessExecution { constructor(process: string, args?: string[], options?: ProcessExecutionOptions); constructor(process: string, options?: ProcessExecutionOptions); process: string; args: string[]; options?: ProcessExecutionOptions; }
export class ShellExecution { constructor(commandLine: string, options?: ShellExecutionOptions); constructor(command: string | ShellQuotedString, args: (string | ShellQuotedString)[], options?: ShellExecutionOptions); commandLine?: string; command?: string | ShellQuotedString; args?: (string | ShellQuotedString)[]; options?: ShellExecutionOptions; }
export class CustomExecution { constructor(callback: (definition: TaskDefinition) => Pseudoterminal | PromiseLike<Pseudoterminal>); callback: (definition: TaskDefinition) => Pseudoterminal | PromiseLike<Pseudoterminal>; }
export class TaskGroup { constructor(id: string, label: string, isDefault?: boolean); readonly id: string; readonly isDefault?: boolean; label: string; static readonly Build: TaskGroup; static readonly Test: TaskGroup; static readonly Clean: TaskGroup; static readonly Rebuild: TaskGroup; }
export interface TaskPresentationOptions { reveal?: TaskRevealKind; panel?: TaskPanelKind; echo?: boolean; focus?: boolean; clear?: boolean; showReuseMessage?: boolean; close?: boolean; }
export class Task {
	constructor(definition: TaskDefinition, name: string, source: string, execution?: ProcessExecution | ShellExecution | CustomExecution, problemMatchers?: string | string[]);
	constructor(definition: TaskDefinition, scope: TaskScope | WorkspaceFolder, name: string, source: string, execution?: ProcessExecution | ShellExecution | CustomExecution, problemMatchers?: string | string[]);
	definition: TaskDefinition; scope?: TaskScope | WorkspaceFolder; name: string; source: string; execution?: ProcessExecution | ShellExecution | CustomExecution; problemMatchers: string[]; isBackground: boolean; group?: TaskGroup; detail?: string; presentationOptions: TaskPresentationOptions; runOptions: { reevaluateOnRerun?: boolean };
}
export interface TaskExecution { readonly task: Task; terminate(): void; }
export interface TaskProvider { provideTasks(token: CancellationToken): ProviderResult<Task[]>; resolveTask?(task: Task, token: CancellationToken): ProviderResult<Task>; }
export namespace tasks { const taskExecutions: readonly TaskExecution[]; const onDidStartTask: Event<{ execution: TaskExecution }>; const onDidEndTask: Event<{ execution: TaskExecution }>; const onDidStartTaskProcess: Event<{ execution: TaskExecution; processId: number }>; const onDidEndTaskProcess: Event<{ execution: TaskExecution; exitCode?: number }>; function fetchTasks(filter?: { type?: string; version?: string }): Promise<Task[]>; function executeTask(task: Task): Promise<TaskExecution>; function registerTaskProvider(type: string, provider: TaskProvider): Disposable; }
export interface DebugConfiguration { type: string; name: string; request: string; [key: string]: unknown; }
export interface DebugSession { readonly id: string; readonly type: string; name: string; readonly configuration: DebugConfiguration; readonly parentSession?: DebugSession; readonly workspaceFolder?: WorkspaceFolder; customRequest<T = unknown>(command: string, args?: unknown): Promise<T | undefined>; getDebugProtocolBreakpoint(point: Breakpoint): Promise<unknown>; }
export class Breakpoint { constructor(enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string); readonly id: string; readonly enabled: boolean; readonly condition?: string; readonly hitCondition?: string; readonly logMessage?: string; }
export class SourceBreakpoint extends Breakpoint { constructor(location: Location, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string); readonly location: Location; }
export class FunctionBreakpoint extends Breakpoint { constructor(functionName: string, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string); readonly functionName: string; }
export class DebugThread { constructor(session: DebugSession, threadId: number); readonly session: DebugSession; readonly threadId: number; }
export class DebugStackFrame { constructor(session: DebugSession, threadId: number, frameId: number); readonly session: DebugSession; readonly threadId: number; readonly frameId: number; }
export enum DebugConsoleMode { Separate = 0, MergeWithParent = 1 }
export enum DebugConfigurationProviderTriggerKind { Initial = 1, Dynamic = 2 }
export interface DebugSessionOptions { parentSession?: DebugSession; lifecycleManagedByParent?: boolean; consoleMode?: DebugConsoleMode; noDebug?: boolean; suppressSaveBeforeStart?: boolean; }
export interface DebugConfigurationProvider { provideDebugConfigurations?(folder: WorkspaceFolder | undefined, token: CancellationToken): ProviderResult<DebugConfiguration[]>; resolveDebugConfiguration?(folder: WorkspaceFolder | undefined, configuration: DebugConfiguration, token: CancellationToken): ProviderResult<DebugConfiguration>; resolveDebugConfigurationWithSubstitutedVariables?(folder: WorkspaceFolder | undefined, configuration: DebugConfiguration, token: CancellationToken): ProviderResult<DebugConfiguration>; }
export interface DebugAdapterTracker { onWillStartSession?(): void; onWillReceiveMessage?(message: unknown): void; onDidSendMessage?(message: unknown): void; onWillStopSession?(): void; onError?(error: Error): void; onExit?(code: number | undefined, signal: string | undefined): void; }
export interface DebugAdapter extends Disposable { readonly onDidSendMessage: Event<unknown>; handleMessage(message: unknown): void; }
export class DebugAdapterExecutable { constructor(command: string, args?: string[], options?: { cwd?: string; env?: Record<string, string | null> }); command: string; args: string[]; options?: { cwd?: string; env?: Record<string, string | null> }; }
export class DebugAdapterServer { constructor(port: number, host?: string); port: number; host?: string; }
export class DebugAdapterNamedPipeServer { constructor(path: string); path: string; }
export class DebugAdapterInlineImplementation { constructor(implementation: DebugAdapter); implementation: DebugAdapter; }
export type DebugAdapterDescriptor = DebugAdapterExecutable | DebugAdapterServer | DebugAdapterNamedPipeServer | DebugAdapterInlineImplementation;
export namespace debug {
	const activeDebugSession: DebugSession | undefined; const activeStackItem: DebugThread | DebugStackFrame | undefined; const breakpoints: readonly Breakpoint[];
	const onDidChangeActiveStackItem: Event<DebugThread | DebugStackFrame | undefined>; const onDidChangeBreakpoints: Event<{ added: readonly Breakpoint[]; removed: readonly Breakpoint[]; changed: readonly Breakpoint[] }>;
	const onDidStartDebugSession: Event<DebugSession>; const onDidTerminateDebugSession: Event<DebugSession>; const onDidChangeActiveDebugSession: Event<DebugSession | undefined>; const onDidReceiveDebugSessionCustomEvent: Event<{ session: DebugSession; event: string; body: unknown }>;
	function asDebugSourceUri(source: { path?: string; name?: string; sourceReference?: number }, session?: DebugSession): Uri;
	function addBreakpoints(points: readonly Breakpoint[]): void; function removeBreakpoints(points: readonly Breakpoint[]): void;
	function startDebugging(folder: WorkspaceFolder | undefined, nameOrConfiguration: string | DebugConfiguration, options?: DebugSessionOptions | DebugSession): Promise<boolean>; function stopDebugging(session?: DebugSession): Promise<void>;
	function registerDebugConfigurationProvider(type: string, provider: DebugConfigurationProvider, triggerKind?: DebugConfigurationProviderTriggerKind): Disposable;
	function registerDebugAdapterTrackerFactory(type: string, factory: { createDebugAdapterTracker(session: DebugSession): ProviderResult<DebugAdapterTracker> }): Disposable;
	function registerDebugAdapterDescriptorFactory(type: string, factory: { createDebugAdapterDescriptor(session: DebugSession, executable: DebugAdapterExecutable | undefined): ProviderResult<DebugAdapterDescriptor> }): Disposable;
}
export class ResolvedAuthority { constructor(host: string, port: number, connectionToken?: string); host: string; port: number; connectionToken?: string; }
export class ManagedResolvedAuthority { constructor(makeConnection: () => Promise<unknown>, connectionToken?: string); makeConnection: () => Promise<unknown>; connectionToken?: string; }
export class RemoteAuthorityResolverError extends Error { constructor(message: string, code?: string, handled?: boolean); code: string; handled: boolean; static NotAvailable(message: string, handled?: boolean): RemoteAuthorityResolverError; static TemporarilyNotAvailable(message: string): RemoteAuthorityResolverError; }
export interface RemoteAuthorityResolver { resolve(authority: string, context: { resolveAttempt: number }): ProviderResult<ResolvedAuthority | ManagedResolvedAuthority>; }
export enum SpeechToTextStatus { Started = 1, Recognizing = 2, Recognized = 3, Stopped = 4, Error = 5 }
export enum TextToSpeechStatus { Started = 1, Stopped = 2, Error = 3 }
export enum KeywordRecognitionStatus { Recognized = 1, Stopped = 2 }
export interface SpeechToTextSession { readonly onDidChange: Event<{ status: SpeechToTextStatus; text?: string }>; }
export interface TextToSpeechSession { readonly onDidChange: Event<{ status: TextToSpeechStatus }>; synthesize(text: string): Promise<void>; }
export interface KeywordRecognitionSession { readonly onDidChange: Event<{ status: KeywordRecognitionStatus; text?: string }>; }
export interface SpeechProvider { provideSpeechToTextSession(token: CancellationToken, options?: { language?: string }): ProviderResult<SpeechToTextSession>; provideTextToSpeechSession(token: CancellationToken, options?: { language?: string }): ProviderResult<TextToSpeechSession>; provideKeywordRecognitionSession(token: CancellationToken): ProviderResult<KeywordRecognitionSession>; }
export namespace speech { function registerSpeechProvider(identifier: string, provider: SpeechProvider): Disposable; }
export interface SCMAction { id: string; label: string; tooltip?: string; icon?: { id: string }; enabled?: boolean; checked?: boolean; run(): ProviderResult<void>; }
export interface SCMResource { sourceUri: Uri; path: string; originalPath?: string; decorations?: { badge?: string; tooltip?: string; kind?: string }; openLabel?: string; actions: SCMAction[]; open(options?: EditorOpenOptions, sideBySide?: boolean): ProviderResult<void>; }
export interface SCMResourceGroup { id: string; label: string; actions: SCMAction[]; resources: SCMResource[]; }
export interface SCMInput { value: string; placeholder: string; enabled: boolean; canAccept: boolean; buttonLabel: string; buttonTooltip: string; visible?: boolean; buttonVisible?: boolean; validationMessage?: string; accept(): ProviderResult<unknown>; }
export interface SCMStatusCommand { id: string; text: string; ariaLabel?: string; tooltip?: string; priority?: number; compactGroup?: string; icon?: { id: string }; run?(): ProviderResult<void>; }
export interface SCMObservable<T> { get(): T; readonly onDidChange: Event<T>; }
export interface SCMHistoryProvider { historyItemRef: SCMObservable<unknown>; historyItemRemoteRef?: SCMObservable<unknown>; historyItemBaseRef?: SCMObservable<unknown>; readonly onDidChange: Event<unknown>; readonly onDidChangeHistoryItemRefs?: Event<unknown[]>; refresh?(): ProviderResult<void>; provideHistoryItemRefs?(...args: unknown[]): ProviderResult<unknown>; resolveHistoryItemRefsCommonAncestor?(...args: unknown[]): ProviderResult<unknown>; provideHistoryItems?(...args: unknown[]): ProviderResult<unknown>; resolveHistoryItemDetails?(...args: unknown[]): ProviderResult<unknown>; provideHistoryItemChanges?(...args: unknown[]): ProviderResult<unknown>; resolveHistoryItemChangeContents?(...args: unknown[]): ProviderResult<unknown>; resolveHistoryItemChatContext?(...args: unknown[]): ProviderResult<unknown>; resolveHistoryItemChangeRangeChatContext?(...args: unknown[]): ProviderResult<unknown>; }
export interface SCMProvider { id: string; providerId: string; label: string; rootUri?: Uri; count?: number; readonly onDidChangeResources: Event<unknown>; groups: SCMResourceGroup[]; input: SCMInput; statusBarCommands: SCMStatusCommand[]; statusMessage: string; isBusy: boolean; activeRepositoryName?: string; historyProvider?: SCMHistoryProvider; mergeProvider?: { resolve(...args: unknown[]): ProviderResult<unknown>; complete(...args: unknown[]): ProviderResult<unknown> }; refresh(): ProviderResult<void>; activate(): ProviderResult<void>; }
export interface SCMReadSignal { readonly aborted: boolean; addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void; removeEventListener(type: 'abort', listener: () => void): void; }
export interface SCMProviderOptions { parseUri(value: string): Uri; decorations?: { readonly onDidChange?: Event<unknown>; provideDecorations(uri: Uri, token: CancellationToken): ProviderResult<unknown> }; quickDiff?: { provideOriginalResource(uri: Uri, signal: SCMReadSignal): ProviderResult<{ originalResource: string; label: string; text?: string; revision?: number } | null> }; multiDiff?: { metadata: unknown; resolve(resource: Uri): ProviderResult<unknown> }; }
export namespace scm { function initialize(): void; function registerSCMProvider(provider: SCMProvider, options: SCMProviderOptions): Disposable; function selectRepository(id: string | undefined): void; }

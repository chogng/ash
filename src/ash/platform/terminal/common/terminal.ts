import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { Event } from '../../../base/common/event.js';
import type { OperatingSystem } from '../../../base/common/platform.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import type { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { ILogger } from '../../log/common/log.js';

export const ITerminalLogService = createServiceIdentifier<ITerminalLogService>('terminalLogService');
export interface ITerminalLogService extends ILogger { }

export const enum TerminalSettingPrefix {
	AutomationProfile = 'terminal.integrated.automationProfile.',
	DefaultProfile = 'terminal.integrated.defaultProfile.',
	Profiles = 'terminal.integrated.profiles.',
}

export const enum TerminalSettingId {
	Cwd = 'terminal.integrated.cwd',
}

export type TerminalProcessConnectionState = "stopped" | "starting" | "initializing" | "ready" | "stopping" | "crashed" | "restarting";

export interface ITerminalProcessProfile {
	readonly profileId: string;
	readonly title: string;
	readonly isDefault: boolean;
}

/** Arrays are literal argv; strings are pre-escaped Windows command-line tails. */
export type TerminalArguments = string | readonly string[];
export type TerminalIcon = ThemeIcon | URI | { light: URI; dark: URI; };

export const enum PosixShellType {
	Bash = 'bash', Fish = 'fish', Sh = 'sh', Csh = 'csh', Ksh = 'ksh', Zsh = 'zsh',
}

export const enum WindowsShellType {
	CommandPrompt = 'cmd', Wsl = 'wsl', GitBash = 'gitbash',
}

export const enum GeneralShellType {
	Claude = 'claude', Codex = 'codex', CommandCode = 'commandcode', Copilot = 'copilot', Gemini = 'gemini',
	PowerShell = 'pwsh', Python = 'python', Julia = 'julia', NuShell = 'nu', Node = 'node', Xonsh = 'xonsh',
}

export type TerminalShellType = PosixShellType | WindowsShellType | GeneralShellType | undefined;

export type TerminalProcessProfileSelection =
	| { readonly type: "default"; }
	| { readonly type: "profile"; readonly profileId: string; }
	| { readonly type: 'custom'; readonly name: string; readonly path: readonly string[]; readonly args: TerminalArguments; };

export interface ITerminalResolvedProfile {
	readonly profile: ITerminalProcessProfile;
	readonly executable: string;
	readonly args: TerminalArguments;
}

export interface ITerminalProfileObject {
	readonly path?: string | readonly string[];
	readonly source?: 'PowerShell' | 'Git Bash';
	readonly args?: TerminalArguments;
	readonly env?: Readonly<Record<string, string | null>>;
	readonly overrideName?: boolean;
	readonly icon?: string;
	readonly color?: string;
}

/** A configured or execution-host-discovered shell, before invocation variables are resolved. */
export interface ITerminalProfile extends ITerminalProcessProfile {
	readonly profileName: string;
	readonly path: string | readonly string[];
	readonly args?: TerminalArguments;
	readonly env?: Readonly<Record<string, string | null>>;
	readonly overrideName?: boolean;
	readonly icon?: ThemeIcon;
	readonly color?: string;
	readonly isAutoDetected?: boolean;
}

export interface ICreateContributedTerminalProfileOptions {
	readonly icon?: ThemeIcon;
	readonly color?: string;
}

export interface IExtensionTerminalProfile {
	readonly extensionIdentifier: string;
	readonly id: string;
	readonly title: string;
	readonly options?: ICreateContributedTerminalProfileOptions;
}

export type TerminalProcessExecution =
	| { readonly type: 'process'; readonly program: string; readonly args: TerminalArguments; }
	| { readonly type: 'shell'; readonly commandLine: string; };

export interface ITerminalProcessCreateOptions {
	readonly dirId?: string;
	readonly rows: number;
	readonly cols: number;
	readonly profile: TerminalProcessProfileSelection;
	readonly env?: Readonly<Record<string, string | null>>;
	/** Start from only the supplied environment rather than the execution host snapshot. */
	readonly strictEnv?: boolean;
	readonly cwd?: string;
	readonly execution?: TerminalProcessExecution;
}

/** Describes whether a terminal process survives replacement of its App Server connection. */
export type TerminalProcessConnectionPersistence = "connectionOwned" | "reconnectable";

/** Identity and directory confirmed by the backend when the shell was spawned. */
export interface ITerminalProcessReady {
	readonly pid: number;
	readonly cwd: string;
}

/** Current properties queried from the execution owner; unavailable cwd stays distinct from launch cwd. */
export interface ITerminalProcessInfo {
	readonly ready: ITerminalProcessReady;
	readonly cwd: string | undefined;
	readonly rows: number;
	readonly cols: number;
}

export interface ITerminalProcessCreation {
	readonly ready: ITerminalProcessReady;
	readonly terminalId: string;
	readonly profile: ITerminalProcessProfile;
	readonly connectionPersistence: TerminalProcessConnectionPersistence;
}

export interface ITerminalProcessWriteOptions {
	readonly dirId?: string;
	readonly terminalId: string;
	readonly data: string | Uint8Array;
}

export interface ITerminalProcessResizeOptions {
	readonly dirId?: string;
	readonly terminalId: string;
	readonly rows: number;
	readonly cols: number;
}

export interface ITerminalProcessReadOptions {
	readonly dirId?: string;
	readonly terminalId: string;
	readonly afterSequence: number;
	readonly afterCommandSequence: number;
	readonly maxChunks: number;
}

/** Decoded by the execution owner and ordered with the screen's byte stream. */
export type TerminalShellIntegrationEvent =
	| { readonly type: 'outputGap'; }
	| { readonly type: 'processReady'; readonly isWindowsPty: boolean; readonly shellType?: TerminalShellType; }
	| { readonly type: 'promptStart' | 'commandStart' | 'continuationStart' | 'continuationEnd' | 'rightPromptStart' | 'rightPromptEnd' | 'commandStorageDisabled'; }
	| { readonly type: 'commandExecuted'; readonly commandStorageDisabled?: boolean; readonly commandId: string; readonly command: string | undefined; readonly isTrusted: boolean; readonly cwd: string | undefined; readonly timestampMillis: number; }
	| { readonly type: 'commandFinished'; readonly exitCode: number | undefined; readonly durationMillis: number | undefined; }
	| { readonly type: 'commandLine' | 'cwd'; readonly value: string; readonly isTrusted: boolean; }
	| { readonly type: 'hasRichCommandDetection'; readonly value: boolean; }
	| { readonly type: 'promptType'; readonly value: string; }
	| { readonly type: 'environment'; readonly values: import('../../../base/common/platform.js').IProcessEnvironment | undefined; readonly isTrusted: boolean; }
	| { readonly type: 'environmentStart'; readonly clear: boolean; readonly isTrusted: boolean; }
	| { readonly type: 'environmentEntry' | 'environmentDelete'; readonly key: string; readonly value: string | undefined; readonly isTrusted: boolean; }
	| { readonly type: 'environmentEnd'; readonly isTrusted: boolean; };

export interface ITerminalProcessOutputChunk {
	readonly sequence: number;
	/** JSON encoding is removed by the adapter; UTF-8 and ANSI parsing remain with the terminal screen. */
	readonly data: Uint8Array;
	readonly shellIntegration?: TerminalShellIntegrationEvent;
}

export type TerminalProcessCommandStatus = "running" | "completed" | "succeeded" | "failed" | "canceled";

export interface ITerminalProcessCommandStatusEvent {
	readonly sequence: number;
	readonly commandId: string;
	readonly status: TerminalProcessCommandStatus;
	readonly exitCode: number | undefined;
	readonly afterOutputSequence: number;
	readonly cwd?: string;
	readonly command?: string;
	readonly isTrusted?: boolean;
}

/** Detected support and retained completed commands from the original PTY owner. */
export interface ITerminalProcessShellIntegration {
	readonly commandDetection: boolean;
	readonly cwdDetection: boolean;
	readonly hasRichCommandDetection: boolean;
	readonly commandStorageDisabled: boolean;
	readonly promptType?: string;
	readonly commands: readonly ITerminalProcessCommandStatusEvent[];
	readonly afterOutputSequence: number;
}

export interface ITerminalProcessReadResult {
	readonly terminalId: string;
	readonly chunks: readonly ITerminalProcessOutputChunk[];
	readonly nextSequence: number;
	readonly outputGap: boolean;
	readonly commandEvents: readonly ITerminalProcessCommandStatusEvent[];
	readonly nextCommandSequence: number;
	readonly commandEventGap: boolean;
	readonly exited: boolean;
	readonly exitCode: number | undefined;
	readonly cwd?: { readonly value: string; readonly isTrusted?: boolean; readonly afterOutputSequence: number; };
	readonly shellIntegration?: ITerminalProcessShellIntegration;
}

export interface ITerminalProcessCloseOptions {
	readonly dirId?: string;
	readonly terminalId: string;
}

/** Platform contract for creating and communicating with terminal processes. */
export interface ITerminalProcessService {
	/** Initialized execution host OS; unavailable before connection readiness. */
	readonly operatingSystem?: OperatingSystem;
	listProfiles(dirId?: string): Promise<readonly ITerminalProcessProfile[]>;
	resolveProfile(profile: TerminalProcessProfileSelection, dirId?: string): Promise<ITerminalResolvedProfile>;
	/** Reads requested variables from the selected execution host; missing values are omitted. */
	getEnvironment(names?: readonly string[], dirId?: string): Promise<Readonly<Record<string, string>>>;
	getProcessInfo(options: ITerminalProcessCloseOptions): Promise<ITerminalProcessInfo>;
	create(options: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation>;
	write(options: ITerminalProcessWriteOptions): Promise<void>;
	resize(options: ITerminalProcessResizeOptions): Promise<void>;
	read(options: ITerminalProcessReadOptions): Promise<ITerminalProcessReadResult>;
	close(options: ITerminalProcessCloseOptions): Promise<void>;
	getConnectionState(): Promise<TerminalProcessConnectionState>;
	onConnectionState(listener: (state: TerminalProcessConnectionState) => void): IDisposable;
}

export const ITerminalProcessService = createServiceIdentifier<ITerminalProcessService>("terminalProcessService");

export type WaitOnExitValue = boolean | string | ((exitCode: number) => string);

/** Launch information shared with providers that supply their own terminal output. */
export interface IShellLaunchConfig {
	executable?: string | readonly string[];
	args?: TerminalArguments;
	name?: string;
	icon?: ThemeIcon;
	color?: string;
	readonly isFeatureTerminal?: boolean;
	/** Displayed before process output; strings include a trailing newline. */
	readonly initialText?: string | { text: string; trailingNewLine: boolean; };
	/** Retain a completed terminal until a key press, optionally displaying a message. */
	readonly waitOnExit?: WaitOnExitValue;
	env?: Readonly<Record<string, string | null>>;
	strictEnv?: boolean;
	cwd?: string;
	/** Structured execution stays with the existing Rust process owner when a task reuses its screen. */
	readonly execution?: TerminalProcessExecution;
	readonly deferStart?: boolean;
	readonly customPtyImplementation?: (terminalId: number, cols: number, rows: number) => ITerminalChildProcess;
}

export interface IProcessReadyEvent {
	readonly pid: number;
	readonly cwd: string;
}

/** Decoded child-process output; transport adapters preserve bytes until the process decoder consumes them. */
export interface IProcessDataEvent {
	readonly data: string;
	readonly trackCommit: boolean;
	/** Display boundaries share the same parse completion as their preceding bytes. */
	readonly shellIntegration?: TerminalShellIntegrationEvent;
	/** The screen assigns this synchronously, resolving only after xterm parses the write. */
	writePromise?: Promise<void>;
}

export enum ProcessPropertyType {
	Title = 'title',
}

export interface IProcessProperty {
	readonly type: ProcessPropertyType.Title;
	readonly value: string;
}

/** Client event and input ports; the backend or provider owns execution and resource lifetime. */
export interface ITerminalChildProcess extends IDisposable {
	readonly id: number;
	readonly shouldPersist: boolean;
	readonly onProcessData: Event<string | IProcessDataEvent>;
	readonly onProcessReady: Event<IProcessReadyEvent>;
	readonly onDidChangeProperty: Event<IProcessProperty>;
	readonly onProcessExit: Event<number | undefined>;
	start(): Promise<void>;
	shutdown(immediate: boolean): void;
	input?(data: string): void | Promise<void>;
	/** Raw single-byte input from xterm; output-only or text-only providers omit this capability. */
	processBinary?(data: string): Promise<void>;
	resize?(cols: number, rows: number): void | Promise<void>;
	/** Output-only virtual PTYs do not own a working directory. Backed processes query their execution owner. */
	getCwd?(): Promise<string>;
}

/** Workbench host for a terminal screen; moving it retains the process. */
export enum TerminalLocation { Panel = 1, Editor = 2 }

/** Parsed display text captured once; it cannot launch or write to a process. */
export interface ITerminalOutputSnapshot {
	readonly text: string;
	readonly columns: number;
}

/** A buffer contract shared by the command and prompt models without exposing DOM globals. */
export interface ITerminalCommandBuffer {
	readonly type: string;
	readonly baseY: number;
	readonly cursorY: number;
	readonly cursorX: number;
	readonly length: number;
	getLine(line: number): {
		readonly isWrapped: boolean;
		readonly length: number;
		translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
		getCell(column: number): { getChars(): string; getWidth(): number; isDim(): number; isItalic(): number; } | undefined;
	} | undefined;
}

export interface ITerminalCommandScreen {
	readonly cols: number;
	readonly rows: number;
	readonly buffer: { readonly active: ITerminalCommandBuffer; readonly normal: ITerminalCommandBuffer; };
	registerMarker(offset?: number): import('./capabilities/capabilities.js').IMarkProperties['marker'];
	onData(listener: (value: string) => void): { dispose(): void; };
	onCursorMove(listener: () => void): { dispose(): void; };
	onWriteParsed(listener: () => void): { dispose(): void; };
}

export interface ITerminalOutputMatch { regexMatch: RegExpMatchArray; outputLines: string[]; }
export interface ITerminalOutputMatcher {
	lineMatcher: string | RegExp;
	anchor: 'top' | 'bottom';
	offset: number;
	length: number;
	multipleMatches?: boolean;
}

export const enum ShellIntegrationStatus { Off = 0, FinalTerm = 1, VSCode = 2 }
export interface IShellIntegration {
	readonly capabilities: import('./capabilities/capabilities.js').ITerminalCapabilityStore;
	readonly seenSequences: ReadonlySet<string>;
	readonly status: ShellIntegrationStatus;
	readonly onDidChangeStatus: Event<ShellIntegrationStatus>;
	readonly onDidChangeSeenSequences: Event<ReadonlySet<string>>;
	deserialize(value: import('./capabilities/capabilities.js').ISerializedCommandDetectionCapability): void;
	setNextCommandId(command: string, commandId: string): void;
}

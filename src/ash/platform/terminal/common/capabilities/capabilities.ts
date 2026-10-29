import type { Event } from '../../../../base/common/event.js';
import type { ITerminalOutputMatch, ITerminalOutputMatcher } from '../terminal.js';
import type { IPromptInputModel, ISerializedPromptInputModel } from './commandDetection/promptInputModel.js';
import type { ICurrentPartialCommand } from './commandDetection/terminalCommand.js';

export const enum TerminalCapability {
	CwdDetection = 0,
	NaiveCwdDetection = 1,
	CommandDetection = 2,
	PartialCommandDetection = 3,
	BufferMarkDetection = 4,
	ShellEnvDetection = 5,
	PromptTypeDetection = 6,
}

export interface ICwdDetectionCapability {
	readonly type: TerminalCapability.CwdDetection;
	readonly onDidChangeCwd: Event<string>;
	readonly cwds: string[];
	readonly isTrusted: boolean;
	getCwd(): string;
	updateCwd(cwd: string, isTrusted?: boolean): void;
}

export interface INaiveCwdDetectionCapability {
	readonly type: TerminalCapability.NaiveCwdDetection;
	readonly onDidChangeCwd: Event<string>;
	getCwd(): Promise<string>;
}

export interface IPromptTypeDetectionCapability {
	readonly type: TerminalCapability.PromptTypeDetection;
	readonly promptType: string | undefined;
	readonly onPromptTypeChanged: Event<string | undefined>;
	setPromptType(value: string): void;
}

export interface ICommandDetectionCapability {
	readonly type: TerminalCapability.CommandDetection;
	readonly promptInputModel: IPromptInputModel;
	readonly commands: readonly ITerminalCommand[];
	readonly executingCommand: string | undefined;
	readonly executingCommandObject: ITerminalCommand | undefined;
	readonly executingCommandConfidence: 'low' | 'medium' | 'high' | undefined;
	readonly cwd: string | undefined;
	readonly hasRichCommandDetection: boolean;
	readonly currentCommand: ICurrentPartialCommand | undefined;
	readonly onCommandStarted: Event<ITerminalCommand>;
	readonly onCommandFinished: Event<ITerminalCommand>;
	readonly onCommandExecuted: Event<ITerminalCommand>;
	readonly onCommandInvalidated: Event<ITerminalCommand[]>;
	readonly onCurrentCommandInvalidated: Event<ICommandInvalidationRequest>;
	readonly onSetRichCommandDetection: Event<boolean>;
	setContinuationPrompt(value: string): void;
	setPromptTerminator(value: string, lastPromptLine: string): void;
	setCwd(value: string): void;
	setIsWindowsPty(value: boolean): void;
	setIsCommandStorageDisabled(): void;
	getCwdForLine(line: number): string | undefined;
	getCommandForLine(line: number): ITerminalCommand | ICurrentPartialCommand | undefined;
	clearCommands(): void;
	handlePromptStart(options?: IHandleCommandOptions): void;
	handleContinuationStart(): void;
	handleContinuationEnd(): void;
	handleRightPromptStart(): void;
	handleRightPromptEnd(): void;
	handleCommandStart(options?: IHandleCommandOptions): void;
	handleCommandExecuted(options?: IHandleCommandOptions): void;
	handleCommandFinished(exitCode?: number, options?: IHandleCommandOptions): void;
	setHasRichCommandDetection(value: boolean): void;
	setCommandLine(commandLine: string, isTrusted: boolean): void;
	setNextCommandId(command: string, commandId: string): void;
	serialize(): ISerializedCommandDetectionCapability;
	deserialize(value: ISerializedCommandDetectionCapability): void;
}

export const enum CommandInvalidationReason { Windows = 'windows', NoProblemsReported = 'noProblemsReported' }
export interface ICommandInvalidationRequest { reason: CommandInvalidationReason; }
export interface IHandleCommandOptions { ignoreCommandLine?: boolean; marker?: IMarkProperties['marker']; markProperties?: IMarkProperties; }

interface IBaseTerminalCommand {
	command: string;
	commandLineConfidence: 'low' | 'medium' | 'high';
	isTrusted: boolean;
	timestamp: number;
	duration: number;
	id: string | undefined;
	cwd: string | undefined;
	exitCode: number | undefined;
	commandStartLineContent: string | undefined;
	markProperties: IMarkProperties | undefined;
	executedX: number | undefined;
	startX: number | undefined;
}

export interface ITerminalCommand extends IBaseTerminalCommand {
	readonly promptStartMarker?: IMarkProperties['marker'];
	readonly marker?: IMarkProperties['marker'];
	endMarker?: IMarkProperties['marker'];
	readonly executedMarker?: IMarkProperties['marker'];
	readonly aliases?: string[][];
	readonly wasReplayed?: boolean;
	extractCommandLine(): string;
	getOutput(): string | undefined;
	getOutputMatch(matcher: ITerminalOutputMatcher): ITerminalOutputMatch | undefined;
	hasOutput(): boolean;
	getPromptRowCount(): number;
	getCommandRowCount(): number;
}

export interface ISerializedTerminalCommand extends IBaseTerminalCommand {
	startLine: number | undefined;
	promptStartLine: number | undefined;
	endLine: number | undefined;
	executedLine: number | undefined;
}

export interface ISerializedCommandDetectionCapability {
	isWindowsPty: boolean;
	hasRichCommandDetection: boolean;
	commands: ISerializedTerminalCommand[];
	promptInputModel: ISerializedPromptInputModel | undefined;
}

export interface IPartialCommandDetectionCapability {
	readonly type: TerminalCapability.PartialCommandDetection;
	readonly commands: readonly NonNullable<IMarkProperties['marker']>[];
	readonly onCommandFinished: Event<NonNullable<IMarkProperties['marker']>>;
	clearCommands(): void;
}

export interface TerminalCapabilityChangeEvent<T extends TerminalCapability> {
	readonly id: T;
	readonly capability: ITerminalCapabilityImplMap[T];
}

export type AnyTerminalCapabilityChangeEvent = {
	[K in TerminalCapability]: TerminalCapabilityChangeEvent<K>
}[TerminalCapability];

export interface ITerminalCapabilityImplMap {
	[TerminalCapability.CwdDetection]: ICwdDetectionCapability;
	[TerminalCapability.PartialCommandDetection]: IPartialCommandDetectionCapability;
	[TerminalCapability.CommandDetection]: ICommandDetectionCapability;
	[TerminalCapability.NaiveCwdDetection]: INaiveCwdDetectionCapability;
	[TerminalCapability.PromptTypeDetection]: IPromptTypeDetectionCapability;
	[TerminalCapability.BufferMarkDetection]: IBufferMarkCapability;
	[TerminalCapability.ShellEnvDetection]: IShellEnvDetectionCapability;
}

export interface IMarkProperties {
	hoverMessage?: string;
	disableCommandStorage?: boolean;
	hidden?: boolean;
	/** Structural xterm marker contract, without importing the package's DOM globals into Common. */
	marker?: {
		readonly id: number;
		readonly line: number;
		readonly isDisposed: boolean;
		onDispose(listener: () => void): { dispose(): void; };
		dispose(): void;
	};
	id?: string;
}

export interface IBufferMarkCapability {
	readonly type: TerminalCapability.BufferMarkDetection;
	readonly onMarkAdded: Event<IMarkProperties>;
	markers(): IterableIterator<NonNullable<IMarkProperties['marker']>>;
	addMark(properties?: IMarkProperties): void;
	getMark(id: string): IMarkProperties['marker'];
}

export interface ITerminalCapabilityStore {
	readonly items: IterableIterator<TerminalCapability>;
	readonly onDidAddCapability: Event<AnyTerminalCapabilityChangeEvent>;
	readonly onDidRemoveCapability: Event<AnyTerminalCapabilityChangeEvent>;
	readonly onDidChangeCapabilities: Event<void>;
	readonly onDidAddCommandDetectionCapability: Event<ICommandDetectionCapability>;
	readonly onDidRemoveCommandDetectionCapability: Event<void>;
	readonly onDidAddCwdDetectionCapability: Event<ICwdDetectionCapability>;
	readonly onDidRemoveCwdDetectionCapability: Event<void>;
	createOnDidAddCapabilityOfTypeEvent<T extends TerminalCapability>(type: T): Event<ITerminalCapabilityImplMap[T]>;
	createOnDidRemoveCapabilityOfTypeEvent<T extends TerminalCapability>(type: T): Event<ITerminalCapabilityImplMap[T]>;
	has(id: TerminalCapability): boolean;
	get<T extends TerminalCapability>(id: T): ITerminalCapabilityImplMap[T] | undefined;
}

export interface TerminalShellIntegrationEnvironment {
	value: { [key: string]: string | undefined; } | undefined;
	/** Provenance of the reported values, never execution or filesystem authority. */
	isTrusted: boolean;
}
export interface TerminalShellIntegration { readonly env: TerminalShellIntegrationEnvironment; }
export interface IShellEnvDetectionCapability {
	readonly type: TerminalCapability.ShellEnvDetection;
	readonly onDidChangeEnv: Event<TerminalShellIntegrationEnvironment>;
	readonly env: TerminalShellIntegrationEnvironment;
	setEnvironment(values: { [key: string]: string | undefined; } | undefined, isTrusted: boolean): void;
	startEnvironmentSingleVar(clear: boolean, isTrusted: boolean): void;
	setEnvironmentSingleVar(key: string, value: string | undefined, isTrusted: boolean): void;
	deleteEnvironmentSingleVar(key: string, value: string | undefined, isTrusted: boolean): void;
	endEnvironmentSingleVar(isTrusted: boolean): void;
}

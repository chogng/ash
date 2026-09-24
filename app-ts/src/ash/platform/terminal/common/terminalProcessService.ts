import type { IDisposable } from "../../../base/common/lifecycle.js";

export type TerminalProcessConnectionState = "stopped" | "starting" | "initializing" | "ready" | "stopping" | "crashed" | "restarting";

export interface ITerminalProcessProfile {
	readonly profileId: string;
	readonly title: string;
	readonly isDefault: boolean;
}

export type TerminalProcessProfileSelection =
	| { readonly type: "default" }
	| { readonly type: "profile"; readonly profileId: string };

export interface ITerminalProcessCreateOptions {
	readonly dirId?: string;
	readonly rows: number;
	readonly cols: number;
	readonly profile: TerminalProcessProfileSelection;
}

/** Describes whether a terminal process survives replacement of its App Server connection. */
export type TerminalProcessConnectionPersistence = "connectionOwned" | "reconnectable";

export interface ITerminalProcessCreation {
	readonly terminalId: string;
	readonly profile: ITerminalProcessProfile;
	readonly connectionPersistence: TerminalProcessConnectionPersistence;
}

export interface ITerminalProcessWriteOptions {
	readonly dirId?: string;
	readonly terminalId: string;
	readonly data: string;
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

export interface ITerminalProcessOutputChunk {
	readonly sequence: number;
	readonly dataBase64: string;
}

export type TerminalProcessCommandStatus = "running" | "completed" | "succeeded" | "failed" | "canceled";

export interface ITerminalProcessCommandStatusEvent {
	readonly sequence: number;
	readonly commandId: string;
	readonly status: TerminalProcessCommandStatus;
	readonly exitCode: number | null;
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
	readonly exitCode: number | null;
}

export interface ITerminalProcessCloseOptions {
	readonly dirId?: string;
	readonly terminalId: string;
}

/** Platform contract for creating and communicating with terminal processes. */
export interface ITerminalProcessService {
	listProfiles(): Promise<readonly ITerminalProcessProfile[]>;
	create(options: ITerminalProcessCreateOptions): Promise<ITerminalProcessCreation>;
	write(options: ITerminalProcessWriteOptions): Promise<void>;
	resize(options: ITerminalProcessResizeOptions): Promise<void>;
	read(options: ITerminalProcessReadOptions): Promise<ITerminalProcessReadResult>;
	close(options: ITerminalProcessCloseOptions): Promise<void>;
	getConnectionState(): Promise<TerminalProcessConnectionState>;
	onConnectionState(listener: (state: TerminalProcessConnectionState) => void): IDisposable;
}

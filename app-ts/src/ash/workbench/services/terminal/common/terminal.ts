import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** Character-cell dimensions used by Workbench terminal callers. */
export interface ITerminalDimensions {
	readonly rows: number;
	readonly cols: number;
}

/** Lifecycle state of one Workbench terminal instance. */
export type TerminalInstanceState = "running" | "reconnecting" | "exited" | "disconnected" | "error";

/** Renderer-independent lifecycle state of one shell command. */
export type TerminalCommandStatus = "running" | "completed" | "succeeded" | "failed" | "canceled";

/** One command lifecycle transition positioned relative to terminal output. */
export interface ITerminalCommandStatusEvent {
	readonly commandId: string;
	readonly status: TerminalCommandStatus;
	readonly exitCode: number | undefined;
}

/** One available shell profile exposed to Workbench callers. */
export interface ITerminalProfile {
	readonly profileId: string;
	readonly title: string;
	readonly isDefault: boolean;
}

/** Explicit profile selection for a new terminal. */
export type ITerminalProfileSelection =
	| { readonly type: "default" }
	| { readonly type: "profile"; readonly profileId: string };

/** Complete caller-facing input for creating one terminal. */
export interface ITerminalCreateOptions {
	readonly dirId?: string;
	readonly dimensions: ITerminalDimensions;
	readonly profile: ITerminalProfileSelection;
	readonly title?: string;
}

/** One interactive terminal independently of its transport representation. */
export interface ITerminalInstance extends IDisposable {
	readonly id: string;
	readonly dirId: string;
	readonly title: string;
	readonly profile: ITerminalProfile;
	readonly state: TerminalInstanceState;
	readonly exitCode: number | undefined;
	readonly onDidWriteData: Event<Uint8Array>;
	readonly onDidChangeCommandStatus: Event<ITerminalCommandStatusEvent>;
	readonly onDidExit: Event<number | undefined>;
	readonly onDidChangeState: Event<TerminalInstanceState>;

	write(data: string): void;
	resize(dimensions: ITerminalDimensions): void;
	close(): Promise<void>;
}

/** Workbench service contract for terminal instances and active-instance selection. */
export interface ITerminalService extends IDisposable {
	readonly instances: readonly ITerminalInstance[];
	readonly activeInstance: ITerminalInstance | undefined;
	readonly onDidCreateInstance: Event<ITerminalInstance>;
	readonly onDidDisposeInstance: Event<ITerminalInstance>;
	readonly onDidChangeInstances: Event<void>;
	readonly onDidChangeActiveInstance: Event<ITerminalInstance | undefined>;

	getProfiles(): Promise<readonly ITerminalProfile[]>;
	createTerminal(options: ITerminalCreateOptions): Promise<ITerminalInstance>;
	relaunchTerminal(instance: ITerminalInstance, dimensions: ITerminalDimensions): Promise<void>;
	setActiveInstance(instance: ITerminalInstance | undefined): void;
	moveTerminal(instance: ITerminalInstance, targetIndex: number): void;
	closeTerminal(instance: ITerminalInstance): Promise<void>;
}

export const ITerminalService = createServiceIdentifier<ITerminalService>("terminalService");

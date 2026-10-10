import type { IView } from "../../../common/views.js";
import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IProcessDataEvent, IShellLaunchConfig, TerminalProcessExecution } from '../../../../platform/terminal/common/terminal.js';
import type { XtermTerminal } from './xterm/xtermTerminal.js';

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
	| { readonly type: "default"; }
	| { readonly type: "profile"; readonly profileId: string; };

/** Complete caller-facing input for creating one terminal. */
export type ITerminalCreateOptions = {
	readonly dirId?: string;
	readonly dimensions: ITerminalDimensions;
	readonly title?: string;
	readonly env?: Readonly<Record<string, string | null>>;
	readonly cwd?: string;
	readonly execution?: TerminalProcessExecution;
	readonly initialText?: IShellLaunchConfig['initialText'];
	readonly waitOnExit?: IShellLaunchConfig['waitOnExit'];
	/** The caller subscribes to output and exit before opening a custom PTY or polling a process. */
	readonly deferStart?: boolean;
} & (
		| { readonly profile: ITerminalProfileSelection; readonly config?: never; }
		| { readonly config: IShellLaunchConfig & Required<Pick<IShellLaunchConfig, 'customPtyImplementation'>>; readonly profile?: never; }
	);

/** One interactive terminal independently of its transport representation. */
export interface ITerminalInstance extends IDisposable {
	readonly isReadOnly?: boolean;
	readonly id: string;
	readonly dirId: string;
	readonly processId: number;
	readonly initialCwd: string;
	readonly title: string;
	readonly profile: ITerminalProfile;
	readonly state: TerminalInstanceState;
	readonly exitCode: number | undefined;
	readonly onDidWriteData: Event<IProcessDataEvent>;
	readonly onDidChangeCommandStatus: Event<ITerminalCommandStatusEvent>;
	readonly onDidExit: Event<number | undefined>;
	readonly onDidChangeState: Event<TerminalInstanceState>;

	readonly xterm: XtermTerminal | undefined;
	readonly xtermReadyPromise: Promise<XtermTerminal | undefined>;
	getContribution<T extends ITerminalContribution>(id: string): T | null;
	start(): void;
	attachToElement(container: HTMLElement): void;
	detachFromElement(): void;
	/** Sends text to stdin, optionally executing it or applying the child Shell's paste mode. */
	sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void>;
	processBinary(data: string): Promise<void>;
	resize(dimensions: ITerminalDimensions): void;
	clearBuffer(): void;
	reuseTerminal(shell: IShellLaunchConfig): Promise<void>;
	close(): Promise<void>;
}

/** Per-instance features share the instance's screen and release with the instance. */
export interface ITerminalContribution extends IDisposable {
	xtermReady?(xterm: XtermTerminal): void;
}

/** Reads the retained terminal screen without changing the active terminal or focus. */
export interface ITerminalView extends IView {
	getTerminalOutput(instance: ITerminalInstance, maxCharacters: number, signal: AbortSignal): Promise<string | undefined>;
}

/** Workbench service contract for terminal instances and active-instance selection. */
export interface ITerminalService extends IDisposable {
	readonly instances: readonly ITerminalInstance[];
	readonly activeInstance: ITerminalInstance | undefined;
	readonly onDidCreateInstance: Event<ITerminalInstance>;
	readonly onDidDisposeInstance: Event<ITerminalInstance>;
	/** Fires after membership or order changes, with titles and active instance updated. */
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

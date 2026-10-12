import type { Terminal } from '@xterm/xterm';
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import type { IView } from "../../../common/views.js";
import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IProcessDataEvent, IShellLaunchConfig, TerminalProcessExecution, TerminalProcessProfileSelection } from '../../../../platform/terminal/common/terminal.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type Severity from '../../../../base/common/severity.js';

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
	readonly cwd?: string;
	readonly command?: string;
	/** Command-text provenance only; no authority to execute or access paths. */
	readonly isTrusted?: boolean;
}

/** Backend-owned completed history and detected Shell integration support. */
export interface ITerminalShellIntegration {
	readonly commandDetection: boolean;
	readonly cwdDetection: boolean;
	readonly hasRichCommandDetection: boolean;
	readonly commandStorageDisabled: boolean;
	readonly commands: readonly ITerminalCommandStatusEvent[];
}

/** One available shell profile exposed to Workbench callers. */
export interface ITerminalProfile {
	readonly profileId: string;
	readonly title: string;
	readonly isDefault: boolean;
	readonly icon?: ThemeIcon;
	readonly color?: string;
}

/** Explicit profile selection for a new terminal. */
export type ITerminalProfileSelection = TerminalProcessProfileSelection;

/** Complete caller-facing input for creating one terminal. */
export type ITerminalCreateOptions = {
	readonly dirId?: string;
	readonly dimensions: ITerminalDimensions;
	readonly title?: string;
	readonly icon?: ThemeIcon;
	readonly color?: string;
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
	readonly instanceId: number;
	readonly dirId: string;
	readonly processId: number;
	readonly initialCwd: string;
	readonly cwd?: string;
	readonly shellIntegration?: ITerminalShellIntegration;
	readonly title: string;
	readonly profile: ITerminalProfile;
	readonly shellLaunchConfig?: Readonly<IShellLaunchConfig>;
	readonly statusList?: ITerminalStatusList;
	readonly state: TerminalInstanceState;
	readonly exitCode: number | undefined;
	readonly onDidWriteData: Event<IProcessDataEvent>;
	readonly onDidChangeCommandStatus: Event<ITerminalCommandStatusEvent>;
	readonly onDidExit: Event<number | undefined>;
	readonly onDidChangeState: Event<TerminalInstanceState>;

	readonly xterm: IXtermTerminal | undefined;
	readonly xtermReadyPromise: Promise<IXtermTerminal | undefined>;
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

/** Browser screen operations shared by terminal views and instance contributions. */
export interface IXtermTerminal extends IDisposable {
	readonly element: HTMLDivElement;
	readonly raw: Terminal;
	readonly isDisposed: boolean;
	readonly onDidChangeFindResults: Event<ISearchResultChangeEvent>;
	readonly findResult: ISearchResultChangeEvent | undefined;
	setVisible(visible: boolean): void;
	focus(): void;
	fit(): void;
	dimensions(): ITerminalDimensions;
	clearBuffer(): void;
	getBufferText(maxCharacters: number, signal: AbortSignal): Promise<string | undefined>;
	openDetectedLink(): Promise<void>;
	findNext(term: string, searchOptions: ISearchOptions): Promise<boolean>;
	findPrevious(term: string, searchOptions: ISearchOptions): Promise<boolean>;
	clearSearchDecorations(): void;
	scrollToPreviousCommand(): void;
	scrollToNextCommand(): void;
}

/** Per-instance features share the instance's screen and release with the instance. */
export interface ITerminalContribution extends IDisposable {
	xtermReady?(xterm: IXtermTerminal): void;
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

/** Panel grouping owns membership and geometry; instances retain their process and screen. */
export interface ITerminalGroup extends IDisposable {
	readonly terminalInstances: readonly ITerminalInstance[];
	readonly activeInstance: ITerminalInstance | undefined;
	readonly title: string;
	readonly onInstancesChanged: Event<void>;
	addInstance(instance: ITerminalInstance): void;
	removeInstance(instance: ITerminalInstance): void;
	attachToElement(element: HTMLElement): void;
	setVisible(visible: boolean): void;
	layout(width: number, height: number): void;
	focusPreviousPane(): void;
	focusNextPane(): void;
}

export interface ITerminalGroupService extends IDisposable {
	readonly groups: readonly ITerminalGroup[];
	readonly activeGroup: ITerminalGroup | undefined;
	readonly onDidChangeGroups: Event<void>;
	createGroup(instance: ITerminalInstance): ITerminalGroup;
	getGroupForInstance(instance: ITerminalInstance): ITerminalGroup | undefined;
	joinInstances(instances: readonly ITerminalInstance[]): void;
	unsplitInstance(instance: ITerminalInstance): void;
	instanceIsSplit(instance: ITerminalInstance): boolean;
	setActiveInstanceByIndex(index: number): void;
	showPanel(focus?: boolean): Promise<void>;
}

export const ITerminalGroupService = createServiceIdentifier<ITerminalGroupService>('terminalGroupService');

/** Display messages are independent of the instance's process and connection state. */
export interface ITerminalStatus {
	readonly id: string;
	readonly severity: Severity;
	readonly tooltip: string;
}

export interface ITerminalStatusList {
	readonly primary: ITerminalStatus | undefined;
	readonly statuses: readonly ITerminalStatus[];
	readonly onDidChangePrimaryStatus: Event<ITerminalStatus | undefined>;
	add(status: ITerminalStatus): void;
	remove(status: ITerminalStatus | string): void;
}

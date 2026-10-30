import type { ITerminalAutoReply } from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalProcessOwnership } from '../../../services/terminal/common/terminal.js';
import { localize } from '../../../../nls.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IMarker, Terminal } from '@xterm/xterm';
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import type { ITerminalConfiguration } from '../common/terminal.js';
import type { IView } from '../../../common/views.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IProcessDataEvent, IShellLaunchConfig, TerminalProcessExecution, TerminalProcessProfileSelection, TerminalLocation, ProcessPropertyType, IProcessPropertyMap } from '../../../../platform/terminal/common/terminal.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { ITerminalStatusList } from './terminalStatusList.js';
import type { ITerminalCapabilityStore, ITerminalCommand } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ITerminalSerializedState } from '../../../services/terminal/common/terminal.js';
import type { ITerminalProcessCreation, ITerminalReconnectLease } from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalTabLayoutInfoById } from '../../../../platform/terminal/common/terminal.js';
import type { IExtensionTerminalProfile, ITerminalProfile as IShellProfile } from '../../../../platform/terminal/common/terminal.js';
import type { EditorGroupId } from '../../../services/editor/common/editorState.js';

/** Provider coordinates refer to UTF-16 offsets in the complete wrapped output line. */
export interface ITerminalExternalLinkProvider {
	provideLinks(instance: ITerminalInstance, line: string): Promise<ITerminalLink[] | undefined>;
}

export interface ITerminalLink {
	/** UTF-16 offset in the complete wrapped line. */
	startIndex: number;
	length: number;
	label?: string;
	activate(text: string): void;
}

/** Character-cell dimensions used by Workbench terminal callers. */
export interface ITerminalDimensions {
	readonly rows: number;
	readonly cols: number;
}

/** Lifecycle state of one Workbench terminal instance. */
export type TerminalInstanceState = 'running' | 'reconnecting' | 'exited' | 'disconnected' | 'error';

/** The screen needs no process, membership, persistence, or launch authority. */
export interface ITerminalScreenHost {
	readonly capabilities?: ITerminalCapabilityStore;
	readonly target?: TerminalLocation;
	readonly onDidChangeTarget?: Event<TerminalLocation | undefined>;
	readonly isReadOnly?: boolean;
	readonly processId: number;
	readonly state: TerminalInstanceState;
	readonly onDidChangeCommandStatus: Event<ITerminalCommandStatusEvent>;
	readonly onDidChangeState: Event<TerminalInstanceState>;
	resize(dimensions: ITerminalDimensions): void;
}



/** Renderer-independent lifecycle state of one shell command. */
export type TerminalCommandStatus = 'running' | 'completed' | 'succeeded' | 'failed' | 'canceled';

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
	readonly promptType?: string;
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
	readonly type?: IShellLaunchConfig['type'];
	/** UI-resolved launch metadata; native profile selection still belongs to the execution host. */
	readonly resolvedShellLaunchConfig?: Readonly<Pick<IShellLaunchConfig, 'executable' | 'args'>>;
	readonly environmentVariableCollections?: import('../../../../platform/terminal/common/environmentVariable.js').ISerializableEnvironmentVariableCollections;
	readonly environmentVariableCollectionsPersistable?: boolean;
	readonly dirId?: string;
	readonly dimensions: ITerminalDimensions;
	readonly title?: string;
	readonly icon?: ThemeIcon;
	readonly color?: string;
	readonly env?: Readonly<Record<string, string | null>>;
	/** Raw interactive intent, before host settings and environment collections. Resolved
	 * profile callers opt in explicitly; execution launches are never revived. */
	readonly revivalLaunch?: ITerminalSerializedState['launch'];
	readonly strictEnv?: boolean;
	readonly cwd?: string;
	readonly execution?: TerminalProcessExecution;
	readonly initialText?: IShellLaunchConfig['initialText'];
	readonly waitOnExit?: IShellLaunchConfig['waitOnExit'];
	/** The caller subscribes to output and exit before opening a custom PTY or polling a process. */
	readonly deferStart?: boolean;
	readonly attachPersistentProcess?: { readonly state: ITerminalSerializedState; readonly process: ITerminalProcessCreation; readonly ownership?: ITerminalProcessOwnership; };
} & (
		| { readonly profile: ITerminalProfileSelection; readonly config?: never; }
		| { readonly config: IShellLaunchConfig & Required<Pick<IShellLaunchConfig, 'customPtyImplementation'>>; readonly profile?: never; }
	);

/** Creation intent; TerminalService resolves it before handing launch data to the instance factory. */
export type ICreateTerminalOptions = Omit<Partial<ITerminalCreateOptions>, 'config' | 'cwd'> & {
	readonly config?: IShellLaunchConfig | IShellProfile | IExtensionTerminalProfile;
	readonly cwd?: string | URI;
	readonly location?: ITerminalLocationOptions;
	readonly skipContributedProfileCheck?: boolean;
	/** Do not select the created instance, including intermediate provider-created instances. */
	readonly preserveFocus?: boolean;
};

export type ITerminalLocationOptions = TerminalLocation | TerminalEditorLocation | { readonly parentTerminal: ITerminalInstance | Promise<ITerminalInstance>; } | { readonly splitActiveTerminal: boolean; };

/** Captures a group in the main or an auxiliary editor part. */
export interface TerminalEditorLocation {
	readonly viewColumn?: EditorGroupId;
	readonly preserveFocus?: boolean;
}

/** A failed destination returns its rotated lease without placing credentials in diagnostics. */
export class TerminalTransferError extends Error {
	declare readonly rollbackLease: ITerminalReconnectLease | undefined;
	constructor(lease: ITerminalReconnectLease | undefined) {
		super(localize('terminal.windowTransfer.targetFailed', 'Could not initialize the terminal in its destination window.'));
		this.name = 'TerminalTransferError';
		Object.defineProperty(this, 'rollbackLease', { value: lease });
	}
}

/** One interactive terminal independently of its transport representation. */
export interface ITerminalInstance extends IDisposable {
	readonly extEnvironmentVariableCollection?: import('../../../../platform/terminal/common/environmentVariable.js').IMergedEnvironmentVariableCollection;
	readonly revivalLaunch?: ITerminalSerializedState['launch'];
	readonly isReadOnly?: boolean;
	readonly resource?: URI;
	target?: TerminalLocation;
	readonly onDidChangeTarget?: Event<TerminalLocation | undefined>;
	readonly id: string;
	readonly instanceId: number;
	readonly dirId: string;
	readonly processId: number;
	readonly initialCwd: string;
	readonly cwd?: string;
	readonly shellIntegration?: ITerminalShellIntegration;
	readonly injectedArgs?: import('../../../../platform/terminal/common/terminal.js').TerminalArguments;
	readonly shellType?: import('../../../../platform/terminal/common/terminal.js').TerminalShellType;
	readonly capabilities?: ITerminalCapabilityStore;
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
	rename?(title?: string): Promise<void>;
	changeIcon?(icon?: ThemeIcon): Promise<ThemeIcon | undefined>;
	start(): void;
	attachToElement(container: HTMLElement): void;
	detachFromElement(): void;
	/** Sends text to stdin, optionally executing it or applying the child Shell's paste mode. */
	sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void>;
	/** Quotes a host path for the spawn-confirmed shell; URI inputs must belong to this execution host. */
	sendPath(originalPath: string | URI, shouldExecute: boolean): Promise<void>;
	sendSignal(signal: string): Promise<void>;
	/** Installs execution-side rules on a backed process; virtual PTYs ignore them. */
	setAutoReplies(rules: readonly ITerminalAutoReply[]): Promise<void>;
	processBinary(data: string): Promise<void>;
	resize(dimensions: ITerminalDimensions): void;
	clearBuffer(): void;
	reuseTerminal(shell: IShellLaunchConfig): Promise<void>;
	refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]>;
	/** Revival starts a new shell, so its checkpoint excludes the old idle prompt. */
	serializeState(options?: { readonly revive?: boolean; }): Promise<ITerminalSerializedState>;
	close(): Promise<void>;
}

/** Browser screen operations shared by terminal views and instance contributions. */
export interface IXtermTerminal extends IDisposable {
	readonly shellIntegration: import('../../../../platform/terminal/common/terminal.js').IShellIntegration;
	readonly element: HTMLDivElement;
	readonly raw: Terminal;
	readonly isDisposed: boolean;
	readonly onDidChangeFindResults: Event<ISearchResultChangeEvent>;
	readonly onDidRequestRunCommand: Event<{ command: ITerminalCommand; noNewLine?: boolean; }>;
	readonly findResult: ISearchResultChangeEvent | undefined;
	attachWidget(widget: IDisposable & { readonly id: string; attach(container: HTMLElement): void; }): IDisposable | undefined;
	setVisible(visible: boolean): void;
	focus(): void;
	fit(): void;
	dimensions(): ITerminalDimensions;
	clearBuffer(): void;
	getRangeAsVT(startMarker?: IMarker, endMarker?: IMarker, skipLastLine?: boolean): Promise<string>;
	getBufferText(maxCharacters: number, signal: AbortSignal): Promise<string | undefined>;
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
	focusHover(): void;
	getTerminalOutput(instance: ITerminalInstance, maxCharacters: number, signal: AbortSignal): Promise<string | undefined>;
}

/** Workbench service contract for terminal instances and active-instance selection. */
export interface ITerminalService extends IDisposable {
	readonly whenConnected: Promise<void>;
	readonly instances: readonly ITerminalInstance[];
	readonly activeInstance: ITerminalInstance | undefined;
	readonly onDidCreateInstance: Event<ITerminalInstance>;
	readonly onDidDisposeInstance: Event<ITerminalInstance>;
	/** Fires after membership or order changes, with titles and active instance updated. */
	readonly onDidChangeInstances: Event<void>;
	readonly onDidChangeActiveInstance: Event<ITerminalInstance | undefined>;

	createTerminal(options?: ICreateTerminalOptions): Promise<ITerminalInstance>;
	importTerminalState(state: ITerminalSerializedState, lease: ITerminalReconnectLease): Promise<ITerminalInstance>;
	relaunchTerminal(instance: ITerminalInstance, dimensions: ITerminalDimensions): Promise<void>;
	setActiveInstance(instance: ITerminalInstance | undefined): void;
	moveTerminal(instance: ITerminalInstance, targetIndex: number): void;
	closeTerminal(instance: ITerminalInstance): Promise<void>;
	confirmTerminalClose(instance: ITerminalInstance): Promise<boolean>;
	safeDisposeTerminal(instance: ITerminalInstance): Promise<void>;
}

export const ITerminalService = createServiceIdentifier<ITerminalService>('terminalService');

/** Panel grouping owns membership and geometry; instances retain their process and screen. */
export interface ITerminalGroup extends IDisposable {
	readonly terminalInstances: readonly ITerminalInstance[];
	readonly activeInstance: ITerminalInstance | undefined;
	readonly title: string;
	readonly onInstancesChanged: Event<void>;
	addInstance(instance: ITerminalInstance): void;
	removeInstance(instance: ITerminalInstance): void;
	moveInstance(instances: ITerminalInstance | readonly ITerminalInstance[], index: number, position: 'before' | 'after'): void;
	attachToElement(element: HTMLElement): void;
	setVisible(visible: boolean): void;
	layout(width: number, height: number): void;
	focusPreviousPane(): void;
	focusNextPane(): void;
	resizePanes(relativeSizes: number[]): void;
	getLayoutInfo(isActive: boolean): ITerminalTabLayoutInfoById;
}

export interface ITerminalGroupService extends IDisposable {
	readonly groups: readonly ITerminalGroup[];
	readonly activeGroup: ITerminalGroup | undefined;
	readonly onDidChangeGroups: Event<void>;
	createGroup(instance: ITerminalInstance): ITerminalGroup;
	getGroupForInstance(instance: ITerminalInstance): ITerminalGroup | undefined;
	joinInstances(instances: readonly ITerminalInstance[]): void;
	moveInstance(source: ITerminalInstance, target: ITerminalInstance, side: 'before' | 'after'): void;
	unsplitInstance(instance: ITerminalInstance): void;
	instanceIsSplit(instance: ITerminalInstance): boolean;
	setActiveInstanceByIndex(index: number): void;
	showPanel(focus?: boolean): Promise<void>;
	focusHover(): Promise<void>;
}

export const ITerminalGroupService = createServiceIdentifier<ITerminalGroupService>('terminalGroupService');

export const enum TerminalDataTransfers {
	Terminals = 'Terminals',
}

/** Editor operations for the same window-owned terminal instances. */
export interface ITerminalEditorService {
	openEditor(instance: ITerminalInstance, editorOptions?: TerminalEditorLocation): Promise<void>;
	splitInstance(instanceToSplit: ITerminalInstance, shellLaunchConfig?: ICreateTerminalOptions['config']): Promise<ITerminalInstance>;
	detachInstance(instance: ITerminalInstance): Promise<void>;
	getInstanceFromResource(resource: URI): ITerminalInstance | undefined;
}
export const ITerminalEditorService = createServiceIdentifier<ITerminalEditorService>('terminalEditorService');

/** Temporary title editing, separate from the instance's title state. */
export interface ITerminalEditingService {
	getEditingTerminal(): ITerminalInstance | undefined;
	rename(instance: ITerminalInstance): Promise<void>;
}
export const ITerminalEditingService = createServiceIdentifier<ITerminalEditingService>('terminalEditingService');

export interface ITerminalConfigurationService extends IDisposable {
	readonly config: Readonly<ITerminalConfiguration>;
	readonly onConfigChanged: Event<void>;
}

export const ITerminalConfigurationService = createServiceIdentifier<ITerminalConfigurationService>('terminalConfigurationService');

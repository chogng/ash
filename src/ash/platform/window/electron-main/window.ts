import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import {
	type IAnyWorkspaceIdentifier,
	type IWorkspace,
	type IWorkspaceIdentifier,
	type ISingleFolderWorkspaceIdentifier,
	workspaceFromIdentifier,
} from '../../workspace/common/workspace.js';
import { DEFAULT_EMPTY_WINDOW_SIZE, DEFAULT_WORKSPACE_WINDOW_SIZE, type IWindowClientSize } from '../common/window.js';
import { WorkbenchState } from '../../workspace/common/workspace.js';

export const WindowMode = { Normal: 'normal', Maximized: 'maximized', Fullscreen: 'fullscreen' } as const;

/** Stable string values used by runtime and persisted window state. */
export type WindowMode = (typeof WindowMode)[keyof typeof WindowMode];

/** A complete operating-system window rectangle. */
export interface IWindowBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export const enum LoadReason {
	INITIAL = 1,
	LOAD,
	RELOAD,
}

export interface ILoadEvent {
	readonly workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined;
	readonly reason: LoadReason;
}

/** One window owns its current document and the readiness of that document. */
export interface ICodeWindow<TWindow = Electron.BrowserWindow> extends IDisposable {
	readonly win: TWindow;
	readonly id: number;
	readonly lastFocusTime: number;
	readonly onDidClose: Event<void>;
	readonly onDidEnterFullScreen: Event<void>;
	readonly onDidLeaveFullScreen: Event<void>;
	readonly openedWorkspace: IAnyWorkspaceIdentifier;
	readonly onDidSignalReady: Event<void>;
	readonly onWillLoad: Event<ILoadEvent>;
	readonly isReady: boolean;
	readonly whenClosedOrLoaded: Promise<void>;
	focus(): void;
	close(): void;
	getBounds(): IWindowBounds;
	getClientSize(): IWindowClientSize | undefined;
	isFullScreen(): boolean;
	serializeWindowState(): IWindowState & IWindowBounds;
	addTabbedWindow(window: ICodeWindow<TWindow>): void;
	send(channel: string, ...args: unknown[]): void;
	sendWhenReady(channel: string, token: CancellationToken, ...args: unknown[]): void;
	ready(): Promise<ICodeWindow<TWindow>>;
	setReady(): void;
	load(configuration: {
		readonly file: string;
		readonly url: string;
		readonly useDevelopmentUrl: boolean;
	}): Promise<void>;
	reload(): Promise<void>;
	reportWindowError(gone: boolean, shutdownSignal?: AbortSignal): Promise<void>;
	updateWindowControls(options: {
		backgroundColor?: string;
		foregroundColor?: string;
		backdropColor?: string;
		dimmed?: boolean;
	}): void;
}

/**
 * Runtime state used to create and restore an Electron window.
 *
 * A default state may omit its position so the operating system can choose it.
 * Restored states contain both `x` and `y` after validation.
 */
export interface IWindowState {
	readonly mode: WindowMode;
	readonly width: number;
	readonly height: number;
	readonly x?: number;
	readonly y?: number;
	readonly displayId?: number;
	/** Display work area in DIP units when the normal window bounds were captured. */
	readonly workArea?: IWindowBounds;
}

/** Returns a fresh default state sized for the requested workbench state. */
export function defaultWindowState(workbenchState: WorkbenchState, mode: WindowMode = WindowMode.Normal): IWindowState {
	const size = workbenchState === WorkbenchState.EMPTY ? DEFAULT_EMPTY_WINDOW_SIZE : DEFAULT_WORKSPACE_WINDOW_SIZE;

	return { mode, width: size.width, height: size.height };
}

export interface IFocusableWindow {
	isDestroyed(): boolean;
	isMinimized(): boolean;
	restore(): void;
	focus(): void;
}

/** Restores a minimized Electron window before focusing it. */
export function focusWindow(window: IFocusableWindow): void {
	if (window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.focus();
}

export interface IWorkspaceContextMainChangeEvent {
	readonly previous: IAnyWorkspaceIdentifier;
	readonly workspace: IAnyWorkspaceIdentifier;
	readonly resolvedWorkspace: IWorkspace;
}

/** Holds the workspace currently opened in one desktop window. */
export class WorkspaceContextMainService extends Disposable {
	private workspace: IAnyWorkspaceIdentifier;
	private resolvedWorkspace: IWorkspace;
	private readonly _onDidChangeWorkspace = this._register(new Emitter<IWorkspaceContextMainChangeEvent>());

	public readonly onDidChangeWorkspace: Event<IWorkspaceContextMainChangeEvent> = this._onDidChangeWorkspace.event;

	constructor(
		workspace: IAnyWorkspaceIdentifier,
		resolvedWorkspace: IWorkspace = workspaceFromIdentifier(workspace),
	) {
		super();
		this.workspace = workspace;
		this.resolvedWorkspace = resolvedWorkspace;
	}

	public getWorkspace(): IAnyWorkspaceIdentifier {
		return this.workspace;
	}

	public getResolvedWorkspace(): IWorkspace {
		return this.resolvedWorkspace;
	}

	public updateWorkspace(
		workspace: IAnyWorkspaceIdentifier,
		resolvedWorkspace: IWorkspace = workspaceFromIdentifier(workspace),
	): void {
		if (
			workspace.id === this.workspace.id &&
			JSON.stringify(resolvedWorkspace) === JSON.stringify(this.resolvedWorkspace)
		) {
			return;
		}
		const previous = this.workspace;
		this.workspace = workspace;
		this.resolvedWorkspace = resolvedWorkspace;
		this._onDidChangeWorkspace.fire({ previous, workspace, resolvedWorkspace });
	}
}

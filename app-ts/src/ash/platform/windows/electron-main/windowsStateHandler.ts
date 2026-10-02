import type { Event } from "../../../base/common/event.js";
import { DisposableStore, toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { isFiniteNumber } from "../../../base/common/numbers.js";
import { isNonEmptyString, isRecord } from "../../../base/common/types.js";
import { URI } from "../../../base/common/uri.js";
import type { IStateService } from "../../state/node/state.js";
import { type IAnyWorkspaceIdentifier, type IWorkspaceIdentifier, type WorkbenchState, isEmptyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, parseWorkspaceIdentifier, serializeWorkspaceIdentifier, workbenchStateFromWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import { defaultWindowState, WindowMode, type IWindowBounds, type IWindowState } from "../../window/electron-main/window.js";
import { validateWindowState, type IWindowDisplay } from "./windows.js";
import { WINDOW_MINIMUM_SIZE } from "../../window/common/window.js";
import { getRemoteWorkspacePath, isRemoteResource } from "../../remote/common/remote.js";

const WINDOWS_STATE_STORAGE_KEY = "windowsState";
const WINDOWS_STATE_VERSION = 1;
const MAX_OPENED_WINDOW_RECORDS = 100;
const WINDOW_SESSION_STATE_KEY = 'windowSession';

/** Display operations needed to restore and capture window placement. */
export interface IWindowDisplayService {
	readonly onDidChangeDisplays: Event<void>;
	getAllDisplays(): readonly IWindowDisplay[];
	getDisplayMatching(bounds: IWindowBounds): IWindowDisplay;
}

/**
 * BrowserWindow operations used by state persistence.
 *
 * Keeping this structural contract small makes state behavior testable without
 * loading Electron in a Node.js test process.
 */
export interface IStatefulWindow {
	isFullScreen(): boolean;
	isMaximized(): boolean;
	getBounds(): IWindowBounds;
	getNormalBounds(): IWindowBounds;
	setBounds(bounds: IWindowBounds): void;
	setMinimumSize(width: number, height: number): void;
	on(event: "blur" | "close" | "move" | "moved" | "resize" | "unmaximize" | "leave-full-screen", listener: () => void): void;
	removeListener(event: "blur" | "close" | "move" | "moved" | "resize" | "unmaximize" | "leave-full-screen", listener: () => void): void;
}

interface IWindowStateRecord {
	readonly workspace?: IWorkspaceIdentifier;
	readonly folderUri?: URI;
	readonly backupPath?: string;
	readonly emptyWorkspaceId?: string;
	readonly uiState: IWindowState;
}

interface IWindowsState {
	readonly lastActiveWindow?: IWindowStateRecord;
	readonly openedWindows: readonly IWindowStateRecord[];
}

/** Dependencies and current-window identity used by the window state owner. */
export interface IWindowsStateHandlerOptions {
	readonly stateService: IStateService;
	readonly displayService: IWindowDisplayService;
	readonly workspace: IAnyWorkspaceIdentifier;
	readonly backupPath?: string;
	readonly storageKey?: string;
	readonly defaultState?: IWindowState;
	readonly onError?: (error: unknown) => void;
}

/**
 * Owns the persisted schema and lifecycle for one Electron window role.
 *
 * Window placement is associated with a concrete workspace, folder, or empty
 * window backup. Separate storage keys keep a dedicated window's placement
 * from replacing the main window's last-active placement.
 */
export class WindowsStateHandler {
	private readonly stateService: IStateService;
	private readonly displayService: IWindowDisplayService;
	private readonly workspace: IAnyWorkspaceIdentifier;
	private readonly backupPath: string | undefined;
	private readonly storageKey: string;
	private readonly defaultState: IWindowState | undefined;
	private readonly workbenchState: WorkbenchState;
	private readonly onError: (error: unknown) => void;
	private windowsState: IWindowsState;
	private lastNormalState: IWindowState | undefined;

	constructor({
		stateService,
		displayService,
		workspace,
		backupPath,
		storageKey = WINDOWS_STATE_STORAGE_KEY,
		defaultState,
		onError = () => undefined,
	}: IWindowsStateHandlerOptions) {
		this.stateService = stateService;
		this.displayService = displayService;
		this.workspace = workspace;
		this.backupPath = backupPath;
		this.storageKey = storageKey;
		this.defaultState = defaultState;
		this.workbenchState = workbenchStateFromWorkspaceIdentifier(workspace);
		this.onError = onError;
		this.windowsState = parseWindowsState(
			this.stateService.getItem(this.storageKey),
		);
	}

	/** Restores an exact workspace match, then last active state, then defaults. */
	restoreWindowState(): IWindowState {
		const exactState = this.windowsState.openedWindows.find((windowState) =>
			matchesWindowIdentity(
				windowState,
				this.workspace,
				this.backupPath,
			)
		);
		const candidates = [
			exactState?.uiState,
			this.windowsState.lastActiveWindow?.uiState,
		];

		for (const candidate of candidates) {
			if (!candidate) {
				continue;
			}
			const restoredState = validateWindowState(
				candidate,
				this.displayService.getAllDisplays(),
				this.workbenchState,
			);
			if (restoredState) {
				this.lastNormalState = restoredState;
				return restoredState;
			}
		}

		const state = this.defaultState ?? defaultWindowState(this.workbenchState);
		const display = this.displayService.getDisplayMatching({ x: state.x ?? 0, y: state.y ?? 0, width: state.width, height: state.height });
		const area = display.workArea;
		const width = Math.min(area.width, Math.max(WINDOW_MINIMUM_SIZE.width, state.width));
		const height = Math.min(area.height, Math.max(WINDOW_MINIMUM_SIZE.height, state.height));
		this.lastNormalState = {
			...state,
			x: Math.round(Math.max(area.x, Math.min(state.x ?? area.x + (area.width - width) / 2, area.x + area.width - width))),
			y: Math.round(Math.max(area.y, Math.min(state.y ?? area.y + (area.height - height) / 2, area.y + area.height - height))),
			width,
			height,
			displayId: display.id,
			workArea: { ...area },
		};
		return this.lastNormalState;
	}

	/** Saves immediately on blur and before the BrowserWindow closes. */
	trackWindow(window: IStatefulWindow): IDisposable {
		const resources = new DisposableStore();
		this.lastNormalState = this.captureWindowState(window);
		const save = (): void => {
			void this.saveWindowState(window).catch(this.onError);
		};
		const updatePlacement = (): void => {
			if (window.isMaximized() || window.isFullScreen()) {
				return;
			}
			const previous = this.lastNormalState;
			if (previous?.workArea) {
				const display = this.displayService.getAllDisplays().find(display => display.id === previous.displayId);
				// OS resize/move events can precede the display notification. Keep the old
				// geometry until that notification has converted it exactly once.
				if (!display || !sameBounds(display.workArea, previous.workArea)) {
					return;
				}
				if (this.displayService.getDisplayMatching(window.getBounds()).id !== previous.displayId) {
					return;
				}
			}
			this.captureWindowState(window);
		};
		const applyPlacement = (): void => {
			if (window.isMaximized() || window.isFullScreen() || !this.lastNormalState) {
				return;
			}
			const bounds = toBounds(this.lastNormalState);
			const area = this.lastNormalState.workArea;
			if (area) {
				window.setMinimumSize(Math.min(WINDOW_MINIMUM_SIZE.width, area.width), Math.min(WINDOW_MINIMUM_SIZE.height, area.height));
			}
			if (bounds && !sameBounds(bounds, window.getBounds())) {
				window.setBounds(bounds);
			}
		};
		const finishMove = (): void => {
			if (window.isMaximized() || window.isFullScreen() || !this.lastNormalState) {
				return;
			}
			const bounds = window.getBounds();
			const display = this.displayService.getDisplayMatching(bounds);
			if (display.id === this.lastNormalState.displayId) {
				updatePlacement();
				return;
			}
			const state = validateWindowState(this.lastNormalState, [display], this.workbenchState);
			if (state) {
				// Only constrain size after the drag ends; the dropped center owns
				// placement on the destination display.
				const area = display.workArea;
				const x = bounds.x + (bounds.width - state.width) / 2;
				const y = bounds.y + (bounds.height - state.height) / 2;
				this.lastNormalState = {
					...state,
					x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - state.width))),
					y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - state.height))),
				};
				applyPlacement();
			}
		};
		resources.add(this.displayService.onDidChangeDisplays(() => {
			if (!this.lastNormalState) {
				return;
			}
			const state = validateWindowState(this.lastNormalState, this.displayService.getAllDisplays(), this.workbenchState);
			if (state) {
				this.lastNormalState = state;
				applyPlacement();
				save();
			}
		}));
		for (const [event, listener] of [
			["blur", save], ["close", save],
			["move", updatePlacement], ["resize", updatePlacement],
			["moved", finishMove],
			["unmaximize", applyPlacement], ["leave-full-screen", applyPlacement],
		] as const) {
			window.on(event, listener);
			resources.add(toDisposable(() => window.removeListener(event, listener)));
		}
		return resources;
	}

	/** Captures normal bounds and flushes the complete window-session state. */
	async saveWindowState(window: IStatefulWindow): Promise<void> {
		const uiState = this.captureWindowState(window);
		if (!uiState) {
			return;
		}

		const currentWindow = createWindowStateRecord(
			this.workspace,
			this.backupPath,
			uiState,
		);
		const latestState = parseWindowsState(this.stateService.getItem(this.storageKey));
		const otherWindows = latestState.openedWindows.filter(windowState => !matchesWindowIdentity(windowState, this.workspace, this.backupPath));
		const windowsState: IWindowsState = {
			lastActiveWindow: currentWindow,
			openedWindows: [currentWindow, ...otherWindows].slice(0, MAX_OPENED_WINDOW_RECORDS),
		};
		this.windowsState = windowsState;
		this.stateService.setItem(
			this.storageKey,
			serializeWindowsState(windowsState),
		);
		await this.stateService.flush();
	}

	private captureWindowState(window: IStatefulWindow): IWindowState | undefined {
		const mode = window.isFullScreen()
			? WindowMode.Fullscreen
			: window.isMaximized()
				? WindowMode.Maximized
				: WindowMode.Normal;
		if (this.lastNormalState?.workArea) {
			const displays = this.displayService.getAllDisplays();
			const previousDisplay = displays.find(display => display.id === this.lastNormalState?.displayId);
			if (!previousDisplay || !sameBounds(previousDisplay.workArea, this.lastNormalState.workArea)) {
				const placement = validateWindowState(this.lastNormalState, displays, this.workbenchState);
				if (placement) {
					this.lastNormalState = { ...placement, mode: WindowMode.Normal };
					return { ...placement, mode };
				}
			}
		}
		const primaryBounds = readBounds(() =>
			mode === WindowMode.Normal
				? window.getBounds()
				: window.getNormalBounds()
		);
		const bounds = (mode !== WindowMode.Normal && this.lastNormalState ? toBounds(this.lastNormalState) : primaryBounds) ??
			readBounds(() => window.getBounds()) ??
			(this.lastNormalState ? toBounds(this.lastNormalState) : undefined);
		if (!bounds) {
			return undefined;
		}

		const display = this.displayService.getDisplayMatching(mode === WindowMode.Normal ? bounds : window.getBounds());
		let placement: IWindowState = {
			mode: WindowMode.Normal,
			...bounds,
			displayId: display.id,
			workArea: { ...display.workArea },
		};
		if (mode !== WindowMode.Normal && this.lastNormalState?.workArea && display.id !== this.lastNormalState.displayId) {
			const adjusted = validateWindowState(this.lastNormalState, [display], this.workbenchState);
			if (adjusted) {
				placement = { ...adjusted, mode: WindowMode.Normal };
			}
		}
		this.lastNormalState = placement;
		return { ...placement, mode };
	}
}

export interface IWindowSessionEntry {
	readonly kind: string;
	readonly workspace: IAnyWorkspaceIdentifier;
	readonly modeId?: string;
}

export interface IWindowSession<TEntry extends IWindowSessionEntry> {
	readonly windows: readonly TEntry[];
	readonly active: number;
}

export interface IWindowSessionWindow<TEntry extends IWindowSessionEntry> {
	readonly id: number;
	readonly entry: TEntry;
	readonly focused: boolean;
}

/** Owns the persisted list and active identity of top-level application windows. */
export class WindowSessionStateHandler<TEntry extends IWindowSessionEntry> {
	private restoring = false;
	private shuttingDown = false;
	private lastFocusedWindowId: number | undefined;
	private lastClosedWindow: TEntry | undefined;

	constructor(
		private readonly stateService: IStateService,
		private readonly getOpenWindows: () => readonly IWindowSessionWindow<TEntry>[],
		private readonly isEntry: (entry: IWindowSessionEntry) => entry is TEntry,
	) {}

	readSession(): IWindowSession<TEntry> | undefined {
		const value = this.stateService.getItem(WINDOW_SESSION_STATE_KEY);
		if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'active,version,windows' || value.version !== 1 || !Array.isArray(value.windows)) return undefined;
		if (!Number.isSafeInteger(value.active) || (value.active as number) < 0 || (value.windows.length === 0 ? value.active !== 0 : (value.active as number) >= value.windows.length)) return undefined;
		const windows: TEntry[] = [];
		for (const candidate of value.windows) {
			if (!isRecord(candidate) || !isNonEmptyString(candidate.kind)) return undefined;
			if (Object.keys(candidate).sort().join(',') !== (candidate.modeId === undefined ? 'kind,workspace' : 'kind,modeId,workspace')) return undefined;
			if (candidate.modeId !== undefined && !isNonEmptyString(candidate.modeId)) return undefined;
			let workspace: IAnyWorkspaceIdentifier;
			try {
				workspace = parseWorkspaceIdentifier(candidate.workspace);
			} catch {
				return undefined;
			}
			const entry: IWindowSessionEntry = { kind: candidate.kind, workspace, ...(candidate.modeId === undefined ? {} : { modeId: candidate.modeId }) };
			if (!this.isEntry(entry)) return undefined;
			windows.push(entry);
		}
		return { windows, active: value.active as number };
	}

	beginRestoration(): IDisposable {
		this.restoring = true;
		return toDisposable(() => { this.restoring = false; });
	}

	windowOpened(): void {
		this.lastClosedWindow = undefined;
		this.scheduleSave();
	}

	windowFocused(id: number): void {
		this.lastFocusedWindowId = id;
		this.scheduleSave();
	}

	windowClosed(entry: TEntry): void {
		this.lastClosedWindow = entry;
		this.scheduleSave();
	}

	windowChanged(): void {
		this.scheduleSave();
	}

	stopAutomaticSaves(): void {
		this.shuttingDown = true;
	}

	resumeAutomaticSaves(): void {
		this.shuttingDown = false;
		this.scheduleSave();
	}

	async saveSession(): Promise<void> {
		const windows = this.getOpenWindows();
		const entries = windows.length > 0 ? windows.map(window => window.entry) : this.lastClosedWindow ? [this.lastClosedWindow] : [];
		const focused = windows.findIndex(window => window.focused);
		const lastFocused = windows.findIndex(window => window.id === this.lastFocusedWindowId);
		const active = focused >= 0 ? focused : Math.max(0, lastFocused);
		this.stateService.setItem(WINDOW_SESSION_STATE_KEY, {
			version: 1,
			active,
			windows: entries.map(entry => ({
				kind: entry.kind,
				workspace: serializeWorkspaceIdentifier(entry.workspace),
				...(entry.modeId === undefined ? {} : { modeId: entry.modeId }),
			})),
		});
		await this.stateService.flush();
	}

	private scheduleSave(): void {
		if (this.restoring || this.shuttingDown) return;
		void this.saveSession().catch(error => console.error('Failed to save window session', error));
	}
}

function createWindowStateRecord(
	workspace: IAnyWorkspaceIdentifier,
	backupPath: string | undefined,
	uiState: IWindowState,
): IWindowStateRecord {
	if (isWorkspaceIdentifier(workspace)) {
		return { workspace, uiState };
	}
	if (isSingleFolderWorkspaceIdentifier(workspace)) {
		return { folderUri: workspace.uri, uiState };
	}
	// A new empty window has its own workspace state; a restored backup keeps its backup identity.
	return {
		...(backupPath === undefined ? { emptyWorkspaceId: workspace.id } : { backupPath }),
		uiState,
	};
}

function matchesWindowIdentity(
	state: IWindowStateRecord,
	workspace: IAnyWorkspaceIdentifier,
	backupPath: string | undefined,
): boolean {
	if (isWorkspaceIdentifier(workspace)) {
		return state.workspace?.id === workspace.id;
	}
	if (isSingleFolderWorkspaceIdentifier(workspace)) {
		return state.folderUri !== undefined &&
			resourceComparisonKey(state.folderUri) ===
				resourceComparisonKey(workspace.uri);
	}
	return isEmptyWorkspaceIdentifier(workspace) &&
		state.workspace === undefined &&
		state.folderUri === undefined &&
		(backupPath === undefined ? state.emptyWorkspaceId === workspace.id : state.backupPath === backupPath);
}

function resourceComparisonKey(resource: URI): string {
	const value = resource.toString();
	return process.platform === "linux" ? value : value.toLowerCase();
}

function serializeWindowsState(state: IWindowsState): unknown {
	return {
		version: WINDOWS_STATE_VERSION,
		...(state.lastActiveWindow === undefined
			? {}
			: { lastActiveWindow: serializeWindowStateRecord(state.lastActiveWindow) }),
		openedWindows: state.openedWindows.map(serializeWindowStateRecord),
	};
}

function serializeWindowStateRecord(state: IWindowStateRecord): unknown {
	return {
		...(state.workspace === undefined
			? {}
			: {
				workspaceIdentifier: {
					id: state.workspace.id,
					configURIPath: state.workspace.configPath.toString(),
				},
			}),
		...(state.folderUri === undefined
			? {}
			: { folder: state.folderUri.toString() }),
		...(state.backupPath === undefined
			? {}
			: { backupPath: state.backupPath }),
		...(state.emptyWorkspaceId === undefined ? {} : { emptyWorkspaceId: state.emptyWorkspaceId }),
		uiState: serializeUiState(state.uiState),
	};
}

function serializeUiState(state: IWindowState): unknown {
	return {
		mode: state.mode,
		bounds: {
			x: state.x,
			y: state.y,
			width: state.width,
			height: state.height,
		},
		...(state.displayId === undefined ? {} : { displayId: state.displayId }),
		...(state.workArea === undefined ? {} : { workArea: state.workArea }),
	};
}

function parseWindowsState(value: unknown): IWindowsState {
	if (
		!isRecord(value) ||
		value.version !== WINDOWS_STATE_VERSION ||
		!Array.isArray(value.openedWindows)
	) {
		return { openedWindows: [] };
	}

	const lastActiveWindow = value.lastActiveWindow === undefined
		? undefined
		: parseWindowStateRecord(value.lastActiveWindow);
	const openedWindows = value.openedWindows
		.map(parseWindowStateRecord)
		.filter((state): state is IWindowStateRecord => state !== undefined);

	return {
		...(lastActiveWindow === undefined ? {} : { lastActiveWindow }),
		openedWindows,
	};
}

function parseWindowStateRecord(
	value: unknown,
): IWindowStateRecord | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const uiState = parseUiState(value.uiState);
	if (!uiState) {
		return undefined;
	}

	const identityCount = Number(value.workspaceIdentifier !== undefined) +
		Number(value.folder !== undefined) +
		Number(value.backupPath !== undefined) +
		Number(value.emptyWorkspaceId !== undefined);
	if (identityCount > 1) {
		return undefined;
	}

	if (value.workspaceIdentifier !== undefined) {
		const workspace = parseStoredWorkspace(value.workspaceIdentifier);
		return workspace ? { workspace, uiState } : undefined;
	}
	if (value.folder !== undefined) {
		const folderUri = parseWorkspaceFolderUri(value.folder);
		return folderUri ? { folderUri, uiState } : undefined;
	}
	if (value.backupPath !== undefined) {
		return isNonEmptyString(value.backupPath)
			? { backupPath: value.backupPath, uiState }
			: undefined;
	}
	if (value.emptyWorkspaceId !== undefined) {
		return isNonEmptyString(value.emptyWorkspaceId)
			? { emptyWorkspaceId: value.emptyWorkspaceId, uiState }
			: undefined;
	}
	return { uiState };
}

function parseStoredWorkspace(value: unknown): IWorkspaceIdentifier | undefined {
	if (!isRecord(value) || !isNonEmptyString(value.id)) {
		return undefined;
	}
	const configPath = parseFileUri(value.configURIPath);
	return configPath
		? Object.freeze({ id: value.id, configPath })
		: undefined;
}

function parseFileUri(value: unknown): URI | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	try {
		const uri = URI.parse(value);
		return uri.scheme === "file" && !uri.query && !uri.fragment
			? uri
			: undefined;
	} catch {
		return undefined;
	}
}

function parseWorkspaceFolderUri(value: unknown): URI | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const uri = URI.parse(value);
		if (uri.query || uri.fragment) return undefined;
		if (uri.scheme === "file") return uri;
		if (isRemoteResource(uri)) {
			getRemoteWorkspacePath(uri);
			return uri;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function parseUiState(value: unknown): IWindowState | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const mode = value.mode;
	const storedBounds = value.bounds;
	if (!isWindowMode(mode) || !isRecord(storedBounds)) {
		return undefined;
	}

	const bounds = readBounds(() => ({
		x: storedBounds.x,
		y: storedBounds.y,
		width: storedBounds.width,
		height: storedBounds.height,
	}));
	if (!bounds) {
		return undefined;
	}
	if (
		value.displayId !== undefined &&
		!isFiniteNumber(value.displayId)
	) {
		return undefined;
	}
	let workArea: IWindowBounds | undefined;
	if (value.workArea !== undefined) {
		if (!isRecord(value.workArea)) {
			return undefined;
		}
		const area = value.workArea;
		workArea = readBounds(() => ({ x: area.x, y: area.y, width: area.width, height: area.height }));
		if (!workArea) {
			return undefined;
		}
	}

	return {
		mode,
		...bounds,
		displayId: value.displayId,
		...(workArea === undefined ? {} : { workArea }),
	};
}

function sameBounds(first: IWindowBounds, second: IWindowBounds): boolean {
	return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

function toBounds(state: IWindowState): IWindowBounds | undefined {
	if (!isFiniteNumber(state.x) || !isFiniteNumber(state.y)) {
		return undefined;
	}
	return {
		x: state.x,
		y: state.y,
		width: state.width,
		height: state.height,
	};
}

function readBounds(read: () => {
	readonly x: unknown;
	readonly y: unknown;
	readonly width: unknown;
	readonly height: unknown;
}): IWindowBounds | undefined {
	try {
		const bounds = read();
		if (
			!isFiniteNumber(bounds.x) ||
			!isFiniteNumber(bounds.y) ||
			!isFiniteNumber(bounds.width) ||
			!isFiniteNumber(bounds.height) ||
			bounds.width <= 0 ||
			bounds.height <= 0
		) {
			return undefined;
		}
		return {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		};
	} catch {
		return undefined;
	}
}

function isWindowMode(value: unknown): value is IWindowState["mode"] {
	return value === WindowMode.Normal ||
		value === WindowMode.Maximized ||
		value === WindowMode.Fullscreen;
}

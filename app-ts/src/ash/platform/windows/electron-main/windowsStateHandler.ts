import { toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { isFiniteNumber } from "../../../base/common/numbers.js";
import { isNonEmptyString, isRecord } from "../../../base/common/types.js";
import { URI } from "../../../base/common/uri.js";
import type { IStateService } from "../../state/node/state.js";
import { type IAnyWorkspaceIdentifier, type IWorkspaceIdentifier, type WorkbenchState, isEmptyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, workbenchStateFromWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import { defaultWindowState, WindowMode, type IWindowBounds, type IWindowState } from "../../window/electron-main/window.js";
import { validateWindowState, type IWindowDisplay } from "./windows.js";
import { getRemoteWorkspacePath, isRemoteResource } from "../../remote/common/remote.js";

const WINDOWS_STATE_STORAGE_KEY = "windowsState";
const WINDOWS_STATE_VERSION = 1;
const MAX_OPENED_WINDOW_RECORDS = 100;

/** Display operations needed to restore and capture window placement. */
export interface IWindowDisplayService {
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
	on(event: "blur" | "close", listener: () => void): void;
	removeListener(event: "blur" | "close", listener: () => void): void;
}

interface IWindowStateRecord {
	readonly workspace?: IWorkspaceIdentifier;
	readonly folderUri?: URI;
	readonly backupPath?: string;
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
	readonly onError?: (error: unknown) => void;
}

/**
 * Owns the persisted schema and lifecycle for the main Electron window state.
 *
 * Window placement is associated with a concrete workspace, folder, or empty
 * window backup. The last active window remains the fallback for the first
 * window of a new session, matching VS Code's restore order.
 */
export class WindowsStateHandler {
	private readonly stateService: IStateService;
	private readonly displayService: IWindowDisplayService;
	private readonly workspace: IAnyWorkspaceIdentifier;
	private readonly backupPath: string | undefined;
	private readonly workbenchState: WorkbenchState;
	private readonly onError: (error: unknown) => void;
	private windowsState: IWindowsState;
	private lastNormalBounds: IWindowBounds | undefined;

	constructor({
		stateService,
		displayService,
		workspace,
		backupPath,
		onError = () => undefined,
	}: IWindowsStateHandlerOptions) {
		this.stateService = stateService;
		this.displayService = displayService;
		this.workspace = workspace;
		this.backupPath = backupPath;
		this.workbenchState = workbenchStateFromWorkspaceIdentifier(workspace);
		this.onError = onError;
		this.windowsState = parseWindowsState(
			this.stateService.getItem(WINDOWS_STATE_STORAGE_KEY),
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
				this.lastNormalBounds = toBounds(restoredState);
				return restoredState;
			}
		}

		return defaultWindowState(this.workbenchState);
	}

	/** Saves immediately on blur and before the BrowserWindow closes. */
	trackWindow(window: IStatefulWindow): IDisposable {
		const save = (): void => {
			void this.saveWindowState(window).catch(this.onError);
		};
		window.on("blur", save);
		window.on("close", save);

		return toDisposable(() => {
			window.removeListener("blur", save);
			window.removeListener("close", save);
		});
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
		const latestState = parseWindowsState(this.stateService.getItem(WINDOWS_STATE_STORAGE_KEY));
		const otherWindows = latestState.openedWindows.filter(windowState => !matchesWindowIdentity(windowState, this.workspace, this.backupPath));
		const windowsState: IWindowsState = {
			lastActiveWindow: currentWindow,
			openedWindows: [currentWindow, ...otherWindows].slice(0, MAX_OPENED_WINDOW_RECORDS),
		};
		this.windowsState = windowsState;
		this.stateService.setItem(
			WINDOWS_STATE_STORAGE_KEY,
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
		const primaryBounds = readBounds(() =>
			mode === WindowMode.Normal
				? window.getBounds()
				: window.getNormalBounds()
		);
		const bounds = primaryBounds ??
			readBounds(() => window.getBounds()) ??
			this.lastNormalBounds;
		if (!bounds) {
			return undefined;
		}

		this.lastNormalBounds = bounds;
		let displayId: number | undefined;
		if (mode === WindowMode.Fullscreen) {
			const currentBounds = readBounds(() => window.getBounds()) ?? bounds;
			displayId = this.displayService.getDisplayMatching(currentBounds).id;
		}

		return {
			mode,
			...bounds,
			displayId,
		};
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
	return {
		...(backupPath === undefined ? {} : { backupPath }),
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
		backupPath !== undefined &&
		state.backupPath === backupPath;
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
		Number(value.backupPath !== undefined);
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

	return {
		mode,
		...bounds,
		displayId: value.displayId,
	};
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

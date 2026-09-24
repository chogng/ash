import { isFiniteNumber } from "../../../base/common/numbers.js";
import {
	WINDOW_MINIMUM_SIZE,
} from "../../window/common/window.js";
import type {
	WorkbenchState,
} from "../../workspace/common/workspace.js";
import {
	defaultWindowState,
	WindowMode,
	type IWindowBounds,
	type IWindowState,
} from "../../window/electron-main/window.js";

/** The Electron window options owned by the platform window policy. */
export interface IWindowConstructorOptions {
	show: boolean;
	x?: number;
	y?: number;
	width: number;
	height: number;
	minWidth: number;
	minHeight: number;
	titleBarStyle?: "hidden" | "hiddenInset";
	titleBarOverlay?: boolean | {
		readonly color: string;
		readonly symbolColor: string;
		readonly height: number;
	};
	webPreferences: IWindowWebPreferences;
}

/** The preload settings required by Ash's renderer boundary. */
export interface IWindowWebPreferences {
	contextIsolation: boolean;
	nodeIntegration: boolean;
	sandbox: boolean;
	preload: string;
	additionalArguments: string[];
}

/** Structural display information required to validate a restored window. */
export interface IWindowDisplay {
	readonly id: number;
	readonly bounds: IWindowBounds;
	readonly workArea: IWindowBounds;
}

/** Inputs required to resolve one main-window constructor policy. */
export interface IResolveBrowserWindowOptions {
	readonly state: IWindowState;
	readonly webPreferences: IWindowWebPreferences;
	readonly platform?: NodeJS.Platform;
}

/** Produces Electron options from window state and Ash's fixed host policy. */
export function resolveBrowserWindowOptions({
	state,
	webPreferences,
	platform = process.platform,
}: IResolveBrowserWindowOptions): IWindowConstructorOptions {
	const browserWindowOptions: IWindowConstructorOptions = {
		show: state.mode === WindowMode.Normal,
		x: state.x,
		y: state.y,
		width: state.width,
		height: state.height,
		minWidth: WINDOW_MINIMUM_SIZE.width,
		minHeight: WINDOW_MINIMUM_SIZE.height,
		webPreferences,
	};

	if (platform === "win32" || platform === "linux") {
		browserWindowOptions.titleBarStyle = "hidden";
		browserWindowOptions.titleBarOverlay = {
			color: "#181818",
			symbolColor: "#d6d6d6",
			height: 35,
		};
	} else if (platform === "darwin") {
		browserWindowOptions.titleBarStyle = "hiddenInset";
		browserWindowOptions.titleBarOverlay = true;
	}

	return browserWindowOptions;
}

/** A BrowserWindow-like target that can receive a restored non-normal mode. */
export interface IWindowStateTarget {
	maximize(): void;
	setFullScreen(fullscreen: boolean): void;
}

/** Applies the mode that cannot be represented by constructor bounds alone. */
export function applyWindowState(
	target: IWindowStateTarget,
	state: IWindowState,
): void {
	if (state.mode === WindowMode.Maximized) {
		target.maximize();
	} else if (state.mode === WindowMode.Fullscreen) {
		target.setFullScreen(true);
	}
}

/** Validates and adjusts restored state against the displays available now. */
export function validateWindowState(
	state: IWindowState,
	displays: readonly IWindowDisplay[],
	workbenchState: WorkbenchState,
): IWindowState | undefined {
	const { x, y, width: stateWidth, height: stateHeight } = state;
	if (
		!isFiniteNumber(x) ||
		!isFiniteNumber(y) ||
		!isFiniteNumber(stateWidth) ||
		!isFiniteNumber(stateHeight) ||
		stateWidth <= 0 ||
		stateHeight <= 0
	) {
		return undefined;
	}

	const usableDisplays = displays
		.map((display) => ({ display, area: getWorkingArea(display) }))
		.filter((entry): entry is { display: IWindowDisplay; area: IWindowBounds } =>
			entry.area !== undefined
		);
	if (usableDisplays.length === 0) {
		return undefined;
	}

	if (state.mode === WindowMode.Fullscreen && state.displayId !== undefined) {
		const fullscreenDisplay = usableDisplays.find(
			({ display }) => display.id === state.displayId,
		);
		if (fullscreenDisplay) {
			return {
				...defaultWindowState(workbenchState, WindowMode.Fullscreen),
				x: fullscreenDisplay.display.bounds.x,
				y: fullscreenDisplay.display.bounds.y,
				displayId: fullscreenDisplay.display.id,
			};
		}
	}

	if (usableDisplays.length === 1) {
		const { area } = usableDisplays[0];
		const width = Math.min(stateWidth, area.width);
		const height = Math.min(stateHeight, area.height);
		let adjustedX = Math.max(x, area.x);
		let adjustedY = Math.max(y, area.y);

		if (adjustedX > area.x + area.width - 128) {
			adjustedX = area.x + area.width - width;
		}
		if (adjustedY > area.y + area.height - 128) {
			adjustedY = area.y + area.height - height;
		}

		return {
			...state,
			x: Math.max(adjustedX, area.x),
			y: Math.max(adjustedY, area.y),
			width,
			height,
		};
	}

	const intersectsCurrentDisplay = usableDisplays.some(({ area }) =>
		x + stateWidth > area.x &&
		y + stateHeight > area.y &&
		x < area.x + area.width &&
		y < area.y + area.height
	);
	return intersectsCurrentDisplay ? { ...state } : undefined;
}

function getWorkingArea(display: IWindowDisplay): IWindowBounds | undefined {
	if (display.workArea.width > 0 && display.workArea.height > 0) {
		return display.workArea;
	}
	if (display.bounds.width > 0 && display.bounds.height > 0) {
		return display.bounds;
	}
	return undefined;
}

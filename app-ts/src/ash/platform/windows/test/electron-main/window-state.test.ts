import assert from "node:assert/strict";
import { test } from "mocha";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import type { IStateService } from "../../../../platform/state/node/state.js";
import { type IAnyWorkspaceIdentifier, type ISingleFolderWorkspaceIdentifier, type IWorkspaceIdentifier, UNKNOWN_EMPTY_WINDOW_WORKSPACE, WorkbenchState } from "../../../../platform/workspace/common/workspace.js";
import { defaultWindowState, WindowMode, type IWindowBounds } from "../../../../platform/window/electron-main/window.js";
import { applyWindowState, resolveBrowserWindowOptions, validateWindowState, type IWindowDisplay } from "../../../../platform/windows/electron-main/windows.js";
import { WindowsStateHandler, type IStatefulWindow } from "../../../../platform/windows/electron-main/windowsStateHandler.js";

const primaryDisplay: IWindowDisplay = {
	id: 1,
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const folderWorkspace: ISingleFolderWorkspaceIdentifier = Object.freeze({
	id: "folder-project",
	uri: URI.file("C:\\projects\\folder"),
});
const multiRootWorkspace: IWorkspaceIdentifier = Object.freeze({
	id: "multi-root-project",
	configPath: URI.file("C:\\projects\\team.ash-workspace"),
});

class TestStateService implements IStateService {
	readonly items = new Map<string, unknown>();
	flushCount = 0;

	getItem(key: string): unknown {
		return this.items.get(key);
	}

	setItem(key: string, value: unknown): void {
		this.items.set(key, value);
	}

	removeItem(key: string): void {
		this.items.delete(key);
	}

	async flush(): Promise<void> {
		this.flushCount += 1;
	}

	async close(): Promise<void> {
		await this.flush();
	}
}

class TestWindow implements IStatefulWindow {
	private readonly listeners = new Map<"blur" | "close", Set<() => void>>();
	fullscreen = false;
	maximized = false;
	bounds: IWindowBounds = { x: 0, y: 0, width: 1920, height: 1040 };
	normalBounds: IWindowBounds = { x: 120, y: 80, width: 1100, height: 760 };

	isFullScreen(): boolean {
		return this.fullscreen;
	}

	isMaximized(): boolean {
		return this.maximized;
	}

	getBounds(): IWindowBounds {
		return this.bounds;
	}

	getNormalBounds(): IWindowBounds {
		return this.normalBounds;
	}

	on(event: "blur" | "close", listener: () => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
	}

	removeListener(event: "blur" | "close", listener: () => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	emit(event: "blur" | "close"): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener();
		}
	}
}

function createHandler(
	stateService: IStateService,
	workspace: IAnyWorkspaceIdentifier,
	backupPath?: string,
): WindowsStateHandler {
	return new WindowsStateHandler({
		stateService,
		workspace,
		backupPath,
		displayService: {
			getAllDisplays: () => [primaryDisplay],
			getDisplayMatching: () => primaryDisplay,
		},
	});
}

test("default window states match the VS Code workbench sizes", () => {
	assert.deepEqual(defaultWindowState(WorkbenchState.EMPTY), {
		mode: WindowMode.Normal,
		width: 1200,
		height: 800,
	});
	assert.deepEqual(defaultWindowState(WorkbenchState.FOLDER), {
		mode: WindowMode.Normal,
		width: 1440,
		height: 900,
	});
	assert.deepEqual(defaultWindowState(WorkbenchState.WORKSPACE), {
		mode: WindowMode.Normal,
		width: 1440,
		height: 900,
	});
});

test("window state falls back to defaults when persisted data is invalid", () => {
	const stateService = new TestStateService();
	stateService.setItem("windowsState", {
		version: 1,
		openedWindows: [{
			folder: folderWorkspace.uri.toString(),
			uiState: {
				mode: WindowMode.Normal,
				bounds: { x: 0, y: 0, width: -1, height: 800 },
			},
		}],
	});

	assert.deepEqual(
		createHandler(stateService, folderWorkspace).restoreWindowState(),
		defaultWindowState(WorkbenchState.FOLDER),
	);
});

test("legacy per-kind window state keys are not restored", () => {
	const stateService = new TestStateService();
	stateService.setItem("windowState", {
		version: 1,
		mode: WindowMode.Normal,
		bounds: { x: 140, y: 90, width: 1440, height: 900 },
	});

	assert.deepEqual(
		createHandler(
			stateService,
			UNKNOWN_EMPTY_WINDOW_WORKSPACE,
		).restoreWindowState(),
		defaultWindowState(WorkbenchState.EMPTY),
	);
});

test("window state restores exact folder and workspace records", () => {
	const stateService = new TestStateService();
	stateService.setItem("windowsState", {
		version: 1,
		lastActiveWindow: {
			uiState: {
				mode: WindowMode.Normal,
				bounds: { x: 30, y: 40, width: 1200, height: 800 },
			},
		},
		openedWindows: [
			{
				folder: folderWorkspace.uri.toString(),
				uiState: {
					mode: WindowMode.Normal,
					bounds: { x: 100, y: 80, width: 1100, height: 760 },
				},
			},
			{
				workspaceIdentifier: {
					id: multiRootWorkspace.id,
					configURIPath: multiRootWorkspace.configPath.toString(),
				},
				uiState: {
					mode: WindowMode.Maximized,
					bounds: { x: 140, y: 90, width: 1000, height: 700 },
				},
			},
		],
	});

	assert.deepEqual(
		createHandler(stateService, folderWorkspace).restoreWindowState(),
		{
			mode: WindowMode.Normal,
			x: 100,
			y: 80,
			width: 1100,
			height: 760,
			displayId: undefined,
		},
	);
	assert.deepEqual(
		createHandler(stateService, multiRootWorkspace).restoreWindowState(),
		{
			mode: WindowMode.Maximized,
			x: 140,
			y: 90,
			width: 1000,
			height: 700,
			displayId: undefined,
		},
	);
});

test("empty windows restore by backup path", () => {
	const stateService = new TestStateService();
	stateService.setItem("windowsState", {
		version: 1,
		lastActiveWindow: {
			uiState: {
				mode: WindowMode.Normal,
				bounds: { x: 30, y: 40, width: 1200, height: 800 },
			},
		},
		openedWindows: [{
			backupPath: "C:\\backups\\empty-1",
			uiState: {
				mode: WindowMode.Normal,
				bounds: { x: 180, y: 120, width: 900, height: 640 },
			},
		}],
	});

	assert.deepEqual(
		createHandler(
			stateService,
			UNKNOWN_EMPTY_WINDOW_WORKSPACE,
			"C:\\backups\\empty-1",
		).restoreWindowState(),
		{
			mode: WindowMode.Normal,
			x: 180,
			y: 120,
			width: 900,
			height: 640,
			displayId: undefined,
		},
	);
});

test("first unmatched window inherits the last active window state", () => {
	const stateService = new TestStateService();
	stateService.setItem("windowsState", {
		version: 1,
		lastActiveWindow: {
			workspaceIdentifier: {
				id: "other-project",
				configURIPath: URI.file(
					"C:\\projects\\other.ash-workspace",
				).toString(),
			},
			uiState: {
				mode: WindowMode.Normal,
				bounds: { x: 200, y: 100, width: 1280, height: 820 },
			},
		},
		openedWindows: [],
	});

	assert.deepEqual(
		createHandler(stateService, folderWorkspace).restoreWindowState(),
		{
			mode: WindowMode.Normal,
			x: 200,
			y: 100,
			width: 1280,
			height: 820,
			displayId: undefined,
		},
	);
});

test("window state is adjusted to the current single display", () => {
	const state = validateWindowState({
		mode: WindowMode.Normal,
		x: 5000,
		y: 5000,
		width: 2400,
		height: 1600,
	}, [primaryDisplay], WorkbenchState.FOLDER);

	assert.deepEqual(state, {
		mode: WindowMode.Normal,
		x: 0,
		y: 0,
		width: 1920,
		height: 1040,
	});
});

test("window options include restored bounds and defer non-normal display", () => {
	const options = resolveBrowserWindowOptions({
		state: {
			mode: WindowMode.Maximized,
			x: 100,
			y: 60,
			width: 1280,
			height: 800,
		},
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: "preload.js",
			additionalArguments: [],
		},
		platform: "linux",
	});

	assert.equal(options.show, false);
	assert.equal(options.x, 100);
	assert.equal(options.y, 60);
	assert.equal(options.width, 1280);
	assert.equal(options.height, 800);
	assert.equal(options.minWidth, 400);
	assert.equal(options.minHeight, 270);

	let maximized = false;
	applyWindowState({
		maximize: () => {
			maximized = true;
		},
		setFullScreen: () => {
			throw new Error("unexpected fullscreen");
		},
	}, { mode: WindowMode.Maximized, width: 1280, height: 800 });
	assert.equal(maximized, true);
});

test("maximized windows persist their normal bounds", async () => {
	const stateService = new TestStateService();
	const handler = createHandler(stateService, folderWorkspace);
	const window = new TestWindow();
	window.maximized = true;

	await handler.saveWindowState(window);

	const serializedWindow = {
		folder: folderWorkspace.uri.toString(),
		uiState: {
			mode: WindowMode.Maximized,
			bounds: {
				x: 120,
				y: 80,
				width: 1100,
				height: 760,
			},
		},
	};
	assert.deepEqual(stateService.getItem("windowsState"), {
		version: 1,
		lastActiveWindow: serializedWindow,
		openedWindows: [serializedWindow],
	});
	assert.equal(stateService.flushCount, 1);
});

test("workspace windows persist their workspace identifier", async () => {
	const stateService = new TestStateService();
	const handler = createHandler(stateService, multiRootWorkspace);
	const window = new TestWindow();

	await handler.saveWindowState(window);

	const serializedWindow = {
		workspaceIdentifier: {
			id: multiRootWorkspace.id,
			configURIPath: multiRootWorkspace.configPath.toString(),
		},
		uiState: {
			mode: WindowMode.Normal,
			bounds: {
				x: 0,
				y: 0,
				width: 1920,
				height: 1040,
			},
		},
	};
	assert.deepEqual(stateService.getItem("windowsState"), {
		version: 1,
		lastActiveWindow: serializedWindow,
		openedWindows: [serializedWindow],
	});
});

test("empty windows persist their backup identity", async () => {
	const stateService = new TestStateService();
	const handler = createHandler(
		stateService,
		UNKNOWN_EMPTY_WINDOW_WORKSPACE,
		"C:\\backups\\empty-1",
	);
	const window = new TestWindow();

	await handler.saveWindowState(window);

	const serializedWindow = {
		backupPath: "C:\\backups\\empty-1",
		uiState: {
			mode: WindowMode.Normal,
			bounds: {
				x: 0,
				y: 0,
				width: 1920,
				height: 1040,
			},
		},
	};
	assert.deepEqual(stateService.getItem("windowsState"), {
		version: 1,
		lastActiveWindow: serializedWindow,
		openedWindows: [serializedWindow],
	});
});

test("dedicated window state restores without changing the main window state", async () => {
	const stateService = new TestStateService();
	const main = createHandler(stateService, folderWorkspace);
	const dedicatedOptions = {
		stateService,
		workspace: UNKNOWN_EMPTY_WINDOW_WORKSPACE,
		storageKey: 'sessionsWindowState',
		defaultState: { mode: WindowMode.Normal, width: 1180, height: 780 },
		displayService: {
			getAllDisplays: () => [primaryDisplay],
			getDisplayMatching: () => primaryDisplay,
		},
	};
	const dedicated = new WindowsStateHandler(dedicatedOptions);
	assert.deepEqual(dedicated.restoreWindowState(), dedicatedOptions.defaultState);
	const mainWindow = new TestWindow();
	await main.saveWindowState(mainWindow);
	const mainState = stateService.getItem('windowsState');
	const dedicatedWindow = new TestWindow();
	dedicatedWindow.bounds = { x: 180, y: 140, width: 1180, height: 780 };
	await dedicated.saveWindowState(dedicatedWindow);
	assert.deepEqual(stateService.getItem('windowsState'), mainState);
	assert.deepEqual(new WindowsStateHandler(dedicatedOptions).restoreWindowState(), {
		mode: WindowMode.Normal, x: 180, y: 140, width: 1180, height: 780, displayId: undefined,
	});
});

test("independent handlers merge exact Workspace window state instead of overwriting it", async () => {
	const stateService = new TestStateService();
	const folderHandler = createHandler(stateService, folderWorkspace);
	const workspaceHandler = createHandler(stateService, multiRootWorkspace);
	const folderWindow = new TestWindow();
	const workspaceWindow = new TestWindow();
	workspaceWindow.bounds = { x: 200, y: 120, width: 1280, height: 800 };

	await folderHandler.saveWindowState(folderWindow);
	await workspaceHandler.saveWindowState(workspaceWindow);

	const state = stateService.getItem("windowsState") as { readonly openedWindows: readonly unknown[] };
	assert.equal(state.openedWindows.length, 2);
	assert.deepEqual(state.openedWindows.map(record => Object.keys(record as object).sort()), [
		["uiState", "workspaceIdentifier"],
		["folder", "uiState"],
	]);

	folderWindow.bounds = { x: 300, y: 160, width: 1440, height: 900 };
	await folderHandler.saveWindowState(folderWindow);
	const updated = stateService.getItem("windowsState") as { readonly openedWindows: ReadonlyArray<{ readonly folder?: string; readonly uiState: { readonly bounds: { readonly x: number } } }> };
	assert.equal(updated.openedWindows.length, 2);
	assert.equal(updated.openedWindows[0]?.folder, folderWorkspace.uri.toString());
	assert.equal(updated.openedWindows[0]?.uiState.bounds.x, 300);
});

test("tracked windows save on blur and stop after disposal", async () => {
	const stateService = new TestStateService();
	const handler = createHandler(stateService, folderWorkspace);
	const window = new TestWindow();
	const tracking: IDisposable = handler.trackWindow(window);

	window.emit("blur");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(stateService.flushCount, 1);

	tracking.dispose();
	window.emit("blur");
	await Promise.resolve();
	assert.equal(stateService.flushCount, 1);
});

import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import type { IStateService } from "../../../../platform/state/node/state.js";
import { type IAnyWorkspaceIdentifier, type ISingleFolderWorkspaceIdentifier, type IWorkspaceIdentifier, UNKNOWN_EMPTY_WINDOW_WORKSPACE, WorkbenchState, serializeWorkspaceIdentifier } from "../../../../platform/workspace/common/workspace.js";
import { defaultWindowState, WindowMode, type IWindowBounds } from "../../../../platform/window/electron-main/window.js";
import { applyWindowState, resolveBrowserWindowOptions, validateWindowState, type IWindowDisplay } from "../../../../platform/windows/electron-main/windows.js";
import { WindowsStateHandler, WindowSessionStateHandler, type IStatefulWindow, type IWindowSessionEntry, type IWindowSessionWindow } from "../../../../platform/windows/electron-main/windowsStateHandler.js";
import { parseNewWindowDimensions, parseRestoreFullscreen } from '../../../../platform/window/common/window.js';

const defaultOptions = { existingWindows: [], newWindowDimensions: 'default', restoreFullscreen: false, wasRestarted: false } as const;

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

test('window session state owner persists active Workbench and Agents windows and the last closed window', async () => {
	type Entry =
		| { readonly kind: 'workbench'; readonly workspace: IAnyWorkspaceIdentifier }
		| { readonly kind: 'sessions'; readonly workspace: IAnyWorkspaceIdentifier };
	const isEntry = (entry: IWindowSessionEntry): entry is Entry => entry.kind === 'workbench' || entry.kind === 'sessions';
	const workbench: Entry = { kind: 'workbench', workspace: folderWorkspace };
	const agents: Entry = { kind: 'sessions', workspace: multiRootWorkspace };
	const state = new TestStateService();
	let windows: readonly IWindowSessionWindow<Entry>[] = [
		{ id: 1, entry: workbench, focused: false },
		{ id: 2, entry: agents, focused: true },
	];
	const handler = new WindowSessionStateHandler(state, () => windows, isEntry);
	{
		using restoration = handler.beginRestoration();
		handler.windowOpened();
		assert.equal(state.getItem('windowSession'), undefined);
	}
	await handler.saveSession();
	assert.deepEqual(state.getItem('windowSession'), {
		version: 1,
		active: 1,
		windows: [
			{ kind: 'workbench', workspace: serializeWorkspaceIdentifier(folderWorkspace) },
			{ kind: 'sessions', workspace: serializeWorkspaceIdentifier(multiRootWorkspace) },
		],
	});
	const restored = new WindowSessionStateHandler(state, () => windows, isEntry).readSession();
	assert.deepEqual(restored, { windows: [workbench, agents], active: 1 });

	windows = [];
	handler.windowClosed(agents);
	await handler.saveSession();
	assert.deepEqual(handler.readSession(), { windows: [agents], active: 0 });
	windows = [{ id: 3, entry: workbench, focused: true }];
	handler.windowOpened();
	await handler.saveSession();
	assert.deepEqual(handler.readSession(), { windows: [workbench], active: 0 });
	handler.stopAutomaticSaves();
	windows = [{ id: 4, entry: agents, focused: true }];
	handler.windowOpened();
	assert.deepEqual(handler.readSession(), { windows: [workbench], active: 0 });
	handler.resumeAutomaticSaves();
	assert.deepEqual(handler.readSession(), { windows: [agents], active: 0 });
});

test('window session state reads retired mode fields and saves only window kind and workspace', async () => {
	const state = new TestStateService();
	state.setItem('windowSession', {
		version: 1, active: 0,
		windows: [{ kind: 'sessions', workspace: serializeWorkspaceIdentifier(multiRootWorkspace), modeId: 'academic' }],
	});
	const handler = new WindowSessionStateHandler(state, () => [], (entry): entry is IWindowSessionEntry => entry.kind === 'sessions');
	const restored = handler.readSession();
	assert.deepEqual(restored, { active: 0, windows: [{ kind: 'sessions', workspace: multiRootWorkspace }] });
	handler.windowClosed(restored!.windows[0]!);
	await handler.saveSession();
	assert.deepEqual(state.getItem('windowSession'), {
		version: 1, active: 0,
		windows: [{ kind: 'sessions', workspace: serializeWorkspaceIdentifier(multiRootWorkspace) }],
	});
});

class TestWindow implements IStatefulWindow {
	private readonly listeners = new Map<Parameters<IStatefulWindow['on']>[0], Set<() => void>>();
	fullscreen = false;
	maximized = false;
	bounds: IWindowBounds = { x: 0, y: 0, width: 1920, height: 1040 };
	normalBounds: IWindowBounds = { x: 120, y: 80, width: 1100, height: 760 };
	minimumSize = { width: 400, height: 270 };

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

	setMinimumSize(width: number, height: number): void {
		this.minimumSize = { width, height };
	}

	setBounds(bounds: IWindowBounds): void {
		this.bounds = { ...bounds, width: Math.max(bounds.width, this.minimumSize.width), height: Math.max(bounds.height, this.minimumSize.height) };
		this.normalBounds = { ...this.bounds };
		this.emit('move');
		this.emit('resize');
	}

	on(event: Parameters<IStatefulWindow['on']>[0], listener: () => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
	}

	removeListener(event: Parameters<IStatefulWindow['on']>[0], listener: () => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	emit(event: Parameters<IStatefulWindow['on']>[0]): void {
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
			onDidChangeDisplays: Event.None,
			getAllDisplays: () => [primaryDisplay],
			getPrimaryDisplay: () => primaryDisplay, getCursorDisplay: () => primaryDisplay,
			getDisplayMatching: () => primaryDisplay,
		},
	});
}

test("default window states share the user-requested 1200 by 800 size", () => {
	assert.deepEqual(defaultWindowState(WorkbenchState.EMPTY), {
		mode: WindowMode.Normal,
		width: 1200,
		height: 800,
	});
	assert.deepEqual(defaultWindowState(WorkbenchState.FOLDER), {
		mode: WindowMode.Normal,
		width: 1200,
		height: 800,
	});
	assert.deepEqual(defaultWindowState(WorkbenchState.WORKSPACE), {
		mode: WindowMode.Normal,
		width: 1200,
		height: 800,
	});
});

test('window dimension settings validate their complete persisted values', () => {
	for (const value of ['default', 'inherit', 'offset', 'maximized', 'fullscreen']) assert.equal(parseNewWindowDimensions(value), value);
	for (const value of ['center', true, 1440, null]) assert.throws(() => parseNewWindowDimensions(value), TypeError);
	assert.equal(parseRestoreFullscreen(true), true);
	assert.equal(parseRestoreFullscreen(false), false);
	assert.throws(() => parseRestoreFullscreen('true'), TypeError);
});

test('new windows apply each dimension policy to normal bounds and retain their own fullscreen normal size', () => {
	const active = { mode: WindowMode.Normal, x: 160, y: 100, width: 900, height: 600 };
	for (const [policy, mode, bounds] of [
		['default', WindowMode.Normal, { x: 360, y: 140, width: 1200, height: 800 }],
		['inherit', WindowMode.Normal, { x: 160, y: 100, width: 900, height: 600 }],
		['offset', WindowMode.Normal, { x: 190, y: 130, width: 900, height: 600 }],
		['maximized', WindowMode.Maximized, { x: 360, y: 140, width: 1200, height: 800 }],
		['fullscreen', WindowMode.Fullscreen, { x: 360, y: 140, width: 1200, height: 800 }],
	] as const) {
		const handler = createHandler(new TestStateService(), folderWorkspace);
		assert.deepEqual(handler.getNewWindowState({ ...defaultOptions, newWindowDimensions: policy, lastActiveWindow: { state: active, bounds: active }, existingWindows: [active] }), {
			...bounds, mode, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
		});
	}
	for (const policy of ['inherit', 'offset'] as const) {
		const handler = createHandler(new TestStateService(), folderWorkspace);
		assert.deepEqual(handler.getNewWindowState({ ...defaultOptions, newWindowDimensions: policy, lastActiveWindow: { state: { ...active, mode: WindowMode.Fullscreen }, bounds: primaryDisplay.bounds }, existingWindows: [primaryDisplay.bounds] }), {
			mode: WindowMode.Fullscreen, x: 360, y: 140, width: 1200, height: 800, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
		});
	}
	const handler = createHandler(new TestStateService(), folderWorkspace);
	assert.equal(handler.getNewWindowState({ ...defaultOptions, newWindowDimensions: 'offset', lastActiveWindow: { state: { ...active, mode: WindowMode.Maximized }, bounds: primaryDisplay.bounds }, existingWindows: [primaryDisplay.bounds] }).mode, WindowMode.Maximized);
});

test('default placement avoids every existing window sharing either coordinate', () => {
	const handler = createHandler(new TestStateService(), folderWorkspace);
	assert.deepEqual(handler.getNewWindowState({ ...defaultOptions, existingWindows: [
		{ x: 360, y: 10, width: 500, height: 500 },
		{ x: 10, y: 170, width: 500, height: 500 },
	] }), {
		mode: WindowMode.Normal, x: 420, y: 200, width: 1200, height: 800, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
	});
});

test('known fullscreen windows restore fullscreen only when enabled or restarted', async () => {
	const state = new TestStateService();
	const handler = createHandler(state, folderWorkspace);
	const window = new TestWindow();
	window.fullscreen = true;
	await handler.saveWindowState(window);
	for (const [restoreFullscreen, wasRestarted, mode] of [
		[false, false, WindowMode.Normal], [true, false, WindowMode.Fullscreen], [false, true, WindowMode.Fullscreen],
	] as const) {
		for (const newWindowDimensions of ['default', 'fullscreen'] as const) {
			assert.equal(createHandler(state, folderWorkspace).getNewWindowState({ ...defaultOptions, restoreFullscreen, wasRestarted, newWindowDimensions }).mode, mode);
		}
	}
});

test('macOS new windows use the cursor display while other platforms use the active display', () => {
	const secondary = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 24, width: 2560, height: 1416 } };
	for (const platform of ['darwin', 'win32', 'linux'] as const) {
		const handler = new WindowsStateHandler({
			stateService: new TestStateService(), workspace: folderWorkspace, platform,
			displayService: {
				onDidChangeDisplays: Event.None,
				getAllDisplays: () => [primaryDisplay, secondary],
				getPrimaryDisplay: () => primaryDisplay,
				getCursorDisplay: () => secondary,
				getDisplayMatching: () => primaryDisplay,
			},
		});
		const state = handler.getNewWindowState({ ...defaultOptions, lastActiveWindow: { state: { ...primaryDisplay.workArea, mode: WindowMode.Normal }, bounds: primaryDisplay.workArea } });
		assert.equal(state.displayId, platform === 'darwin' ? secondary.id : primaryDisplay.id);
	}
});

test('new windows follow the fullscreen display while retaining each kind\'s default normal size', () => {
	const secondary = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
	for (const [workspace, width, height] of [[UNKNOWN_EMPTY_WINDOW_WORKSPACE, 1200, 800], [folderWorkspace, 1200, 800]] as const) {
		const handler = new WindowsStateHandler({
			stateService: new TestStateService(), workspace, platform: 'win32',
			displayService: {
				onDidChangeDisplays: Event.None, getAllDisplays: () => [primaryDisplay, secondary],
				getPrimaryDisplay: () => primaryDisplay, getCursorDisplay: () => primaryDisplay,
				getDisplayMatching: bounds => bounds.x < 1920 ? primaryDisplay : secondary,
			},
		});
		for (const newWindowDimensions of ['default', 'inherit', 'offset'] as const) {
			assert.deepEqual(handler.getNewWindowState({
				...defaultOptions, newWindowDimensions,
				lastActiveWindow: { state: { ...primaryDisplay.workArea, mode: WindowMode.Fullscreen }, bounds: secondary.bounds },
			}), {
				mode: newWindowDimensions === 'default' ? WindowMode.Normal : WindowMode.Fullscreen,
				x: secondary.bounds.x + (secondary.bounds.width - width) / 2,
				y: (secondary.bounds.height - height) / 2, width, height, displayId: secondary.id, workArea: secondary.workArea,
			});
		}
	}
});

test('quit snapshots remain authoritative until a close is vetoed', async () => {
	const state = new TestStateService();
	const handler = createHandler(state, folderWorkspace);
	const window = new TestWindow();
	using tracking = handler.trackWindow(window);
	handler.stopAutomaticSaves();
	await handler.saveWindowState(window);
	const saved = state.getItem('windowsState');
	window.bounds = { x: 100, y: 100, width: 900, height: 600 };
	window.emit('close');
	assert.equal(state.getItem('windowsState'), saved);
	handler.resumeAutomaticSaves();
	window.emit('blur');
	assert.notEqual(state.getItem('windowsState'), saved);
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
		createHandler(stateService, folderWorkspace).getNewWindowState(defaultOptions),
		{ ...defaultWindowState(WorkbenchState.FOLDER), x: 360, y: 140, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea },
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
		).getNewWindowState(defaultOptions),
		{ ...defaultWindowState(WorkbenchState.EMPTY), x: 360, y: 140, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea },
	);
});

test('new window defaults are centered and constrained to the current logical work area', () => {
	for (const [workspace, size] of [
		[UNKNOWN_EMPTY_WINDOW_WORKSPACE, { width: 1200, height: 800 }],
		[folderWorkspace, { width: 1200, height: 800 }],
	] as const) {
		for (const workArea of [
			{ x: 100, y: 50, width: 1920, height: 1040 },
			{ x: 0, y: 0, width: 1280, height: 984 },
			{ x: 0, y: 0, width: 2560, height: 1040 },
			{ x: 0, y: 0, width: 800, height: 1240 },
			{ x: -1024, y: 20, width: 1024, height: 700 },
			{ x: 0, y: 0, width: 300, height: 200 },
		]) {
			const display = { id: 1, bounds: workArea, workArea };
			const handler = new WindowsStateHandler({
				stateService: new TestStateService(), workspace,
				displayService: { onDidChangeDisplays: Event.None, getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorDisplay: () => display, getDisplayMatching: () => display },
			});
			const width = Math.min(size.width, workArea.width);
			const height = Math.min(size.height, workArea.height);
			assert.deepEqual(handler.getNewWindowState(defaultOptions), {
				mode: WindowMode.Normal,
				x: workArea.x + (workArea.width - width) / 2,
				y: workArea.y + (workArea.height - height) / 2,
				width, height, displayId: display.id, workArea,
			});
		}
	}
});

test('first startup uses the primary display when a larger secondary display overlaps the default rectangle', () => {
	const primary = { id: 10, scaleFactor: 2, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 560 } };
	const secondary = { id: 20, scaleFactor: 1, bounds: { x: 800, y: 0, width: 2560, height: 1440 }, workArea: { x: 800, y: 0, width: 2560, height: 1400 } };
	const displayService = {
		onDidChangeDisplays: Event.None,
		getAllDisplays: () => [primary, secondary],
		getPrimaryDisplay: () => primary, getCursorDisplay: () => primary,
		getDisplayMatching: () => secondary,
	};
	const handler = new WindowsStateHandler({ stateService: new TestStateService(), workspace: folderWorkspace, displayService });
	assert.deepEqual(handler.getNewWindowState(defaultOptions), {
		mode: WindowMode.Normal, x: 0, y: 0, width: 800, height: 560, displayId: primary.id, workArea: primary.workArea,
	});
});

test('resolution changes keep a fitting saved rectangle and bring partially hidden windows fully into view', () => {
	const display = { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 }, workArea: { x: 0, y: 0, width: 1600, height: 860 } };
	for (const workArea of [undefined, primaryDisplay.workArea]) {
		assert.deepEqual(validateWindowState({
			mode: WindowMode.Normal, x: 120, y: 80, width: 1100, height: 760, workArea,
		}, [display], WorkbenchState.FOLDER), {
			mode: WindowMode.Normal, x: 120, y: 80, width: 1100, height: 760, workArea: workArea ? display.workArea : undefined,
			...(workArea ? { displayId: display.id } : {}),
		});
		assert.deepEqual(validateWindowState({
			mode: WindowMode.Normal, x: 1200, y: 700, width: 1100, height: 760, workArea,
		}, [display], WorkbenchState.FOLDER), {
			mode: WindowMode.Normal, x: 500, y: 100, width: 1100, height: 760, workArea: workArea ? display.workArea : undefined,
			...(workArea ? { displayId: display.id } : {}),
		});
	}
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
		createHandler(stateService, folderWorkspace).getNewWindowState({ ...defaultOptions, lastActiveWindow: { state: { ...primaryDisplay.bounds, mode: WindowMode.Normal }, bounds: primaryDisplay.bounds } }),
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
		createHandler(stateService, multiRootWorkspace).getNewWindowState({ ...defaultOptions, lastActiveWindow: { state: { ...primaryDisplay.bounds, mode: WindowMode.Normal }, bounds: primaryDisplay.bounds } }),
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
		).getNewWindowState(defaultOptions),
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
		createHandler(stateService, folderWorkspace).getNewWindowState(defaultOptions),
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

test('new unmatched windows use the required default size on the active display instead of saved last-active dimensions', () => {
	const stateService = new TestStateService();
	stateService.setItem('windowsState', {
		version: 1,
		lastActiveWindow: { uiState: { mode: WindowMode.Maximized, bounds: { x: 200, y: 100, width: 1000, height: 700 } } },
		openedWindows: [],
	});
	const activeBounds = { x: 2200, y: 100, width: 1000, height: 700 };
	for (const workArea of [
		{ x: 1920, y: 0, width: 2560, height: 1400 },
		{ x: 1920, y: 0, width: 1280, height: 984 },
		{ x: 1920, y: 0, width: 960, height: 520 },
	]) {
		const display = { id: 2, bounds: workArea, workArea };
		for (const [workspace, size] of [
			[UNKNOWN_EMPTY_WINDOW_WORKSPACE, { width: 1200, height: 800 }],
			[folderWorkspace, { width: 1200, height: 800 }],
		] as const) {
			const handler = new WindowsStateHandler({
				stateService, workspace,
				displayService: {
					onDidChangeDisplays: Event.None,
					getAllDisplays: () => [primaryDisplay, display],
					getPrimaryDisplay: () => primaryDisplay, getCursorDisplay: () => primaryDisplay,
					getDisplayMatching: bounds => {
						assert.deepEqual(bounds, activeBounds);
						return display;
					},
				},
			});
			const width = Math.min(size.width, workArea.width);
			const height = Math.min(size.height, workArea.height);
			assert.deepEqual(handler.getNewWindowState({ ...defaultOptions, lastActiveWindow: { state: { ...activeBounds, mode: WindowMode.Normal }, bounds: activeBounds } }), {
				mode: WindowMode.Normal,
				x: Math.round(workArea.x + (workArea.width - width) / 2),
				y: Math.round(workArea.y + (workArea.height - height) / 2),
				width, height, displayId: display.id, workArea,
			});
		}
	}
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
			displayId: primaryDisplay.id,
			workArea: primaryDisplay.workArea,
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
			displayId: primaryDisplay.id,
			workArea: primaryDisplay.workArea,
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
			displayId: primaryDisplay.id,
			workArea: primaryDisplay.workArea,
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

test("empty windows keep independent placement by workspace ID", async () => {
	const stateService = new TestStateService();
	const firstWorkspace = { id: "empty-window-first" };
	const secondWorkspace = { id: "empty-window-second" };
	const first = createHandler(stateService, firstWorkspace);
	const second = createHandler(stateService, secondWorkspace);
	const firstWindow = new TestWindow();
	const secondWindow = new TestWindow();
	firstWindow.bounds = { x: 120, y: 80, width: 1000, height: 700 };
	secondWindow.bounds = { x: 320, y: 180, width: 900, height: 640 };

	await first.saveWindowState(firstWindow);
	await second.saveWindowState(secondWindow);

	const state = stateService.getItem("windowsState") as { readonly openedWindows: ReadonlyArray<{ readonly emptyWorkspaceId?: string }> };
	assert.deepEqual(state.openedWindows.map(record => record.emptyWorkspaceId), [secondWorkspace.id, firstWorkspace.id]);
	assert.equal(createHandler(stateService, firstWorkspace).getNewWindowState(defaultOptions).x, 120);
	assert.equal(createHandler(stateService, secondWorkspace).getNewWindowState(defaultOptions).x, 320);
});

test("dedicated windows keep known placement separate and share first-window placement", async () => {
	const stateService = new TestStateService();
	const main = createHandler(stateService, folderWorkspace);
	const dedicatedOptions = {
		stateService,
		workspace: UNKNOWN_EMPTY_WINDOW_WORKSPACE,
		storageKey: 'sessionsWindowState',
		defaultState: defaultWindowState(WorkbenchState.WORKSPACE),
		displayService: {
			onDidChangeDisplays: Event.None,
			getAllDisplays: () => [primaryDisplay],
			getPrimaryDisplay: () => primaryDisplay, getCursorDisplay: () => primaryDisplay,
			getDisplayMatching: () => primaryDisplay,
		},
	};
	const dedicated = new WindowsStateHandler(dedicatedOptions);
	assert.deepEqual(dedicated.getNewWindowState(defaultOptions), {
		...dedicatedOptions.defaultState, x: 360, y: 140, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
	});
	const mainWindow = new TestWindow();
	await main.saveWindowState(mainWindow);
	const mainState = stateService.getItem('windowsState') as { openedWindows: unknown[] };
	const dedicatedWindow = new TestWindow();
	dedicatedWindow.bounds = { x: 180, y: 140, width: 1180, height: 780 };
	await dedicated.saveWindowState(dedicatedWindow);
	assert.deepEqual((stateService.getItem('windowsState') as { openedWindows: unknown[] }).openedWindows, mainState.openedWindows);
	assert.deepEqual(createHandler(stateService, { id: 'new-empty' }).getNewWindowState(defaultOptions), {
		mode: WindowMode.Normal, x: 180, y: 140, width: 1180, height: 780, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
	});
	assert.deepEqual(new WindowsStateHandler(dedicatedOptions).getNewWindowState(defaultOptions), {
		mode: WindowMode.Normal, x: 180, y: 140, width: 1180, height: 780, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
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

test('window persistence retains logical size and position when display resolution increases', async () => {
	const stateService = new TestStateService();
	let display = primaryDisplay;
	const options = {
		stateService,
		workspace: folderWorkspace,
		displayService: {
			onDidChangeDisplays: Event.None,
			getAllDisplays: () => [display],
			getPrimaryDisplay: () => display, getCursorDisplay: () => display,
			getDisplayMatching: () => display,
		},
	};
	const window = new TestWindow();
	window.bounds = { x: 120, y: 80, width: 1100, height: 760 };
	await new WindowsStateHandler(options).saveWindowState(window);
	assert.deepEqual(new WindowsStateHandler(options).getNewWindowState(defaultOptions), {
		mode: WindowMode.Normal, ...window.bounds, displayId: display.id, workArea: display.workArea,
	});

	display = { id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 }, workArea: { x: 0, y: 0, width: 3840, height: 2080 } };
	const restored = new WindowsStateHandler(options).getNewWindowState(defaultOptions);
	assert.deepEqual(restored, {
		mode: WindowMode.Normal, x: 120, y: 80, width: 1100, height: 760, displayId: 1, workArea: display.workArea,
	});
	window.setBounds({ x: restored.x!, y: restored.y!, width: restored.width, height: restored.height });
	await new WindowsStateHandler(options).saveWindowState(window);
	display = primaryDisplay;
	assert.deepEqual(new WindowsStateHandler(options).getNewWindowState(defaultOptions), {
		mode: WindowMode.Normal, x: 120, y: 80, width: 1100, height: 760, displayId: 1, workArea: display.workArea,
	});
});

test('restoring onto a removed display retains logical size within the new work area', () => {
	const target = { id: 2, bounds: { x: -1200, y: 0, width: 1200, height: 900 }, workArea: { x: -1200, y: 0, width: 1200, height: 900 } };
	const state = validateWindowState({
		mode: WindowMode.Normal, x: 480, y: 260, width: 960, height: 520, displayId: 1, workArea: primaryDisplay.workArea,
	}, [target], WorkbenchState.FOLDER);
	assert.deepEqual(state, {
		mode: WindowMode.Normal, x: -960, y: 260, width: 960, height: 520, displayId: 2, workArea: target.workArea,
	});
	const tiny = { ...target, workArea: { x: 0, y: 0, width: 480, height: 360 } };
	assert.deepEqual(validateWindowState({
		mode: WindowMode.Normal, x: 480, y: 260, width: 960, height: 520, displayId: 1, workArea: primaryDisplay.workArea,
	}, [tiny], WorkbenchState.FOLDER), {
		mode: WindowMode.Normal, x: 0, y: 0, width: 480, height: 360, displayId: 2, workArea: tiny.workArea,
	});
});

test('resolution changes apply once after OS resize events and defer maximized geometry until restoration', async () => {
	using changes = new Emitter<void>();
	const stateService = new TestStateService();
	let display = primaryDisplay;
	const options = {
		stateService,
		workspace: folderWorkspace,
		displayService: {
			onDidChangeDisplays: changes.event,
			getAllDisplays: () => [display],
			getPrimaryDisplay: () => display, getCursorDisplay: () => display,
			getDisplayMatching: () => display,
		},
	};
	const handler = new WindowsStateHandler(options);
	const window = new TestWindow();
	window.bounds = { x: 120, y: 80, width: 1100, height: 760 };
	const tracking = handler.trackWindow(window);
	try {
		display = { id: 1, bounds: { x: 0, y: 0, width: 960, height: 540 }, workArea: { x: 0, y: 0, width: 960, height: 520 } };
		window.bounds = { x: 0, y: 0, width: 960, height: 520 };
		window.emit('resize');
		window.emit('blur');
		changes.fire();
		assert.deepEqual(window.bounds, { x: 0, y: 0, width: 960, height: 520 });
		changes.fire();
		assert.deepEqual(window.bounds, { x: 0, y: 0, width: 960, height: 520 });

		window.maximized = true;
		window.bounds = display.workArea;
		display = primaryDisplay;
		changes.fire();
		assert.deepEqual(window.bounds, { x: 0, y: 0, width: 960, height: 520 });
		const restored = new WindowsStateHandler(options).getNewWindowState(defaultOptions);
		assert.deepEqual(restored, {
			mode: WindowMode.Maximized, x: 0, y: 0, width: 960, height: 520, displayId: 1, workArea: primaryDisplay.workArea,
		});
		window.maximized = false;
		window.emit('unmaximize');
		assert.deepEqual(window.bounds, { x: 0, y: 0, width: 960, height: 520 });
	} finally {
		tracking.dispose();
	}
	const flushed = stateService.flushCount;
	display = { ...primaryDisplay, workArea: { x: 0, y: 0, width: 960, height: 520 } };
	changes.fire();
	window.emit('close');
	await Promise.resolve();
	assert.deepEqual({ bounds: window.bounds, flushed: stateService.flushCount }, {
		bounds: { x: 0, y: 0, width: 960, height: 520 }, flushed,
	});
});

test('display changes preserve fullscreen mode and normal bounds for leaving fullscreen', () => {
	using changes = new Emitter<void>();
	let display = primaryDisplay;
	const handler = new WindowsStateHandler({
		stateService: new TestStateService(), workspace: folderWorkspace,
		displayService: { onDidChangeDisplays: changes.event, getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorDisplay: () => display, getDisplayMatching: () => display },
	});
	const window = new TestWindow();
	window.bounds = { x: 120, y: 80, width: 1100, height: 760 };
	using tracking = handler.trackWindow(window);
	window.fullscreen = true;
	window.bounds = primaryDisplay.bounds;
	display = { id: 1, bounds: { x: 0, y: 0, width: 960, height: 540 }, workArea: { x: 0, y: 0, width: 960, height: 520 } };
	changes.fire();
	assert.equal(window.fullscreen, true);
	window.fullscreen = false;
	window.emit('leave-full-screen');
	assert.deepEqual(window.bounds, { x: 0, y: 0, width: 960, height: 520 });
});

test('invalid persisted work areas are rejected at the storage boundary', () => {
	for (const workArea of [null, { x: 0, y: 0, width: 0, height: 1040 }, { x: 0, y: 0, width: '1920', height: 1040 }]) {
		const stateService = new TestStateService();
		stateService.setItem('windowsState', { version: 1, openedWindows: [{
			folder: folderWorkspace.uri.toString(), uiState: { mode: WindowMode.Normal, bounds: { x: 120, y: 80, width: 1100, height: 760 }, workArea },
		}] });
		assert.deepEqual(createHandler(stateService, folderWorkspace).getNewWindowState(defaultOptions), {
			...defaultWindowState(WorkbenchState.FOLDER), x: 360, y: 140, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
		});
	}
});

test('dragging between displays preserves logical size and the dropped position', () => {
	const secondDisplay = { id: 2, bounds: { x: 1920, y: 0, width: 3840, height: 2160 }, workArea: { x: 1920, y: 0, width: 3840, height: 2080 } };
	const handler = new WindowsStateHandler({
		stateService: new TestStateService(), workspace: folderWorkspace,
		displayService: {
			onDidChangeDisplays: Event.None,
			getAllDisplays: () => [primaryDisplay, secondDisplay],
			getPrimaryDisplay: () => primaryDisplay, getCursorDisplay: () => primaryDisplay,
			getDisplayMatching: bounds => bounds.x < 1920 ? primaryDisplay : secondDisplay,
		},
	});
	const window = new TestWindow();
	window.bounds = { x: 120, y: 80, width: 1100, height: 760 };
	using tracking = handler.trackWindow(window);
	window.bounds = { x: 3000, y: 800, width: 1100, height: 760 };
	window.emit('move');
	assert.deepEqual(window.bounds, { x: 3000, y: 800, width: 1100, height: 760 });
	window.emit('moved');
	assert.deepEqual(window.bounds, { x: 3000, y: 800, width: 1100, height: 760 });
	window.emit('moved');
	assert.deepEqual(window.bounds, { x: 3000, y: 800, width: 1100, height: 760 });
});

test('mixed-DPI displays retain logical placement across moves, restarts, scaling changes and disconnection', async () => {
	for (const secondary of [
		{ id: 2, scaleFactor: 1.25, bounds: { x: 1920, y: 0, width: 1536, height: 864 }, workArea: { x: 1920, y: 0, width: 1536, height: 824 } },
		{ id: 2, scaleFactor: 2, bounds: { x: -1080, y: 0, width: 1080, height: 1920 }, workArea: { x: -1080, y: 0, width: 1080, height: 1880 } },
	]) {
		using changes = new Emitter<void>();
		const stateService = new TestStateService();
		let target = secondary;
		let displays = [primaryDisplay, target];
		let currentDisplay: IWindowDisplay = primaryDisplay;
		const options = {
			stateService, workspace: folderWorkspace,
			displayService: {
				onDidChangeDisplays: changes.event,
				getAllDisplays: () => displays,
				getPrimaryDisplay: () => primaryDisplay, getCursorDisplay: () => primaryDisplay,
				getDisplayMatching: () => currentDisplay,
			},
		};
		const handler = new WindowsStateHandler(options);
		const window = new TestWindow();
		window.bounds = { x: 120, y: 80, width: 980, height: 640 };
		const expected = { x: secondary.workArea.x + 50, y: 80, width: 980, height: 640 };
		using tracking = handler.trackWindow(window);
		currentDisplay = secondary;
		window.bounds = expected;
		window.emit('move');
		window.emit('moved');
		await handler.saveWindowState(window);
		assert.deepEqual(new WindowsStateHandler(options).getNewWindowState(defaultOptions), {
			mode: WindowMode.Normal, ...expected, displayId: secondary.id, workArea: secondary.workArea,
		});
		target = { ...secondary, scaleFactor: 1, bounds: { ...secondary.bounds, width: secondary.bounds.width * 2, height: secondary.bounds.height * 2 }, workArea: { ...secondary.workArea, width: secondary.workArea.width * 2, height: secondary.workArea.height * 2 } };
		displays = [primaryDisplay, target];
		currentDisplay = target;
		changes.fire();
		assert.deepEqual(window.bounds, expected);
		await handler.saveWindowState(window);
		assert.deepEqual(new WindowsStateHandler(options).getNewWindowState(defaultOptions), {
			mode: WindowMode.Normal, ...expected, displayId: target.id, workArea: target.workArea,
		});
		displays = [primaryDisplay];
		assert.deepEqual(new WindowsStateHandler(options).getNewWindowState(defaultOptions), {
			mode: WindowMode.Normal, x: 50, y: 80, width: 980, height: 640, displayId: primaryDisplay.id, workArea: primaryDisplay.workArea,
		});
	}
});

test('work areas smaller than the default minimum remain reachable through Electron sizing limits', () => {
	using changes = new Emitter<void>();
	let display = primaryDisplay;
	const handler = new WindowsStateHandler({
		stateService: new TestStateService(), workspace: folderWorkspace,
		displayService: { onDidChangeDisplays: changes.event, getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorDisplay: () => display, getDisplayMatching: () => display },
	});
	const window = new TestWindow();
	window.bounds = { x: 120, y: 80, width: 1100, height: 760 };
	using tracking = handler.trackWindow(window);
	display = { id: 1, bounds: { x: 0, y: 0, width: 300, height: 200 }, workArea: { x: 0, y: 0, width: 300, height: 200 } };
	changes.fire();
	assert.deepEqual({ bounds: window.bounds, minimum: window.minimumSize }, {
		bounds: { x: 0, y: 0, width: 300, height: 200 }, minimum: { width: 300, height: 200 },
	});
	const options = resolveBrowserWindowOptions({
		state: { mode: WindowMode.Normal, ...window.bounds, workArea: display.workArea },
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: 'preload.js', additionalArguments: [] },
	});
	assert.deepEqual({ width: options.minWidth, height: options.minHeight }, window.minimumSize);
});

test('fullscreen persistence uses the current display and retains logical normal size when moved', async () => {
	const stateService = new TestStateService();
	const secondDisplay = { id: 2, bounds: { x: 1920, y: 0, width: 3840, height: 2160 }, workArea: { x: 1920, y: 0, width: 3840, height: 2080 } };
	const handler = new WindowsStateHandler({
		stateService, workspace: folderWorkspace,
		displayService: {
			onDidChangeDisplays: Event.None,
			getAllDisplays: () => [primaryDisplay, secondDisplay],
			getPrimaryDisplay: () => primaryDisplay, getCursorDisplay: () => primaryDisplay,
			getDisplayMatching: bounds => bounds.x < 1920 ? primaryDisplay : secondDisplay,
		},
	});
	const window = new TestWindow();
	window.bounds = { x: 120, y: 80, width: 1100, height: 760 };
	using tracking = handler.trackWindow(window);
	window.fullscreen = true;
	window.bounds = secondDisplay.bounds;
	await handler.saveWindowState(window);
	assert.deepEqual(handler.getNewWindowState({ ...defaultOptions, restoreFullscreen: true }), {
		mode: WindowMode.Fullscreen, x: 2040, y: 80, width: 1100, height: 760, displayId: 2, workArea: secondDisplay.workArea,
	});
});

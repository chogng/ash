import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { Workbench } from '../../../automation/workbench.js';

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-ui', 'Window restoration is a Desktop process lifecycle scenario.');
});

for (const scaleFactor of [1, 1.25, 1.5, 2]) {
	test(`Desktop retains logical Workbench and Agents geometry at ${scaleFactor * 100}% display scaling`, async ({}, testInfo) => {
		test.setTimeout(90_000);
		const userDataDirectory = testInfo.outputPath('user-data');
		await mkdir(userDataDirectory, { recursive: true });
		let application: ElectronApplication | undefined;
		try {
			application = await launch(userDataDirectory, undefined, [`--force-device-scale-factor=${scaleFactor}`]);
			const page = await application.firstWindow();
			await new Workbench(page).waitForReady();
			const defaults = await application.evaluate(({ screen }) => {
				const area = screen.getPrimaryDisplay().workArea;
				const width = Math.min(1200, area.width);
				const height = Math.min(800, area.height);
				return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
			});
			const defaultFrame = await constructorFrame(application, defaults);
			await expect.poll(() => geometryDelta(application!, defaultFrame, 'current')).toBeLessThanOrEqual(2);
			const opened = application.waitForEvent('window');
			await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			await expect((await opened).locator('.ash-sessions-window')).toBeVisible();
			const requested = await application.evaluate(({ BrowserWindow, screen }) => {
				const area = screen.getPrimaryDisplay().workArea;
				const width = Math.max(400, Math.min(1000, Math.floor(area.width * 0.6)));
				const height = Math.max(270, Math.min(700, Math.floor(area.height * 0.6)));
				const bounds = { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height };
				for (const window of BrowserWindow.getAllWindows()) {
					window.setBounds(bounds);
				}
				return bounds;
			});
			// Fractional DPI rounds the operating-system frame to physical pixels.
			await expect.poll(() => geometryDelta(application!, requested, 'current')).toBeLessThanOrEqual(2);
			const expected = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
			// Measure the frame conversion of a new Electron window independently of
			// Ash's placement policy, which is checked exactly by the owner tests.
			const expectedFrame = await constructorFrame(application, expected);
			await application.close();
			application = undefined;

			const statePath = join(userDataDirectory, 'state.json');
			type Placement = { mode: string; displayId: number; bounds: typeof expected; workArea: typeof expected };
			type WindowState = { lastActiveWindow: { uiState: Placement }; openedWindows: { uiState: Placement }[] };
			const saved = JSON.parse(await readFile(statePath, 'utf8')) as { windowsState: WindowState; sessionsWindowState: WindowState };
			await writeFile(testInfo.outputPath('saved-geometry.json'), JSON.stringify({ expected, workbench: saved.windowsState.openedWindows[0]?.uiState, agents: saved.sessionsWindowState.openedWindows[0]?.uiState }, null, 2));
			for (const [key, state] of Object.entries(saved)) {
				if (key !== 'windowsState' && key !== 'sessionsWindowState') {
					continue;
				}
				for (const { uiState } of [state.lastActiveWindow, ...state.openedWindows]) {
					expect(uiState.workArea).toBeDefined();
					// The saved logical rectangle must survive a resolution change even
					// when the previous display had twice the available work area.
					uiState.workArea.width *= 2;
					uiState.workArea.height *= 2;
					if (key === 'windowsState') {
						uiState.mode = 'maximized';
					}
				}
			}
			await writeFile(statePath, JSON.stringify(saved));
			application = await launch(userDataDirectory, undefined, [`--force-device-scale-factor=${scaleFactor}`]);
			await expect.poll(() => application!.windows().length).toBe(2);
			await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isMaximized()).sort())).toEqual([false, true]);
			const geometryPath = testInfo.outputPath('restored-geometry.json');
			await writeFile(geometryPath, JSON.stringify({ expected, expectedFrame, actual: await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ bounds: window.getNormalBounds(), maximized: window.isMaximized() }))) }, null, 2));
			await testInfo.attach('restored-window-geometry', { path: geometryPath, contentType: 'application/json' });
			await expect.poll(() => geometryDelta(application!, expectedFrame, 'normal')).toBeLessThanOrEqual(2);
			await application.evaluate(({ BrowserWindow }) => {
				BrowserWindow.getAllWindows().find(window => window.isMaximized())!.unmaximize();
			});
			await expect.poll(() => geometryDelta(application!, expectedFrame, 'current')).toBeLessThanOrEqual(2);
		} finally {
			await application?.close();
		}
	});
}

test('Desktop adapts open Workbench and Agents windows to display changes without changing zoom or focus', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const application = await launch(userDataDirectory, undefined, ['--force-device-scale-factor=1']);
	try {
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await opened).locator('.ash-sessions-window')).toBeVisible();
		const before = await application.evaluate(({ BrowserWindow, screen }) => {
			for (const window of BrowserWindow.getAllWindows()) {
				window.setBounds({ x: 120, y: 80, width: 1000, height: 700 });
			}
			const area = screen.getPrimaryDisplay().workArea;
			const width = Math.min(1000, Math.floor(area.width / 2));
			const height = Math.min(700, Math.floor(area.height / 2));
			return {
				focus: BrowserWindow.getFocusedWindow()?.id, zoom: BrowserWindow.getAllWindows().map(window => window.webContents.getZoomLevel()),
				expected: {
					x: Math.max(area.x, Math.min(120, area.x + Math.floor(area.width / 2) - width)),
					y: Math.max(area.y, Math.min(80, area.y + Math.floor(area.height / 2) - height)),
					width, height,
				},
			};
		});
		await expect.poll(() => geometryDelta(application, { x: 120, y: 80, width: 1000, height: 700 }, 'current')).toBeLessThanOrEqual(2);
		await application.evaluate(({ screen }) => {
			const originalAll = screen.getAllDisplays;
			const originalMatching = screen.getDisplayMatching;
			const display = screen.getPrimaryDisplay();
			const changed = { ...display, workArea: {
				x: display.workArea.x, y: display.workArea.y,
				width: Math.floor(display.workArea.width / 2), height: Math.floor(display.workArea.height / 2),
			} };
			(globalThis as { restoreTestDisplay?: () => void }).restoreTestDisplay = () => {
				screen.getAllDisplays = originalAll;
				screen.getDisplayMatching = originalMatching;
			};
			screen.getAllDisplays = () => [changed];
			screen.getDisplayMatching = () => changed;
			screen.emit('display-metrics-changed', {}, changed, ['workArea']);
		});
		await expect.poll(() => geometryDelta(application, before.expected, 'current')).toBeLessThanOrEqual(2);
		expect(await application.evaluate(({ BrowserWindow }) => ({
			focus: BrowserWindow.getFocusedWindow()?.id, zoom: BrowserWindow.getAllWindows().map(window => window.webContents.getZoomLevel()),
		}))).toEqual({ focus: before.focus, zoom: before.zoom });
	} finally {
		await application.evaluate(() => {
			const context = globalThis as { restoreTestDisplay?: () => void };
			context.restoreTestDisplay?.();
			delete context.restoreTestDisplay;
		});
		await application.close();
	}
});

test('Desktop restores open Workbench and Agents windows and honors startup intent', async ({}, testInfo) => {
	test.setTimeout(120_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	const folder = testInfo.outputPath('folder');
	await mkdir(userDataDirectory, { recursive: true });
	await mkdir(folder, { recursive: true });
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory);
		const workbench = await application.firstWindow();
		await new Workbench(workbench).waitForReady();
		const opened = application.waitForEvent('window');
		await workbench.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		await application.close();
		application = undefined;

		const saved = JSON.parse(await readFile(join(userDataDirectory, 'state.json'), 'utf8')) as { windowSession: { active: number; windows: readonly { kind: string }[] } };
		expect(saved.windowSession.windows.map(window => window.kind)).toEqual(['workbench', 'sessions']);
		expect(saved.windowSession.active).toBe(1);

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(2);
		await expect(application.windows().find(page => page !== application!.windows()[0])!.locator('.ash-sessions-window')).toBeVisible();
		await application.windows()[0]!.close();
		await expect.poll(() => application!.windows().length).toBe(1);
		await application.close();
		application = undefined;
		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		await expect((await application.firstWindow()).locator('.ash-sessions-window')).toBeVisible();
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory, folder);
		await expect.poll(() => application!.windows().length).toBe(1);
		const targeted = await application.firstWindow();
		await new Workbench(targeted).waitForReady();
		await expect.poll(() => workspaceFolder(targeted)).toBe(folder);
		const reopenedAgents = application.waitForEvent('window');
		await targeted.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await reopenedAgents).locator('.ash-sessions-window')).toBeVisible();
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"one"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		const restoredAgents = await application.firstWindow();
		await expect(restoredAgents.locator('.ash-sessions-window')).toBeVisible();
		const returned = application.waitForEvent('window');
		await restoredAgents.evaluate(() => {
			const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			void bridge.invoke('ash:sessions:return-to-workbench');
		});
		await new Workbench(await returned).waitForReady();
		await expect.poll(() => application!.windows().length).toBe(1);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"none"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		const emptyWorkbench = await application.firstWindow();
		await new Workbench(emptyWorkbench).waitForReady();
		const preservedAgents = application.waitForEvent('window');
		await emptyWorkbench.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await preservedAgents).locator('.ash-sessions-window')).toBeVisible();
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"preserve"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory, folder);
		await expect.poll(() => application!.windows().length).toBe(3);
		await expect.poll(async () => {
			const windows = application!.windows();
			return (await Promise.all(windows.map(page => page.locator('.ash-sessions-window').count()))).reduce((sum, count) => sum + count, 0);
		}).toBe(1);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"folders"}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		const folderWorkbench = await application.firstWindow();
		await new Workbench(folderWorkbench).waitForReady();
		await expect.poll(() => workspaceFolder(folderWorkbench)).toBe(folder);
	} finally {
		await application?.close();
	}
});

test('Workbench restores editor tabs unless editor restoration is disabled', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	const folder = testInfo.outputPath('folder');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await mkdir(folder, { recursive: true });
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory, folder);
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		await expect(page.locator('.ash-getting-started')).toBeVisible();
		await page.locator('[data-part="editor"] .ash-tab').hover();
		await page.locator('[data-part="editor"] .ash-tab-close-action button').click();
		await expect(page.locator('[data-part="editor"] .ash-tab')).toHaveCount(0);
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		await expect(page.locator('[data-part="editor"] .ash-tab')).toHaveCount(1);
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		await expect(page.locator('[data-part="editor"] .ash-tab')).toHaveCount(2);
		await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('editorparts.state')))).toBe(true);
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		const restored = await application.firstWindow();
		await new Workbench(restored).waitForReady();
		await expect(restored.locator('[data-part="editor"] .ash-tab')).toHaveCount(2);
		await expect(restored.locator('.ash-getting-started')).toHaveCount(0);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"workbench.startupEditor":"none","workbench.editor.restoreEditors":false}\n');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		const disabled = await application.firstWindow();
		await new Workbench(disabled).waitForReady();
		await expect(disabled.locator('[data-part="editor"] .ash-tab')).toHaveCount(0);
		await disabled.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		const input = disabled.locator('[data-part="editor"] .stanza-editor-input');
		await input.focus();
		await input.type('unsaved after restart');
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		const dirty = await application.firstWindow();
		await new Workbench(dirty).waitForReady();
		await expect(dirty.locator('[data-part="editor"] .ash-tab')).toHaveCount(1);
		await expect(dirty.locator('[data-part="editor"] .stanza-editor')).toContainText('unsaved after restart');
	} finally {
		await application?.close();
	}
});

test('Workbench reopens detached editor windows with their tabs', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"workbench.startupEditor":"none"}\n');
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory);
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		await expect(page.locator('.ash-tab')).toHaveCount(1);
		await page.keyboard.press('F1');
		const command = page.locator('.ash-quick-pick').getByRole('combobox');
		await command.fill('Move Editor into New Window');
		const opened = page.context().waitForEvent('page');
		await command.press('Enter');
		const detached = await opened;
		await expect(detached.locator('.ash-auxiliary-window-container .ash-tab')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('editorparts.state') && value.includes('Untitled-1')))).toBe(true);
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(2);
		const windows = application.windows();
		const reopened = windows.find(window => window !== windows[0] && !window.isClosed());
		await expect(reopened!.locator('.ash-auxiliary-window-container .ash-tab')).toHaveCount(1);
	} finally {
		await application?.close();
	}
});

test('updated version restores all windows once despite a none preference', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"none"}\n');
	let application: ElectronApplication | undefined;
	try {
		application = await launch(userDataDirectory);
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		const version = await application.evaluate(({ app }) => app.getVersion());
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await opened).locator('.ash-sessions-window')).toBeVisible();
		await application.close();
		application = undefined;

		const statePath = join(userDataDirectory, 'state.json');
		const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
		await writeFile(statePath, JSON.stringify({ ...state, updateRestartVersion: version }));
		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(2);
		await expect.poll(async () => (JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>).updateRestartVersion).toBeUndefined();
		await application.close();
		application = undefined;

		application = await launch(userDataDirectory);
		await expect.poll(() => application!.windows().length).toBe(1);
		await new Workbench(await application.firstWindow()).waitForReady();
	} finally {
		await application?.close();
	}
});

async function launch(userDataDirectory: string, folder?: string, extraArgs?: readonly string[]): Promise<ElectronApplication> {
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory, workspaceDirectory: folder, extraArgs });
	return _electron.launch({
		executablePath: configuration.executablePath,
		args: [...configuration.args],
		cwd: configuration.cwd,
		env: configuration.env,
		timeout: 30_000,
	});
}

async function geometryDelta(application: ElectronApplication, expected: { x: number; y: number; width: number; height: number }, kind: 'normal' | 'current'): Promise<number> {
	const bounds = await application.evaluate(({ BrowserWindow }, kind) => BrowserWindow.getAllWindows().map(window => kind === 'normal' ? window.getNormalBounds() : window.getBounds()), kind);
	return Math.max(...bounds.flatMap(rectangle => (['x', 'y', 'width', 'height'] as const).map(key => Math.abs(rectangle[key] - expected[key]))));
}

async function constructorFrame(application: ElectronApplication, bounds: { x: number; y: number; width: number; height: number }): Promise<typeof bounds> {
	return application.evaluate(({ BrowserWindow }, bounds) => {
		const probe = new BrowserWindow({
			...bounds, show: false, minWidth: 400, minHeight: 270,
			titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
			titleBarOverlay: process.platform === 'darwin' ? true : { height: 35, color: '#181818', symbolColor: '#d6d6d6' },
		});
		try {
			return probe.getBounds();
		} finally {
			probe.destroy();
		}
	}, bounds);
}

async function workspaceFolder(page: Page): Promise<string | undefined> {
	const value = await page.evaluate(() => {
		const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return bridge.invoke('ash:workspace:context:read');
	});
	return parseWorkspace(value).folders[0]?.uri.fsPath;
}

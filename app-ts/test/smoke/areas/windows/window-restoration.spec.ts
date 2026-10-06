import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URI } from '../../../../src/ash/base/common/uri.js';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';
import { launchElectronApplication, type ElectronApplicationLaunchResult } from '../../../automation/playwrightElectron.js';
import { Workbench } from '../../../automation/workbench.js';

test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-ui', 'Window restoration is a Desktop process lifecycle scenario.');
});

for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2]) {
	test(`Desktop retains logical Workbench and Agents geometry at ${scaleFactor * 100}% display scaling`, async ({}, testInfo) => {
		test.setTimeout(90_000);
		const userDataDirectory = testInfo.outputPath('user-data');
		await mkdir(userDataDirectory, { recursive: true });
		let application: ElectronApplication | undefined;
		let session: ElectronApplicationLaunchResult | undefined;
		try {
			session = await launch(userDataDirectory, undefined, [`--force-device-scale-factor=${scaleFactor}`]);
			application = session.application;
			const page = await application.firstWindow();
			await new Workbench(page).waitForReady();
			const defaults = await application.evaluate(({ screen }) => {
				const { bounds, workArea: area } = screen.getPrimaryDisplay();
				const width = Math.min(1200, area.width);
				const height = Math.min(800, area.height);
				return { x: Math.round(Math.max(area.x, Math.min(bounds.x + (bounds.width - 1200) / 2, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(bounds.y + (bounds.height - 800) / 2, area.y + area.height - height))), width, height };
			});
			await expect.poll(() => geometryDelta(application!, defaults, 'current')).toBeLessThanOrEqual(2);
			const opened = application.waitForEvent('window');
			await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			const agents = await opened;
			await expect(agents.locator('.ash-sessions-window')).toBeVisible();
			const agentsWindow = await application.browserWindow(agents);
			try {
				// DPI frame rounding can suppress an exact-coordinate collision and its
				// placement offset. Both windows must still have the same default size.
				await expect.poll(async () => {
					const bounds = await agentsWindow.evaluate(window => window.getBounds());
					return Math.max(Math.abs(bounds.width - defaults.width), Math.abs(bounds.height - defaults.height));
				}).toBeLessThanOrEqual(2);
			} finally {
				await agentsWindow.dispose();
			}
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
			await session.quit();
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
			session = await launch(userDataDirectory, undefined, [`--force-device-scale-factor=${scaleFactor}`]);
			application = session.application;
			await expect.poll(() => application!.windows().length).toBe(2);
			for (const page of application.windows()) {
				await expect(page.locator('.ash-workbench, .ash-sessions-window').first()).toBeVisible();
			}
			await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isMaximized()).sort())).toEqual([false, true]);
			const geometryPath = testInfo.outputPath('restored-geometry.json');
			await writeFile(geometryPath, JSON.stringify({ expected, actual: await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ bounds: window.getNormalBounds(), maximized: window.isMaximized() }))) }, null, 2));
			await testInfo.attach('restored-window-geometry', { path: geometryPath, contentType: 'application/json' });
			await expect.poll(() => geometryDelta(application!, expected, 'normal')).toBeLessThanOrEqual(2);
			await application.evaluate(({ BrowserWindow }) => {
				BrowserWindow.getAllWindows().find(window => window.isMaximized())!.unmaximize();
			});
			await expect.poll(() => geometryDelta(application!, expected, 'current')).toBeLessThanOrEqual(2);
			for (let restart = 0; restart < 2; restart++) {
				await session.quit();
				application = undefined;
				session = await launch(userDataDirectory, undefined, [`--force-device-scale-factor=${scaleFactor}`]);
				application = session.application;
				await expect.poll(() => application!.windows().length).toBe(2);
				for (const page of application.windows()) {
					await expect(page.locator('.ash-workbench, .ash-sessions-window').first()).toBeVisible();
				}
				await expect.poll(() => geometryDelta(application!, expected, 'current')).toBeLessThanOrEqual(2);
			}
		} finally {
			await session?.close();
		}
	});
}

for (const scenario of [
	{ resolution: '1920 × 1080', scaleFactor: 1, width: 1920, height: 1080, expected: { width: 1200, height: 800 } },
	{ resolution: '1280 × 720', scaleFactor: 1, width: 1280, height: 720, expected: { width: 1200, height: 680 } },
	{ resolution: '1024 × 768', scaleFactor: 1, width: 1024, height: 768, expected: { width: 1024, height: 728 } },
	{ resolution: '1920 × 1080', scaleFactor: 1.5, width: 1280, height: 720, expected: { width: 1200, height: 680 } },
	{ resolution: '3840 × 2160', scaleFactor: 2, width: 1920, height: 1080, expected: { width: 1200, height: 800 } },
]) {
	test(`Desktop new windows fit simulated ${scenario.resolution} at ${scenario.scaleFactor * 100}% scaling`, async ({}, testInfo) => {
		const userDataDirectory = testInfo.outputPath('user-data');
		await mkdir(userDataDirectory, { recursive: true });
		// The screen adapter supplies DIP rectangles; physical frame rounding is
		// exercised separately by the actual display-scaling scenarios above.
		const session = await launch(userDataDirectory, undefined, ['--force-device-scale-factor=1']);
		const application = session.application;
		try {
			const page = await application.firstWindow();
			const workbench = new Workbench(page);
			await workbench.waitForReady();
			await application.evaluate(({ BrowserWindow, screen }, scenario) => {
				const originalAll = screen.getAllDisplays;
				const originalPrimary = screen.getPrimaryDisplay;
				const originalMatching = screen.getDisplayMatching;
				const display = {
					...screen.getPrimaryDisplay(),
					scaleFactor: scenario.scaleFactor,
					bounds: { x: 0, y: 0, width: scenario.width, height: scenario.height },
					workArea: { x: 0, y: 0, width: scenario.width, height: scenario.height - 40 },
				};
				(globalThis as { restoreTestDisplay?: () => void }).restoreTestDisplay = () => {
					screen.getAllDisplays = originalAll;
					screen.getPrimaryDisplay = originalPrimary;
					screen.getDisplayMatching = originalMatching;
				};
				screen.getAllDisplays = () => [display];
				screen.getPrimaryDisplay = () => display;
				screen.getDisplayMatching = () => display;
				BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 0, width: 800, height: 500 });
			}, scenario);
			const agents = await workbench.openAgentsWindow('electron');
			const opened = application.waitForEvent('window');
			await page.evaluate(async () => {
				const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<unknown> } } }).ash.ipcRenderer;
				await bridge.invoke('ash:window:open', {});
			});
			const empty = await opened;
			await new Workbench(empty).waitForReady();
			for (const target of [agents, empty]) {
				const window = await application.browserWindow(target);
				try {
					await expect.poll(async () => {
						const { width, height } = await window.evaluate(window => window.getBounds());
						return { width, height };
					}).toEqual(scenario.expected);
				} finally {
					await window.dispose();
				}
			}
			await testInfo.attach('window-sizing', {
				body: JSON.stringify({ ...scenario, actual: await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.getBounds())) }, null, 2),
				contentType: 'application/json',
			});
		} finally {
			await application.evaluate(() => {
				const context = globalThis as { restoreTestDisplay?: () => void };
				context.restoreTestDisplay?.();
				delete context.restoreTestDisplay;
			});
			await session.close();
		}
	});
}

test('Desktop places a new Agents window on the active display of a simulated mixed-DPI desktop', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const session = await launch(userDataDirectory);
	const application = session.application;
	try {
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		const expected = await application.evaluate(({ BrowserWindow, screen }) => {
			const originalAll = screen.getAllDisplays;
			const originalPrimary = screen.getPrimaryDisplay;
			const originalMatching = screen.getDisplayMatching;
			const display = screen.getPrimaryDisplay();
			const area = display.workArea;
			const split = Math.floor(area.width / 2);
			const primary = { ...display, id: 10, scaleFactor: 2, workArea: { ...area, x: area.x + split, width: area.width - split } };
			const secondary = { ...display, id: 20, scaleFactor: 1, workArea: { ...area, width: split } };
			primary.bounds = primary.workArea;
			secondary.bounds = secondary.workArea;
			(globalThis as { restoreTestDisplay?: () => void }).restoreTestDisplay = () => {
				screen.getAllDisplays = originalAll;
				screen.getPrimaryDisplay = originalPrimary;
				screen.getDisplayMatching = originalMatching;
			};
			screen.getAllDisplays = () => [primary, secondary];
			screen.getPrimaryDisplay = () => primary;
			screen.getDisplayMatching = bounds => {
				const overlap = (display: typeof primary): number => {
					const area = display.workArea;
					return Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
				};
				return overlap(primary) > overlap(secondary) ? primary : secondary;
			};
			BrowserWindow.getAllWindows()[0]!.setBounds(primary.workArea);
			const width = Math.min(1200, primary.workArea.width);
			const height = Math.min(800, primary.workArea.height);
			return { x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2), y: Math.round(primary.workArea.y + (primary.workArea.height - height) / 2), width, height };
		});
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		const agentsWindow = await application.browserWindow(agents);
		await expect.poll(async () => {
			const bounds = await agentsWindow.evaluate(window => window.getBounds());
			return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(bounds[key] - expected[key])));
		}).toBeLessThanOrEqual(2);
		await agentsWindow.dispose();
	} finally {
		await application.evaluate(() => {
			const context = globalThis as { restoreTestDisplay?: () => void };
			context.restoreTestDisplay?.();
			delete context.restoreTestDisplay;
		});
		await session.close();
	}
});

for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2]) {
	test(`Desktop new windows share the 1200 by 800 default after resizing the active window at ${scaleFactor * 100}% display scaling`, async ({}, testInfo) => {
		const userDataDirectory = testInfo.outputPath('user-data');
		await mkdir(userDataDirectory, { recursive: true });
		const session = await launch(userDataDirectory, undefined, [`--force-device-scale-factor=${scaleFactor}`]);
		try {
			const application = session.application;
			const page = await application.firstWindow();
			await new Workbench(page).waitForReady();
			const defaults = await application.evaluate(({ screen }) => {
				const area = screen.getPrimaryDisplay().workArea;
				return { width: Math.min(1200, area.width), height: Math.min(800, area.height) };
			});
			await expect.poll(async () => {
				const bounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
				return Math.max(Math.abs(bounds.width - defaults.width), Math.abs(bounds.height - defaults.height));
			}).toBeLessThanOrEqual(2);
			const customBounds = await application.evaluate(({ BrowserWindow, screen }) => {
				const area = screen.getPrimaryDisplay().workArea;
				const bounds = { x: area.x, y: area.y, width: Math.min(800, area.width), height: Math.min(500, area.height) };
				const window = BrowserWindow.getAllWindows()[0]!;
				window.setBounds(bounds);
				return window.getBounds();
			});
			const openedAgents = application.waitForEvent('window');
			await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			const agents = await openedAgents;
			await expect(agents.locator('.ash-sessions-window')).toBeVisible();
			const agentsWindow = await application.browserWindow(agents);
			try {
				await expect.poll(async () => {
					const bounds = await agentsWindow.evaluate(window => window.getBounds());
				return Math.max(Math.abs(bounds.width - defaults.width), Math.abs(bounds.height - defaults.height));
				}).toBeLessThanOrEqual(2);
			} finally {
				await agentsWindow.dispose();
			}
			await expect.poll(async () => {
				const state = JSON.parse(await readFile(join(userDataDirectory, 'state.json'), 'utf8')) as { windowsState?: { lastActiveWindow?: { uiState: { bounds: { width: number } } } } };
				return Math.abs((state.windowsState?.lastActiveWindow?.uiState.bounds.width ?? NaN) - customBounds.width);
			}).toBeLessThanOrEqual(2);
			const openedWindow = application.waitForEvent('window');
			await page.evaluate(async () => {
				const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<unknown> } } }).ash.ipcRenderer;
				await bridge.invoke('ash:window:open', {});
			});
			const empty = await openedWindow;
			await new Workbench(empty).waitForReady();
			const emptyWindow = await application.browserWindow(empty);
			try {
				await expect.poll(async () => {
					const { width, height } = await emptyWindow.evaluate(window => window.getBounds());
					return Math.max(Math.abs(width - defaults.width), Math.abs(height - defaults.height));
				}).toBeLessThanOrEqual(2);
			} finally {
				await emptyWindow.dispose();
			}
		} finally {
			await session.close();
		}
	});
}

test('Desktop adapts open Workbench and Agents windows to display changes without changing zoom or focus', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const session = await launch(userDataDirectory, undefined, ['--force-device-scale-factor=1']);
	const application = session.application;
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
		await session.close();
	}
});

for (const policy of ['inherit', 'offset', 'maximized', 'fullscreen'] as const) {
	test(`Desktop shares the ${policy} dimension setting across Workbench and Agents windows`, async ({}, testInfo) => {
		const userDataDirectory = testInfo.outputPath('user-data');
		await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), JSON.stringify({ 'window.newWindowDimensions': policy }));
		const session = await launch(userDataDirectory);
		try {
			const application = session.application;
			const page = await application.firstWindow();
			await new Workbench(page).waitForReady();
			await application.evaluate(({ BrowserWindow }) => {
				const window = BrowserWindow.getAllWindows()[0]!;
				window.setFullScreen(false);
				window.unmaximize();
			});
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isFullScreen() || window.isMaximized()))).toBe(false);
			const original = await application.evaluate(({ BrowserWindow, screen }) => {
				const area = screen.getPrimaryDisplay().workArea;
				const window = BrowserWindow.getAllWindows()[0]!;
				window.setBounds({ x: area.x + 40, y: area.y + 40, width: Math.min(800, area.width - 100), height: Math.min(500, area.height - 100) });
				return window.getBounds();
			});
			const openedAgents = application.waitForEvent('window');
			await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			const agents = await openedAgents;
			await expect(agents.locator('.ash-sessions-window')).toBeVisible();
			const agentsWindow = await application.browserWindow(agents);
			try {
				await expect.poll(() => agentsWindow.evaluate(window => ({ maximized: window.isMaximized(), fullscreen: window.isFullScreen() }))).toEqual({ maximized: policy === 'maximized', fullscreen: policy === 'fullscreen' });
				if (policy === 'inherit' || policy === 'offset') {
					const expected = { ...original, x: original.x + (policy === 'offset' ? 30 : 0), y: original.y + (policy === 'offset' ? 30 : 0) };
					await expect.poll(async () => {
						const actual = await agentsWindow.evaluate(window => window.getBounds());
						return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(actual[key] - expected[key])));
					}).toBeLessThanOrEqual(2);
				}
				await agentsWindow.evaluate(window => window.focus());
				const openedEmpty = application.waitForEvent('window');
				await agents.evaluate(() => {
					const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<unknown> } } }).ash.ipcRenderer;
					return bridge.invoke('ash:window:open', {});
				});
				const empty = await openedEmpty;
				await new Workbench(empty).waitForReady();
				const emptyWindow = await application.browserWindow(empty);
				try {
					await expect.poll(() => emptyWindow.evaluate(window => ({ maximized: window.isMaximized(), fullscreen: window.isFullScreen() }))).toEqual({ maximized: policy === 'maximized', fullscreen: policy === 'fullscreen' });
					if (policy === 'inherit' || policy === 'offset') {
						const source = await agentsWindow.evaluate(window => window.getNormalBounds());
						const expected = { ...source, x: source.x + (policy === 'offset' ? 30 : 0), y: source.y + (policy === 'offset' ? 30 : 0) };
						await expect.poll(async () => {
							const actual = await emptyWindow.evaluate(window => window.getBounds());
							return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(actual[key] - expected[key])));
						}).toBeLessThanOrEqual(2);
					}
				} finally { await emptyWindow.dispose(); }
			} finally { await agentsWindow.dispose(); }
			await session.quit();
		} finally { await session.close(); }
	});
}

for (const restoreFullscreen of [false, true]) {
	test(`Desktop restores saved fullscreen for both window kinds only when enabled (${restoreFullscreen})`, async ({}, testInfo) => {
		const userDataDirectory = testInfo.outputPath('user-data');
		await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), JSON.stringify({ 'window.restoreFullscreen': restoreFullscreen }));
		let session = await launch(userDataDirectory);
		try {
			let application = session.application;
			const page = await application.firstWindow();
			await new Workbench(page).waitForReady();
			await new Workbench(page).openAgentsWindow('electron');
			await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setFullScreen(true); });
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isFullScreen()))).toEqual([true, true]);
			await session.quit();
			session = await launch(userDataDirectory);
			application = session.application;
			await expect.poll(() => application.windows().length).toBe(2);
			const restoredWorkbench = new Workbench(await application.firstWindow());
			await restoredWorkbench.waitForReady();
			await restoredWorkbench.openAgentsWindow('electron');
			await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isFullScreen()))).toEqual([restoreFullscreen, restoreFullscreen]);
			await session.quit();
		} finally { await session.close(); }
	});
}

test('Desktop window sizing settings expose Chinese labels and keyboard selection', async ({}, testInfo) => {
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"workbench.locale":"zh-CN"}');
	const session = await launch(userDataDirectory);
	try {
		const page = await session.application.firstWindow();
		const workbench = new Workbench(page);
		await workbench.waitForReady();
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = workbench.settingsEditor.element;
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await workbench.settingsEditor.selectCategory('startup');
		const dimensions = settings.locator('[data-settings-item-id="window.newWindowDimensions"]');
		await expect(dimensions).toContainText('新窗口尺寸');
		const select = dimensions.getByRole('combobox');
		await select.focus();
		await select.press('Space');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(select).toBeFocused();
		await expect.poll(async () => JSON.parse(await readFile(join(userDataDirectory, 'profile', 'settings.json'), 'utf8'))['window.newWindowDimensions']).toBe('inherit');
		await expect(settings.locator('[data-settings-item-id="window.restoreFullscreen"]')).toContainText('恢复全屏');
	} finally { await session.close(); }
});

test('Desktop restores open Workbench and Agents windows and honors startup intent', async ({}, testInfo) => {
	test.setTimeout(120_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	const folder = testInfo.outputPath('folder');
	await mkdir(userDataDirectory, { recursive: true });
	await mkdir(folder, { recursive: true });
	let application: ElectronApplication | undefined;
	let session: ElectronApplicationLaunchResult | undefined;
	try {
		session = await launch(userDataDirectory);
		application = session.application;
		const workbench = await application.firstWindow();
		await new Workbench(workbench).waitForReady();
		const opened = application.waitForEvent('window');
		await workbench.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		await session.quit();
		application = undefined;

		const saved = JSON.parse(await readFile(join(userDataDirectory, 'state.json'), 'utf8')) as { windowSession: { active: number; windows: { kind: string; modeId?: string }[] } };
		expect(saved.windowSession.windows.map(window => window.kind)).toEqual(['workbench', 'sessions']);
		expect(saved.windowSession.active).toBe(1);
		expect(saved.windowSession.windows.every(window => !('modeId' in window))).toBe(true);
		// Exercise a persisted record from before product modes were removed.
		saved.windowSession.windows.find(window => window.kind === 'sessions')!.modeId = 'code';
		await writeFile(join(userDataDirectory, 'state.json'), JSON.stringify(saved));

		session = await launch(userDataDirectory);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(2);
		await expect(application.windows().find(page => page !== application!.windows()[0])!.locator('.ash-sessions-window')).toBeVisible();
		await application.windows()[0]!.close();
		await expect.poll(() => application!.windows().length).toBe(1);
		await session.quit();
		application = undefined;
		session = await launch(userDataDirectory);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(1);
		await expect((await application.firstWindow()).locator('.ash-sessions-window')).toBeVisible();
		await session.quit();
		application = undefined;
		const updated = JSON.parse(await readFile(join(userDataDirectory, 'state.json'), 'utf8')) as typeof saved;
		expect(updated.windowSession.windows.every(window => !('modeId' in window))).toBe(true);

		session = await launch(userDataDirectory, folder);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(1);
		const targeted = await application.firstWindow();
		await new Workbench(targeted).waitForReady();
		await expect.poll(() => workspaceFolder(targeted)).toBe(URI.file(folder).fsPath);
		const reopenedAgents = application.waitForEvent('window');
		await targeted.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await reopenedAgents).locator('.ash-sessions-window')).toBeVisible();
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"one"}\n');
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
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
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(1);
		const emptyWorkbench = await application.firstWindow();
		await new Workbench(emptyWorkbench).waitForReady();
		const preservedAgents = application.waitForEvent('window');
		await emptyWorkbench.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await preservedAgents).locator('.ash-sessions-window')).toBeVisible();
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"preserve"}\n');
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory, folder);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(3);
		await expect.poll(async () => {
			const windows = application!.windows();
			return (await Promise.all(windows.map(page => page.locator('.ash-sessions-window').count()))).reduce((sum, count) => sum + count, 0);
		}).toBe(1);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"folders"}\n');
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(1);
		const folderWorkbench = await application.firstWindow();
		await new Workbench(folderWorkbench).waitForReady();
		await expect.poll(() => workspaceFolder(folderWorkbench)).toBe(URI.file(folder).fsPath);
	} finally {
		await session?.close();
	}
});

test('Workbench restores editor tabs unless editor restoration is disabled', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	const folder = testInfo.outputPath('folder');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await mkdir(folder, { recursive: true });
	let application: ElectronApplication | undefined;
	let session: ElectronApplicationLaunchResult | undefined;
	try {
		session = await launch(userDataDirectory, folder);
		application = session.application;
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
		await expect.poll(async () => (await readFile(join(userDataDirectory, 'workbench-state.json'), 'utf8')).includes('editorparts.state')).toBe(true);
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
		const restored = await application.firstWindow();
		await new Workbench(restored).waitForReady();
		await expect(restored.locator('[data-part="editor"] .ash-tab')).toHaveCount(2);
		await expect(restored.locator('.ash-getting-started')).toHaveCount(0);
		await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"workbench.startupEditor":"none","workbench.editor.restoreEditors":false}\n');
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
		const disabled = await application.firstWindow();
		await new Workbench(disabled).waitForReady();
		await expect(disabled.locator('[data-part="editor"] .ash-tab')).toHaveCount(0);
		await disabled.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N');
		const input = disabled.locator('[data-part="editor"] .stanza-editor-input');
		await input.focus();
		await input.type('unsaved after restart');
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
		const dirty = await application.firstWindow();
		await new Workbench(dirty).waitForReady();
		await expect(dirty.locator('[data-part="editor"] .ash-tab')).toHaveCount(1);
		await expect(dirty.locator('[data-part="editor"] .stanza-editor')).toContainText('unsaved after restart');
	} finally {
		await session?.close();
	}
});

test('Workbench reopens detached editor windows with their tabs', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"workbench.startupEditor":"none"}\n');
	let application: ElectronApplication | undefined;
	let session: ElectronApplicationLaunchResult | undefined;
	try {
		session = await launch(userDataDirectory);
		application = session.application;
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
		await expect.poll(async () => {
			const saved = await readFile(join(userDataDirectory, 'workbench-state.json'), 'utf8');
			return saved.includes('editorparts.state') && saved.includes('Untitled-1');
		}).toBe(true);
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(2);
		const windows = application.windows();
		const reopened = windows.find(window => window !== windows[0] && !window.isClosed());
		await expect(reopened!.locator('.ash-auxiliary-window-container .ash-tab')).toHaveCount(1);
	} finally {
		await session?.close();
	}
});

test('updated version restores all windows once despite a none preference', async ({}, testInfo) => {
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(join(userDataDirectory, 'profile'), { recursive: true });
	await writeFile(join(userDataDirectory, 'profile', 'settings.json'), '{"window.restoreWindows":"none"}\n');
	let application: ElectronApplication | undefined;
	let session: ElectronApplicationLaunchResult | undefined;
	try {
		session = await launch(userDataDirectory);
		application = session.application;
		const page = await application.firstWindow();
		await new Workbench(page).waitForReady();
		const version = await application.evaluate(({ app }) => app.getVersion());
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		await expect((await opened).locator('.ash-sessions-window')).toBeVisible();
		await session.quit();
		application = undefined;

		const statePath = join(userDataDirectory, 'state.json');
		const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
		await writeFile(statePath, JSON.stringify({ ...state, updateRestartVersion: version }));
		session = await launch(userDataDirectory);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(2);
		await expect.poll(async () => (JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>).updateRestartVersion).toBeUndefined();
		const restoredWorkbench = new Workbench(await application.firstWindow());
		await restoredWorkbench.waitForReady();
		await restoredWorkbench.openAgentsWindow('electron');
		await session.quit();
		application = undefined;

		session = await launch(userDataDirectory);
		application = session.application;
		await expect.poll(() => application!.windows().length).toBe(1);
		await new Workbench(await application.firstWindow()).waitForReady();
	} finally {
		await session?.close();
	}
});

async function launch(userDataDirectory: string, folder?: string, extraArgs?: readonly string[]): Promise<ElectronApplicationLaunchResult> {
	return launchElectronApplication({ appServerMode: 'disabled', userDataDirectory, workspaceDirectory: folder, extraArgs });
}

async function geometryDelta(application: ElectronApplication, expected: { x: number; y: number; width: number; height: number }, kind: 'normal' | 'current'): Promise<number> {
	const bounds = await application.evaluate(({ BrowserWindow }, kind) => BrowserWindow.getAllWindows().map(window => kind === 'normal' ? window.getNormalBounds() : window.getBounds()), kind);
	return Math.max(...bounds.flatMap(rectangle => (['x', 'y', 'width', 'height'] as const).map(key => Math.abs(rectangle[key] - expected[key]))));
}

async function workspaceFolder(page: Page): Promise<string | undefined> {
	const value = await page.evaluate(() => {
		const bridge = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return bridge.invoke('ash:workspace:context:read');
	});
	return parseWorkspace(value).folders[0]?.uri.fsPath;
}

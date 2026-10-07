import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { PlaywrightDriver, type WindowSize, type WorkbenchDiagnostics } from "./playwrightDriver.js";

/** Adds Electron-hosted window control to the shared Workbench driver. */
export class ElectronPlaywrightDriver extends PlaywrightDriver {
	constructor(application: ElectronApplication, currentPage: Page, diagnostics: WorkbenchDiagnostics) {
		super(application, currentPage, diagnostics);
	}

	override async setWindowSize(size: WindowSize): Promise<WindowSize> {
		const application = this.application;
		if (!("windows" in application)) {
			throw new Error("Electron window control requires an Electron application");
		}
		const window = await application.browserWindow(this.currentPage);
		try {
			const actualSize = await window.evaluate((window, requestedSize) => {
				window.setSize(requestedSize.width, requestedSize.height);
				const bounds = window.getBounds();
				return { width: bounds.width, height: bounds.height };
			}, size);
			await this.workbench.waitForUiIdle();
			return actualSize;
		} finally { await window.dispose(); }
	}
}

/** Renderer readiness does not imply that the desktop has completed focus or fullscreen transitions. */
export async function waitForElectronWindowState(application: ElectronApplication, page: Page, expected: { focused: boolean; fullScreen?: boolean; } | { fullScreen: boolean; focused?: boolean; }): Promise<void> {
	const window = await application.browserWindow(page);
	let id: number;
	try { id = await window.evaluate(window => window.id); }
	finally { await window.dispose(); }
	await expect.poll(() => application.evaluate(({ BrowserWindow, powerMonitor }, id) => {
		const systemIdleState = powerMonitor.getSystemIdleState(60);
		if (systemIdleState === 'locked') throw new Error('Desktop is locked; window focus and fullscreen cannot be verified');
		const window = BrowserWindow.fromId(id);
		if (!window) throw new Error(`Electron window ${id} was closed before its state transition completed`);
		return { id, focused: window.isFocused(), fullScreen: window.isFullScreen(), visible: window.isVisible(), minimized: window.isMinimized(), systemIdleState };
	}, id), { message: `Desktop window ${id} must complete its state transition` }).toMatchObject(expected);
}

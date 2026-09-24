import { BrowserWindow } from "electron/main";
import type { WebPreferences } from "electron/main";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { DisposableStore } from "../../../base/common/lifecycle.js";
import { normalizeEntryUrl } from "../../ipc/electron-main/trustedIpcRouter.js";
import type { TrustedIpcRouter } from "../../ipc/electron-main/trustedIpcRouter.js";
import { REMOTE_RUNTIME_INSTALL_PROGRESS_CHANGED_CHANNEL } from "../common/remoteRuntimeInstallProgress.js";
import type { RemoteRuntimeInstallProgressState } from "../common/remoteRuntimeInstallProgress.js";
import { remoteRuntimeInstallProgressIpcRoutes } from "./remoteRuntimeInstallProgressIpc.js";
import type { RemoteRuntimeInstallProgressMainService } from "./remoteRuntimeInstallProgressMainService.js";

export interface RemoteRuntimeInstallRendererEntry {
	readonly file: string;
	readonly url: string;
	readonly useDevelopmentUrl: boolean;
}

export interface ElectronRemoteRuntimeInstallWindowOptions {
	readonly productName: string;
	readonly rendererEntry: RemoteRuntimeInstallRendererEntry;
	readonly webPreferences: WebPreferences;
	readonly trustedIpcRouter: TrustedIpcRouter;
	readonly progress: RemoteRuntimeInstallProgressMainService;
}

/** Owns the trusted, pre-Workbench progress window for one SSH startup gate. */
export class ElectronRemoteRuntimeInstallWindow extends Disposable {
	private window: BrowserWindow | undefined;

	constructor(private readonly options: ElectronRemoteRuntimeInstallWindowOptions) {
		super();
		this._register(options.progress.onDidChange(state => this.sync(state)));
		this._register(toDisposable(() => {
			const window = this.window;
			this.window = undefined;
			if (window && !window.isDestroyed()) window.destroy();
		}));
	}

	private sync(state: RemoteRuntimeInstallProgressState | undefined): void {
		const window = this.window;
		if (!state) {
			if (window && !window.isDestroyed()) {
				window.setClosable(true);
				window.setProgressBar(-1);
				window.close();
			}
			return;
		}
		if (window && !window.isDestroyed()) {
			updateWindow(window, state, this.options.productName);
			window.webContents.send(REMOTE_RUNTIME_INSTALL_PROGRESS_CHANGED_CHANNEL, state);
			return;
		}
		if (state.status === "cancelling") return;
		void this.open().catch(error => {
			console.error("Failed to open Remote runtime installation progress", error);
			this.options.progress.cancel();
		});
	}

	private async open(): Promise<void> {
		if (this.window && !this.window.isDestroyed()) return;
		const state = this.options.progress.getState();
		if (!state || state.status === "cancelling") return;
		const window = new BrowserWindow({
			width: 540,
			height: 280,
			minWidth: 420,
			minHeight: 230,
			resizable: false,
			maximizable: false,
			fullscreenable: false,
			show: false,
			title: `${this.options.productName} — Preparing SSH Remote`,
			webPreferences: this.options.webPreferences,
		});
		this.window = window;
		updateWindow(window, state, this.options.productName);
		window.once("ready-to-show", () => {
			if (!window.isDestroyed() && this.options.progress.getState()) window.show();
		});
		const windowResources = this._register(new DisposableStore());
		windowResources.add(this.options.trustedIpcRouter.register(
			{
				webContents: window.webContents,
				allowedEntryUrls: new Set([normalizeEntryUrl(this.options.rendererEntry.url)]),
			},
			remoteRuntimeInstallProgressIpcRoutes(this.options.progress),
		));
		window.once("closed", () => {
			windowResources.dispose();
			if (this.window === window) this.window = undefined;
			if (this.options.progress.getState()) this.options.progress.cancel();
		});
		try {
			if (this.options.rendererEntry.useDevelopmentUrl) await window.loadURL(this.options.rendererEntry.url);
			else await window.loadFile(this.options.rendererEntry.file);
			const current = this.options.progress.getState();
			if (current && !window.isDestroyed()) {
				updateWindow(window, current, this.options.productName);
				window.webContents.send(REMOTE_RUNTIME_INSTALL_PROGRESS_CHANGED_CHANNEL, current);
			}
		} catch (error) {
			if (!window.isDestroyed()) window.destroy();
			throw error;
		}
	}
}

function updateWindow(window: BrowserWindow, state: RemoteRuntimeInstallProgressState, productName: string): void {
	window.setTitle(`${productName} — Preparing ${state.host}`);
	window.setClosable(state.phase !== "complete");
	if (state.phase === "complete") {
		window.setProgressBar(1);
		return;
	}
	if (state.phase === "uploading") {
		window.setProgressBar(Math.min(1, state.transferredBytes / state.totalBytes));
		return;
	}
	window.setProgressBar(2);
}
